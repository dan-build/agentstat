// Regression tests for correctness issues fixed in v0.4: each test names the
// failure it guards against.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, screen, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import AgentStat, { type Agent, type AgentStatRef, niceMax } from '../src/AgentStat';
import { TimeSeriesBuffer } from '../src/timeseries';
import { detectStall, detectThrash, DEFAULT_ANOMALY_CONFIG } from '../src/anomaly';
import { StatusLog } from '../src/statuslog';
import { mulberry32, simStep } from '../src/simulator';

const makeAgent = (id: string, extra: Partial<Agent> = {}): Agent => ({
  id,
  name: `Agent ${id}`,
  config: { expectedTokensPerSec: [10, 20] },
  current: { tokensRate: 15, progress: 0, status: 'active' },
  ...extra,
});

const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe('time-series buffer', () => {
  it('drops points that scrolled out of the window even when no new data arrives', () => {
    const buf = new TimeSeriesBuffer();
    for (let i = 0; i < 100; i++) buf.push(i * 50, i);
    expect(buf.windowed(5000, 5000, 400).points.length).toBe(100);
    // Same buffer, later "now": everything is older than the window.
    expect(buf.windowed(60_000, 5000, 400).points.length).toBe(0);
  });

  it('keeps the downsample cache across pushes within a recompute bucket', () => {
    // Phase 0: buckets are [2000, 3000), [3000, 4000), …
    const buf = new TimeSeriesBuffer(500, 0);
    for (let i = 0; i < 2000; i++) buf.push(i, i % 7);
    const a = buf.windowed(2000, undefined, 50, 1000);
    expect(a.downsampled).toBe(true);
    buf.push(2000, 3); // hard cap slides the head
    const b = buf.windowed(2999, undefined, 50, 1000); // same bucket, later now
    expect(b).toBe(a);
    const c = buf.windowed(3000, undefined, 50, 1000); // next bucket
    expect(c).not.toBe(a);
  });

  it('keeps a paused view stable while data keeps arriving', () => {
    const buf = new TimeSeriesBuffer();
    for (let i = 0; i < 1000; i++) buf.push(i * 10, i % 5);
    const frozen = buf.windowed(5000, 2000, 100).points;
    for (let i = 1000; i < 3000; i++) buf.push(i * 10, 99);
    expect(buf.windowed(5000, 2000, 100).points).toEqual(frozen);
    expect(frozen.every((p) => p.t <= 5000)).toBe(true);
  });

  it('enforces a fractional hard cap', () => {
    const buf = new TimeSeriesBuffer(2.5);
    for (let i = 0; i < 10; i++) buf.push(i, i);
    expect(buf.length).toBe(2);
  });

  it('rejects non-finite samples and keeps time sorted', () => {
    const buf = new TimeSeriesBuffer();
    buf.push(10, 1);
    buf.push(20, NaN);
    buf.push(30, Infinity);
    buf.push(5, 2); // out of order → clamped forward
    expect(buf.toArray()).toEqual([
      { t: 10, v: 1 },
      { t: 10, v: 2 },
    ]);
  });

  it('compacts the dead head instead of holding thousands of evicted samples', () => {
    const buf = new TimeSeriesBuffer(100_000);
    for (let i = 0; i < 5000; i++) {
      buf.push(i, i);
      buf.evictOlderThan(i, 100);
    }
    expect(buf.length).toBeLessThanOrEqual(101);
    // Storage shrinks back toward the live window instead of the peak.
    expect((buf as unknown as { _t: Float64Array })._t.length).toBeLessThanOrEqual(512);
  });
});

describe('detectors', () => {
  const cfg = DEFAULT_ANOMALY_CONFIG;

  it('does not count the status already in effect as a thrash change', () => {
    const log = new StatusLog();
    log.record(0, 'active');
    log.record(9000, 'thinking');
    log.record(10_000, 'active');
    log.record(11_000, 'thinking');
    const changes = log.transitionsInRange(12_000 - cfg.thrashWindowMs, 12_000);
    // 3 real changes < threshold of 4 → not thrashing.
    expect(detectThrash(changes, 12_000, cfg)).toBeNull();
  });

  it('flags a silent agent (no data at all) as stalled', () => {
    const a = detectStall([{ t: 0, v: 20 }], 'active', 60_000, cfg);
    expect(a?.kind).toBe('stall');
    expect(a?.severity).toBe('critical');
    expect(a?.message).toMatch(/no data/);
  });

  it('does not flag a recently producing agent', () => {
    expect(detectStall([{ t: 0, v: 20 }], 'active', 1000, cfg)).toBeNull();
  });
});

describe('niceMax', () => {
  it('never returns Infinity or NaN', () => {
    expect(niceMax(Infinity)).toBe(10);
    expect(niceMax(NaN)).toBe(10);
  });
});

describe('simulator', () => {
  it('is reproducible with a seed', () => {
    const agent = makeAgent('a');
    const run = () => {
      const rng = mulberry32(42);
      let state = { anomalyTicks: 0, confidence: 0.9 };
      const out: number[] = [];
      let cur = { ...agent, current: { ...agent.current } };
      for (let i = 0; i < 50; i++) {
        const s = simStep(cur, state, false, rng);
        state = s.state;
        cur = { ...cur, current: { ...cur.current, tokensRate: s.tokensRate, status: s.status } };
        out.push(s.tokensRate);
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});

describe('component', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('survives colors that are not 6-digit hex', async () => {
    const ref = createRef<AgentStatRef>();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <AgentStat
        ref={ref}
        agents={[
          makeAgent('a', { color: 'red' }),
          makeAgent('b', { color: '#f00' }),
          makeAgent('c', { color: 'rgb(0 128 0)' }),
          makeAgent('d', { color: 'var(--missing)' }),
        ]}
      />
    );
    act(() => ref.current?.updateAgent('a', 20, 10, 'active'));
    await tick(200);
    // The loop is still alive: live metrics keep easing toward the update.
    act(() => ref.current?.updateAgent('a', 5, 10, 'active'));
    await tick(500);
    expect(ref.current?.getLiveMetrics('a')?.tokensRate).toBeCloseTo(5, 0);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('ignores NaN / Infinity instead of poisoning health or the axis', async () => {
    const ref = createRef<AgentStatRef>();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<AgentStat ref={ref} agents={[makeAgent('nan')]} metric="tokens" />);
    act(() => ref.current?.updateAgent('nan', NaN, Infinity, 'active'));
    act(() => ref.current?.updateAgent('nan', Infinity, 50, 'active'));
    await tick(600);
    const h = ref.current?.getHealth('nan');
    expect(Number.isFinite(h?.score)).toBe(true);
    expect(Number.isFinite(ref.current?.getLiveMetrics('nan')?.tokensRate)).toBe(true);
    warn.mockRestore();
  });

  it('accepts partial updates and keeps the other fields', async () => {
    const ref = createRef<AgentStatRef>();
    render(<AgentStat ref={ref} agents={[makeAgent('p')]} />);
    act(() => ref.current?.updateAgent('p', { tokensRate: 12, progress: 40, status: 'thinking' }));
    act(() => ref.current?.updateAgent('p', { tokensRate: 18 }));
    await tick(600);
    const lv = ref.current?.getLiveMetrics('p');
    expect(lv?.status).toBe('thinking');
    expect(lv?.progress).toBeCloseTo(40, 0);
    expect(lv?.tokensRate).toBeCloseTo(18, 0);
  });

  it('reports latency trend and hallucination risk only from supplied signals', async () => {
    const ref = createRef<AgentStatRef>();
    render(<AgentStat ref={ref} agents={[makeAgent('s')]} />);
    await tick(600);
    expect(ref.current?.getHealth('s')?.hallucinationRisk).toBeNull();
    expect(ref.current?.getHealth('s')?.latencyTrend).toBeNull();
    for (const ms of [400, 400, 900, 900]) {
      act(() => ref.current?.updateAgent('s', { latencyMs: ms, confidenceScore: 0.8 }));
    }
    await tick(600);
    expect(ref.current?.getHealth('s')?.latencyTrend).toBe('degrading');
    expect(ref.current?.getHealth('s')?.hallucinationRisk).toBe(20);
  });

  it('does not raise a false spike on the first real update', async () => {
    const onAnomaly = vi.fn();
    const ref = createRef<AgentStatRef>();
    render(
      <AgentStat
        ref={ref}
        agents={[makeAgent('z', { current: { tokensRate: 0, progress: 0, status: 'active' } })]}
        anomalyDetection
        onAnomaly={onAnomaly}
      />
    );
    act(() => ref.current?.updateAgent('z', 15, 1, 'active'));
    await tick(600);
    expect(onAnomaly.mock.calls.filter(([, a]) => a.kind === 'spike')).toHaveLength(0);
  });

  it('keeps monitoring agents hidden from the legend', async () => {
    const onAnomaly = vi.fn();
    const ref = createRef<AgentStatRef>();
    render(
      <AgentStat
        ref={ref}
        agents={[makeAgent('h', { visible: false })]}
        anomalyDetection
        anomalyConfig={{ stallDurationMs: 1000 }}
        onAnomaly={onAnomaly}
      />
    );
    for (let i = 0; i < 20; i++) {
      act(() => ref.current?.updateAgent('h', 0, 5, 'active'));
      await tick(100);
    }
    await tick(600);
    expect(onAnomaly.mock.calls.some(([, a]) => a.kind === 'stall')).toBe(true);
  });

  it('applies name and color changes to existing agents', async () => {
    const { rerender } = render(<AgentStat agents={[makeAgent('n', { name: 'Old' })]} />);
    expect(screen.getByRole('button', { name: 'Old' })).toBeTruthy();
    rerender(<AgentStat agents={[makeAgent('n', { name: 'New' })]} />);
    await tick(600);
    expect(screen.getByRole('button', { name: 'New' })).toBeTruthy();
  });

  it('exposes legend toggles as pressed/unpressed buttons', async () => {
    render(<AgentStat agents={[makeAgent('l', { name: 'Legend' })]} />);
    const btn = screen.getByRole('button', { name: 'Legend' });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('pause is a real toggle exposed to assistive tech', () => {
    render(<AgentStat agents={[makeAgent('q')]} />);
    const pause = screen.getByRole('button', { name: 'Pause' });
    expect(pause.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(pause);
    expect(screen.getByRole('button', { name: 'Resume' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('announces a new anomaly through a live region', async () => {
    const ref = createRef<AgentStatRef>();
    render(
      <AgentStat
        ref={ref}
        agents={[makeAgent('r', { name: 'Planner' })]}
        anomalyDetection
        anomalyConfig={{ stallDurationMs: 1000 }}
      />
    );
    for (let i = 0; i < 12; i++) {
      act(() => ref.current?.updateAgent('r', 0, 5, 'active'));
      await tick(100);
    }
    await tick(600);
    const regions = [...screen.queryAllByRole('status'), ...screen.queryAllByRole('alert')];
    expect(regions.some((el) => /Planner: stalled/.test(el.textContent ?? ''))).toBe(true);
  });

  it('warns once and ignores updates for unknown ids', () => {
    const ref = createRef<AgentStatRef>();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<AgentStat ref={ref} agents={[makeAgent('k')]} />);
    act(() => ref.current?.updateAgent('ghost-id', 1, 1, 'active'));
    act(() => ref.current?.updateAgent('ghost-id', 1, 1, 'active'));
    expect(warn.mock.calls.filter(([m]) => String(m).includes('ghost-id'))).toHaveLength(1);
    warn.mockRestore();
  });
});

describe('draw path (real geometry)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400,
      toJSON: () => ({}),
    } as DOMRect);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['progress', 'tokens', 'both'] as const)(
    'renders %s mode with anomalies, hover, keyboard and pause without a frame error',
    async (metric) => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const ref = createRef<AgentStatRef>();
      const onPointClick = vi.fn();
      const { container } = render(
        <AgentStat
          ref={ref}
          metric={metric}
          windowSeconds={metric === 'both' ? 30 : undefined}
          referenceLine={{ value: 50, label: 'Target' }}
          anomalyDetection
          anomalyConfig={{ stallDurationMs: 1000 }}
          smoothing={0.3}
          onPointClick={onPointClick}
          agents={[makeAgent('a', { color: 'red' }), makeAgent('b'), makeAgent('c', { visible: false })]}
        />
      );
      for (let i = 0; i < 30; i++) {
        act(() => {
          ref.current?.updateAgent('a', i < 15 ? 15 : 0, i, 'active');
          ref.current?.updateAgent('b', 10 + (i % 5), i * 2, i % 2 ? 'thinking' : 'active');
        });
        await tick(100);
      }
      await tick(600);
      const canvas = container.querySelector('canvas')!;
      fireEvent.mouseMove(canvas, { clientX: 740, clientY: 200 });
      fireEvent.keyDown(canvas, { key: 'End' });
      fireEvent.keyDown(canvas, { key: 'ArrowLeft' });
      fireEvent.keyDown(canvas, { key: 'ArrowDown' });
      fireEvent.keyDown(canvas, { key: 'Enter' });
      expect(onPointClick).toHaveBeenCalled();
      fireEvent.keyDown(canvas, { key: ' ' });
      await tick(200);
      fireEvent.keyDown(canvas, { key: ' ' });
      fireEvent.keyDown(canvas, { key: 'Escape' });
      await tick(200);
      expect(errors).not.toHaveBeenCalled();
    }
  );
});

describe('anomaly episodes', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reports when an anomaly ends, once', async () => {
    const onAnomaly = vi.fn();
    const onAnomalyEnd = vi.fn();
    const ref = createRef<AgentStatRef>();
    render(
      <AgentStat
        ref={ref}
        agents={[makeAgent('e', { name: 'Worker' })]}
        anomalyDetection
        anomalyConfig={{ stallDurationMs: 1000 }}
        onAnomaly={onAnomaly}
        onAnomalyEnd={onAnomalyEnd}
      />
    );
    for (let i = 0; i < 20; i++) {
      act(() => ref.current?.updateAgent('e', 0, 1, 'active'));
      await tick(100);
    }
    expect(onAnomaly.mock.calls.some(([, a]) => a.kind === 'stall')).toBe(true);
    expect(onAnomalyEnd).not.toHaveBeenCalled();
    for (let i = 0; i < 80; i++) {
      act(() => ref.current?.updateAgent('e', 15, 2, 'active'));
      await tick(100);
    }
    const ends = onAnomalyEnd.mock.calls.filter(([, a]) => a.kind === 'stall');
    expect(ends).toHaveLength(1);
    expect(screen.getAllByRole('status').some((el) => /Worker: stall resolved/.test(el.textContent ?? ''))).toBe(true);
  });
});

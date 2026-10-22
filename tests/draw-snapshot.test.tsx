// Characterization tests for the renderer: each scene records every canvas
// call of the last drawn frame and compares it with a stored snapshot. Any
// refactor of the drawing code must leave these identical; an intentional
// visual change updates them with `npx vitest run -u` (and gets reviewed).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import AgentStat, { createAgent, type AgentStatProps, type AgentStatRef } from '../src/AgentStat';

type Call = string;

/** A 2D context that logs calls (numbers rounded) and restarts at each full clear. */
function makeRecorder() {
  let frame: Call[] = [];
  let gradients = 0;
  const fmt = (v: unknown): string =>
    typeof v === 'number'
      ? String(Math.round(v * 100) / 100)
      : typeof v === 'string'
        ? JSON.stringify(v)
        : v && typeof v === 'object' && 'id' in (v as object)
          ? `gradient#${(v as { id: number }).id}`
          : String(v);
  const log = (name: string, args: unknown[]) => frame.push(`${name}(${args.map(fmt).join(', ')})`);
  const state: Record<string, unknown> = {};
  const target = {
    get frame() {
      return frame;
    },
    createLinearGradient: (...a: number[]) => {
      const g = {
        id: ++gradients,
        addColorStop: (o: number, c: string) => log(`gradient#${g.id}.addColorStop`, [o, c]),
      };
      log('createLinearGradient', a);
      return g;
    },
    createRadialGradient: () => ({ id: ++gradients, addColorStop: () => {} }),
    measureText: (t: string) => ({ width: t.length * 6 }),
    fillRect: (...a: number[]) => {
      // A full clear at the origin starts a new frame.
      if (a[0] === 0 && a[1] === 0) frame = [];
      log('fillRect', a);
    },
  };
  return new Proxy(target as Record<string, unknown>, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      if (prop in state) return state[prop];
      return (...args: unknown[]) => log(prop, args);
    },
    set(_t, prop: string, value) {
      state[prop] = value;
      log(`set ${prop}`, [value]);
      return true;
    },
  });
}

const recorders = new WeakMap<HTMLCanvasElement, ReturnType<typeof makeRecorder>>();

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'],
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400,
    toJSON: () => ({}),
  } as DOMRect);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    let r = recorders.get(this);
    if (!r) {
      r = makeRecorder();
      recorders.set(this, r);
    }
    return r as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

async function scene(props: Partial<AgentStatProps>, feed?: (ref: AgentStatRef, i: number) => void, after?: (c: HTMLCanvasElement) => void) {
  const ref = createRef<AgentStatRef>();
  const { container } = render(
    <AgentStat
      ref={ref}
      agents={[createAgent('a', 'Planner'), createAgent('b', 'Researcher'), createAgent('c', 'Coder')]}
      {...props}
    />
  );
  for (let i = 0; i < 60; i++) {
    act(() => feed?.(ref.current!, i));
    await tick(100);
  }
  await tick(600);
  const canvas = container.querySelector('canvas')!;
  after?.(canvas);
  await tick(200);
  return recorders.get(canvas)!.frame;
}

const wave = (ref: AgentStatRef, i: number) => {
  ref.updateAgent('a', { tokensRate: 12 + 6 * Math.sin(i / 5), progress: i, status: i % 20 < 10 ? 'active' : 'thinking' });
  ref.updateAgent('b', { tokensRate: 22 + 3 * Math.cos(i / 7), progress: i * 1.4, status: 'active' });
  ref.updateAgent('c', { tokensRate: i < 25 ? 10 : 0, progress: Math.min(i, 25), status: 'active' });
};

describe('renderer snapshots', () => {
  it('progress metric with a reference line', async () => {
    const frame = await scene({ metric: 'progress', referenceLine: { value: 50, label: 'Target' } }, wave);
    expect(frame).toMatchSnapshot();
  });

  it('tokens metric, windowed, smoothed, with a stall marker and keyboard inspection', async () => {
    const frame = await scene(
      { metric: 'tokens', windowSeconds: 10, smoothing: 0.3, anomalyDetection: true, anomalyConfig: { stallDurationMs: 2000 } },
      wave,
      (c) => {
        fireEvent.keyDown(c, { key: 'End' });
        fireEvent.keyDown(c, { key: 'ArrowLeft' });
      }
    );
    expect(frame).toMatchSnapshot();
  });

  it('both metrics, dark theme, one agent hidden, paused', async () => {
    const frame = await scene(
      {
        metric: 'both',
        theme: 'dark',
        agents: [createAgent('a', 'Planner'), { ...createAgent('b', 'Researcher'), visible: false }, createAgent('c', 'Coder', 'rgb(200 80 20)')],
      },
      wave,
      (c) => fireEvent.keyDown(c, { key: ' ' })
    );
    expect(frame).toMatchSnapshot();
  });

  it('both metrics with an agent that never reports progress (token line only)', async () => {
    const frame = await scene({ metric: 'both' }, (ref, i) => {
      ref.updateAgent('a', { tokensRate: 12 + 6 * Math.sin(i / 5), progress: i, status: 'active' });
      ref.push('c', { type: 'tokens', count: 3 }); // event-driven: never reports progress
    });
    // a: progress line + dashed token line; c: dashed token line only.
    expect((frame as string[]).filter((c) => c.startsWith('setLineDash(3,3)')).length).toBe(2);
    expect(frame).toMatchSnapshot();
  });

  it('empty roster', async () => {
    const frame = await scene({ agents: [] });
    expect(frame).toMatchSnapshot();
  });
});

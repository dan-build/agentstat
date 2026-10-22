// Event-based ingest (`push`): derived rate, TTFT, inter-token latency,
// status, and how the detectors treat `waiting`.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentStore } from '../src/core/store';
import { DEFAULT_ANOMALY_CONFIG, detectStall, type Anomaly } from '../src/anomaly';
import type { Agent } from '../src/types';

const T0 = 10_000;
const agent = (id = 'a'): Agent => ({ id, name: id, current: { tokensRate: 0, progress: 0, status: 'complete' } });
const make = () => new AgentStore([agent()], { maxHistoryPoints: 100_000 }, T0);
const cfg = DEFAULT_ANOMALY_CONFIG;

/** Run health ticks every 500 ms over [from, to], collecting new anomalies. */
function ticks(store: AgentStore, from: number, to: number): Anomaly[] {
  const out: Anomaly[] = [];
  for (let t = from; t <= to; t += 500) {
    store.healthTick(t, true, cfg, (e) => {
      if (e.kind === 'anomaly') out.push(e.anomaly);
    });
  }
  return out;
}

/** Stream `rate` tokens/s as chunks of `chunk` over [from, to). */
function stream(store: AgentStore, from: number, to: number, rate: number, chunk = 5) {
  const gap = (chunk / rate) * 1000;
  for (let t = from; t < to; t += gap) store.push('a', { type: 'tokens', count: chunk }, t);
}

afterEach(() => vi.restoreAllMocks());

describe('push: derived values', () => {
  it('derives the token rate from chunk counts', () => {
    const s = make();
    s.push('a', { type: 'start' }, T0);
    stream(s, T0 + 500, T0 + 5_500, 40);
    const rec = s.byId.get('a')!;
    expect(rec.current.status).toBe('active');
    expect(rec.current.tokensRate).toBeGreaterThan(32);
    expect(rec.current.tokensRate).toBeLessThan(48);
    expect(s.getStats('a', T0 + 5_500)!.totalTokens).toBe(200);
  });

  it('reads the rate right from the first chunk (no window ramp)', () => {
    const s = make();
    stream(s, T0, T0 + 2_000, 40); // establishes the gap between chunks
    s.push('a', { type: 'tool-start' }, T0 + 2_000);
    s.push('a', { type: 'tool-end' }, T0 + 5_000);
    s.push('a', { type: 'tokens', count: 5 }, T0 + 5_500);
    expect(s.byId.get('a')!.current.tokensRate).toBeGreaterThan(30);
  });

  it('turns cumulative totals into deltas; a smaller total starts a new count', () => {
    const s = make();
    s.push('a', { type: 'tokens', total: 100 }, T0);
    s.push('a', { type: 'tokens', total: 150 }, T0 + 1_000);
    s.push('a', { type: 'tokens', total: 150 }, T0 + 1_500);
    s.push('a', { type: 'tokens', total: 30 }, T0 + 2_000);
    expect(s.getStats('a', T0 + 2_000)!.totalTokens).toBe(180);
  });

  it('measures TTFT from start and feeds it to the latency trend', () => {
    const s = make();
    s.push('a', { type: 'start' }, T0);
    expect(s.byId.get('a')!.current.status).toBe('thinking');
    s.push('a', { type: 'tokens', count: 3 }, T0 + 800);
    expect(s.getStats('a', T0 + 800)!.ttftMs).toBe(800);
    expect(s.byId.get('a')!.current.latencyMs).toBe(800);
  });

  it('tracks inter-token latency while streaming', () => {
    const s = make();
    stream(s, T0, T0 + 3_000, 50, 5); // a chunk every 100 ms
    expect(s.getStats('a', T0 + 3_000)!.interTokenMs).toBeCloseTo(100, 0);
  });

  it('is waiting while any tool call is open, and counts tool errors', () => {
    const s = make();
    const rec = s.byId.get('a')!;
    s.push('a', { type: 'tool-start', name: 'search' }, T0);
    s.push('a', { type: 'tool-start', name: 'bash' }, T0 + 100);
    expect(rec.current.status).toBe('waiting');
    expect(s.getStats('a', T0 + 100)!.tool).toBe('bash');
    s.push('a', { type: 'tool-end', name: 'search', error: true }, T0 + 200);
    expect(rec.current.status).toBe('waiting');
    expect(s.getStats('a', T0 + 200)!.tool).toBe('bash');
    s.push('a', { type: 'tool-end', name: 'bash' }, T0 + 300);
    expect(rec.current.status).toBe('thinking');
    expect(rec.current.errorCount).toBe(1);
    expect(s.getStats('a', T0 + 1_300)!.statusMs).toBe(1_000);
  });

  it('drops the rate to zero on finish and on a hand-off to a tool', () => {
    const s = make();
    stream(s, T0, T0 + 2_000, 40);
    s.push('a', { type: 'tool-start' }, T0 + 2_000);
    expect(s.byId.get('a')!.current.tokensRate).toBe(0);
    s.push('a', { type: 'tool-end' }, T0 + 3_000);
    stream(s, T0 + 3_000, T0 + 5_000, 40);
    s.push('a', { type: 'finish' }, T0 + 5_000);
    expect(s.byId.get('a')!.current.tokensRate).toBe(0);
    expect(s.byId.get('a')!.current.status).toBe('complete');
  });

  it('decays the rate on health ticks when events stop', () => {
    const s = make();
    stream(s, T0, T0 + 2_000, 40);
    ticks(s, T0 + 2_000, T0 + 7_000);
    expect(s.byId.get('a')!.current.tokensRate).toBe(0);
  });

  it('keeps event times monotonic and never in the future', () => {
    const s = make();
    s.push('a', { type: 'start', time: T0 + 5_000 }, T0 + 1_000); // future → now
    s.push('a', { type: 'tokens', count: 4, time: T0 }, T0 + 1_500); // earlier → previous
    expect(s.getStats('a', T0 + 1_500)!.ttftMs).toBe(0);
    const times = s.tokens.get('a')!.since(0).map((p) => p.t);
    expect([...times].sort((x, y) => x - y)).toEqual(times);
  });

  it('ignores malformed events with one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = make();
    s.push('a', { type: 'tokens', count: NaN }, T0);
    s.push('a', { type: 'tokens', count: NaN }, T0);
    s.push('a', { type: 'nope' } as never, T0);
    s.push('zzz', { type: 'start' }, T0);
    expect(s.getStats('a', T0)!.totalTokens).toBe(0);
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

describe('waiting and stalls', () => {
  it('does not report a stall during a long tool call', () => {
    const s = make();
    stream(s, T0, T0 + 20_000, 40);
    s.push('a', { type: 'tool-start', name: 'tests' }, T0 + 20_000);
    expect(ticks(s, T0 + 500, T0 + 200_000)).toEqual([]);
  });

  it('reports a wait longer than waitingStallMs, naming the tool', () => {
    const s = make();
    s.push('a', { type: 'tool-start', name: 'run_tests' }, T0);
    const found = ticks(s, T0 + 500, T0 + cfg.waitingStallMs + 1_000);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'stall', severity: 'warning', t: T0 });
    expect(found[0].message).toBe(`waiting on run_tests for ${cfg.waitingStallMs / 1000}s`);
  });

  it('does not count a quiet wait toward a stall once work resumes', () => {
    const s = make();
    stream(s, T0, T0 + 20_000, 40);
    s.push('a', { type: 'tool-start' }, T0 + 20_000);
    s.push('a', { type: 'tool-end' }, T0 + 80_000); // → thinking, quiet
    expect(ticks(s, T0 + 500, T0 + 100_000)).toEqual([]);
    // …but a first token that never comes is a stall after thinkingStallMs.
    const found = ticks(s, T0 + 100_500, T0 + 112_000);
    expect(found.map((a) => a.kind)).toEqual(['stall']);
    expect(found[0].t).toBe(T0 + 80_000);
  });

  it('judges a stream that dies mid-answer by the active limit, from its last output', () => {
    const s = make();
    s.push('a', { type: 'start' }, T0);
    ticks(s, T0 + 500, T0 + 20_000); // 20 s quiet thinking: under its limit
    stream(s, T0 + 20_000, T0 + 30_000, 40);
    const found = ticks(s, T0 + 20_500, T0 + 45_000);
    expect(found).toHaveLength(1);
    expect(found[0].message).toMatch(/while active/);
    expect(found[0].t).toBeGreaterThanOrEqual(T0 + 29_000);
  });

  it('detectStall: waiting is judged by its length only', () => {
    const quiet = [{ t: 0, v: 0 }];
    const ctx = { statusSince: 0, waitingOn: 'bash' };
    expect(detectStall(quiet, 'waiting', cfg.waitingStallMs - 1, cfg, ctx)).toBeNull();
    expect(detectStall(quiet, 'waiting', cfg.waitingStallMs * 2, cfg, ctx)?.severity).toBe('critical');
    expect(detectStall(quiet, 'waiting', 1e9, { ...cfg, waitingStallMs: 0 }, ctx)).toBeNull();
    expect(detectStall(quiet, 'waiting', 1e9, cfg)).toBeNull();
  });
});

// End-to-end detector behaviour through the store (10 Hz samples, 500 ms ticks).
import { describe, it, expect } from 'vitest';
import { AgentStore, type StoreEvent } from '../src/core/store';
import { DEFAULT_ANOMALY_CONFIG } from '../src/anomaly';
import type { AgentStatus } from '../src/types';

function replay(rate: (tS: number) => number, seconds: number, status: (tS: number) => AgentStatus = () => 'active') {
  const T0 = 10_000;
  const store = new AgentStore(
    [{ id: 'a', name: 'Agent', current: { tokensRate: 0, progress: 0, status: 'active' } }],
    { maxHistoryPoints: 100_000 },
    T0
  );
  const events: (StoreEvent & { at: number })[] = [];
  for (let ms = 0; ms <= seconds * 1000; ms += 100) {
    const t = ms / 1000;
    // Deterministic ±5% wobble.
    store.ingest('a', { tokensRate: rate(t) * (1 + 0.05 * Math.sin(ms / 70)), status: status(t) }, T0 + ms);
    if (ms % 500 === 0 && ms > 0) {
      store.healthTick(T0 + ms, true, DEFAULT_ANOMALY_CONFIG, (e) => {
        if (e.kind !== 'health') events.push({ ...e, at: t });
      });
    }
  }
  return events;
}

describe('detector episodes through the store', () => {
  it('reports a runaway that starts right after a stall', () => {
    const ev = replay((t) => (t < 30 ? 25 : t < 45 ? 0 : 100), 120);
    const stall = ev.find((e) => e.kind === 'anomaly' && e.anomaly.kind === 'stall');
    const spike = ev.find((e) => e.kind === 'anomaly' && e.anomaly.kind === 'spike');
    expect(stall).toBeDefined();
    expect(spike?.at).toBeGreaterThanOrEqual(45);
    expect(spike?.at).toBeLessThan(52);
  });

  it('does not call a one-second backlog flush after a stall a runaway', () => {
    const ev = replay((t) => (t < 30 ? 25 : t < 45 ? 0 : t < 46 ? 100 : 25), 90);
    expect(ev.some((e) => e.kind === 'anomaly' && e.anomaly.kind === 'spike')).toBe(false);
  });

  it('keeps a long runaway as one episode and resolves it after it ends', () => {
    const ev = replay((t) => (t >= 40 && t < 160 ? 100 : 20), 200);
    const spikes = ev.filter((e) => e.kind === 'anomaly' && e.anomaly.kind === 'spike');
    const ends = ev.filter((e) => e.kind === 'resolved' && e.anomaly.kind === 'spike');
    expect(spikes.length).toBeGreaterThanOrEqual(1);
    expect(spikes.length).toBeLessThanOrEqual(2); // open + escalation
    expect(ends).toHaveLength(1);
    expect(ends[0].at).toBeGreaterThanOrEqual(160);
  });

  // A planner that starts by thinking (a 2.2 t/s trickle), then alternates
  // 5 s of output at 15 t/s with 5 s of thinking.
  const thinksFirst = (t: number): AgentStatus => (t < 5 || Math.floor(t / 5) % 2 === 0 ? 'thinking' : 'active');

  it('does not call the first burst after a thinking start a spike', () => {
    const ev = replay((t) => (thinksFirst(t) === 'thinking' ? 2.2 : 15), 90, thinksFirst);
    expect(ev.some((e) => e.kind === 'anomaly')).toBe(false);
  });

  it('still catches a runaway after a thinking start', () => {
    const ev = replay((t) => (t >= 60 ? 60 : thinksFirst(t) === 'thinking' ? 2.2 : 15), 90, (t) =>
      t >= 60 ? 'active' : thinksFirst(t)
    );
    const spike = ev.find((e) => e.kind === 'anomaly' && e.anomaly.kind === 'spike');
    expect(spike?.at).toBeGreaterThanOrEqual(60);
    expect(spike?.at).toBeLessThan(65);
  });

  it('still catches a runaway while the agent keeps reporting thinking', () => {
    const ev = replay((t) => (t >= 40 ? 120 : 20), 70, () => 'thinking');
    const spike = ev.find((e) => e.kind === 'anomaly' && e.anomaly.kind === 'spike');
    expect(spike?.at).toBeGreaterThanOrEqual(40);
    expect(spike?.at).toBeLessThan(45);
  });
});

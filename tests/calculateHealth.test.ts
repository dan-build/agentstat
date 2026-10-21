import { describe, it, expect } from 'vitest';
import { calculateHealth, type Agent } from '../src/AgentStat';

const makeAgent = (overrides: Partial<Agent['current']> = {}): Agent => ({
  id: 'test',
  name: 'Test Agent',
  color: '#000',
  data: [],
  visible: true,
  config: { expectedTokensPerSec: [10, 20] },
  current: {
    tokensRate: 15,
    progress: 50,
    status: 'active',
    confidenceScore: 1.0,
    ...overrides,
  },
});

describe('calculateHealth — score normalization', () => {
  const steadyRates = [15, 15, 15, 15, 15];

  it('reaches 100 for a perfectly healthy agent with no latency data', () => {
    const h = calculateHealth(makeAgent(), steadyRates);
    expect(h.score).toBe(100);
  });

  it('reaches 100 for a perfectly healthy agent with improving latency', () => {
    const h = calculateHealth(makeAgent(), steadyRates, [], [900, 900, 400, 400]);
    expect(h.score).toBe(100);
    expect(h.latencyTrend).toBe('improving');
  });

  it('reaches 95 for a perfectly healthy agent with stable latency', () => {
    const h = calculateHealth(makeAgent(), steadyRates, [], [1000, 1000, 1000, 1000]);
    expect(h.score).toBe(95);
    expect(h.latencyTrend).toBe('stable');
  });

  it('reaches 90 for a perfectly healthy agent with degrading latency', () => {
    const h = calculateHealth(makeAgent(), steadyRates, [], [400, 400, 900, 900]);
    expect(h.score).toBe(90);
    expect(h.latencyTrend).toBe('degrading');
  });

  it('leaves components without data out of the composite', () => {
    // No confidence and no latency: the score is efficiency + stability only.
    const h = calculateHealth(makeAgent({ confidenceScore: undefined }), steadyRates);
    expect(h.hallucinationRisk).toBeNull();
    expect(h.latencyTrend).toBeNull();
    expect(h.score).toBe(100);
  });

  it('clamps score into [0, 100]', () => {
    const terrible = makeAgent({
      tokensRate: 100,
      status: 'hallucinating',
      confidenceScore: 0,
    });
    const erratic = [0, 50, 0, 50, 0, 50, 0, 50];
    const h = calculateHealth(terrible, erratic);
    expect(h.score).toBeGreaterThanOrEqual(0);
    expect(h.score).toBeLessThanOrEqual(100);
  });

  it('ignores non-finite samples', () => {
    const h = calculateHealth(makeAgent(), [15, NaN, Infinity, 15]);
    expect(Number.isFinite(h.score)).toBe(true);
    expect(h.stability).toBe(100);
  });
});

describe('calculateHealth — metric components', () => {
  it('reports tokenEfficiency=100 when rate is inside the expected range', () => {
    const h = calculateHealth(makeAgent({ tokensRate: 15 }), [15, 15]);
    expect(h.tokenEfficiency).toBe(100);
  });

  it('reports tokenEfficiency=100 at the lower boundary of the expected range', () => {
    const h = calculateHealth(makeAgent({ tokensRate: 10 }), [10, 10]);
    expect(h.tokenEfficiency).toBe(100);
  });

  it('reports tokenEfficiency=100 at the upper boundary of the expected range', () => {
    const h = calculateHealth(makeAgent({ tokensRate: 20 }), [20, 20]);
    expect(h.tokenEfficiency).toBe(100);
  });

  it('reports reduced tokenEfficiency when rate is outside the expected range', () => {
    const h = calculateHealth(makeAgent({ tokensRate: 35 }), [35, 35]);
    // 35 is 15 above the band's upper edge (20); efficiency = 100 - 15/20*100 = 25
    expect(h.tokenEfficiency).toBe(25);
  });

  it('scales the efficiency fall-off with the band (same relative miss, same score)', () => {
    const small = calculateHealth(makeAgent(), [25]); // band [10,20], 25% over
    const big: Agent = { ...makeAgent(), config: { expectedTokensPerSec: [500, 1000] } };
    const large = calculateHealth(big, [1250]); // 25% over
    expect(large.tokenEfficiency).toBe(small.tokenEfficiency);
  });

  it('reports tokenEfficiency floor of 0 for extreme rates', () => {
    const h = calculateHealth(makeAgent({ tokensRate: 500 }), [500]);
    expect(h.tokenEfficiency).toBe(0);
  });

  it('reports stability=100 for perfectly steady rates', () => {
    const h = calculateHealth(makeAgent(), [15, 15, 15, 15, 15]);
    expect(h.stability).toBe(100);
  });

  it('reports low stability for erratic rates', () => {
    const erratic = [5, 25, 5, 25, 5, 25, 5, 25, 5, 25];
    const h = calculateHealth(makeAgent(), erratic);
    expect(h.stability).toBeLessThan(60);
  });

  it('handles empty recentRates without dividing by zero', () => {
    const h = calculateHealth(makeAgent(), []);
    // no variance data → treat as fully stable
    expect(h.stability).toBe(100);
  });

  it('handles single-element recentRates without dividing by zero', () => {
    const h = calculateHealth(makeAgent(), [15]);
    expect(h.stability).toBe(100);
  });
});

describe('calculateHealth — hallucination risk', () => {
  it('reports 100% hallucination risk when status is hallucinating', () => {
    const h = calculateHealth(
      makeAgent({ status: 'hallucinating', confidenceScore: 0.95 }),
      [15, 15]
    );
    expect(h.hallucinationRisk).toBe(100);
  });

  it('derives hallucination risk from confidence when status is not hallucinating', () => {
    const h = calculateHealth(
      makeAgent({ status: 'active', confidenceScore: 0.5 }),
      [15, 15]
    );
    expect(h.hallucinationRisk).toBe(50);
  });

  it('reports null (no signal) when confidenceScore is undefined', () => {
    const h = calculateHealth(
      makeAgent({ status: 'active', confidenceScore: undefined }),
      [15, 15]
    );
    // AgentStat can't infer hallucinations from telemetry; no made-up default.
    expect(h.hallucinationRisk).toBeNull();
  });

  it('takes the max of explicit hallucination and low confidence', () => {
    const h = calculateHealth(
      makeAgent({ status: 'hallucinating', confidenceScore: 0.99 }),
      [15, 15]
    );
    // explicit=100 beats confidence-risk=1
    expect(h.hallucinationRisk).toBe(100);
  });
});

describe('calculateHealth — latency trend', () => {
  it('needs at least four latency samples', () => {
    expect(calculateHealth(makeAgent(), [15], [], [300, 2500, 2500]).latencyTrend).toBeNull();
  });

  it('is null when no latency was reported', () => {
    expect(calculateHealth(makeAgent(), [15]).latencyTrend).toBeNull();
  });

  it('classifies a >15% rise as degrading', () => {
    expect(calculateHealth(makeAgent(), [15], [], [500, 500, 700, 700]).latencyTrend).toBe('degrading');
  });

  it('classifies a >15% drop as improving', () => {
    expect(calculateHealth(makeAgent(), [15], [], [700, 700, 500, 500]).latencyTrend).toBe('improving');
  });

  it('treats small changes as stable', () => {
    expect(calculateHealth(makeAgent(), [15], [], [500, 520, 510, 530]).latencyTrend).toBe('stable');
  });

  it('judges direction, not level: a constant slow latency is stable', () => {
    expect(calculateHealth(makeAgent(), [15], [], [3000, 3000, 3000, 3000]).latencyTrend).toBe('stable');
  });
});

describe('calculateHealth — output shape', () => {
  it('returns integer values for the percentage fields', () => {
    const h = calculateHealth(makeAgent({ tokensRate: 11.3 }), [11, 12, 13]);
    expect(Number.isInteger(h.score)).toBe(true);
    expect(Number.isInteger(h.tokenEfficiency)).toBe(true);
    expect(Number.isInteger(h.stability)).toBe(true);
    expect(Number.isInteger(h.hallucinationRisk!)).toBe(true);
  });

  it('returns the expected shape', () => {
    const h = calculateHealth(makeAgent(), [15]);
    expect(h).toHaveProperty('score');
    expect(h).toHaveProperty('tokenEfficiency');
    expect(h).toHaveProperty('stability');
    expect(h).toHaveProperty('hallucinationRisk');
    expect(h).toHaveProperty('latencyTrend');
  });
});

describe('calculateHealth — anomaly penalty (real data-derived signals)', () => {
  const steady = [15, 15, 15, 15, 15];

  it('is unchanged when no anomalies are passed (backward compatible)', () => {
    const without = calculateHealth(makeAgent(), steady);
    const withEmpty = calculateHealth(makeAgent(), steady, []);
    expect(withEmpty.score).toBe(without.score);
  });

  it('penalizes the score for a detected anomaly', () => {
    const healthy = calculateHealth(makeAgent(), steady);
    const withStall = calculateHealth(makeAgent(), steady, [
      { kind: 'stall', severity: 'warning', t: 0, message: 'stalled', value: 0 },
    ]);
    expect(withStall.score).toBeLessThan(healthy.score);
  });

  it('penalizes critical anomalies more than warnings', () => {
    const warn = calculateHealth(makeAgent(), steady, [
      { kind: 'stall', severity: 'warning', t: 0, message: 's', value: 0 },
    ]);
    const crit = calculateHealth(makeAgent(), steady, [
      { kind: 'stall', severity: 'critical', t: 0, message: 's', value: 0 },
    ]);
    expect(crit.score).toBeLessThan(warn.score);
  });

  it('stacks multiple anomalies and never goes below 0', () => {
    const h = calculateHealth(makeAgent(), steady, [
      { kind: 'stall', severity: 'critical', t: 0, message: 's', value: 0 },
      { kind: 'thrash', severity: 'critical', t: 0, message: 't', value: 5 },
      { kind: 'spike', severity: 'critical', t: 0, message: 'p', value: 99 },
    ]);
    expect(h.score).toBeGreaterThanOrEqual(0);
    expect(h.score).toBeLessThanOrEqual(100);
  });

  it('weights a stall more heavily than a spike of the same severity', () => {
    const stall = calculateHealth(makeAgent(), steady, [
      { kind: 'stall', severity: 'warning', t: 0, message: 's', value: 0 },
    ]);
    const spike = calculateHealth(makeAgent(), steady, [
      { kind: 'spike', severity: 'warning', t: 0, message: 'p', value: 99 },
    ]);
    expect(stall.score).toBeLessThan(spike.score);
  });
});

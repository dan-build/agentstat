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

describe('calculateHealth — score normalization (FIX B2)', () => {
  const steadyRates = [15, 15, 15, 15, 15];

  it('reaches 100 for a perfectly healthy agent with no latency data', () => {
    const h = calculateHealth(makeAgent(), steadyRates);
    expect(h.score).toBe(100);
  });

  it('reaches 100 for a perfectly healthy agent with improving latency', () => {
    const h = calculateHealth(makeAgent({ latencyMs: 200 }), steadyRates);
    expect(h.score).toBe(100);
    expect(h.latencyTrend).toBe('improving');
  });

  it('reaches 95 for a perfectly healthy agent with stable latency', () => {
    const h = calculateHealth(makeAgent({ latencyMs: 1000 }), steadyRates);
    expect(h.score).toBe(95);
    expect(h.latencyTrend).toBe('stable');
  });

  it('reaches 90 for a perfectly healthy agent with degrading latency', () => {
    const h = calculateHealth(makeAgent({ latencyMs: 3000 }), steadyRates);
    expect(h.score).toBe(90);
    expect(h.latencyTrend).toBe('degrading');
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
    // 35 is 20 above ideal (15); efficiency = 100 - 20*4 = 20
    expect(h.tokenEfficiency).toBe(20);
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

  it('uses a low default risk when confidenceScore is undefined', () => {
    const h = calculateHealth(
      makeAgent({ status: 'active', confidenceScore: undefined }),
      [15, 15]
    );
    // default: confidenceRisk = 0.1 → 10%
    expect(h.hallucinationRisk).toBe(10);
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

describe('calculateHealth — latency trend classification', () => {
  it('classifies <500ms as improving', () => {
    const h = calculateHealth(makeAgent({ latencyMs: 499 }), [15]);
    expect(h.latencyTrend).toBe('improving');
  });

  it('classifies exactly 500ms as stable', () => {
    const h = calculateHealth(makeAgent({ latencyMs: 500 }), [15]);
    expect(h.latencyTrend).toBe('stable');
  });

  it('classifies exactly 2000ms as stable', () => {
    const h = calculateHealth(makeAgent({ latencyMs: 2000 }), [15]);
    expect(h.latencyTrend).toBe('stable');
  });

  it('classifies >2000ms as degrading', () => {
    const h = calculateHealth(makeAgent({ latencyMs: 2001 }), [15]);
    expect(h.latencyTrend).toBe('degrading');
  });

  it('defaults to stable when latencyMs is undefined', () => {
    const h = calculateHealth(makeAgent(), [15]);
    expect(h.latencyTrend).toBe('stable');
  });
});

describe('calculateHealth — output shape', () => {
  it('returns integer values for the percentage fields', () => {
    const h = calculateHealth(makeAgent({ tokensRate: 11.3 }), [11, 12, 13]);
    expect(Number.isInteger(h.score)).toBe(true);
    expect(Number.isInteger(h.tokenEfficiency)).toBe(true);
    expect(Number.isInteger(h.stability)).toBe(true);
    expect(Number.isInteger(h.hallucinationRisk)).toBe(true);
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

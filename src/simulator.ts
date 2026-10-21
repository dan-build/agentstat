// src/simulator.ts
//
// Demo data generator behind `simulateData`. A pure step function plus a
// seedable RNG, so demos can be reproduced exactly (screenshots, docs, tests)
// and the simulator never writes into fields that belong to real telemetry.

import type { Agent, AgentStatus } from './types';

export type Rng = () => number;

/** Small, fast, seedable PRNG (mulberry32). Returns floats in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SIM_TICK_MS = 55;
// ~3 s of simulated anomaly before auto-recovery (55 ms × 55 ticks).
const RECOVERY_TICKS = 55;

export interface SimState {
  /** Ticks spent in the current simulated anomaly. */
  anomalyTicks: number;
  /** Simulated confidence (only used by the demo). */
  confidence: number;
}

export interface SimStep {
  tokensRate: number;
  progress: number;
  status: AgentStatus;
  confidenceScore: number;
  state: SimState;
}

/**
 * Advance one simulated agent by one tick.
 * `locked` = the consumer pinned this agent's status via updateAgent, so the
 * simulator must neither auto-recover it nor roll a new anomaly.
 */
export function simStep(
  agent: Agent,
  prev: SimState,
  locked: boolean,
  rng: Rng
): SimStep {
  const status = agent.current.status;
  const inAnomaly = status === 'stuck' || status === 'hallucinating';

  let nextStatus: AgentStatus = status;
  let anomalyTicks = prev.anomalyTicks;
  if (locked) {
    // Keep the pinned status; rate/progress drift below still runs so locked
    // agents keep their visual signature.
  } else if (!inAnomaly && rng() > 0.96) {
    nextStatus = rng() < 0.5 ? 'stuck' : 'hallucinating';
    anomalyTicks = 0;
  } else if (inAnomaly) {
    anomalyTicks += 1;
    if (anomalyTicks > RECOVERY_TICKS) {
      nextStatus = 'active';
      anomalyTicks = 0;
    }
  }

  const [minTok, maxTok] = agent.config?.expectedTokensPerSec ?? [5, 25];
  const targetTok = (minTok + maxTok) / 2;
  const rate = agent.current.tokensRate;

  let tokensRate: number;
  if (nextStatus === 'stuck') {
    // Stuck: output decays toward zero.
    tokensRate = Math.max(0.5, rate * 0.88);
  } else if (nextStatus === 'hallucinating') {
    // Erratic output.
    tokensRate = Math.max(1, Math.min(maxTok * 1.4, rate + (rng() * 8 - 4)));
  } else if (status !== 'active' && nextStatus === 'active') {
    // Recovering: ramp back toward the expected band.
    tokensRate = Math.min(targetTok, rate + rng() * 2);
  } else {
    // Healthy: mean-reverting walk around the middle of the band.
    const reversion = (targetTok - rate) * 0.12;
    const jitter = rng() * 1.6 - 0.8;
    tokensRate = Math.max(minTok * 0.6, Math.min(maxTok * 1.15, rate + reversion + jitter));
  }

  const progressStep =
    nextStatus === 'stuck' ? 0 : nextStatus === 'hallucinating' ? 0.15 : rng() * 0.9;
  const progress = Math.min(100, agent.current.progress + progressStep);

  const confTarget = nextStatus === 'stuck' || nextStatus === 'hallucinating' ? 0.3 : 0.95;
  const confidence = prev.confidence + (confTarget - prev.confidence) * 0.25;

  return {
    tokensRate,
    progress,
    status: nextStatus,
    confidenceScore: confidence,
    state: { anomalyTicks, confidence },
  };
}

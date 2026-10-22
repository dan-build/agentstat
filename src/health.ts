// src/health.ts
//
// Health scoring. Every component is computed from data the caller actually
// supplied; anything we have no signal for is reported as null and left out of
// the composite, rather than filled with a plausible-looking default.

import type { Anomaly } from './anomaly';
import type { Agent, HealthMetrics } from './types';

const DEFAULT_BAND: [number, number] = [5, 25];

const WEIGHTS = {
  efficiency: 0.35,
  stability: 0.25,
  hallucination: 0.3,
  latency: 0.1,
};

const LATENCY_SCORE = { improving: 100, stable: 50, degrading: 0 } as const;

/** Mean of a non-empty array (0 for empty). */
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

/**
 * Classify the direction of a latency series by comparing the mean of its
 * newer half to its older half. ±15% is treated as noise.
 */
export function latencyTrendOf(
  latencies: number[] | undefined
): HealthMetrics['latencyTrend'] {
  const xs = (latencies ?? []).filter(Number.isFinite);
  if (xs.length < 4) return null;
  const mid = Math.floor(xs.length / 2);
  const older = mean(xs.slice(0, mid));
  const newer = mean(xs.slice(mid));
  const rel = (newer - older) / Math.max(older, 1);
  if (rel > 0.15) return 'degrading';
  if (rel < -0.15) return 'improving';
  return 'stable';
}

/**
 * Compute health for one agent.
 *
 * @param recentRates   token-rate samples from the recent window (oldest first)
 * @param anomalies     currently active anomalies (each applies a penalty)
 * @param recentLatencies  recent `latencyMs` reports (oldest first)
 *
 * Exported for unit testing; not part of the package entry.
 */
export const calculateHealth = (
  agent: Agent,
  recentRates: number[],
  anomalies?: Anomaly[],
  recentLatencies?: number[]
): HealthMetrics => {
  const { current, config } = agent;
  const rates = recentRates.filter(Number.isFinite);

  // ── Rate in band ────────────────────────────────────────────────────────
  // Uses the recent average, not the instantaneous sample, so the number
  // tracks what the line shows instead of flickering every tick.
  const [minTok, maxTok] = config?.expectedTokensPerSec ?? DEFAULT_BAND;
  const repRate = rates.length ? mean(rates) : current.tokensRate;
  // Waiting on a tool, subagents or a person: no output is expected.
  const outside =
    current.status === 'waiting' ? 0 : repRate < minTok ? minTok - repRate : repRate > maxTok ? repRate - maxTok : 0;
  const tokenEfficiency = Number.isFinite(outside)
    ? Math.max(0, 100 - (outside / Math.max(maxTok, 1)) * 100)
    : 0;

  // ── Stability ───────────────────────────────────────────────────────────
  // Mean absolute step relative to the series' own level, so a 1 t/s wobble
  // means the same thing for a 10 t/s agent as 100 t/s wobble does for a
  // 1000 t/s one.
  let stability = 100;
  if (rates.length > 1) {
    let steps = 0;
    for (let i = 1; i < rates.length; i++) steps += Math.abs(rates[i] - rates[i - 1]);
    const meanStep = steps / (rates.length - 1);
    stability = Math.max(0, 100 - (meanStep / Math.max(mean(rates), 1)) * 100);
  }

  // ── Caller-supplied quality signal ─────────────────────────────────────
  let hallucinationRisk: number | null = null;
  if (current.status === 'hallucinating') hallucinationRisk = 100;
  else if (current.confidenceScore !== undefined && Number.isFinite(current.confidenceScore)) {
    const c = Math.max(0, Math.min(1, current.confidenceScore));
    hallucinationRisk = Math.round((1 - c) * 100);
  }

  const latencyTrend = latencyTrendOf(recentLatencies);

  // ── Composite over the components we actually have ─────────────────────
  let weighted = tokenEfficiency * WEIGHTS.efficiency + stability * WEIGHTS.stability;
  let total = WEIGHTS.efficiency + WEIGHTS.stability;
  if (hallucinationRisk !== null) {
    weighted += (100 - hallucinationRisk) * WEIGHTS.hallucination;
    total += WEIGHTS.hallucination;
  }
  if (latencyTrend !== null) {
    weighted += LATENCY_SCORE[latencyTrend] * WEIGHTS.latency;
    total += WEIGHTS.latency;
  }
  const base = Math.round(weighted / total);

  // Penalties from detected anomalies (stall/spike/thrash) — behavior the
  // detector observed, not an estimate.
  let anomalyPenalty = 0;
  for (const a of anomalies ?? []) {
    const sev = a.severity === 'critical' ? 30 : 15;
    const kindWeight = a.kind === 'stall' ? 1.0 : a.kind === 'thrash' ? 0.9 : 0.7;
    anomalyPenalty += sev * kindWeight;
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(base - anomalyPenalty))),
    tokenEfficiency: Math.round(tokenEfficiency),
    stability: Math.round(stability),
    hallucinationRisk,
    latencyTrend,
  };
};

// src/anomaly.ts
//
// Agent anomaly detection. This is the thing a generic charting library can't
// do: it reads the token-rate and status streams AgentStat already buffers and
// flags the moments that actually matter for an agent — stalls, runaway loops,
// and status thrashing — using plain, explainable rolling statistics (no model,
// no "AI", no consumer-supplied magic numbers).
//
// Design principles:
//   - Pure functions over data already in the buffers. No rendering, no React.
//   - Self-calibrating where possible (z-score against the agent's own baseline)
//     so we don't ship brittle absolute thresholds.
//   - Conservative by default: a detector that cries wolf is worse than none.
//   - Every result is explainable — it carries the numbers that triggered it.

import type { AgentStatus } from './AgentStat';

export type AnomalyKind = 'stall' | 'spike' | 'thrash';
export type AnomalySeverity = 'warning' | 'critical';

export interface Anomaly {
  kind: AnomalyKind;
  severity: AnomalySeverity;
  /** Timestamp (performance.now() domain) the anomaly is anchored at. */
  t: number;
  /** Short human-readable explanation, e.g. "stalled 8s while active". */
  message: string;
  /** The measured value that triggered it (rate for stall/spike, count for thrash). */
  value: number;
}

export interface AnomalyConfig {
  /** A rate at/below this (tokens/sec) counts as "idle" for stall detection. */
  stallRateThreshold: number;
  /** Sustained idle time (ms) while status is active before flagging a stall. */
  stallDurationMs: number;
  /** z-score above the rolling mean to flag a spike. */
  spikeZScore: number;
  /** Minimum samples of history before spike detection activates (avoids noise). */
  spikeMinSamples: number;
  /** Status changes within thrashWindowMs to flag thrashing. */
  thrashChangeCount: number;
  thrashWindowMs: number;
}

export const DEFAULT_ANOMALY_CONFIG: AnomalyConfig = {
  stallRateThreshold: 0.5,
  stallDurationMs: 5_000,
  spikeZScore: 3,
  spikeMinSamples: 20,
  thrashChangeCount: 4,
  thrashWindowMs: 4_000,
};

export interface TokenSample {
  t: number;
  v: number;
}

export interface StatusChange {
  t: number;
  status: AgentStatus;
}

/**
 * Mean and (population) standard deviation of a numeric series. Returned
 * together so callers compute both in one pass. Empty → {mean:0, std:0}.
 */
export function meanStd(values: number[]): { mean: number; std: number } {
  const n = values.length;
  if (n === 0) return { mean: 0, std: 0 };
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  const mean = sum / n;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i] - mean;
    sq += d * d;
  }
  return { mean, std: Math.sqrt(sq / n) };
}

/**
 * Detect a STALL: token rate has stayed at/below `stallRateThreshold` for at
 * least `stallDurationMs`, while the agent's current status is 'active' or
 * 'thinking' (i.e. it claims to be working but isn't producing output).
 * Returns the anomaly anchored at the start of the idle stretch, or null.
 */
export function detectStall(
  tokens: TokenSample[],
  currentStatus: AgentStatus,
  now: number,
  cfg: AnomalyConfig
): Anomaly | null {
  // Only meaningful when the agent claims to be doing work.
  if (currentStatus !== 'active' && currentStatus !== 'thinking') return null;
  if (tokens.length === 0) return null;

  // Walk backwards from the latest sample while rate is idle; measure the span.
  let i = tokens.length - 1;
  if (tokens[i].v > cfg.stallRateThreshold) return null; // currently producing
  const endT = tokens[i].t;
  while (i >= 0 && tokens[i].v <= cfg.stallRateThreshold) i--;
  const startT = tokens[i + 1].t;
  const idleMs = endT - startT;
  // Use "now" as the true end so a stall that's ongoing keeps growing.
  const sustainedMs = Math.max(idleMs, now - startT);
  if (sustainedMs < cfg.stallDurationMs) return null;

  const secs = Math.round(sustainedMs / 1000);
  return {
    kind: 'stall',
    severity: sustainedMs >= cfg.stallDurationMs * 2 ? 'critical' : 'warning',
    t: startT,
    message: `stalled ${secs}s while ${currentStatus}`,
    value: 0,
  };
}

/**
 * Detect a SPIKE / runaway: the most recent token rate is more than
 * `spikeZScore` standard deviations above the agent's own rolling mean. Self-
 * calibrating, so it adapts to each agent's normal range. Needs at least
 * `spikeMinSamples` of history to have a stable baseline.
 */
export function detectSpike(
  tokens: TokenSample[],
  cfg: AnomalyConfig
): Anomaly | null {
  const n = tokens.length;
  if (n < cfg.spikeMinSamples) return null;
  const latest = tokens[n - 1];
  // Baseline excludes the latest point so the spike doesn't inflate its own std.
  const baseline = tokens.slice(0, n - 1).map((p) => p.v);
  const { mean, std } = meanStd(baseline);

  // Primary path: z-score against the rolling baseline.
  if (std > 1e-6) {
    const z = (latest.v - mean) / std;
    if (z < cfg.spikeZScore) return null;
    return {
      kind: 'spike',
      severity: z >= cfg.spikeZScore * 1.5 ? 'critical' : 'warning',
      t: latest.t,
      message: `token spike ${latest.v.toFixed(0)}/s (${z.toFixed(1)}σ above ~${mean.toFixed(0)}/s)`,
      value: latest.v,
    };
  }

  // Fallback: a perfectly flat baseline (std≈0) has no z-score, but a large
  // jump away from that flat line is the *clearest* possible spike. Flag it via
  // relative change instead. Require at least a 3× jump (and a meaningful
  // absolute delta) so tiny floating wobbles around a flat line don't trigger.
  const delta = latest.v - mean;
  if (delta > 2 && (mean < 1e-6 ? latest.v > 2 : latest.v >= mean * 3)) {
    const ratio = mean < 1e-6 ? Infinity : latest.v / mean;
    return {
      kind: 'spike',
      severity: mean < 1e-6 || ratio >= 5 ? 'critical' : 'warning',
      t: latest.t,
      message:
        mean < 1e-6
          ? `token spike ${latest.v.toFixed(0)}/s from idle baseline`
          : `token spike ${latest.v.toFixed(0)}/s (${ratio.toFixed(1)}× the ~${mean.toFixed(0)}/s baseline)`,
      value: latest.v,
    };
  }
  return null;
}

/**
 * Detect THRASH: status changed at least `thrashChangeCount` times within the
 * last `thrashWindowMs`. Reads a list of status changes (the StatusLog provides
 * these). Anchored at the first change in the window.
 */
export function detectThrash(
  changes: StatusChange[],
  now: number,
  cfg: AnomalyConfig
): Anomaly | null {
  if (changes.length < cfg.thrashChangeCount) return null;
  const cutoff = now - cfg.thrashWindowMs;
  const recent = changes.filter((c) => c.t >= cutoff);
  if (recent.length < cfg.thrashChangeCount) return null;
  return {
    kind: 'thrash',
    severity: recent.length >= cfg.thrashChangeCount * 1.5 ? 'critical' : 'warning',
    t: recent[0].t,
    message: `status thrashing (${recent.length} changes in ${Math.round(
      cfg.thrashWindowMs / 1000
    )}s)`,
    value: recent.length,
  };
}

/**
 * Run all detectors and return whatever fired. At most one of each kind. Order
 * is stable (stall, spike, thrash) so rendering is deterministic.
 */
export function detectAnomalies(
  tokens: TokenSample[],
  changes: StatusChange[],
  currentStatus: AgentStatus,
  now: number,
  cfg: AnomalyConfig = DEFAULT_ANOMALY_CONFIG
): Anomaly[] {
  const out: Anomaly[] = [];
  const stall = detectStall(tokens, currentStatus, now, cfg);
  if (stall) out.push(stall);
  const spike = detectSpike(tokens, cfg);
  if (spike) out.push(spike);
  const thrash = detectThrash(changes, now, cfg);
  if (thrash) out.push(thrash);
  return out;
}

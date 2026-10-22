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
//   - Self-calibrating: spikes are judged against the agent's own recent highs
//     (the 95th percentile of its recent rate), which a bursty but healthy
//     agent's normal peaks define and a single past spike can't move.
//   - Know what normal looks like: reasoning models think without emitting
//     tokens, agents alternate thinking and acting, and starting to stream
//     after a pause is not a runaway.
//   - Conservative by default: a detector that cries wolf is worse than none.
//   - Every result is explainable — it carries the numbers that triggered it.

import type { AgentStatus } from './types';

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
  /** Idle time (ms) while `active` before flagging a stall. */
  stallDurationMs: number;
  /**
   * Idle time (ms) while `thinking` before flagging a stall. Reasoning models
   * legitimately emit nothing while they think, so this is much longer.
   */
  thinkingStallMs: number;
  /**
   * A spike is the last second's peak reaching this multiple of the agent's
   * recent high (the 95th percentile of its rate over the baseline window).
   * An open spike stays open down to 1.2×.
   */
  spikeRatio: number;
  /** …and exceeding that recent high by at least this many tokens/sec. */
  spikeMinIncrease: number;
  /** Baseline samples required before spike detection activates. */
  spikeMinSamples: number;
  /**
   * Length (ms) of the baseline window preceding the last second. Spikes are
   * detected once the agent's history covers at least a third of it.
   */
  spikeBaselineMs: number;
  /**
   * Below this recent high (tokens/sec) the agent is considered idle and
   * nothing counts as a spike: starting to stream is not a runaway.
   */
  spikeMinBaselineRate: number;
  /** Status changes within thrashWindowMs to flag thrashing. */
  thrashChangeCount: number;
  thrashWindowMs: number;
  /**
   * Normal working states. Flipping between two of them (e.g. an agent
   * alternating thinking and acting) is not thrashing; changes that involve
   * any other status (stuck, hallucinating, …) count.
   */
  thrashBenignStatuses: AgentStatus[];
}

export const DEFAULT_ANOMALY_CONFIG: AnomalyConfig = {
  stallRateThreshold: 0.5,
  stallDurationMs: 5_000,
  thinkingStallMs: 30_000,
  spikeRatio: 1.5,
  spikeMinIncrease: 3,
  spikeMinSamples: 20,
  spikeBaselineMs: 30_000,
  spikeMinBaselineRate: 1,
  thrashChangeCount: 4,
  thrashWindowMs: 4_000,
  thrashBenignStatuses: ['active', 'thinking'],
};

/** The "recent" window whose peak is compared with the baseline. */
const SPIKE_RECENT_MS = 1_000;

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
 * The q-quantile (0–1) of a numeric series, linearly interpolated; 0 for
 * empty. Does not modify the input.
 */
export function quantile(values: number[], q: number): number {
  const n = values.length;
  if (n === 0) return 0;
  const s = Float64Array.from(values).sort();
  const pos = Math.min(1, Math.max(0, q)) * (n - 1);
  const lo = Math.floor(pos);
  return s[lo] + (s[Math.min(n - 1, lo + 1)] - s[lo]) * (pos - lo);
}

/**
 * Detect a STALL: the agent claims to be working but isn't producing output.
 * While `active` that means no output for `stallDurationMs`; while `thinking`,
 * for `thinkingStallMs` (reasoning is allowed to be quiet). Two cases:
 *   - idle: the token rate has stayed at/below `stallRateThreshold`, anchored
 *     at the start of the idle stretch;
 *   - silent: no sample has arrived at all (a dropped stream or a hung tool
 *     call), anchored at the last sample.
 */
export function detectStall(
  tokens: TokenSample[],
  currentStatus: AgentStatus,
  now: number,
  cfg: AnomalyConfig
): Anomaly | null {
  const limit =
    currentStatus === 'active'
      ? cfg.stallDurationMs
      : currentStatus === 'thinking'
        ? cfg.thinkingStallMs
        : 0;
  if (!(limit > 0) || tokens.length === 0) return null;

  let i = tokens.length - 1;
  const last = tokens[i];
  if (last.v > cfg.stallRateThreshold) {
    // Producing as of the last sample — unless the stream has gone quiet.
    const silentMs = now - last.t;
    if (silentMs < limit) return null;
    return {
      kind: 'stall',
      severity: silentMs >= limit * 2 ? 'critical' : 'warning',
      t: last.t,
      message: `no data for ${Math.round(silentMs / 1000)}s while ${currentStatus}`,
      value: 0,
    };
  }

  // Walk backwards from the latest sample while rate is idle; measure the span.
  while (i >= 0 && tokens[i].v <= cfg.stallRateThreshold) i--;
  const startT = tokens[i + 1].t;
  // Use "now" as the true end so a stall that's ongoing keeps growing.
  const sustainedMs = Math.max(last.t - startT, now - startT);
  if (sustainedMs < limit) return null;

  return {
    kind: 'stall',
    severity: sustainedMs >= limit * 2 ? 'critical' : 'warning',
    t: startT,
    message: `stalled ${Math.round(sustainedMs / 1000)}s while ${currentStatus}`,
    value: 0,
  };
}

/**
 * Detect a SPIKE / runaway: the peak rate over the last second clearly
 * exceeds the agent's recent high — the 95th percentile of its rate over the
 * preceding `spikeBaselineMs` — by `spikeRatio` and by `spikeMinIncrease`.
 *
 * Judging against the recent high rather than the average keeps bursty but
 * healthy agents (chunked output alternating fast and slow) quiet: their
 * normal peaks are their recent highs. A single earlier spike doesn't move a
 * 95th percentile. Nothing counts while the recent high is below
 * `spikeMinBaselineRate` (an agent starting to stream after thinking isn't
 * running away), or before the history covers a third of the baseline window.
 * Pass `open` when a spike is already being reported, to keep it open down to
 * 1.2× (hysteresis) instead of flickering.
 */
export function detectSpike(
  tokens: TokenSample[],
  cfg: AnomalyConfig,
  now: number = tokens.length ? tokens[tokens.length - 1].t : 0,
  open = false
): Anomaly | null {
  const recentFrom = now - SPIKE_RECENT_MS;
  const baselineFrom = recentFrom - cfg.spikeBaselineMs;
  const baseline: number[] = [];
  let firstBaselineT = Infinity;
  let peak: TokenSample | null = null;
  for (const s of tokens) {
    if (s.t >= recentFrom) {
      if (s.t <= now && (!peak || s.v > peak.v)) peak = s;
    } else if (s.t >= baselineFrom) {
      baseline.push(s.v);
      if (s.t < firstBaselineT) firstBaselineT = s.t;
    }
  }
  // Warm-up: enough samples, covering at least a third of the window, so a
  // start-up ramp isn't mistaken for the agent's norm.
  if (!peak || baseline.length < cfg.spikeMinSamples) return null;
  if (recentFrom - firstBaselineT < cfg.spikeBaselineMs / 3) return null;

  const high = quantile(baseline, 0.95);
  if (high < cfg.spikeMinBaselineRate) return null;
  const ratio = peak.v / high;
  const minRatio = open ? Math.min(1.2, cfg.spikeRatio) : cfg.spikeRatio;
  if (ratio < minRatio || peak.v - high < (open ? 0 : cfg.spikeMinIncrease)) return null;

  return {
    kind: 'spike',
    severity: ratio >= 3 ? 'critical' : 'warning',
    t: peak.t,
    message: `token spike ${peak.v.toFixed(0)}/s (${ratio.toFixed(1)}× recent high ~${high.toFixed(0)}/s)`,
    value: peak.v,
  };
}

/**
 * Detect THRASH: at least `thrashChangeCount` status changes within the last
 * `thrashWindowMs`, not counting changes between two normal working states
 * (`thrashBenignStatuses`). `changes` is the status log for the window; an
 * entry at or before the window start only provides the starting status.
 */
export function detectThrash(
  changes: StatusChange[],
  now: number,
  cfg: AnomalyConfig
): Anomaly | null {
  const cutoff = now - cfg.thrashWindowMs;
  const benign = new Set(cfg.thrashBenignStatuses);
  let count = 0;
  let firstT = 0;
  let prev: AgentStatus | null = null;
  for (const c of changes) {
    if (prev !== null && c.t > cutoff && c.status !== prev && !(benign.has(prev) && benign.has(c.status))) {
      if (count === 0) firstT = c.t;
      count++;
    }
    prev = c.status;
  }
  if (count < cfg.thrashChangeCount) return null;
  return {
    kind: 'thrash',
    severity: count >= cfg.thrashChangeCount * 1.5 ? 'critical' : 'warning',
    t: firstT,
    message: `status thrashing (${count} changes in ${Math.round(cfg.thrashWindowMs / 1000)}s)`,
    value: count,
  };
}

/**
 * Run all detectors and return whatever fired. At most one of each kind, in a
 * stable order (stall, spike, thrash). `open` lists kinds currently being
 * reported, so detectors with hysteresis keep them open on weaker evidence.
 */
export function detectAnomalies(
  tokens: TokenSample[],
  changes: StatusChange[],
  currentStatus: AgentStatus,
  now: number,
  cfg: AnomalyConfig = DEFAULT_ANOMALY_CONFIG,
  open?: ReadonlySet<AnomalyKind>
): Anomaly[] {
  const out: Anomaly[] = [];
  const stall = detectStall(tokens, currentStatus, now, cfg);
  if (stall) out.push(stall);
  const spike = detectSpike(tokens, cfg, now, open?.has('spike') ?? false);
  if (spike) out.push(spike);
  const thrash = detectThrash(changes, now, cfg);
  if (thrash) out.push(thrash);
  return out;
}

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
//   - Self-calibrating: spikes are judged against the agent's own usual peak
//     (the 95th percentile of its active rate), which a bursty but healthy
//     agent's normal bursts define and a single past spike can't move; stalls
//     against its usual active rate.
//   - Know what normal looks like: reasoning models think without emitting
//     tokens, tool calls pause output, agents alternate thinking and acting,
//     and starting to stream after a pause is not a runaway.
//   - Evaluated, not just tested: scripts/eval-detectors.mjs scores the
//     detectors on labelled scenarios, including an adversarial set written
//     to find their blind spots.
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
  /** For spikes: the usual level `value` was compared with (tokens/sec). */
  baseline?: number;
}

/** What detectors with memory need to know about an episode in progress. */
export interface OpenEpisode {
  /** When the episode opened (same clock as samples). */
  since: number;
  /** The baseline it opened against (spikes keep comparing with it). */
  baseline?: number;
}

export interface AnomalyConfig {
  /** A rate at/below this (tokens/sec) always counts as idle. */
  stallRateThreshold: number;
  /** Idle time (ms) while `active` before flagging a stall. */
  stallDurationMs: number;
  /**
   * Idle time (ms) while `thinking` before flagging a stall. Reasoning models
   * legitimately emit nothing while they think, so this is much longer.
   */
  thinkingStallMs: number;
  /**
   * A spike is output reaching this multiple of the agent's usual peak (the
   * 95th percentile of its active rate over the baseline window), averaged
   * over the last second. An open spike stays open down to 1.2×.
   */
  spikeRatio: number;
  /** …and exceeding that usual peak by at least this many tokens/sec. */
  spikeMinIncrease: number;
  /** Active baseline samples required before spike detection starts. */
  spikeMinSamples: number;
  /** Length (ms) of the baseline window the usual peak is taken from. */
  spikeBaselineMs: number;
  /**
   * Below this usual peak (tokens/sec) the agent is considered idle and
   * nothing counts as a spike: starting to stream is not a runaway.
   */
  spikeMinBaselineRate: number;
  /**
   * After this long (ms) an ongoing spike is accepted as the agent's new
   * level: the alert resolves and the baseline moves on.
   */
  spikeMaxEpisodeMs: number;
  /** Status changes within thrashWindowMs to flag thrashing. */
  thrashChangeCount: number;
  thrashWindowMs: number;
  /**
   * Normal working states. Moving between two of them (thinking ↔ acting,
   * finishing a job and starting the next) is not thrashing; changes that
   * involve any other status (stuck, hallucinating, …) count.
   */
  thrashBenignStatuses: AgentStatus[];
}

export const DEFAULT_ANOMALY_CONFIG: AnomalyConfig = {
  stallRateThreshold: 0.5,
  stallDurationMs: 10_000,
  thinkingStallMs: 30_000,
  spikeRatio: 1.5,
  spikeMinIncrease: 3,
  spikeMinSamples: 10,
  spikeBaselineMs: 30_000,
  spikeMinBaselineRate: 1,
  spikeMaxEpisodeMs: 120_000,
  thrashChangeCount: 4,
  thrashWindowMs: 4_000,
  thrashBenignStatuses: ['active', 'thinking', 'complete'],
};

/** Minimum length of the "recent" window whose output is compared. */
const RECENT_MS = 1_000;
/** Minimum span the active baseline must cover before spikes are judged. */
const WARMUP_MS = 3_000;
/** A single sample this far above the usual peak is a burst on its own. */
const BURST_RATIO = 4;
/** Idle means below this share of the agent's usual active rate. */
const IDLE_SHARE = 0.05;
/** Drift: the last 5 s compared with the 10 s that ended 25 s ago… */
const DRIFT_RECENT_MS = 5_000;
const DRIFT_AGO_MS = 25_000;
const DRIFT_RATIO = 2;
/** …rising by at least this factor at each step (older → middle → recent). */
const DRIFT_STEP = 1.3;

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

/** Median gap between the last few samples (ms), or 0 with too few. */
function typicalGap(tokens: TokenSample[]): number {
  const gaps: number[] = [];
  for (let i = Math.max(1, tokens.length - 20); i < tokens.length; i++) {
    const g = tokens[i].t - tokens[i - 1].t;
    if (g > 0) gaps.push(g);
  }
  return quantile(gaps, 0.5);
}

/**
 * Rates at or below this count as idle: the absolute `stallRateThreshold`, or
 * 5% of the agent's recent high, whichever is larger — so a trickle from a
 * normally fast agent is idle, not "low but active".
 */
function activeCutoff(tokens: TokenSample[], cfg: AnomalyConfig): number {
  return Math.max(cfg.stallRateThreshold, IDLE_SHARE * quantile(tokens.map((s) => s.v), 0.95));
}

/**
 * Detect a STALL: the agent claims to be working but isn't producing output.
 * While `active` that means no real output for `stallDurationMs`; while
 * `thinking`, for `thinkingStallMs` (reasoning is allowed to be quiet).
 *
 * "No real output" is judged relative to the agent: an average rate at or
 * below 5% of its recent high (and at least `stallRateThreshold`), so a
 * trickle or an occasional heartbeat can't hide a stall. If no
 * sample arrives at all (a dropped stream, a hung tool call), that's a stall
 * too, anchored at the last sample.
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
  const severity = (ms: number): AnomalySeverity => (ms >= limit * 2 ? 'critical' : 'warning');

  const last = tokens[tokens.length - 1];
  const silentMs = now - last.t;
  if (silentMs >= limit) {
    return {
      kind: 'stall',
      severity: severity(silentMs),
      t: last.t,
      message: `no data for ${Math.round(silentMs / 1000)}s while ${currentStatus}`,
      value: 0,
    };
  }

  const idleLevel = activeCutoff(tokens, cfg);

  // Walk back from now while the running average stays idle; the stall began
  // at the earliest such sample.
  let sum = 0;
  let n = 0;
  let startT = Infinity;
  for (let i = tokens.length - 1; i >= 0; i--) {
    sum += tokens[i].v;
    n++;
    if (sum / n <= idleLevel) startT = tokens[i].t;
    else if (tokens[i].v > idleLevel * 4) break; // real output: the stall can't start earlier
  }
  if (!Number.isFinite(startT)) return null;
  const sustainedMs = now - startT;
  if (sustainedMs < limit) return null;
  return {
    kind: 'stall',
    severity: severity(sustainedMs),
    t: startT,
    message: `stalled ${Math.round(sustainedMs / 1000)}s while ${currentStatus}`,
    value: 0,
  };
}

/**
 * Detect a SPIKE / runaway: output clearly above the agent's usual peak — the
 * 95th percentile of its active (non-idle) rate over the preceding
 * `spikeBaselineMs`. Three ways in:
 *   - sustained: the last second's average ≥ `spikeRatio` × usual peak;
 *   - burst: a single sample ≥ 4× the usual peak;
 *   - drift: the last 5 s average ≥ 2× the agent's typical rate 25–35 s ago,
 *     for a runaway that climbs too gradually to jump.
 * Each also needs to exceed the usual peak by `spikeMinIncrease`.
 *
 * Judging against the usual *peak* keeps bursty but healthy agents quiet, and
 * using only active samples means resuming after a pause (of any length) is
 * never a spike. Nothing is judged until the active baseline holds
 * `spikeMinSamples` samples over at least 3 s, so a start-up ramp isn't
 * mistaken for the norm.
 *
 * Pass `episode` while a spike is being reported: the baseline it opened
 * against (returned as `baseline`) is reused, so a sustained runaway can't
 * become its own normal, and the episode stays open while output is at least
 * 1.2× that baseline — for up to `spikeMaxEpisodeMs`, after which the new
 * level is accepted.
 */
export function detectSpike(
  tokens: TokenSample[],
  cfg: AnomalyConfig,
  now: number = tokens.length ? tokens[tokens.length - 1].t : 0,
  episode?: OpenEpisode
): Anomaly | null {
  if (tokens.length === 0) return null;
  if (episode && now - episode.since >= cfg.spikeMaxEpisodeMs) return null;

  // Sparse telemetry: the recent window always spans a few samples.
  const recentMs = Math.max(RECENT_MS, 2.5 * typicalGap(tokens));
  const idleCutoff = activeCutoff(tokens, cfg);
  let peakNorm: number;
  if (episode?.baseline !== undefined) {
    // An open episode keeps the baseline it opened against, so a sustained
    // runaway can't become its own normal.
    peakNorm = episode.baseline;
  } else {
    const baseEnd = now - recentMs;
    const baseStart = baseEnd - cfg.spikeBaselineMs;
    const baseline: number[] = [];
    let total = 0;
    let firstT = Infinity;
    let lastT = -Infinity;
    for (const s of tokens) {
      if (s.t < baseStart || s.t >= baseEnd) continue;
      total++;
      if (s.v > idleCutoff) {
        baseline.push(s.v);
        if (s.t < firstT) firstT = s.t;
        lastT = s.t;
      }
    }
    // Warm-up, and a mostly idle baseline (resuming after a pause) isn't a norm.
    if (baseline.length < cfg.spikeMinSamples || lastT - firstT < WARMUP_MS) return null;
    if (baseline.length < total / 2) return null;
    peakNorm = quantile(baseline, 0.95);
  }
  if (peakNorm < cfg.spikeMinBaselineRate) return null;
  const open = episode !== undefined;

  let recentSum = 0;
  let recentN = 0;
  let top: TokenSample | null = null;
  for (const s of tokens) {
    if (s.t < now - recentMs || s.t > now) continue;
    recentSum += s.v;
    recentN++;
    if (!top || s.v > top.v) top = s;
  }
  if (!top) return null;
  const recentMean = recentSum / recentN;
  const fmt = (v: number) => v.toFixed(v < 10 ? 1 : 0);

  if (open) {
    if (recentMean < 1.2 * peakNorm) return null;
    const ratio = recentMean / peakNorm;
    return {
      kind: 'spike',
      severity: ratio >= 3 ? 'critical' : 'warning',
      t: top.t,
      message: `runaway output ${fmt(recentMean)}/s (${ratio.toFixed(1)}× the usual peak of ~${fmt(peakNorm)}/s)`,
      value: recentMean,
      baseline: peakNorm,
    };
  }

  const sustained = recentMean >= cfg.spikeRatio * peakNorm && recentMean - peakNorm >= cfg.spikeMinIncrease;
  const burst = top.v >= BURST_RATIO * peakNorm && top.v - peakNorm >= cfg.spikeMinIncrease;
  if (sustained || burst) {
    // A lone sample far above the rest is a burst; a raised level is a runaway.
    const isBurst = burst && (!sustained || top.v > 2 * recentMean);
    const v = isBurst ? top.v : recentMean;
    const ratio = v / peakNorm;
    return {
      kind: 'spike',
      severity: ratio >= 3 ? 'critical' : 'warning',
      t: top.t,
      message: !isBurst
        ? `runaway output ${fmt(v)}/s (${ratio.toFixed(1)}× the usual peak of ~${fmt(peakNorm)}/s)`
        : `token burst ${fmt(v)}/s (${ratio.toFixed(1)}× the usual peak of ~${fmt(peakNorm)}/s)`,
      value: v,
      baseline: peakNorm,
    };
  }

  // Drift: a climb that keeps going — the last 5 s against 10 s windows that
  // ended 10 s and 25 s ago. A ramp that rises once and levels off (start-up)
  // fails the middle step; averages keep bursty output comparable.
  // Speed while producing: idle samples (pauses, finished turns) are left out,
  // so how much of a window was idle doesn't read as a change in rate.
  const activeMean = (from: number, to: number, minSamples: number) => {
    let sum = 0;
    let n = 0;
    for (const s of tokens) {
      if (s.t < from || s.t >= to || s.v <= idleCutoff) continue;
      sum += s.v;
      n++;
    }
    return n >= minSamples ? sum / n : NaN;
  };
  const before = activeMean(now - DRIFT_AGO_MS - 10_000, now - DRIFT_AGO_MS, cfg.spikeMinSamples / 2);
  const middle = activeMean(now - 20_000, now - 10_000, cfg.spikeMinSamples / 2);
  const recent5 = activeMean(now - DRIFT_RECENT_MS, now + 1, 2);
  if (
    before >= cfg.spikeMinBaselineRate &&
    middle >= DRIFT_STEP * before &&
    recent5 >= DRIFT_STEP * middle &&
    recent5 >= DRIFT_RATIO * before &&
    recent5 - before >= cfg.spikeMinIncrease
  ) {
    const ratio = recent5 / before;
    return {
      kind: 'spike',
      severity: ratio >= 3 ? 'critical' : 'warning',
      t: top.t,
      message: `output climbing: ${fmt(recent5)}/s, ${ratio.toFixed(1)}× its rate 30s ago`,
      value: recent5,
      // Later ticks compare with the level the climb started from.
      baseline: before,
    };
  }
  return null;
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
  const involved = new Set<AgentStatus>();
  let count = 0;
  let firstT = 0;
  let prev: AgentStatus | null = null;
  for (const c of changes) {
    if (prev !== null && c.t > cutoff && c.status !== prev && !(benign.has(prev) && benign.has(c.status))) {
      if (count === 0) firstT = c.t;
      count++;
      involved.add(prev);
      involved.add(c.status);
    }
    prev = c.status;
  }
  if (count < cfg.thrashChangeCount) return null;
  return {
    kind: 'thrash',
    severity: count >= cfg.thrashChangeCount * 1.5 ? 'critical' : 'warning',
    t: firstT,
    message: `status flapping ${[...involved].join('↔')} (${count} changes in ${Math.round(cfg.thrashWindowMs / 1000)}s)`,
    value: count,
  };
}

/**
 * Run all detectors and return whatever fired. At most one of each kind, in a
 * stable order (stall, spike, thrash). `open` describes episodes currently
 * being reported, so detectors with memory (spike) keep their baseline and
 * apply hysteresis.
 */
export function detectAnomalies(
  tokens: TokenSample[],
  changes: StatusChange[],
  currentStatus: AgentStatus,
  now: number,
  cfg: AnomalyConfig = DEFAULT_ANOMALY_CONFIG,
  open?: ReadonlyMap<AnomalyKind, OpenEpisode>
): Anomaly[] {
  const out: Anomaly[] = [];
  const stall = detectStall(tokens, currentStatus, now, cfg);
  if (stall) out.push(stall);
  const spike = detectSpike(tokens, cfg, now, open?.get('spike'));
  if (spike) out.push(spike);
  const thrash = detectThrash(changes, now, cfg);
  if (thrash) out.push(thrash);
  return out;
}

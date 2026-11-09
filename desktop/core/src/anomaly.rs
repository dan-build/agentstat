//! Anomaly detection (mirrors `src/anomaly.ts`): stalls, runaway output and
//! status thrashing, from plain, explainable rolling statistics. Every result
//! carries the numbers that triggered it.

use serde::{Deserialize, Serialize};

use crate::num::{js_int, quantile, to_fixed};
use crate::series::Point;
use crate::statuslog::Transition;
use crate::types::Status;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnomalyKind {
    Stall,
    Spike,
    Thrash,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Warning,
    Critical,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Anomaly {
    pub kind: AnomalyKind,
    pub severity: Severity,
    /// When the anomaly is anchored (the store's clock).
    pub t: f64,
    /// Short explanation, e.g. "stalled 8s while active".
    pub message: String,
    /// The measured value (rate for stall/spike, change count for thrash).
    pub value: f64,
    /// For spikes: the usual level `value` was compared with (tokens/s).
    pub baseline: Option<f64>,
}

/// What the detectors know about an agent beyond its recent samples.
#[derive(Clone, Debug, Default)]
pub struct AgentContext {
    /// Slow reference of the agent's normal active rate, once it reflects real activity.
    pub reference_rate: Option<f64>,
    /// A stall is being reported for this agent.
    pub stall_open: bool,
    /// Whether the caller has ever reported a status (rate-only feeds haven't).
    pub status_reported: Option<bool>,
    /// When the current status began.
    pub status_since: Option<f64>,
    /// When the agent last left `waiting` or `complete`.
    pub work_since: Option<f64>,
    /// What a waiting agent waits on (e.g. a tool name).
    pub waiting_on: Option<String>,
}

/// An episode being reported, for detectors with memory.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OpenEpisode {
    pub since: f64,
    pub baseline: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AnomalyConfig {
    /// A rate at/below this (tokens/s) always counts as idle.
    pub stall_rate_threshold: f64,
    /// Idle time (ms) while active before a stall.
    pub stall_duration_ms: f64,
    /// Idle time (ms) while thinking before a stall.
    pub thinking_stall_ms: f64,
    /// Time (ms) in waiting before a stall; 0 = never.
    pub waiting_stall_ms: f64,
    /// Multiple of the usual peak that counts as a spike.
    pub spike_ratio: f64,
    /// …and at least this many tokens/s above it.
    pub spike_min_increase: f64,
    /// Active baseline samples needed before spikes are judged.
    pub spike_min_samples: f64,
    /// Window (ms) the usual peak is taken from.
    pub spike_baseline_ms: f64,
    /// Below this usual peak nothing counts as a spike.
    pub spike_min_baseline_rate: f64,
    /// After this long (ms) an ongoing spike is the new level.
    pub spike_max_episode_ms: f64,
    /// Status changes within `thrash_window_ms` that count as thrashing.
    pub thrash_change_count: f64,
    pub thrash_window_ms: f64,
    /// Moving between two of these is not thrashing.
    pub thrash_benign_statuses: Vec<Status>,
}

impl Default for AnomalyConfig {
    fn default() -> Self {
        AnomalyConfig {
            stall_rate_threshold: 0.5,
            stall_duration_ms: 10_000.0,
            thinking_stall_ms: 30_000.0,
            waiting_stall_ms: 300_000.0,
            spike_ratio: 1.5,
            spike_min_increase: 3.0,
            spike_min_samples: 10.0,
            spike_baseline_ms: 30_000.0,
            spike_min_baseline_rate: 1.0,
            spike_max_episode_ms: 600_000.0,
            thrash_change_count: 4.0,
            thrash_window_ms: 4_000.0,
            thrash_benign_statuses: vec![Status::Active, Status::Thinking, Status::Waiting, Status::Complete],
        }
    }
}

/// Minimum length of the "recent" window whose output is compared.
const RECENT_MS: f64 = 1_000.0;
/// After a pause, output must stay high for this many consecutive seconds.
const AFTER_IDLE_SECONDS: usize = 3;
/// Minimum span the active baseline must cover before spikes are judged.
const WARMUP_MS: f64 = 3_000.0;
/// A single sample this far above the usual peak is a burst on its own.
const BURST_RATIO: f64 = 4.0;
/// Idle means below this share of the agent's usual active rate.
const IDLE_SHARE: f64 = 0.05;
/// Drift: the last 5 s against the 10 s that ended 25 s ago…
const DRIFT_RECENT_MS: f64 = 5_000.0;
const DRIFT_AGO_MS: f64 = 25_000.0;
const DRIFT_RATIO: f64 = 2.0;
/// …rising by at least this factor at each step.
const DRIFT_STEP: f64 = 1.3;

/// False for NaN as well as for ≤ 0 (a missing limit disables its rule).
fn positive(x: f64) -> bool {
    x > 0.0
}

fn severity_for(ratio: f64) -> Severity {
    if ratio >= 3.0 { Severity::Critical } else { Severity::Warning }
}

/// Rates like the TypeScript `fmt`: one decimal below 10, none above.
fn fmt_rate(v: f64) -> String {
    to_fixed(v, if v < 10.0 { 1 } else { 0 })
}

/// Median gap between the last few samples (ms), or 0 with too few.
fn typical_gap(tokens: &[Point]) -> f64 {
    let gaps: Vec<f64> = (tokens.len().saturating_sub(20).max(1)..tokens.len())
        .map(|i| tokens[i].t - tokens[i - 1].t)
        .filter(|g| *g > 0.0)
        .collect();
    quantile(&gaps, 0.5)
}

/// Rates at or below this count as idle: 5% of the agent's normal high, never
/// less than `stall_rate_threshold` unless its own typical output is that low.
fn active_cutoff(tokens: &[Point], cfg: &AnomalyConfig, ctx: &AgentContext) -> f64 {
    let values: Vec<f64> = tokens.iter().map(|s| s.v).collect();
    let positive: Vec<f64> = values.iter().copied().filter(|v| *v > 0.0).collect();
    let floor = if positive.is_empty() {
        cfg.stall_rate_threshold
    } else {
        cfg.stall_rate_threshold.min(0.5 * quantile(&positive, 0.5))
    };
    let high = quantile(&values, 0.95).max(ctx.reference_rate.unwrap_or(0.0));
    floor.max(IDLE_SHARE * high)
}

/// A STALL: working but producing no output for longer than the status allows.
pub fn detect_stall(
    tokens: &[Point],
    status: Status,
    now: f64,
    cfg: &AnomalyConfig,
    ctx: &AgentContext,
) -> Option<Anomaly> {
    if status == Status::Waiting {
        let ms = ctx.status_since.map_or(0.0, |s| now - s);
        if !positive(cfg.waiting_stall_ms) || ms < cfg.waiting_stall_ms {
            return None;
        }
        let on = ctx.waiting_on.as_deref().filter(|s| !s.is_empty()).map(|s| format!(" on {s}")).unwrap_or_default();
        return Some(Anomaly {
            kind: AnomalyKind::Stall,
            severity: if ms >= cfg.waiting_stall_ms * 2.0 { Severity::Critical } else { Severity::Warning },
            t: ctx.status_since.unwrap_or(f64::NAN),
            message: format!("waiting{on} for {}s", js_int(ms / 1000.0)),
            value: 0.0,
            baseline: None,
        });
    }
    let limit = match status {
        Status::Active => cfg.stall_duration_ms,
        Status::Thinking => cfg.thinking_stall_ms,
        _ => 0.0,
    };
    if !positive(limit) || tokens.is_empty() {
        return None;
    }
    let severity = |ms: f64| if ms >= limit * 2.0 { Severity::Critical } else { Severity::Warning };

    let work_since = ctx.work_since.unwrap_or(f64::NEG_INFINITY);
    let last = tokens[tokens.len() - 1];
    let silent_from = last.t.max(work_since);
    let silent_ms = now - silent_from;
    if silent_ms >= limit {
        return Some(Anomaly {
            kind: AnomalyKind::Stall,
            severity: severity(silent_ms),
            t: silent_from,
            message: format!("no data for {}s while {}", js_int(silent_ms / 1000.0), status.as_str()),
            value: 0.0,
            baseline: None,
        });
    }

    // Rate-only integrations: quiet output alone isn't evidence of a stall.
    if ctx.status_reported == Some(false) {
        return None;
    }
    let idle = active_cutoff(tokens, cfg, ctx);

    // Walk back while the running average stays idle.
    let mut sum = 0.0;
    let mut n = 0.0;
    let mut start = f64::INFINITY;
    for s in tokens.iter().rev() {
        sum += s.v;
        n += 1.0;
        if sum / n <= idle {
            start = s.t;
        } else if s.v > idle * 4.0 {
            break;
        }
    }
    if !start.is_finite() {
        return None;
    }
    let start = start.max(work_since);
    let sustained = now - start;
    if sustained < limit {
        return None;
    }
    Some(Anomaly {
        kind: AnomalyKind::Stall,
        severity: severity(sustained),
        t: start,
        message: format!("stalled {}s while {}", js_int(sustained / 1000.0), status.as_str()),
        value: 0.0,
        baseline: None,
    })
}

/// Spike check after a stall or long pause: each of the last 3 seconds must be
/// well above the agent's slow normal rate.
fn after_idle_spike(tokens: &[Point], cfg: &AnomalyConfig, now: f64, ctx: &AgentContext) -> Option<Anomaly> {
    let r = ctx.reference_rate.unwrap_or(0.0);
    if r < cfg.spike_min_baseline_rate {
        return None;
    }
    let mut total = 0.0;
    let mut count = 0.0;
    for k in 0..AFTER_IDLE_SECONDS {
        let (hi, lo) = (now - k as f64 * 1000.0, now - (k as f64 + 1.0) * 1000.0);
        let mut sum = 0.0;
        let mut n = 0.0;
        for s in tokens {
            if s.t > lo && s.t <= hi {
                sum += s.v;
                n += 1.0;
            }
        }
        if n == 0.0 || sum / n < cfg.spike_ratio * r || sum / n - r < cfg.spike_min_increase {
            return None;
        }
        total += sum;
        count += n;
    }
    let v = total / count;
    let ratio = v / r;
    Some(Anomaly {
        kind: AnomalyKind::Spike,
        severity: severity_for(ratio),
        t: now,
        message: format!(
            "runaway output {}/s ({}× the agent's normal ~{}/s)",
            fmt_rate(v),
            to_fixed(ratio, 1),
            fmt_rate(r)
        ),
        value: v,
        baseline: Some(r),
    })
}

/// A SPIKE / runaway: output clearly above the agent's usual peak (sustained,
/// a single burst, or a gradual drift). An open `episode` keeps the baseline it
/// opened against and stays open down to 1.2× it.
pub fn detect_spike(
    tokens: &[Point],
    cfg: &AnomalyConfig,
    now: f64,
    episode: Option<OpenEpisode>,
    ctx: &AgentContext,
) -> Option<Anomaly> {
    if tokens.is_empty() {
        return None;
    }
    if episode.is_some_and(|e| now - e.since >= cfg.spike_max_episode_ms) {
        return None;
    }

    let recent_ms = RECENT_MS.max(2.5 * typical_gap(tokens));
    let idle_cutoff = active_cutoff(tokens, cfg, ctx);
    let peak = match episode.and_then(|e| e.baseline) {
        Some(b) => b,
        None => {
            let base_end = now - recent_ms;
            let base_start = base_end - cfg.spike_baseline_ms;
            let mut baseline = Vec::new();
            let mut total = 0.0;
            let mut first_t = f64::INFINITY;
            let mut last_t = f64::NEG_INFINITY;
            for s in tokens {
                if s.t < base_start || s.t >= base_end {
                    continue;
                }
                total += 1.0;
                if s.v > idle_cutoff {
                    baseline.push(s.v);
                    if s.t < first_t {
                        first_t = s.t;
                    }
                    last_t = s.t;
                }
            }
            let usable = baseline.len() as f64 >= cfg.spike_min_samples
                && last_t - first_t >= WARMUP_MS
                && baseline.len() as f64 >= total / 2.0;
            if !usable || ctx.stall_open {
                if episode.is_some() {
                    return None;
                }
                return after_idle_spike(tokens, cfg, now, ctx);
            }
            quantile(&baseline, 0.95)
        }
    };
    if peak < cfg.spike_min_baseline_rate {
        return None;
    }

    let mut recent_sum = 0.0;
    let mut recent_n = 0.0;
    let mut top: Option<Point> = None;
    for s in tokens {
        if s.t < now - recent_ms || s.t > now {
            continue;
        }
        recent_sum += s.v;
        recent_n += 1.0;
        if top.is_none_or(|t| s.v > t.v) {
            top = Some(*s);
        }
    }
    let top = top?;
    let recent_mean = recent_sum / recent_n;

    if episode.is_some() {
        if recent_mean < 1.2 * peak {
            return None;
        }
        let ratio = recent_mean / peak;
        return Some(Anomaly {
            kind: AnomalyKind::Spike,
            severity: severity_for(ratio),
            t: top.t,
            message: format!(
                "runaway output {}/s ({}× the usual peak of ~{}/s)",
                fmt_rate(recent_mean),
                to_fixed(ratio, 1),
                fmt_rate(peak)
            ),
            value: recent_mean,
            baseline: Some(peak),
        });
    }

    let sustained = recent_mean >= cfg.spike_ratio * peak && recent_mean - peak >= cfg.spike_min_increase;
    let burst = top.v >= BURST_RATIO * peak && top.v - peak >= cfg.spike_min_increase;
    if sustained || burst {
        let is_burst = (burst && (!sustained || top.v > 2.0 * recent_mean)) || recent_n == 1.0;
        let v = if is_burst { top.v } else { recent_mean };
        let ratio = v / peak;
        let what = if is_burst { "token burst" } else { "runaway output" };
        return Some(Anomaly {
            kind: AnomalyKind::Spike,
            severity: severity_for(ratio),
            t: top.t,
            message: format!(
                "{what} {}/s ({}× the usual peak of ~{}/s)",
                fmt_rate(v),
                to_fixed(ratio, 1),
                fmt_rate(peak)
            ),
            value: v,
            baseline: Some(peak),
        });
    }

    // Drift: a climb that keeps going, judged on speed while producing.
    let active_mean = |from: f64, to: f64, min_samples: f64| {
        let mut sum = 0.0;
        let mut n = 0.0;
        for s in tokens {
            if s.t < from || s.t >= to || s.v <= idle_cutoff {
                continue;
            }
            sum += s.v;
            n += 1.0;
        }
        if n >= min_samples { sum / n } else { f64::NAN }
    };
    let before = active_mean(now - DRIFT_AGO_MS - 10_000.0, now - DRIFT_AGO_MS, cfg.spike_min_samples / 2.0);
    let middle = active_mean(now - 20_000.0, now - 10_000.0, cfg.spike_min_samples / 2.0);
    let recent5 = active_mean(now - DRIFT_RECENT_MS, now + 1.0, 2.0);
    if before >= cfg.spike_min_baseline_rate
        && middle >= DRIFT_STEP * before
        && recent5 >= DRIFT_STEP * middle
        && recent5 >= DRIFT_RATIO * before
        && recent5 - before >= cfg.spike_min_increase
    {
        let ratio = recent5 / before;
        return Some(Anomaly {
            kind: AnomalyKind::Spike,
            severity: severity_for(ratio),
            t: top.t,
            message: format!("output climbing: {}/s, {}× its rate 30s ago", fmt_rate(recent5), to_fixed(ratio, 1)),
            value: recent5,
            baseline: Some(before),
        });
    }
    None
}

/// THRASH: many status changes in a short window, not counting changes between
/// two normal working states.
pub fn detect_thrash(changes: &[Transition], now: f64, cfg: &AnomalyConfig) -> Option<Anomaly> {
    let cutoff = now - cfg.thrash_window_ms;
    let benign = |s: Status| cfg.thrash_benign_statuses.contains(&s);
    let mut involved: Vec<Status> = Vec::new();
    let add = |s: Status, involved: &mut Vec<Status>| {
        if !involved.contains(&s) {
            involved.push(s);
        }
    };
    let mut count = 0.0;
    let mut first_t = 0.0;
    let mut prev: Option<Status> = None;
    for c in changes {
        if let Some(p) = prev
            && c.t > cutoff
            && c.status != p
            && !(benign(p) && benign(c.status))
        {
            if count == 0.0 {
                first_t = c.t;
            }
            count += 1.0;
            add(p, &mut involved);
            add(c.status, &mut involved);
        }
        prev = Some(c.status);
    }
    if count < cfg.thrash_change_count {
        return None;
    }
    let names: Vec<&str> = involved.iter().map(|s| s.as_str()).collect();
    Some(Anomaly {
        kind: AnomalyKind::Thrash,
        severity: if count >= cfg.thrash_change_count * 1.5 { Severity::Critical } else { Severity::Warning },
        t: first_t,
        message: format!(
            "status flapping {} ({} changes in {}s)",
            names.join("↔"),
            count,
            js_int(cfg.thrash_window_ms / 1000.0)
        ),
        value: count,
        baseline: None,
    })
}

/// Run every detector; at most one anomaly of each kind, in the order stall,
/// spike, thrash. `open` lists the episodes being reported.
pub fn detect_anomalies(
    tokens: &[Point],
    changes: &[Transition],
    status: Status,
    now: f64,
    cfg: &AnomalyConfig,
    open: &[(AnomalyKind, OpenEpisode)],
    ctx: &AgentContext,
) -> Vec<Anomaly> {
    let get = |k: AnomalyKind| open.iter().find(|(kind, _)| *kind == k).map(|(_, e)| *e);
    let mut out = Vec::new();
    let stall = detect_stall(tokens, status, now, cfg, ctx);
    let stall_open = stall.is_some() || get(AnomalyKind::Stall).is_some();
    out.extend(stall);
    let spike_ctx = AgentContext { stall_open, ..ctx.clone() };
    out.extend(detect_spike(tokens, cfg, now, get(AnomalyKind::Spike), &spike_ctx));
    out.extend(detect_thrash(changes, now, cfg));
    out
}

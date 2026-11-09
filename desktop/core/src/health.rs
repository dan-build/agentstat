//! Health scoring (mirrors `src/health.ts`). Every component comes from data
//! the caller supplied; anything without a signal is None and left out of the
//! composite.

use serde::{Deserialize, Serialize};

use crate::anomaly::{Anomaly, AnomalyKind, Severity};
use crate::num::{js_round, mean};
use crate::types::{Agent, Status};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LatencyTrend {
    Improving,
    Stable,
    Degrading,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthMetrics {
    /// Composite 0–100 over the components that have data.
    pub score: f64,
    /// How close the recent average rate sits to the expected band (100 = inside).
    pub token_efficiency: f64,
    /// Steadiness of the rate relative to its own level (100 = steady).
    pub stability: f64,
    /// Caller-supplied signal only; None without one.
    pub hallucination_risk: Option<f64>,
    /// Direction of reported latencies; None until four are reported.
    pub latency_trend: Option<LatencyTrend>,
}

const DEFAULT_BAND: (f64, f64) = (5.0, 25.0);
const W_EFFICIENCY: f64 = 0.35;
const W_STABILITY: f64 = 0.25;
const W_HALLUCINATION: f64 = 0.3;
const W_LATENCY: f64 = 0.1;

/// Newer half of the latencies against the older half; ±15% is noise.
pub fn latency_trend_of(latencies: Option<&[f64]>) -> Option<LatencyTrend> {
    let xs: Vec<f64> = latencies.unwrap_or(&[]).iter().copied().filter(|x| x.is_finite()).collect();
    if xs.len() < 4 {
        return None;
    }
    let mid = xs.len() / 2;
    let older = mean(&xs[..mid]);
    let newer = mean(&xs[mid..]);
    let rel = (newer - older) / older.max(1.0);
    Some(if rel > 0.15 {
        LatencyTrend::Degrading
    } else if rel < -0.15 {
        LatencyTrend::Improving
    } else {
        LatencyTrend::Stable
    })
}

/// Health for one agent from its recent rates (oldest first), active anomalies
/// (each a penalty) and recent latencies.
pub fn calculate_health(
    agent: &Agent,
    recent_rates: &[f64],
    anomalies: Option<&[Anomaly]>,
    latencies: Option<&[f64]>,
) -> HealthMetrics {
    let cur = &agent.current;
    let rates: Vec<f64> = recent_rates.iter().copied().filter(|x| x.is_finite()).collect();

    let (min_tok, max_tok) = agent.expected_tokens_per_sec.unwrap_or(DEFAULT_BAND);
    let rep = if rates.is_empty() { cur.tokens_rate } else { mean(&rates) };
    let outside = if cur.status == Status::Waiting {
        0.0
    } else if rep < min_tok {
        min_tok - rep
    } else if rep > max_tok {
        rep - max_tok
    } else {
        0.0
    };
    let token_efficiency =
        if outside.is_finite() { (100.0 - outside / max_tok.max(1.0) * 100.0).max(0.0) } else { 0.0 };

    let mut stability = 100.0;
    if rates.len() > 1 {
        let mut steps = 0.0;
        for i in 1..rates.len() {
            steps += (rates[i] - rates[i - 1]).abs();
        }
        let mean_step = steps / (rates.len() - 1) as f64;
        stability = (100.0 - mean_step / mean(&rates).max(1.0) * 100.0).max(0.0);
    }

    let hallucination_risk = if cur.status == Status::Hallucinating {
        Some(100.0)
    } else {
        cur.confidence_score.filter(|c| c.is_finite()).map(|c| js_round((1.0 - c.clamp(0.0, 1.0)) * 100.0))
    };

    let latency_trend = latency_trend_of(latencies);

    let mut weighted = token_efficiency * W_EFFICIENCY + stability * W_STABILITY;
    let mut total = W_EFFICIENCY + W_STABILITY;
    if let Some(r) = hallucination_risk {
        weighted += (100.0 - r) * W_HALLUCINATION;
        total += W_HALLUCINATION;
    }
    if let Some(t) = latency_trend {
        let score = match t {
            LatencyTrend::Improving => 100.0,
            LatencyTrend::Stable => 50.0,
            LatencyTrend::Degrading => 0.0,
        };
        weighted += score * W_LATENCY;
        total += W_LATENCY;
    }
    let base = js_round(weighted / total);

    let mut penalty = 0.0;
    for a in anomalies.unwrap_or(&[]) {
        let sev = if a.severity == Severity::Critical { 30.0 } else { 15.0 };
        let kind = match a.kind {
            AnomalyKind::Stall => 1.0,
            AnomalyKind::Thrash => 0.9,
            AnomalyKind::Spike => 0.7,
        };
        penalty += sev * kind;
    }

    HealthMetrics {
        score: js_round(base - penalty).clamp(0.0, 100.0),
        token_efficiency: js_round(token_efficiency),
        stability: js_round(stability),
        hallucination_risk,
        latency_trend,
    }
}

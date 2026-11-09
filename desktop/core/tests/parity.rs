//! Parity with the TypeScript library: replays traces recorded from it
//! (`node scripts/parity/generate.mjs` at the repo root) and checks that every
//! health tick produces the same events and the same per-agent state.

use std::{fs, path::PathBuf};

use agentstat_core::{
    Agent, AnomalyConfig, Current, Event, Sample, Status, Store, StoreEvent, StoreOptions, anomaly::Anomaly,
    health::HealthMetrics,
};
use serde_json::Value;

fn traces_dir() -> PathBuf {
    std::env::var_os("AGENTSTAT_PARITY_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/parity"))
}

fn close(a: f64, b: f64) -> bool {
    a == b || (a - b).abs() <= 1e-9 * a.abs().max(b.abs()).max(1.0)
}

fn num(v: &Value) -> Option<f64> {
    v.as_f64()
}

fn opt_close(a: Option<f64>, b: Option<f64>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => close(a, b),
        _ => false,
    }
}

fn check_anomaly(got: &Anomaly, want: &Value) -> Result<(), String> {
    let want_a: Anomaly = serde_json::from_value(want.clone()).map_err(|e| format!("bad anomaly in trace: {e}"))?;
    if got.kind != want_a.kind
        || got.severity != want_a.severity
        || got.message != want_a.message
        || !close(got.t, want_a.t)
        || !close(got.value, want_a.value)
        || !opt_close(got.baseline, want_a.baseline)
    {
        return Err(format!("anomaly differs\n  rust: {got:?}\n  ts:   {want_a:?}"));
    }
    Ok(())
}

fn check_health(got: &HealthMetrics, want: &Value) -> Result<(), String> {
    let w: HealthMetrics = serde_json::from_value(want.clone()).map_err(|e| format!("bad health in trace: {e}"))?;
    if !close(got.score, w.score)
        || !close(got.token_efficiency, w.token_efficiency)
        || !close(got.stability, w.stability)
        || !opt_close(got.hallucination_risk, w.hallucination_risk)
        || got.latency_trend != w.latency_trend
    {
        return Err(format!("health differs\n  rust: {got:?}\n  ts:   {w:?}"));
    }
    Ok(())
}

fn check_event(got: &StoreEvent, want: &Value) -> Result<(), String> {
    let kind = want["event"].as_str().unwrap_or("");
    let id = want["id"].as_str().unwrap_or("");
    match (got, kind) {
        (StoreEvent::Health { id: gid, health }, "health") if gid == id => check_health(health, want),
        (StoreEvent::Anomaly { id: gid, anomaly, .. }, "anomaly")
        | (StoreEvent::Resolved { id: gid, anomaly, .. }, "resolved")
            if gid == id =>
        {
            check_anomaly(anomaly, &want["anomaly"])
        }
        _ => Err(format!("event differs\n  rust: {got:?}\n  ts:   {want}")),
    }
}

fn check_agent(store: &Store, now: f64, want: &Value) -> Result<(), String> {
    let id = want["id"].as_str().unwrap_or("");
    let cur = store.current(id).ok_or_else(|| format!("{id} missing"))?;
    let status: Status = serde_json::from_value(want["status"].clone()).map_err(|e| e.to_string())?;
    let stats = store.stats(id, now).ok_or("no stats")?;
    let ws = &want["stats"];
    let ok = cur.status == status
        && close(cur.tokens_rate, num(&want["rate"]).unwrap_or(f64::NAN))
        && close(cur.error_count.unwrap_or(0.0), num(&want["errors"]).unwrap_or(f64::NAN))
        && close(stats.total_tokens, num(&ws["totalTokens"]).unwrap_or(f64::NAN))
        && opt_close(stats.ttft_ms, num(&ws["ttftMs"]))
        && opt_close(stats.inter_token_ms, num(&ws["interTokenMs"]))
        && stats.tool.as_deref() == ws["tool"].as_str()
        && close(stats.status_ms, num(&ws["statusMs"]).unwrap_or(f64::NAN));
    if !ok {
        return Err(format!(
            "{id} state differs\n  rust: status={:?} rate={} errors={:?} {stats:?}\n  ts:   {want}",
            cur.status, cur.tokens_rate, cur.error_count
        ));
    }
    Ok(())
}

fn replay(trace: &Value) -> Result<usize, String> {
    let n = trace["agents"].as_u64().unwrap_or(1) as usize;
    let t0 = num(&trace["t0"]).unwrap_or(0.0);
    let cfg: AnomalyConfig = serde_json::from_value(trace["cfg"].clone()).map_err(|e| format!("bad cfg: {e}"))?;
    let agents = (0..n)
        .map(|i| Agent {
            id: format!("a{i}"),
            name: format!("agent {i}"),
            color: None,
            expected_tokens_per_sec: None,
            current: Current {
                tokens_rate: 0.0,
                progress: 0.0,
                status: Status::Active,
                latency_ms: None,
                confidence_score: None,
                error_count: None,
            },
        })
        .collect();
    let mut store = Store::new(agents, StoreOptions { window_seconds: None, max_history_points: 100_000 }, t0);
    let mut ticks = 0;
    for op in trace["ops"].as_array().ok_or("no ops")? {
        let now = num(&op["now"]).ok_or("op without now")?;
        let id = op["id"].as_str().unwrap_or("");
        match op["op"].as_str() {
            Some("ingest") => {
                let s: Sample = serde_json::from_value(op["sample"].clone()).map_err(|e| format!("bad sample: {e}"))?;
                store.ingest(id, &s, now);
            }
            Some("push") => {
                let e: Event = serde_json::from_value(op["event"].clone())
                    .map_err(|e| format!("bad event {}: {e}", op["event"]))?;
                store.push(id, &e, now);
            }
            Some("tick") => {
                ticks += 1;
                let got = store.health_tick(now, true, &cfg);
                let want = op["out"].as_array().ok_or("tick without out")?;
                let at = format!("at t={}s", (now - t0) / 1000.0);
                if got.len() != want.len() {
                    return Err(format!(
                        "{at}: {} events, expected {}\n  rust: {got:?}\n  ts:   {}",
                        got.len(),
                        want.len(),
                        Value::Array(want.clone())
                    ));
                }
                for (g, w) in got.iter().zip(want) {
                    check_event(g, w).map_err(|e| format!("{at}: {e}"))?;
                }
                for a in op["agents"].as_array().ok_or("tick without agents")? {
                    check_agent(&store, now, a).map_err(|e| format!("{at}: {e}"))?;
                }
            }
            other => return Err(format!("unknown op {other:?}")),
        }
    }
    Ok(ticks)
}

#[test]
fn matches_typescript_on_every_eval_scenario() {
    let dir = traces_dir();
    let mut files: Vec<PathBuf> = fs::read_dir(&dir)
        .unwrap_or_else(|_| {
            panic!("no parity traces in {}; run `node scripts/parity/generate.mjs` at the repo root", dir.display())
        })
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    assert!(!files.is_empty(), "no parity traces in {}", dir.display());

    let mut failures = Vec::new();
    let mut ticks = 0;
    for f in &files {
        let trace: Value = serde_json::from_slice(&fs::read(f).expect("read trace")).expect("parse trace");
        match replay(&trace) {
            Ok(n) => ticks += n,
            Err(e) => failures.push(format!("{}: {e}", f.file_name().unwrap().to_string_lossy())),
        }
    }
    println!("{} traces, {ticks} ticks matched", files.len() - failures.len());
    assert!(failures.is_empty(), "{} of {} traces differ:\n\n{}", failures.len(), files.len(), failures.join("\n\n"));
}

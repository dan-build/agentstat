//! Throughput of the core on this machine: event ingest and health ticks.
//!
//!   cargo run --release -p agentstat-core --example throughput

use std::time::Instant;

use agentstat_core::{AnomalyConfig, Event, Store, StoreOptions};

fn main() {
    let agents = 50;
    let secs = 120; // simulated
    let rate_hz = 20; // token events per agent per second
    let mut store = Store::new(Vec::new(), StoreOptions::default(), 0.0);
    let ids: Vec<String> = (0..agents).map(|i| format!("agent-{i}")).collect();
    for id in &ids {
        store.ensure(id, 0.0, 0.0);
        store.push(id, &Event::Start { time: Some(0.0) }, 0.0);
    }
    let cfg = AnomalyConfig::default();
    let mut events = 0u64;
    let mut ticks = 0u64;
    let mut ingest = 0.0;
    let mut tick = 0.0;
    let step = 1000 / rate_hz;
    for ms in (step..=secs * 1000).step_by(step as usize) {
        let now = ms as f64;
        let t0 = Instant::now();
        for (i, id) in ids.iter().enumerate() {
            let e = if ms % 15_000 == 0 && i % 3 == 0 {
                Event::ToolStart { name: Some("bash".into()), time: None }
            } else if ms % 15_000 == 2_000 && i % 3 == 0 {
                Event::ToolEnd { name: Some("bash".into()), error: None, time: None }
            } else {
                Event::Tokens { count: Some(5.0 + (i % 7) as f64), total: None, since: None, time: None }
            };
            store.push(id, &e, now);
            events += 1;
        }
        ingest += t0.elapsed().as_secs_f64();
        if ms % 500 == 0 {
            let t1 = Instant::now();
            let out = store.health_tick(now, true, &cfg);
            std::hint::black_box(out);
            tick += t1.elapsed().as_secs_f64();
            ticks += 1;
        }
    }
    println!(
        "{agents} agents, {secs}s simulated: ingest {:.0} events/s ({:.2} µs/event), health tick {:.2} ms for all agents ({ticks} ticks)",
        events as f64 / ingest,
        ingest / events as f64 * 1e6,
        tick / ticks as f64 * 1e3,
    );
}

//! AgentStat's telemetry logic, without I/O or UI: event ingest, status, token
//! rates, health and anomaly detection.
//!
//! This is a port of the TypeScript library's `src/core/store.ts`,
//! `src/anomaly.ts`, `src/health.ts`, `src/statuslog.ts` and the buffer half of
//! `src/timeseries.ts`. Both must behave identically: `tests/parity.rs` replays
//! traces recorded from the TypeScript code (`node scripts/parity/generate.mjs`)
//! and compares every output.

pub mod anomaly;
pub mod health;
mod num;
pub mod series;
pub mod statuslog;
pub mod store;
pub mod types;

pub use anomaly::{Anomaly, AnomalyConfig, AnomalyKind, Severity};
pub use health::{HealthMetrics, LatencyTrend};
pub use store::{Store, StoreEvent, StoreOptions, StreamStats};
pub use types::{Agent, Current, Event, Sample, Status};

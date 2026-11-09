//! AgentStat's local service: receives agent telemetry (OpenTelemetry, for now
//! from Claude Code), keeps it in an event stream and in the core store, and
//! serves both — the agent list as JSON, the stream as Server-Sent Events in
//! the format the npm library's `connectSse` reads.

pub mod claude;
pub mod client;
pub mod otlp;
pub mod server;
pub mod stream;

/// Default port: the standard OTLP/HTTP one, so OpenTelemetry exporters need
/// only the protocol set. Override with `--port` or `AGENTSTAT_PORT`.
pub const DEFAULT_PORT: u16 = 4318;

/// Wall-clock milliseconds since the Unix epoch: the clock every time in the
/// service is in (OpenTelemetry timestamps are too).
pub fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

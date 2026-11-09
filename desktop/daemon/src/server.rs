//! The HTTP service: OTLP ingest, the agent list, the live stream.
//!
//! Listens on 127.0.0.1 only, and refuses requests whose Host isn't this
//! machine, so a web page can't reach it through DNS rebinding.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agentstat_core::{AnomalyConfig, Store, StoreEvent, StoreOptions};
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Query, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{broadcast, mpsc};
use tokio_stream::wrappers::ReceiverStream;

use crate::claude::{ClaudeMapper, Output, is_claude};
use crate::now_ms;
use crate::otlp::log_records;
use crate::stream::{Body as MsgBody, EventLog, Message};

/// Health and detection run this often (as in the chart).
const TICK_MS: u64 = 500;
/// Keep-alive comment on idle streams, so proxies don't close them.
const HEARTBEAT: Duration = Duration::from_secs(15);
/// Agents without events for this long leave the list.
const IDLE_REMOVE_MS: f64 = 30.0 * 60_000.0;
/// Anomaly openings kept for the list's "recent" feed.
const RECENT_ANOMALIES: usize = 50;
/// Largest OTLP request accepted (exporters send small batches).
const MAX_BODY: usize = 512 * 1024;
/// Largest hook call accepted: it carries the tool's whole input and output
/// (read and dropped; only names and ids are kept), and a lost tool end would
/// leave the agent "waiting" forever.
const MAX_HOOK_BODY: usize = 16 * 1024 * 1024;
/// Live streams served at once.
const MAX_STREAMS: usize = 16;
static STREAMS: AtomicUsize = AtomicUsize::new(0);

pub struct Daemon {
    log: EventLog,
    store: Store,
    claude: ClaudeMapper,
    cfg: AnomalyConfig,
    /// When each agent was last heard from, for idle removal.
    last_seen: HashMap<String, f64>,
    recent: Vec<RecentAnomaly>,
    /// Random per run, so clients can tell a restart from a resume.
    pub instance: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentAnomaly {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub severity: String,
    pub message: String,
    pub t: f64,
    pub resolved: bool,
}

pub type Shared = Arc<Mutex<Daemon>>;

impl Daemon {
    pub fn new() -> Self {
        let seed = now_ms().to_bits() ^ ((std::process::id() as u64) << 32);
        Daemon {
            log: EventLog::default(),
            store: Store::new(Vec::new(), StoreOptions::default(), now_ms()),
            claude: ClaudeMapper::default(),
            cfg: AnomalyConfig::default(),
            last_seen: HashMap::new(),
            recent: Vec::new(),
            instance: format!("{:08x}", (seed.wrapping_mul(0x9e3779b97f4a7c15) >> 32) as u32),
        }
    }

    /// Record a message in the store (the stream already has it).
    fn apply(&mut self, m: &Message, now: f64) {
        match &m.body {
            MsgBody::Event { id, event } => {
                let t = event.time().unwrap_or(now);
                self.store.ensure(id, t, now);
                self.store.push(id, event, now);
                self.last_seen.insert(id.clone(), now);
            }
            MsgBody::Agent { id, name, color, config } => {
                let band = config.as_ref().map(|c| c.expected_tokens_per_sec);
                self.store.describe(id, name.clone(), color.clone(), band, now);
                self.last_seen.insert(id.clone(), now);
            }
            MsgBody::Remove { id } => {
                self.store.remove(id);
                self.last_seen.remove(id);
                self.claude.forget(id);
            }
        }
    }

    /// Ingest an OTLP logs request; returns how many events it produced.
    pub fn ingest_logs(&mut self, body: &Value, now: f64) -> usize {
        let mut n = 0;
        for r in log_records(body).iter().filter(|r| is_claude(r)) {
            let out = self.claude.map(r, now);
            n += self.emit(out, now);
        }
        n
    }

    /// Ingest one Claude Code hook call; returns how many events it produced.
    pub fn ingest_hook(&mut self, body: &Value, now: f64) -> usize {
        let out = self.claude.map_hook(body, now);
        self.emit(out, now)
    }

    /// Send mapper output to the stream and the store; returns the event count.
    fn emit(&mut self, out: Vec<Output>, now: f64) -> usize {
        let mut n = 0;
        for o in out {
            let m = match o {
                Output::New { id, name } => self.log.describe(&id, Some(name), None, None, now),
                Output::Event { id, event } => {
                    n += 1;
                    self.log.push(&id, event, now)
                }
            };
            self.apply(&m, now);
        }
        n
    }

    /// Health, detection and idle removal.
    pub fn tick(&mut self, now: f64) {
        let finished = self.claude.flush(now);
        self.emit(finished, now);
        for e in self.store.health_tick(now, true, &self.cfg) {
            let (id, name, a, resolved) = match e {
                StoreEvent::Anomaly { id, name, anomaly } => (id, name, anomaly, false),
                StoreEvent::Resolved { id, name, anomaly } => (id, name, anomaly, true),
                StoreEvent::Health { .. } => continue,
            };
            let label = |v: Value| v.as_str().unwrap_or_default().to_string();
            self.recent.push(RecentAnomaly {
                id,
                name,
                kind: label(serde_json::to_value(a.kind).unwrap_or_default()),
                severity: label(serde_json::to_value(a.severity).unwrap_or_default()),
                message: a.message,
                t: a.t,
                resolved,
            });
        }
        let excess = self.recent.len().saturating_sub(RECENT_ANOMALIES);
        self.recent.drain(..excess);
        let idle: Vec<String> =
            self.last_seen.iter().filter(|(_, t)| now - **t > IDLE_REMOVE_MS).map(|(id, _)| id.clone()).collect();
        for id in idle {
            let m = self.log.remove(&id, now);
            self.apply(&m, now);
        }
    }

    /// The list served at /v1/agents.
    pub fn snapshot(&self, now: f64) -> Snapshot {
        let agents = self
            .store
            .agents()
            .map(|a| {
                let stats = self.store.stats(&a.id, now);
                AgentView {
                    id: a.id.clone(),
                    name: a.name.clone(),
                    status: a.current.status.as_str().to_string(),
                    status_ms: stats.as_ref().map_or(0.0, |s| s.status_ms),
                    // + 0.0 turns a -0 into 0.
                    rate: a.current.tokens_rate + 0.0,
                    total_tokens: stats.as_ref().map_or(0.0, |s| s.total_tokens),
                    ttft_ms: stats.as_ref().and_then(|s| s.ttft_ms),
                    tool: stats.as_ref().and_then(|s| s.tool.clone()),
                    errors: a.current.error_count.unwrap_or(0.0),
                    health: self.store.health(&a.id).map(|h| h.score),
                    anomalies: self.store.anomalies(&a.id).iter().map(|x| x.message.clone()).collect(),
                }
            })
            .collect();
        Snapshot { agents, recent: self.recent.clone() }
    }
}

impl Default for Daemon {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentView {
    pub id: String,
    pub name: String,
    pub status: String,
    pub status_ms: f64,
    pub rate: f64,
    pub total_tokens: f64,
    pub ttft_ms: Option<f64>,
    pub tool: Option<String>,
    pub errors: f64,
    pub health: Option<f64>,
    pub anomalies: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Snapshot {
    pub agents: Vec<AgentView>,
    #[serde(default)]
    pub recent: Vec<RecentAnomaly>,
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

pub fn router(state: Shared, port: u16) -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/v1/logs", post(logs))
        .route("/v1/hooks/claude", post(hook).layer(DefaultBodyLimit::max(MAX_HOOK_BODY)))
        // Accepted so exporters configured for every signal don't error; not read yet.
        .route("/v1/metrics", post(|| async { Json(serde_json::json!({})) }))
        .route("/v1/traces", post(|| async { Json(serde_json::json!({})) }))
        .route("/v1/agents", get(agents))
        .route("/v1/stream", get(stream))
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .layer(middleware::from_fn(move |req: Request, next: Next| local_only(req, next, port)))
        .with_state(state)
}

/// Refuse any Host that isn't this machine (DNS rebinding), and any write from
/// a web page: browsers mark those with Origin, and a page can only send JSON
/// after a preflight this service never approves.
async fn local_only(req: Request, next: Next, port: u16) -> Response {
    let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    let ok = ["127.0.0.1", "localhost", "[::1]"].iter().any(|h| host == *h || host == format!("{h}:{port}"));
    if !ok {
        return (StatusCode::FORBIDDEN, "agentstat only answers requests for localhost").into_response();
    }
    if req.method() == axum::http::Method::POST {
        if req.headers().contains_key(header::ORIGIN) {
            return (StatusCode::FORBIDDEN, "agentstat doesn't accept data from web pages").into_response();
        }
        let ctype = req.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("");
        let json = ctype.to_ascii_lowercase().starts_with("application/json");
        let protobuf = ctype.to_ascii_lowercase().starts_with("application/x-protobuf");
        if !json && !protobuf {
            return (StatusCode::UNSUPPORTED_MEDIA_TYPE, "send application/json").into_response();
        }
    }
    next.run(req).await
}

async fn logs(State(state): State<Shared>, headers: HeaderMap, body: Bytes) -> Response {
    let text =
        |h| headers.get(h).and_then(|v: &header::HeaderValue| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    if !matches!(text(header::CONTENT_ENCODING).as_str(), "" | "identity") {
        let msg = "agentstat reads uncompressed OTLP: set OTEL_EXPORTER_OTLP_COMPRESSION=none";
        return (StatusCode::UNSUPPORTED_MEDIA_TYPE, msg).into_response();
    }
    if !text(header::CONTENT_TYPE).starts_with("application/json") {
        let msg = "agentstat reads OTLP/HTTP JSON: set OTEL_EXPORTER_OTLP_PROTOCOL=http/json";
        return (StatusCode::UNSUPPORTED_MEDIA_TYPE, msg).into_response();
    }
    let Ok(v) = serde_json::from_slice::<Value>(&body) else {
        return (StatusCode::BAD_REQUEST, "invalid JSON").into_response();
    };
    state.lock().unwrap_or_else(|e| e.into_inner()).ingest_logs(&v, now_ms());
    Json(serde_json::json!({})).into_response()
}

/// A Claude Code hook (the AgentStat plugin posts each one's JSON input).
async fn hook(State(state): State<Shared>, body: Bytes) -> Response {
    let Ok(v) = serde_json::from_slice::<Value>(&body) else {
        return (StatusCode::BAD_REQUEST, "invalid JSON").into_response();
    };
    state.lock().unwrap_or_else(|e| e.into_inner()).ingest_hook(&v, now_ms());
    // An empty 2xx: nothing for Claude Code to act on.
    StatusCode::NO_CONTENT.into_response()
}

async fn agents(State(state): State<Shared>) -> Json<Snapshot> {
    Json(state.lock().unwrap_or_else(|e| e.into_inner()).snapshot(now_ms()))
}

#[derive(Deserialize)]
struct StreamQuery {
    #[serde(rename = "lastEventId")]
    last_event_id: Option<String>,
}

/// What travels per message, as the npm library's `connectSse` reads it: the
/// message, its event's age when sent (and its `since`'s), and the send time.
fn frame(instance: &str, m: &Message, now: f64) -> Bytes {
    let mut wire = serde_json::json!({ "m": m, "sent": now });
    if let MsgBody::Event { event, .. } = &m.body {
        if let Some(t) = event.time() {
            wire["age"] = (now - t).max(0.0).into();
        }
        if let agentstat_core::Event::Tokens { since: Some(s), .. } = event {
            wire["sinceAge"] = (now - s).max(0.0).into();
        }
    }
    Bytes::from(format!("id: {instance}:{}\ndata: {wire}\n\n", m.seq))
}

/// Server-Sent Events: history after the client's last id (if it came from this
/// run), then live messages. A client that falls far behind is disconnected; it
/// reconnects and resumes.
/// Counts a live stream for as long as it exists.
struct StreamSlot;

impl StreamSlot {
    fn take() -> Option<Self> {
        let n = STREAMS.fetch_add(1, Ordering::SeqCst);
        if n >= MAX_STREAMS {
            STREAMS.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        Some(StreamSlot)
    }
}

impl Drop for StreamSlot {
    fn drop(&mut self) {
        STREAMS.fetch_sub(1, Ordering::SeqCst);
    }
}

async fn stream(State(state): State<Shared>, headers: HeaderMap, Query(q): Query<StreamQuery>) -> Response {
    let Some(slot) = StreamSlot::take() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "too many live streams").into_response();
    };
    let last = headers.get("last-event-id").and_then(|v| v.to_str().ok()).map(str::to_string).or(q.last_event_id);
    let (instance, sub) = {
        let mut d = state.lock().unwrap_or_else(|e| e.into_inner());
        let after = last
            .as_deref()
            .and_then(|l| l.split_once(':'))
            .filter(|(inst, _)| *inst == d.instance)
            .and_then(|(_, seq)| seq.parse().ok())
            .unwrap_or(0);
        (d.instance.clone(), d.log.subscribe(after, now_ms()))
    };
    let instance_header = instance.clone();
    let (tx, rx) = mpsc::channel::<Result<Bytes, Infallible>>(64);
    tokio::spawn(async move {
        let _slot = slot;
        let send = |b: Bytes| tx.send(Ok(b));
        if send(Bytes::from_static(b"retry: 2000\n\n")).await.is_err() {
            return;
        }
        for m in &sub.replay {
            if send(frame(&instance, m, now_ms())).await.is_err() {
                return;
            }
        }
        let mut live = sub.live;
        let mut beat = tokio::time::interval(HEARTBEAT);
        beat.tick().await;
        loop {
            let bytes = tokio::select! {
                m = live.recv() => match m {
                    Ok(m) => frame(&instance, &m, now_ms()),
                    // Too far behind (or shutting down): let the client reconnect.
                    Err(broadcast::error::RecvError::Lagged(_) | broadcast::error::RecvError::Closed) => return,
                },
                _ = beat.tick() => Bytes::from_static(b": keep-alive\n\n"),
            };
            if send(bytes).await.is_err() {
                return;
            }
        }
    });
    Response::builder()
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache, no-transform")
        .header("x-accel-buffering", "no")
        // Which run this is, before any message: a client can tell a restart at once.
        .header("x-agentstat-instance", instance_header)
        .body(Body::from_stream(ReceiverStream::new(rx)))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Health, detection, pending finishes and idle removal, every 500 ms.
pub fn spawn_ticker(state: Shared) {
    tokio::spawn(async move {
        let mut every = tokio::time::interval(Duration::from_millis(TICK_MS));
        loop {
            every.tick().await;
            state.lock().unwrap_or_else(|e| e.into_inner()).tick(now_ms());
        }
    });
}

/// Run the service until Ctrl-C (or SIGTERM).
pub async fn serve(port: u16) -> std::io::Result<()> {
    let state: Shared = Arc::new(Mutex::new(Daemon::new()));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    spawn_ticker(state.clone());
    let shutdown = async {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).ok();
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = async { match term.as_mut() { Some(t) => { t.recv().await; } None => std::future::pending().await } } => {}
        }
    };
    // Open streams never end on their own, so shutting down doesn't wait for them.
    tokio::select! {
        r = axum::serve(listener, router(state, port)) => r,
        _ = shutdown => Ok(()),
    }
}

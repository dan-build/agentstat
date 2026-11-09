//! Per-agent telemetry state (mirrors `src/core/store.ts`, without the chart-only
//! parts: legend visibility, live-value easing, the demo simulator and pause).
//!
//! Every method takes `now` explicitly, in the caller's millisecond clock.

use crate::anomaly::{AgentContext, Anomaly, AnomalyConfig, AnomalyKind, OpenEpisode, Severity, detect_anomalies};
use crate::health::{HealthMetrics, calculate_health};
use crate::num::{clamp, js_round};
use crate::series::TimeSeries;
use crate::statuslog::StatusLog;
use crate::types::{Agent, Current, Event, Sample, Status};

/// Visible span when no window is set (the retention floor is 1.5× this).
const DEFAULT_VIEW_MS: f64 = 10_000.0;
/// History kept for the detectors regardless of the visible window.
const DETECTOR_HISTORY_MS: f64 = 40_000.0;
const HEALTH_WINDOW_MS: f64 = 5_000.0;
const LATENCY_HISTORY: usize = 20;
const DEFAULT_CAP: usize = 100_000;
/// An episode ends after its detector has been quiet this long.
const EPISODE_GRACE_MS: f64 = 5_000.0;
/// Active time the slow reference rate needs before detectors may use it.
const REFERENCE_WARMUP_MS: f64 = 10_000.0;
/// Event ingest: rate window bounds (~3 inter-token gaps between them).
const RATE_WINDOW_MS: (f64, f64) = (1_000.0, 4_000.0);
/// Token events are sampled at most this often.
const SAMPLE_MS: f64 = 100.0;
/// Once events stop, health ticks sample the (falling) rate this often.
const STREAM_TICK_MS: f64 = 250.0;

fn resting(s: Status) -> bool {
    matches!(s, Status::Waiting | Status::Complete)
}

#[derive(Clone, Debug)]
pub struct StoreOptions {
    /// Visible window in seconds (affects retention only).
    pub window_seconds: Option<f64>,
    pub max_history_points: usize,
}

impl Default for StoreOptions {
    fn default() -> Self {
        StoreOptions { window_seconds: None, max_history_points: DEFAULT_CAP }
    }
}

/// Emitted by a health tick, in order.
#[derive(Clone, Debug, PartialEq)]
pub enum StoreEvent {
    /// An episode opened or escalated.
    Anomaly { id: String, name: String, anomaly: Anomaly },
    /// An episode ended.
    Resolved { id: String, name: String, anomaly: Anomaly },
    /// Health changed.
    Health { id: String, health: HealthMetrics },
}

/// What the store derived from an agent's events.
#[derive(Clone, Debug, PartialEq)]
pub struct StreamStats {
    pub total_tokens: f64,
    pub ttft_ms: Option<f64>,
    pub inter_token_ms: Option<f64>,
    /// Innermost open tool call ("" if unnamed).
    pub tool: Option<String>,
    /// Time in the current status (ms).
    pub status_ms: f64,
}

/// Per-agent state for agents fed with events.
#[derive(Clone, Debug)]
struct Stream {
    /// Token events in the rate window: (time, count).
    win: Vec<(f64, f64)>,
    total: f64,
    last_total: Option<f64>,
    /// Latest time applied (events are clamped to be monotonic).
    t: f64,
    /// When the last event arrived (store clock), whatever its time.
    arrived: f64,
    last_sample: f64,
    ttft_from: Option<f64>,
    ttft: Option<f64>,
    last_tok: Option<f64>,
    /// Estimated start of the current streaming stretch.
    from: f64,
    n: u32,
    itl: Option<f64>,
    tools: Vec<String>,
}

impl Stream {
    fn new(now: f64) -> Self {
        Stream {
            win: Vec::new(),
            total: 0.0,
            last_total: None,
            t: f64::NEG_INFINITY,
            arrived: now,
            last_sample: f64::NEG_INFINITY,
            ttft_from: None,
            ttft: None,
            last_tok: None,
            from: f64::NEG_INFINITY,
            n: 0,
            itl: None,
            tools: Vec::new(),
        }
    }

    /// Rate window at `t`: ~3 inter-token gaps, never reaching before the stretch.
    fn window(&self, t: f64) -> f64 {
        let base = match self.itl {
            None => RATE_WINDOW_MS.1,
            Some(itl) => clamp(3.0 * itl, RATE_WINDOW_MS.0, RATE_WINDOW_MS.1),
        };
        SAMPLE_MS.max(base.min(t - self.from))
    }
}

#[derive(Clone, Debug)]
struct Episode {
    since: f64,
    baseline: Option<f64>,
    severity: Severity,
    last_seen: f64,
    last: Anomaly,
    name: String,
}

#[derive(Clone, Debug)]
struct AgentState {
    agent: Agent,
    progress: TimeSeries,
    tokens: TimeSeries,
    status_log: StatusLog,
    progress_known: bool,
    latency: Vec<f64>,
    health: Option<HealthMetrics>,
    anomalies: Vec<Anomaly>,
    /// Open episodes in insertion order (resolution order depends on it).
    episodes: Vec<(AnomalyKind, Episode)>,
    /// A `stuck`/`hallucinating` status set by the caller holds against events.
    locked: bool,
    ref_rate: Option<f64>,
    ref_active_ms: f64,
    status_reported: bool,
    status_since: f64,
    work_since: f64,
    stream: Option<Stream>,
    /// Added by a stream (not by the caller's roster).
    auto: bool,
}

/// Telemetry state for a roster of agents.
#[derive(Clone, Debug)]
pub struct Store {
    agents: Vec<AgentState>,
    options: StoreOptions,
    pending: Vec<StoreEvent>,
    detector_history_ms: f64,
    idle_rate: f64,
    last_tick: f64,
}

impl Store {
    pub fn new(agents: Vec<Agent>, options: StoreOptions, now: f64) -> Self {
        let mut store = Store {
            agents: Vec::new(),
            options,
            pending: Vec::new(),
            detector_history_ms: DETECTOR_HISTORY_MS,
            idle_rate: 0.5,
            last_tick: 0.0,
        };
        for a in agents {
            if store.index(&a.id).is_none() {
                store.create(a, now, false);
            }
        }
        store
    }

    fn index(&self, id: &str) -> Option<usize> {
        self.agents.iter().position(|a| a.agent.id == id)
    }

    fn create(&mut self, mut a: Agent, now: f64, auto: bool) -> usize {
        let finite = |v: f64, lo: f64, hi: f64| if v.is_finite() { clamp(v, lo, hi) } else { 0.0 };
        a.current.tokens_rate = finite(a.current.tokens_rate, 0.0, f64::INFINITY);
        a.current.progress = finite(a.current.progress, 0.0, 100.0);
        let progress_known = a.current.progress > 0.0;
        // 0 means the default, as in the TypeScript `Math.floor(max) || DEFAULT_CAP`.
        let cap =
            if self.options.max_history_points == 0 { DEFAULT_CAP } else { self.options.max_history_points.max(2) };
        let mut progress = TimeSeries::new(cap);
        let mut tokens = TimeSeries::new(cap);
        if progress_known {
            progress.push(now, a.current.progress);
        }
        tokens.push(now, a.current.tokens_rate);
        let mut status_log = StatusLog::default();
        status_log.record(now, a.current.status);
        self.agents.push(AgentState {
            agent: a,
            progress,
            tokens,
            status_log,
            progress_known,
            latency: Vec::new(),
            health: None,
            anomalies: Vec::new(),
            episodes: Vec::new(),
            locked: false,
            ref_rate: None,
            ref_active_ms: 0.0,
            status_reported: false,
            status_since: now,
            work_since: now,
            stream: None,
            auto,
        });
        self.agents.len() - 1
    }

    // ── Roster ──────────────────────────────────────────────────────────────

    /// Agents in roster order.
    pub fn agents(&self) -> impl Iterator<Item = &Agent> {
        self.agents.iter().map(|a| &a.agent)
    }

    pub fn agent(&self, id: &str) -> Option<&Agent> {
        self.index(id).map(|i| &self.agents[i].agent)
    }

    /// Before a stream event at `t`: add the agent if unknown (idle, at the end),
    /// or move the start of an agent with no data yet back to `t`.
    pub fn ensure(&mut self, id: &str, t: f64, now: f64) {
        // A non-finite time is treated as now (TypeScript would store NaN).
        let t = if t.is_finite() { t.min(now) } else { now };
        let Some(i) = self.index(id) else {
            self.create(Agent::idle(id), t, true);
            return;
        };
        let a = &self.agents[i];
        if t < a.status_since && a.tokens.len() == 1 && !a.status_reported && a.stream.is_none() {
            let agent = a.agent.clone();
            let auto = a.auto;
            self.close_episodes_pending(i);
            self.agents.remove(i);
            let j = self.create(agent, t, auto);
            let last = self.agents.remove(j);
            self.agents.insert(i, last);
        }
    }

    /// Name, color or band for a stream-added agent (roster agents keep theirs).
    /// `band`: None leaves it, Some(None) goes back to the default band.
    pub fn describe(
        &mut self,
        id: &str,
        name: Option<String>,
        color: Option<String>,
        band: Option<Option<(f64, f64)>>,
        now: f64,
    ) {
        self.ensure(id, now, now);
        let Some(i) = self.index(id) else { return };
        let a = &mut self.agents[i];
        if !a.auto {
            return;
        }
        if let Some(n) = name {
            a.agent.name = n;
        }
        if color.is_some() {
            a.agent.color = color;
        }
        if let Some(band) = band {
            a.agent.expected_tokens_per_sec = band;
        }
    }

    /// Remove a stream-added agent (roster agents stay); its open episodes are
    /// reported resolved on the next tick.
    pub fn remove(&mut self, id: &str) {
        if let Some(i) = self.index(id).filter(|&i| self.agents[i].auto) {
            self.close_episodes_pending(i);
            self.agents.remove(i);
        }
    }

    fn close_episodes_pending(&mut self, i: usize) {
        let evs = Self::close_episodes(&mut self.agents[i]);
        self.pending.extend(evs);
    }

    fn close_episodes(a: &mut AgentState) -> Vec<StoreEvent> {
        let id = a.agent.id.clone();
        a.episodes
            .drain(..)
            .map(|(_, ep)| StoreEvent::Resolved { id: id.clone(), name: ep.name, anomaly: ep.last })
            .collect()
    }

    // ── Ingest ──────────────────────────────────────────────────────────────

    /// Samples are kept for 1.5× the visible window, and never less than the
    /// detectors need.
    pub fn retention_ms(&self) -> f64 {
        let view = match self.options.window_seconds {
            Some(w) if w > 0.0 => w * 1000.0,
            _ => DEFAULT_VIEW_MS,
        } * 1.5;
        view.max(self.detector_history_ms)
    }

    fn set_status(a: &mut AgentState, status: Status, t: f64, output: bool) {
        a.status_reported = true;
        let prev = a.agent.current.status;
        if status == prev {
            return;
        }
        a.agent.current.status = status;
        a.status_since = t;
        // A new stretch of work: after resting, or thinking that ends in output.
        if (resting(prev) || (prev == Status::Thinking && output)) && !resting(status) {
            a.work_since = t;
        }
        a.status_log.record(t, status);
    }

    fn push_sample(a: &mut AgentState, now: f64, retain: f64) {
        if a.progress_known {
            a.progress.push(now, a.agent.current.progress);
        }
        a.tokens.push(now, a.agent.current.tokens_rate);
        a.progress.evict_older_than(now, retain);
        a.tokens.evict_older_than(now, retain);
        a.status_log.evict_older_than(now - retain);
    }

    fn record_latency(a: &mut AgentState, ms: f64) {
        a.agent.current.latency_ms = Some(ms);
        a.latency.push(ms);
        if a.latency.len() > LATENCY_HISTORY {
            let excess = a.latency.len() - LATENCY_HISTORY;
            a.latency.drain(..excess);
        }
    }

    /// Apply a partial sample (a caller computing its own rates). Non-finite
    /// fields are ignored; values are clamped to their ranges.
    pub fn ingest(&mut self, id: &str, sample: &Sample, now: f64) {
        let Some(i) = self.index(id) else { return };
        let retain = self.retention_ms();
        let idle_rate = self.idle_rate;
        let a = &mut self.agents[i];
        let num = |v: Option<f64>, lo: f64, hi: f64| v.filter(|x| x.is_finite()).map(|x| clamp(x, lo, hi));
        let tokens_rate = num(sample.tokens_rate, 0.0, f64::INFINITY);
        let progress = num(sample.progress, 0.0, 100.0);
        let latency = num(sample.latency_ms, 0.0, f64::INFINITY);
        let confidence = num(sample.confidence_score, 0.0, 1.0);
        let errors = num(sample.error_count, 0.0, f64::INFINITY);

        match sample.status {
            Some(Status::Stuck | Status::Hallucinating) => a.locked = true,
            Some(_) => a.locked = false,
            None => {}
        }
        let cur = &mut a.agent.current;
        if let Some(r) = tokens_rate {
            cur.tokens_rate = r;
        }
        if let Some(p) = progress {
            cur.progress = p;
            a.progress_known = true;
        }
        if confidence.is_some() {
            cur.confidence_score = confidence;
        }
        if errors.is_some() {
            cur.error_count = errors;
        }
        if let Some(l) = latency {
            Self::record_latency(a, l);
        }
        if let Some(s) = sample.status {
            Self::set_status(a, s, now, tokens_rate.is_some_and(|r| r > idle_rate));
        }
        if tokens_rate.is_some() || progress.is_some() {
            Self::push_sample(a, now, retain);
        }
    }

    /// Apply a stream event: derive rate, TTFT, inter-token latency and status.
    pub fn push(&mut self, id: &str, e: &Event, now: f64) {
        let Some(i) = self.index(id) else { return };
        let retain = self.retention_ms();
        let a = &mut self.agents[i];
        let mut s = a.stream.take().unwrap_or_else(|| Stream::new(now));
        Self::apply_event(a, &mut s, e, now, retain);
        a.stream = Some(s);
    }

    fn apply_event(a: &mut AgentState, s: &mut Stream, e: &Event, now: f64, retain: f64) {
        // Never in the future, never before anything already recorded.
        let floor = s.t.max(a.status_since).max(a.tokens.last_t());
        let t = now.min(floor.max(e.time().filter(|x| x.is_finite()).unwrap_or(now)));
        s.t = t;
        s.arrived = now;
        let set_status = |a: &mut AgentState, st: Status, output: bool| {
            if !a.locked {
                Self::set_status(a, st, t, output);
            }
        };
        // Before a hand-off clears the window: sample a held-back first chunk.
        if matches!(e, Event::Start { .. } | Event::ToolStart { .. } | Event::Finish { .. })
            && let Some(&(last, _)) = s.win.last()
            && s.last_sample < last
        {
            Self::sample_stream(a, s, t, false, retain);
        }
        match e {
            Event::Start { .. } => {
                s.tools.clear();
                s.ttft_from = Some(t);
                s.last_tok = None;
                s.win.clear();
                set_status(a, Status::Thinking, false);
            }
            Event::Tokens { count, total, since, .. } => {
                let n = if let Some(total) = total.filter(|x| x.is_finite() && *x >= 0.0) {
                    // The first total only sets the starting point; a smaller one starts a new count.
                    let n = match s.last_total {
                        None => 0.0,
                        Some(last) if total >= last => total - last,
                        Some(_) => total,
                    };
                    s.last_total = Some(total);
                    n
                } else if let Some(count) = count.filter(|x| x.is_finite() && *x >= 0.0) {
                    count
                } else {
                    return;
                };
                if n == 0.0 {
                    Self::sample_stream(a, s, t, true, retain);
                    return;
                }
                let since = since.filter(|x| x.is_finite()).map(|x| x.min(t));
                if let Some(since) = since {
                    // One block produced over [since, t]: one sample at its average rate.
                    if let Some(from) = s.ttft_from {
                        let ttft = (if since > from { since } else { t }) - from;
                        s.ttft = Some(ttft);
                        Self::record_latency(a, ttft);
                    }
                    s.ttft_from = None;
                    s.total += n;
                    s.win.clear();
                    s.last_tok = None;
                    let st = if s.tools.is_empty() { Status::Active } else { Status::Waiting };
                    set_status(a, st, true);
                    a.agent.current.tokens_rate = n * 1000.0 / SAMPLE_MS.max(t - since);
                    s.last_sample = t;
                    Self::push_sample(a, t, retain);
                    return;
                }
                // A gap longer than any rate window is a pause, not streaming.
                if s.last_tok.is_some_and(|lt| t - lt > RATE_WINDOW_MS.1) {
                    s.last_tok = None;
                }
                match s.last_tok {
                    None => {
                        let span = s.itl.unwrap_or(match s.ttft_from {
                            Some(from) => t - from,
                            None => RATE_WINDOW_MS.0,
                        });
                        s.from = t - clamp(span, SAMPLE_MS, RATE_WINDOW_MS.1);
                        s.n = 0;
                    }
                    Some(lt) => {
                        s.n += 1;
                        if s.n == 1 && s.itl.is_none() {
                            // The second chunk shows the real gap: re-anchor on it.
                            s.from = lt - clamp(t - lt, SAMPLE_MS, RATE_WINDOW_MS.1);
                        }
                    }
                }
                s.win.push((t, n));
                s.total += n;
                if let Some(from) = s.ttft_from.take() {
                    let ttft = t - from;
                    s.ttft = Some(ttft);
                    Self::record_latency(a, ttft);
                }
                if let Some(lt) = s.last_tok {
                    let gap = t - lt;
                    s.itl = Some(match s.itl {
                        None => gap,
                        Some(itl) => itl + (gap - itl) * 0.2,
                    });
                }
                s.last_tok = Some(t);
                let st = if s.tools.is_empty() { Status::Active } else { Status::Waiting };
                set_status(a, st, true);
                // A lone first chunk with no known gap can't be read as a rate yet.
                if s.itl.is_none() && s.n == 0 {
                    return;
                }
            }
            Event::ToolStart { name, .. } => {
                s.tools.push(name.clone().unwrap_or_default());
                s.last_tok = None;
                s.win.clear();
                set_status(a, Status::Waiting, false);
            }
            Event::ToolEnd { name, error, .. } => {
                if *error == Some(true) {
                    a.agent.current.error_count = Some(a.agent.current.error_count.unwrap_or(0.0) + 1.0);
                }
                if !s.tools.is_empty() {
                    let name = name.clone().unwrap_or_default();
                    let i = s.tools.iter().rposition(|x| *x == name).unwrap_or(s.tools.len() - 1);
                    s.tools.remove(i);
                    if s.tools.is_empty() {
                        s.ttft_from = Some(t);
                        s.last_tok = None;
                        set_status(a, Status::Thinking, false);
                    }
                }
            }
            Event::Error { .. } => {
                a.agent.current.error_count = Some(a.agent.current.error_count.unwrap_or(0.0) + 1.0);
            }
            Event::Finish { .. } => {
                s.tools.clear();
                s.win.clear();
                s.ttft_from = None;
                s.last_tok = None;
                set_status(a, Status::Complete, false);
            }
        }
        let throttle = matches!(e, Event::Tokens { .. });
        Self::sample_stream(a, s, t, throttle, retain);
    }

    /// Push the event-derived rate as a sample at `t` (token events at most
    /// every SAMPLE_MS).
    fn sample_stream(a: &mut AgentState, s: &mut Stream, t: f64, throttle: bool, retain: f64) {
        if throttle && t - s.last_sample < SAMPLE_MS {
            return;
        }
        let w = s.window(t);
        let k = s.win.iter().take_while(|(wt, _)| *wt <= t - w).count();
        s.win.drain(..k);
        let sum: f64 = s.win.iter().map(|(_, n)| n).sum();
        a.agent.current.tokens_rate = sum * 1000.0 / w;
        s.last_sample = t;
        Self::push_sample(a, t, retain);
    }

    /// Health-tick sampling of an event-fed agent: once events stop, its rate
    /// falls to zero when the last tokens leave the window.
    fn tick_stream(a: &mut AgentState, s: &mut Stream, now: f64, retain: f64) {
        if let Some(&(last, _)) = s.win.last() {
            if s.last_sample < last {
                if now - s.arrived >= STREAM_TICK_MS {
                    Self::sample_stream(a, s, s.t, false, retain);
                }
                return;
            }
            let w = s.window(last);
            if now - s.arrived < w + STREAM_TICK_MS {
                return;
            }
            s.t = now.min(s.t.max(last + w));
            Self::sample_stream(a, s, s.t, false, retain);
        } else if now - s.last_sample >= STREAM_TICK_MS {
            s.t = s.t.max(now);
            Self::sample_stream(a, s, now, false, retain);
        }
    }

    // ── Health and anomalies ────────────────────────────────────────────────

    /// Run detection and health for every agent. Returns, in order and per agent,
    /// anomalies that opened or escalated, episodes that ended, and health values
    /// that changed.
    pub fn health_tick(&mut self, now: f64, detect: bool, cfg: &AnomalyConfig) -> Vec<StoreEvent> {
        let mut out: Vec<StoreEvent> = std::mem::take(&mut self.pending);
        self.idle_rate = cfg.stall_rate_threshold;
        self.detector_history_ms = DETECTOR_HISTORY_MS
            .max(2.0 * cfg.thinking_stall_ms + 15_000.0)
            .max(2.0 * cfg.stall_duration_ms + 15_000.0)
            .max(cfg.spike_baseline_ms + 10_000.0);
        let dt = if self.last_tick != 0.0 { (now - self.last_tick).max(0.0) } else { 0.0 };
        let step = if dt != 0.0 { dt } else { 500.0 };
        self.last_tick = now;
        let retain = self.retention_ms();

        for a in &mut self.agents {
            if let Some(mut s) = a.stream.take() {
                Self::tick_stream(a, &mut s, now, retain);
                a.stream = Some(s);
            }
            let id = a.agent.id.clone();
            let mut found: Vec<Anomaly> = Vec::new();
            if detect {
                let tokens = a.tokens.since(now - retain);
                let changes = a.status_log.transitions_in_range(now - cfg.thrash_window_ms, now);
                let open: Vec<(AnomalyKind, OpenEpisode)> = a
                    .episodes
                    .iter()
                    .map(|(k, ep)| (*k, OpenEpisode { since: ep.since, baseline: ep.baseline }))
                    .collect();
                // Slow reference of the active rate (time constant ~5 min).
                let mut sum = 0.0;
                let mut n = 0.0;
                for p in a.tokens.since(now - step) {
                    if p.v > cfg.stall_rate_threshold {
                        sum += p.v;
                        n += 1.0;
                    }
                }
                if n > 0.0 {
                    a.ref_active_ms += step;
                    let prev = a.ref_rate.unwrap_or(0.0);
                    let k = if a.ref_active_ms <= REFERENCE_WARMUP_MS {
                        step / a.ref_active_ms
                    } else {
                        // libm: the same exp on every platform (and the fdlibm family JavaScript's comes from).
                        1.0 - libm::exp(-step / 300_000.0)
                    };
                    a.ref_rate = Some(prev + (sum / n - prev) * k);
                }
                let ctx = AgentContext {
                    reference_rate: if a.ref_active_ms >= REFERENCE_WARMUP_MS { a.ref_rate } else { None },
                    stall_open: false,
                    status_reported: Some(a.status_reported),
                    status_since: Some(a.status_since),
                    work_since: Some(a.work_since),
                    waiting_on: a.stream.as_ref().and_then(|s| s.tools.last()).filter(|t| !t.is_empty()).cloned(),
                };
                found = detect_anomalies(&tokens, &changes, a.agent.current.status, now, cfg, &open, &ctx);
                a.anomalies = found.clone();

                // Report once when an episode opens (and on escalation), and once when it ends.
                for an in &found {
                    let pos = a.episodes.iter().position(|(k, _)| *k == an.kind);
                    let open = pos.map(|p| a.episodes[p].1.clone());
                    let escalated = open.as_ref().is_some_and(|o| o.severity == Severity::Warning)
                        && an.severity == Severity::Critical;
                    if open.is_none() || escalated {
                        out.push(StoreEvent::Anomaly {
                            id: id.clone(),
                            name: a.agent.name.clone(),
                            anomaly: an.clone(),
                        });
                    }
                    let ep = Episode {
                        since: open.as_ref().map_or(now, |o| o.since),
                        baseline: open.as_ref().and_then(|o| o.baseline).or(an.baseline),
                        severity: match &open {
                            Some(o) if !escalated => o.severity,
                            _ => an.severity,
                        },
                        last_seen: now,
                        last: an.clone(),
                        name: a.agent.name.clone(),
                    };
                    match pos {
                        Some(p) => a.episodes[p].1 = ep,
                        None => a.episodes.push((an.kind, ep)),
                    }
                }
                let mut k = 0;
                while k < a.episodes.len() {
                    if now - a.episodes[k].1.last_seen >= EPISODE_GRACE_MS {
                        let (_, ep) = a.episodes.remove(k);
                        out.push(StoreEvent::Resolved { id: id.clone(), name: a.agent.name.clone(), anomaly: ep.last });
                    } else {
                        k += 1;
                    }
                }
            } else if !a.anomalies.is_empty() || !a.episodes.is_empty() {
                out.extend(Self::close_episodes(a));
                a.anomalies.clear();
            }

            let rates = a.tokens.values_since(now - HEALTH_WINDOW_MS);
            let latency = if a.latency.is_empty() { None } else { Some(a.latency.as_slice()) };
            let health = calculate_health(&a.agent, &rates, if detect { Some(&found) } else { None }, latency);
            // Ease the headline score; a large drop surfaces immediately.
            let score = match &a.health {
                Some(c) if health.score >= c.score - 15.0 => js_round(c.score * 0.6 + health.score * 0.4),
                _ => health.score,
            };
            let smoothed = HealthMetrics { score, ..health };
            let changed = match &a.health {
                None => true,
                Some(c) => {
                    (c.score - smoothed.score).abs() >= 1.0
                        || c.hallucination_risk != smoothed.hallucination_risk
                        || c.latency_trend != smoothed.latency_trend
                }
            };
            a.health = Some(smoothed.clone());
            if changed {
                out.push(StoreEvent::Health { id: id.clone(), health: smoothed });
            }
        }
        out
    }

    // ── Reads ───────────────────────────────────────────────────────────────

    pub fn current(&self, id: &str) -> Option<&Current> {
        self.agent(id).map(|a| &a.current)
    }

    pub fn health(&self, id: &str) -> Option<&HealthMetrics> {
        self.index(id).and_then(|i| self.agents[i].health.as_ref())
    }

    pub fn anomalies(&self, id: &str) -> &[Anomaly] {
        self.index(id).map_or(&[], |i| &self.agents[i].anomalies)
    }

    /// Token-rate samples, oldest first.
    pub fn tokens(&self, id: &str) -> Option<&TimeSeries> {
        self.index(id).map(|i| &self.agents[i].tokens)
    }

    /// Progress samples (empty until the agent reports progress).
    pub fn progress(&self, id: &str) -> Option<&TimeSeries> {
        self.index(id).map(|i| &self.agents[i].progress)
    }

    pub fn progress_known(&self, id: &str) -> bool {
        self.index(id).is_some_and(|i| self.agents[i].progress_known)
    }

    pub fn stats(&self, id: &str, now: f64) -> Option<StreamStats> {
        let a = &self.agents[self.index(id)?];
        let s = a.stream.as_ref();
        Some(StreamStats {
            total_tokens: s.map_or(0.0, |s| s.total),
            ttft_ms: s.and_then(|s| s.ttft),
            inter_token_ms: s.and_then(|s| s.itl),
            tool: s.and_then(|s| s.tools.last().cloned()),
            status_ms: (now - a.status_since).max(0.0),
        })
    }
}

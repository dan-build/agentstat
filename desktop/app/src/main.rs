//! AgentStat for the desktop: every agent on this machine, live. Reads the
//! local service's stream (starting the service if needed) into the same core
//! store the npm chart uses, and draws a fleet list, the selected agent's
//! token rate and recent anomalies.

mod chart;
mod feed;
mod theme;

use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use agentstat_core::statuslog::StatusLog;
use agentstat_core::{AnomalyConfig, Event, Status, Store, StoreEvent, StoreOptions};
use futures::StreamExt;
use gpui::{
    AnyView, App, Application, Bounds, ClickEvent, Context, FocusHandle, Font, FontFeatures, FontStyle, FontWeight,
    Hsla, IntoElement, KeyBinding, MouseMoveEvent, Pixels, Render, SharedString, TitlebarOptions, Window, WindowBounds,
    WindowControlArea, WindowOptions, actions, canvas, div, point, prelude::*, px, size,
};

use crate::chart::{Block, Layer, Overlay, Series, Span};
use crate::feed::{Feed, Message};
use crate::theme::{DARK, LIGHT, Theme};

/// What the chart and sparklines show.
const WINDOW_MS: f64 = 60_000.0;
/// Health, detection and the status timers refresh this often.
const TICK: Duration = Duration::from_millis(500);
const RECENT_MAX: usize = 30;
/// Redraw interval while the chart scrolls: a 60 s window moves under half a
/// pixel per frame at this rate, so it looks continuous for a fraction of the
/// cost of every display frame.
const SCROLL_FRAME: Duration = Duration::from_millis(40);

actions!(agentstat, [SelectNext, SelectPrevious, TogglePause, Quit]);

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

#[derive(Clone, Copy, PartialEq)]
enum Conn {
    Connecting,
    Live,
    Reconnecting,
    NoService,
}

struct Recent {
    name: String,
    message: String,
    critical: bool,
    resolved: bool,
    at: f64,
}

/// What a paused view shows: every agent's data and statuses as of `at`, kept
/// so the frozen chart doesn't age while new data keeps arriving.
struct Frozen {
    at: f64,
    series: HashMap<String, Rc<Series>>,
    status: HashMap<String, StatusLog>,
}

/// macOS "Reduce motion", from the system's accessibility settings.
// The Objective-C macros check a cfg this crate doesn't declare.
#[allow(unexpected_cfgs)]
fn reduce_motion() -> bool {
    use objc::runtime::{NO, Object};
    use objc::{class, msg_send, sel, sel_impl};
    unsafe {
        let ws: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
        if ws.is_null() {
            return false;
        }
        let on: objc::runtime::BOOL = msg_send![ws, accessibilityDisplayShouldReduceMotion];
        on != NO
    }
}

/// Per-agent calls reported as blocks (what Claude Code sends).
#[derive(Default)]
struct Calls {
    /// Calls in the window, in order of their end.
    blocks: Vec<Block>,
    /// The latest call, kept after it leaves the window.
    last: Option<Block>,
    total: u64,
}

struct AgentStatApp {
    store: Store,
    calls: HashMap<String, Calls>,
    /// When each agent's last event arrived (app clock), so a silent agent
    /// doesn't keep the chart redrawing fast.
    heard: HashMap<String, f64>,
    cfg: AnomalyConfig,
    selected: Option<String>,
    conn: Conn,
    instance: Option<String>,
    recent: Vec<Recent>,
    /// A scroll redraw is already scheduled.
    frame_pending: bool,
    focus: FocusHandle,
    /// The selection last moved by keyboard: show the focus ring (until a click).
    keyboard: bool,
    /// The paused view (Space or the Pause button).
    frozen: Option<Frozen>,
    /// When pause was last toggled (a held Space repeats; one toggle per press).
    toggled_at: f64,
    /// Each agent's line, built once per update and shared by the list and the chart.
    cache: HashMap<String, Rc<Series>>,
    cache_dirty: bool,
    /// Pointer x over the chart, and the chart's bounds from its last paint.
    hover_x: Option<f32>,
    chart_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    /// macOS "Reduce motion": no continuous scroll, no breathing halo.
    reduce_motion: bool,
    /// AGENTSTAT_DEBUG: redraws since the last report, and whether the window was in front.
    debug: Option<(u32, bool, u32)>,
}

fn new_store() -> Store {
    // History for 1.5× the window: a minute on screen, ninety seconds kept.
    Store::new(
        Vec::new(),
        StoreOptions { window_seconds: Some(WINDOW_MS / 1000.0), max_history_points: 100_000 },
        now_ms(),
    )
}

impl AgentStatApp {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let port = std::env::var("AGENTSTAT_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(4318);
        let (tx, mut rx) = futures::channel::mpsc::unbounded();
        feed::spawn(port, tx);
        cx.spawn(async move |this, cx| {
            while let Some(f) = rx.next().await {
                if this.update(cx, |app, cx| app.on_feed(f, cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(TICK).await;
                if this.update(cx, |app, cx| app.tick(cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        cx.observe_window_appearance(window, |_, _, cx| cx.notify()).detach();
        let focus = cx.focus_handle();
        window.focus(&focus);
        AgentStatApp {
            store: new_store(),
            calls: HashMap::new(),
            heard: HashMap::new(),
            cfg: AnomalyConfig::default(),
            selected: None,
            conn: Conn::Connecting,
            instance: None,
            recent: Vec::new(),
            frame_pending: false,
            focus,
            keyboard: false,
            frozen: None,
            toggled_at: 0.0,
            cache: HashMap::new(),
            cache_dirty: true,
            hover_x: None,
            chart_bounds: Rc::new(Cell::new(None)),
            reduce_motion: reduce_motion(),
            debug: std::env::var_os("AGENTSTAT_DEBUG").map(|_| (0, false, 0)),
        }
    }

    fn on_feed(&mut self, f: Feed, cx: &mut Context<Self>) {
        let now = now_ms();
        match f {
            Feed::Connected { instance } => {
                // A different service run: what we had is gone (it replays its history).
                if self.instance.as_ref().is_some_and(|i| *i != instance) {
                    self.store = new_store();
                    self.calls.clear();
                    self.heard.clear();
                    self.recent.clear();
                }
                self.instance = Some(instance);
                self.conn = Conn::Live;
            }
            Feed::Disconnected => self.conn = Conn::Reconnecting,
            Feed::NoService => self.conn = Conn::NoService,
            Feed::Message(m) => {
                if self.conn != Conn::Live {
                    self.conn = Conn::Live;
                    cx.notify();
                }
                match m {
                    Message::Event { id, event } => {
                        let t = event.time().unwrap_or(now);
                        // A call reported when it ended (validated as the store does).
                        if let Event::Tokens { count: Some(count), total: None, since: Some(since), time: Some(t) } =
                            event
                            && count.is_finite()
                            && count > 0.0
                            && since.is_finite()
                            && t.is_finite()
                        {
                            let b = Block { since: since.min(t), t, count };
                            let c = self.calls.entry(id.clone()).or_default();
                            let at = c.blocks.partition_point(|x| x.t <= b.t);
                            c.blocks.insert(at, b);
                            if c.last.is_none_or(|l| b.t >= l.t) {
                                c.last = Some(b);
                            }
                            c.total += 1;
                        }
                        self.heard.insert(id.clone(), now);
                        self.store.ensure(&id, t, now);
                        self.store.push(&id, &event, now);
                    }
                    Message::Agent { id, name, color, config } => {
                        let band = config.map(|c| c.expected_tokens_per_sec);
                        self.store.describe(&id, name, color, band, now);
                    }
                    Message::Remove { id } => {
                        self.store.remove(&id);
                        self.calls.remove(&id);
                        self.heard.remove(&id);
                        if self.selected.as_deref() == Some(id.as_str()) {
                            self.selected = None;
                        }
                    }
                }
                // Data is drawn on the next tick (or frame, while animating), not
                // per message: a busy fleet would otherwise redraw constantly.
                self.cache_dirty = true;
                return;
            }
        }
        cx.notify();
    }

    fn tick(&mut self, cx: &mut Context<Self>) {
        let now = now_ms();
        if let Some((renders, active, ticks)) = &mut self.debug {
            *ticks += 1;
            if *ticks == 10 {
                eprintln!("agentstat-app: {:.1} redraws/s, window in front: {active}", *renders as f64 / 5.0);
                (*renders, *ticks) = (0, 0);
            }
        }
        for e in self.store.health_tick(now, true, &self.cfg) {
            let (name, a, resolved) = match e {
                StoreEvent::Anomaly { name, anomaly, .. } => (name, anomaly, false),
                StoreEvent::Resolved { name, anomaly, .. } => (name, anomaly, true),
                StoreEvent::Health { .. } => continue,
            };
            self.recent.push(Recent {
                name,
                message: a.message,
                critical: a.severity == agentstat_core::Severity::Critical,
                resolved,
                at: now,
            });
        }
        for c in self.calls.values_mut() {
            c.blocks.retain(|b| b.t >= now - WINDOW_MS);
        }
        let excess = self.recent.len().saturating_sub(RECENT_MAX);
        self.recent.drain(..excess);
        // Cheap (one system call), and follows the setting within half a second.
        self.reduce_motion = reduce_motion();
        self.cache_dirty = true;
        if self.selected.as_ref().is_none_or(|id| self.store.agent(id).is_none()) {
            self.selected = self.store.agents().next().map(|a| a.id.clone());
        }
        cx.notify();
    }
}

impl AgentStatApp {
    /// What to draw for an agent: its calls when it reports them as blocks,
    /// else its rate samples (a little before the window, for the curve's entry).
    fn build_series(&self, id: &str, now: f64) -> Series {
        match self.calls.get(id) {
            Some(c) => Series::Blocks(c.blocks.clone()),
            None => {
                Series::Samples(self.store.tokens(id).map(|t| t.since(now - WINDOW_MS - 2_000.0)).unwrap_or_default())
            }
        }
    }

    /// Rebuild every agent's line if data or time moved on since the last build.
    fn refresh(&mut self, now: f64) {
        if !self.cache_dirty {
            return;
        }
        let ids: Vec<String> = self.store.agents().map(|a| a.id.clone()).collect();
        self.cache = ids.into_iter().map(|id| (id.clone(), Rc::new(self.build_series(&id, now)))).collect();
        self.cache_dirty = false;
    }

    /// An agent's line as shown: frozen while paused, else current.
    fn series(&self, id: &str) -> Rc<Series> {
        let from = self.frozen.as_ref().map_or(&self.cache, |f| &f.series);
        from.get(id).cloned().unwrap_or_else(|| Rc::new(Series::Samples(Vec::new())))
    }

    fn paused_at(&self) -> Option<f64> {
        self.frozen.as_ref().map(|f| f.at)
    }
}

// ── Formatting ──────────────────────────────────────────────────────────────

fn ui_font(weight: FontWeight) -> Font {
    Font {
        family: ".SystemUIFont".into(),
        // Tabular figures, so live numbers don't jitter as they change.
        features: FontFeatures(Arc::new(vec![("tnum".into(), 1)])),
        fallbacks: None,
        weight,
        style: FontStyle::Normal,
    }
}

fn fmt_rate(v: f64) -> String {
    let v = v + 0.0;
    if v < 10.0 { format!("{v:.1}") } else { format!("{v:.0}") }
}

/// Axis labels: whole numbers, thousands as "k".
fn fmt_axis(v: f64) -> String {
    if v >= 1000.0 {
        format!("{}k", v / 1000.0)
    } else if v.fract() == 0.0 {
        format!("{v:.0}")
    } else {
        format!("{v:.1}")
    }
}

fn fmt_count(v: f64) -> String {
    let s = format!("{:.0}", v.max(0.0));
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn fmt_duration(ms: f64) -> String {
    let s = (ms / 1000.0).floor().max(0.0) as u64;
    match s {
        0..60 => format!("{s}s"),
        60..3600 => format!("{}m {:02}s", s / 60, s % 60),
        _ => format!("{}h {:02}m", s / 3600, s / 60 % 60),
    }
}

/// "active · 12s", "waiting on Bash · 4s".
fn status_line(status: Status, tool: Option<&str>, ms: f64) -> String {
    let word = match (status, tool) {
        (Status::Waiting, Some(t)) if !t.is_empty() => format!("waiting on {t}"),
        (s, _) => s.as_str().to_string(),
    };
    format!("{word} · {}", fmt_duration(ms))
}

// ── View ────────────────────────────────────────────────────────────────────

/// Height of the top bar: standard window chrome. It holds the window buttons
/// (placed so they sit fully inside the system title bar) and moves the window.
const BAR: f32 = 38.0;

/// An agent's identity: its series color, as on the chart.
fn swatch(color: Hsla) -> impl IntoElement {
    div().size(px(8.)).flex_shrink_0().rounded(px(2.)).bg(color)
}

fn dot(color: impl Into<Hsla>) -> impl IntoElement {
    div().size(px(6.)).flex_shrink_0().rounded_full().bg(color.into())
}

/// A tooltip with the full text of something truncated.
struct Tip {
    text: SharedString,
    theme: Theme,
}

impl Render for Tip {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .px_2()
            .py_1()
            .rounded_md()
            .bg(self.theme.surface)
            .border_1()
            .border_color(self.theme.border)
            .text_size(px(12.))
            .text_color(self.theme.text)
            .font(ui_font(FontWeight::NORMAL))
            .child(self.text.clone())
    }
}

fn tip(text: String, theme: Theme) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
    let text = SharedString::from(text);
    move |_, cx| cx.new(|_| Tip { text: text.clone(), theme }).into()
}

impl AgentStatApp {
    /// Move the selection up or down the list (from the keyboard: no animation).
    fn step(&mut self, delta: isize, cx: &mut Context<Self>) {
        let ids: Vec<String> = self.store.agents().map(|a| a.id.clone()).collect();
        if ids.is_empty() {
            return;
        }
        let at = self.selected.as_ref().and_then(|s| ids.iter().position(|i| i == s));
        let next = match at {
            Some(i) => (i as isize + delta).clamp(0, ids.len() as isize - 1) as usize,
            None => 0,
        };
        self.selected = Some(ids[next].clone());
        self.keyboard = true;
        cx.notify();
    }

    fn toggle_pause(&mut self, cx: &mut Context<Self>) {
        let now = now_ms();
        // Holding Space repeats the key; one toggle per press.
        if now - self.toggled_at < 250.0 {
            return;
        }
        self.toggled_at = now;
        self.frozen = match self.frozen {
            Some(_) => None,
            None => {
                self.cache_dirty = true;
                self.refresh(now);
                let ids: Vec<String> = self.store.agents().map(|a| a.id.clone()).collect();
                Some(Frozen {
                    at: now,
                    series: self.cache.clone(),
                    status: ids
                        .iter()
                        .filter_map(|id| Some((id.clone(), self.store.status_log(id)?.clone())))
                        .collect(),
                })
            }
        };
        cx.notify();
    }

    fn sidebar(&self, theme: &Theme, now: f64, focused: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let (conn_color, conn_text) = match self.conn {
            Conn::Live => (theme.ok, "Live"),
            Conn::Connecting => (theme.text_tertiary, "Connecting…"),
            Conn::Reconnecting => (theme.warning, "Reconnecting…"),
            Conn::NoService => (theme.critical, "No service"),
        };
        let span = Span { now: self.paused_at().unwrap_or(now), window_ms: WINDOW_MS };
        let rows = self.store.agents().enumerate().map(|(i, a)| {
            let id = a.id.clone();
            let selected = self.selected.as_deref() == Some(a.id.as_str());
            let stats = self.store.stats(&a.id, now);
            let tool = stats.as_ref().and_then(|s| s.tool.clone());
            let status_ms = stats.as_ref().map_or(0.0, |s| s.status_ms);
            let anomalies = self.store.anomalies(&a.id);
            let critical = anomalies.iter().any(|x| x.severity == agentstat_core::Severity::Critical);
            let series = self.series(&a.id);
            let color = theme.series(i);
            // Per-call agents have no instantaneous rate: show their output.
            let figure = if self.calls.contains_key(&a.id) {
                format!("{} tok", fmt_count(stats.as_ref().map_or(0.0, |s| s.total_tokens)))
            } else {
                format!("{} t/s", fmt_rate(a.current.tokens_rate))
            };
            let ring = selected && self.keyboard && focused;
            div()
                .id(SharedString::from(format!("agent-{}", a.id)))
                .mx_2()
                .px_3()
                .py_2()
                .rounded_md()
                // Always a 1px border, so showing the focus ring never shifts the row.
                .border_1()
                .border_color(if ring { theme.focus } else { gpui::transparent_black().into() })
                .flex()
                .items_center()
                .gap_3()
                .cursor_pointer()
                .when(selected, |d| d.bg(theme.selected))
                .hover(|d| d.bg(theme.selected))
                .tooltip(tip(a.name.clone(), *theme))
                .on_click(cx.listener(move |app, _: &ClickEvent, _, cx| {
                    app.selected = Some(id.clone());
                    app.keyboard = false;
                    cx.notify();
                }))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .gap_0p5()
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap_2()
                                .child(swatch(color))
                                .child(
                                    div().min_w_0().truncate().font(ui_font(FontWeight::MEDIUM)).child(a.name.clone()),
                                )
                                .when(!anomalies.is_empty(), |d| {
                                    let c = if critical { theme.critical } else { theme.warning };
                                    d.child(div().text_color(c).text_size(px(11.)).child(if critical {
                                        "◆"
                                    } else {
                                        "▲"
                                    }))
                                }),
                        )
                        .child(
                            div()
                                .pl(px(16.))
                                .truncate()
                                .text_size(px(12.))
                                .text_color(theme.status_text(a.current.status, theme.text_tertiary))
                                .child(status_line(a.current.status, tool.as_deref(), status_ms)),
                        ),
                )
                .child(
                    div()
                        .flex_shrink_0()
                        .flex()
                        .flex_col()
                        .items_end()
                        .gap_1()
                        .child(div().text_size(px(12.)).text_color(theme.text_secondary).child(figure))
                        .child(
                            canvas(
                                |_, _, _| {},
                                move |b: Bounds<Pixels>, _, window, _| {
                                    chart::paint_sparkline(window, b, &series, span, color)
                                },
                            )
                            .w(px(64.))
                            .h(px(18.)),
                        ),
                )
        });
        div()
            .w(px(288.))
            .h_full()
            .flex_shrink_0()
            .flex()
            .flex_col()
            .bg(theme.sidebar)
            .border_r_1()
            .border_color(theme.border)
            .child(
                // The window buttons sit at the left of this bar; it also moves the window.
                div()
                    .h(px(BAR))
                    .flex_shrink_0()
                    .px_5()
                    .flex()
                    .items_center()
                    .justify_end()
                    .window_control_area(WindowControlArea::Drag)
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_1p5()
                            .text_size(px(12.))
                            .text_color(theme.text_tertiary)
                            .child(dot(conn_color))
                            .child(conn_text),
                    ),
            )
            .child(div().id("fleet").flex_1().overflow_y_scroll().pb_3().flex().flex_col().gap_0p5().children(rows))
    }

    fn stat(theme: &Theme, label: &str, value: String) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .gap_0p5()
            .child(div().text_size(px(12.)).text_color(theme.text_tertiary).child(label.to_string()))
            .child(div().text_size(px(15.)).font(ui_font(FontWeight::MEDIUM)).child(value))
    }

    fn detail(&self, theme: &Theme, now: f64, cx: &mut Context<Self>) -> impl IntoElement {
        let agent = self.selected.as_deref().and_then(|id| self.store.agent(id));
        let Some(a) = agent else {
            let (title, hint) = match self.conn {
                Conn::NoService => {
                    ("The AgentStat service isn't installed", "Install it with: cargo install --path desktop/daemon")
                }
                _ => ("No agents yet", "Start one with: agentstat run -- claude"),
            };
            return div()
                .flex_1()
                .flex()
                .flex_col()
                .child(div().h(px(BAR)).flex_shrink_0().window_control_area(WindowControlArea::Drag))
                .child(
                    div()
                        .flex_1()
                        .flex()
                        .flex_col()
                        .items_center()
                        .justify_center()
                        .gap_1()
                        .pb(px(BAR))
                        .child(div().font(ui_font(FontWeight::MEDIUM)).child(title))
                        .child(div().text_color(theme.text_tertiary).child(hint)),
                )
                .into_any_element();
        };
        let span = Span { now: self.paused_at().unwrap_or(now), window_ms: WINDOW_MS };
        let index = self.store.agents().position(|x| x.id == a.id).unwrap_or(0);
        let color = theme.series(index);
        let stats = self.store.stats(&a.id, now);
        let tool = stats.as_ref().and_then(|s| s.tool.clone());
        let layers: Vec<Layer> = self
            .store
            .agents()
            .enumerate()
            .map(|(i, x)| Layer { series: self.series(&x.id), color: theme.series(i), emphasis: x.id == a.id })
            .collect();
        let peak = layers.iter().map(|l| l.series.peak()).fold(0.0, f64::max);
        let ceiling = chart::nice_ceiling(peak.max(5.0) * 1.1);
        // The inspected time under the pointer, and what the selected agent did then.
        let hover_t = match (self.hover_x, self.chart_bounds.get()) {
            (Some(x), Some(b)) => {
                let (bx, bw) = (f32::from(b.origin.x), f32::from(b.size.width));
                (x >= bx && x <= bx + bw && bw > 0.0)
                    .then(|| span.now - span.window_ms + ((x - bx) / bw) as f64 * span.window_ms)
            }
            _ => None,
        };
        let readout = hover_t.map(|t| {
            let value = layers.iter().find(|l| l.emphasis).and_then(|l| l.series.value_at(t));
            let status = match &self.frozen {
                Some(f) => f.status.get(&a.id).and_then(|log| log.status_at(t)),
                None => self.store.status_at(&a.id, t),
            };
            format!(
                "{} ago · {} · {}",
                fmt_duration(span.now - t),
                value.map_or("–".into(), |v| format!("{} t/s", fmt_rate(v))),
                status.map_or("–", |s| s.as_str())
            )
        });
        let animating = self.animating(now) && !self.reduce_motion;
        let pulse = if animating { 0.5 + 0.5 * ((now / 420.0).sin() as f32) } else { 0.5 };
        let overlay = Overlay { hover_t, pulse };
        let theme_c = *theme;
        let bounds_out = self.chart_bounds.clone();
        let y_label = |v: f64| div().text_size(px(11.)).text_color(theme.text_tertiary).child(fmt_axis(v));
        let tokens = fmt_count(stats.as_ref().map_or(0.0, |s| s.total_tokens));
        let errors = fmt_count(a.current.error_count.unwrap_or(0.0));
        let stats_row = match self.calls.get(&a.id) {
            // Calls reported when they end: what the last one did, and how many.
            Some(c) => {
                let last = c.last.as_ref();
                vec![
                    ("Output tokens", tokens),
                    ("Calls", fmt_count(c.total as f64)),
                    (
                        "Last call",
                        last.map_or("–".into(), |b| {
                            format!("{} tok · {:.1}s", fmt_count(b.count), (b.t - b.since) / 1000.0)
                        }),
                    ),
                    ("Last call rate", last.map_or("–".into(), |b| format!("{} t/s", fmt_rate(b.rate())))),
                    ("Errors", errors),
                ]
            }
            None => vec![
                ("Rate", format!("{} t/s", fmt_rate(a.current.tokens_rate))),
                ("Output tokens", tokens),
                ("Errors", errors),
            ],
        };
        let paused = self.frozen.is_some();

        div()
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .child(
                // The selected agent names the view; this bar also moves the window.
                div()
                    .h(px(BAR))
                    .flex_shrink_0()
                    .px_8()
                    .flex()
                    .items_center()
                    .gap_4()
                    .window_control_area(WindowControlArea::Drag)
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .items_center()
                            .gap_2()
                            .child(swatch(color))
                            .child(div().min_w_0().truncate().font(ui_font(FontWeight::SEMIBOLD)).child(a.name.clone()))
                            .child(
                                div()
                                    .flex_shrink_0()
                                    .text_color(theme.status_text(a.current.status, theme.text_tertiary))
                                    .child(status_line(
                                        a.current.status,
                                        tool.as_deref(),
                                        stats.as_ref().map_or(0.0, |s| s.status_ms),
                                    )),
                            ),
                    )
                    .child(
                        // Anything that keeps moving gets a pause control (also Space).
                        div()
                            .id("pause")
                            .flex_shrink_0()
                            .h(px(28.))
                            .px_3()
                            .rounded_md()
                            .flex()
                            .items_center()
                            .gap_1p5()
                            .cursor_pointer()
                            .text_size(px(12.))
                            .text_color(theme.text_secondary)
                            .bg(theme.selected)
                            .hover(|d| d.text_color(theme.text))
                            .tooltip(tip("Space".into(), *theme))
                            .on_click(cx.listener(|app, _: &ClickEvent, _, cx| app.toggle_pause(cx)))
                            .child(if paused { "▶" } else { "❚❚" })
                            .child(if paused { "Resume" } else { "Pause" }),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .flex_col()
                    .px_8()
                    .pt_2()
                    .pb_6()
                    .gap_6()
                    .child(
                        div()
                            .flex()
                            .gap_10()
                            .children(stats_row.into_iter().map(|(label, value)| Self::stat(theme, label, value))),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_h(px(180.))
                            .flex()
                            .flex_col()
                            .gap_2()
                            .child(
                                // The axis unit, or what's under the pointer.
                                div()
                                    .h(px(16.))
                                    .pl(px(40.))
                                    .text_size(px(12.))
                                    .text_color(if readout.is_some() {
                                        theme.text_secondary
                                    } else {
                                        theme.text_tertiary
                                    })
                                    .child(readout.unwrap_or_else(|| {
                                        if paused {
                                            "Paused · tokens per second".into()
                                        } else {
                                            "Tokens per second".into()
                                        }
                                    })),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .flex()
                                    .gap_3()
                                    .child(
                                        div()
                                            .flex()
                                            .flex_col()
                                            .justify_between()
                                            .items_end()
                                            .w(px(28.))
                                            .pb(px(18.))
                                            .child(y_label(ceiling))
                                            .child(y_label(ceiling / 2.0))
                                            .child(y_label(0.0)),
                                    )
                                    .child(
                                        div()
                                            .flex_1()
                                            .flex()
                                            .flex_col()
                                            .gap_1()
                                            .child(
                                                div()
                                                    .id("chart")
                                                    .flex_1()
                                                    .on_mouse_move(cx.listener(|app, e: &MouseMoveEvent, _, cx| {
                                                        app.hover_x = Some(f32::from(e.position.x));
                                                        cx.notify();
                                                    }))
                                                    .on_hover(cx.listener(|app, hovered: &bool, _, cx| {
                                                        if !*hovered {
                                                            app.hover_x = None;
                                                            cx.notify();
                                                        }
                                                    }))
                                                    .child(
                                                        canvas(
                                                            |_, _, _| {},
                                                            move |b: Bounds<Pixels>, _, window, _| {
                                                                bounds_out.set(Some(b));
                                                                chart::paint_chart(
                                                                    window, b, &layers, span, ceiling, &theme_c,
                                                                    &overlay,
                                                                )
                                                            },
                                                        )
                                                        .size_full(),
                                                    ),
                                            )
                                            .child(
                                                div()
                                                    .flex()
                                                    .justify_between()
                                                    .text_size(px(11.))
                                                    .text_color(theme.text_tertiary)
                                                    .child("−60s")
                                                    .child("−30s")
                                                    .child(if paused { "paused" } else { "now" }),
                                            ),
                                    ),
                            ),
                    )
                    .child(self.recent_list(theme, now)),
            )
            .into_any_element()
    }

    fn recent_list(&self, theme: &Theme, now: f64) -> impl IntoElement {
        let rows = self.recent.iter().rev().take(4).map(|r| {
            let (glyph, c) = match (r.resolved, r.critical) {
                (true, _) => ("✓", theme.text_tertiary),
                (false, true) => ("◆", theme.critical),
                (false, false) => ("▲", theme.warning),
            };
            div()
                .flex()
                .items_center()
                .gap_2()
                .text_size(px(12.))
                .child(div().w(px(12.)).text_color(c).child(glyph))
                .child(div().flex_shrink_0().font(ui_font(FontWeight::MEDIUM)).child(r.name.clone()))
                .child(div().flex_1().min_w_0().truncate().text_color(theme.text_secondary).child(if r.resolved {
                    format!("resolved: {}", r.message)
                } else {
                    r.message.clone()
                }))
                .child(
                    div()
                        .flex_shrink_0()
                        .text_color(theme.text_tertiary)
                        .child(format!("{} ago", fmt_duration(now - r.at))),
                )
        });
        div()
            .flex()
            .flex_col()
            .gap_2()
            .pt_4()
            .border_t_1()
            .border_color(theme.border)
            .child(div().text_size(px(12.)).text_color(theme.text_tertiary).child("Recent anomalies"))
            .when(self.recent.is_empty(), |d| {
                d.child(div().text_size(px(12.)).text_color(theme.text_tertiary).child("None so far."))
            })
            .children(rows)
    }

    /// Whether anything on the chart is moving: some agent's data is still in
    /// view, so the lines scroll. (A hidden or covered window draws nothing.)
    fn animating(&self, now: f64) -> bool {
        self.frozen.is_none()
            && (self.heard.values().any(|t| now - t < WINDOW_MS)
                || self.store.agents().any(|a| a.current.tokens_rate > 0.0))
    }
}

impl Render for AgentStatApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = match window.appearance() {
            gpui::WindowAppearance::Dark | gpui::WindowAppearance::VibrantDark => DARK,
            _ => LIGHT,
        };
        let now = now_ms();
        // Each frame moves the view; the lines' data only changes with updates.
        self.refresh(now);
        // Scroll smoothly while anything on the chart moves, focused or not (you
        // watch it while working elsewhere); never with Reduce Motion. The system
        // stops drawing a covered or minimized window, so that costs nothing.
        let smooth = self.animating(now) && !self.reduce_motion;
        if smooth && !self.frame_pending {
            self.frame_pending = true;
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(SCROLL_FRAME).await;
                this.update(cx, |app, cx| {
                    app.frame_pending = false;
                    cx.notify();
                })
                .ok();
            })
            .detach();
        }
        if let Some((renders, active, _)) = &mut self.debug {
            *renders += 1;
            *active = window.is_window_active();
        }
        let focused = self.focus.is_focused(window);
        div()
            .size_full()
            .flex()
            .bg(theme.bg)
            .text_color(theme.text)
            .text_size(px(13.))
            .font(ui_font(FontWeight::NORMAL))
            .track_focus(&self.focus)
            .key_context("AgentStat")
            .on_action(cx.listener(|app, _: &SelectNext, _, cx| app.step(1, cx)))
            .on_action(cx.listener(|app, _: &SelectPrevious, _, cx| app.step(-1, cx)))
            .on_action(cx.listener(|app, _: &TogglePause, _, cx| app.toggle_pause(cx)))
            .child(self.sidebar(&theme, now, focused, cx))
            .child(self.detail(&theme, now, cx))
    }
}

fn main() {
    Application::new().run(|cx: &mut App| {
        cx.bind_keys([
            KeyBinding::new("down", SelectNext, Some("AgentStat")),
            KeyBinding::new("up", SelectPrevious, Some("AgentStat")),
            KeyBinding::new("j", SelectNext, Some("AgentStat")),
            KeyBinding::new("k", SelectPrevious, Some("AgentStat")),
            KeyBinding::new("space", TogglePause, Some("AgentStat")),
            KeyBinding::new("cmd-q", Quit, None),
            KeyBinding::new("cmd-w", Quit, None),
        ]);
        cx.on_action(|_: &Quit, cx| cx.quit());
        let bounds = Bounds::centered(None, size(px(1080.), px(680.)), cx);
        let window = cx
            .open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    // Content runs to the top: the columns are full height, and the
                    // app's name isn't repeated inside the window.
                    titlebar: Some(TitlebarOptions {
                        title: Some("AgentStat".into()),
                        appears_transparent: true,
                        traffic_light_position: Some(point(px(14.), px(12.))),
                    }),
                    window_min_size: Some(size(px(760.), px(480.))),
                    focus: true,
                    ..Default::default()
                },
                |window, cx| cx.new(|cx| AgentStatApp::new(window, cx)),
            )
            .expect("open window");
        window
            .update(cx, |_, window, cx| {
                // Closing the window quits (the service keeps running for the agents).
                window.on_window_should_close(cx, |_, cx| {
                    cx.quit();
                    true
                });
            })
            .ok();
        cx.activate(true);
    });
}

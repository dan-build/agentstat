//! AgentStat for the desktop: every agent on this machine, live. Reads the
//! local service's stream (starting the service if needed) into the same core
//! store the npm chart uses, and draws a fleet list, the selected agent's
//! token rate and recent anomalies.

mod chart;
mod feed;
mod theme;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use agentstat_core::{AnomalyConfig, Event, Status, Store, StoreEvent, StoreOptions};
use futures::StreamExt;
use gpui::{
    App, Application, Bounds, ClickEvent, Context, Font, FontFeatures, FontStyle, FontWeight, Hsla, IntoElement,
    Pixels, Render, SharedString, TitlebarOptions, Window, WindowBounds, WindowOptions, canvas, div, prelude::*, px,
    size,
};

use crate::chart::{Block, Series, Span};
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
/// An agent silent this long scrolls with the half-second tick only.
const QUIET_MS: f64 = 10_000.0;

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
        if self.selected.as_ref().is_none_or(|id| self.store.agent(id).is_none()) {
            self.selected = self.store.agents().next().map(|a| a.id.clone());
        }
        cx.notify();
    }
}

impl AgentStatApp {
    /// What to draw for an agent: its calls when it reports them as blocks,
    /// else its rate samples.
    fn series(&self, id: &str, now: f64) -> Series {
        match self.calls.get(id) {
            Some(c) => Series::Blocks(c.blocks.clone()),
            None => Series::Samples(self.store.tokens(id).map(|t| t.since(now - WINDOW_MS)).unwrap_or_default()),
        }
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

fn dot(color: Hsla) -> impl IntoElement {
    div().size(px(7.)).flex_shrink_0().rounded_full().bg(color)
}

impl AgentStatApp {
    fn sidebar(&self, theme: &Theme, now: f64, cx: &mut Context<Self>) -> impl IntoElement {
        let (conn_color, conn_text) = match self.conn {
            Conn::Live => (theme.status(Status::Active), "Live"),
            Conn::Connecting => (theme.status(Status::Complete), "Connecting…"),
            Conn::Reconnecting => (Hsla::from(theme.warning), "Reconnecting…"),
            Conn::NoService => (Hsla::from(theme.critical), "No service"),
        };
        let rows = self.store.agents().enumerate().map(|(i, a)| {
            let id = a.id.clone();
            let selected = self.selected.as_deref() == Some(a.id.as_str());
            let stats = self.store.stats(&a.id, now);
            let tool = stats.as_ref().and_then(|s| s.tool.clone());
            let status_ms = stats.as_ref().map_or(0.0, |s| s.status_ms);
            let anomalies = self.store.anomalies(&a.id);
            let mark = anomalies.iter().any(|x| x.severity == agentstat_core::Severity::Critical);
            let series = self.series(&a.id, now);
            let color = theme.series(i);
            // Per-call agents have no instantaneous rate: show their output.
            let figure = if self.calls.contains_key(&a.id) {
                format!("{} tok", fmt_count(stats.as_ref().map_or(0.0, |s| s.total_tokens)))
            } else {
                format!("{} t/s", fmt_rate(a.current.tokens_rate))
            };
            div()
                .id(SharedString::from(format!("agent-{}", a.id)))
                .mx_2()
                .px_3()
                .py_2()
                .rounded_md()
                .flex()
                .items_center()
                .gap_3()
                .cursor_pointer()
                .when(selected, |d| d.bg(theme.selected))
                .hover(|d| d.bg(theme.selected))
                .on_click(cx.listener(move |app, _: &ClickEvent, _, cx| {
                    app.selected = Some(id.clone());
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
                                .child(dot(theme.status(a.current.status)))
                                .child(
                                    div().min_w_0().truncate().font(ui_font(FontWeight::MEDIUM)).child(a.name.clone()),
                                )
                                .when(!anomalies.is_empty(), |d| {
                                    let c = if mark { theme.critical } else { theme.warning };
                                    d.child(div().text_color(c).text_size(px(11.)).child(if mark {
                                        "◆"
                                    } else {
                                        "▲"
                                    }))
                                }),
                        )
                        .child(
                            div()
                                .pl(px(15.))
                                .truncate()
                                .text_size(px(12.))
                                .text_color(theme.text_tertiary)
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
                                    chart::paint_sparkline(
                                        window,
                                        b,
                                        &series,
                                        Span { now, window_ms: WINDOW_MS },
                                        color,
                                    )
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
                div()
                    .px_5()
                    .pt_5()
                    .pb_4()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(div().font(ui_font(FontWeight::SEMIBOLD)).child("AgentStat"))
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

    fn detail(&self, theme: &Theme, now: f64) -> impl IntoElement {
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
                .items_center()
                .justify_center()
                .gap_1()
                .child(div().font(ui_font(FontWeight::MEDIUM)).child(title))
                .child(div().text_color(theme.text_tertiary).child(hint))
                .into_any_element();
        };
        let index = self.store.agents().position(|x| x.id == a.id).unwrap_or(0);
        let color = theme.series(index);
        let stats = self.store.stats(&a.id, now);
        let tool = stats.as_ref().and_then(|s| s.tool.clone());
        let series = self.series(&a.id, now);
        let ceiling = chart::nice_ceiling(series.peak().max(5.0) * 1.1);
        let theme_c = *theme;
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

        div()
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .px_8()
            .pt_6()
            .pb_6()
            .gap_6()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(
                        div().text_size(px(17.)).font(ui_font(FontWeight::SEMIBOLD)).truncate().child(a.name.clone()),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .text_color(theme.text_secondary)
                            .child(dot(theme.status(a.current.status)))
                            .child(status_line(
                                a.current.status,
                                tool.as_deref(),
                                stats.as_ref().map_or(0.0, |s| s.status_ms),
                            )),
                    ),
            )
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
                                canvas(
                                    |_, _, _| {},
                                    move |b: Bounds<Pixels>, _, window, _| {
                                        chart::paint_chart(
                                            window,
                                            b,
                                            &series,
                                            Span { now, window_ms: WINDOW_MS },
                                            ceiling,
                                            color,
                                            &theme_c,
                                        )
                                    },
                                )
                                .flex_1()
                                .w_full(),
                            )
                            .child(
                                div()
                                    .flex()
                                    .justify_between()
                                    .text_size(px(11.))
                                    .text_color(theme.text_tertiary)
                                    .child("−60s")
                                    .child("−30s")
                                    .child("now"),
                            ),
                    ),
            )
            .child(self.recent_list(theme, now))
            .into_any_element()
    }

    fn recent_list(&self, theme: &Theme, now: f64) -> impl IntoElement {
        let rows = self.recent.iter().rev().take(5).map(|r| {
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
}

impl Render for AgentStatApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = match window.appearance() {
            gpui::WindowAppearance::Dark | gpui::WindowAppearance::VibrantDark => DARK,
            _ => LIGHT,
        };
        let now = now_ms();
        // Scroll smoothly while the selected agent is working and the window is
        // in front; otherwise the half-second tick is enough.
        let busy = self.selected.as_deref().and_then(|id| self.store.agent(id)).is_some_and(|a| {
            let recent = self.heard.get(&a.id).is_some_and(|t| now - t < QUIET_MS);
            a.current.tokens_rate > 0.0 || (a.current.status != Status::Complete && recent)
        });
        if busy && window.is_window_active() && !self.frame_pending {
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
        div()
            .size_full()
            .flex()
            .bg(theme.bg)
            .text_color(theme.text)
            .text_size(px(13.))
            .font(ui_font(FontWeight::NORMAL))
            .child(self.sidebar(&theme, now, cx))
            .child(self.detail(&theme, now))
    }
}

fn main() {
    Application::new().run(|cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(1080.), px(680.)), cx);
        let window = cx
            .open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    titlebar: Some(TitlebarOptions { title: Some("AgentStat".into()), ..Default::default() }),
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

//! Claude Code and Codex as AgentStat events: one agent per session (and per
//! subagent). Both have hooks of the same shape (`session_id`, `cwd`,
//! `hook_event_name`, `tool_name`, `tool_use_id`, `agent_id`), so one mapper
//! reads either; their telemetry differs and has a reader each.
//!
//! Two sources, used together:
//! - Hooks (the AgentStat plugin): a turn starting and ending, each tool
//!   starting and ending, subagents, and the project, as they happen.
//! - OpenTelemetry: each model call when it finishes (`api_request`, with its
//!   output tokens and duration). Without hooks it also stands in for them:
//!   tools from `tool_decision`/`tool_result`, a turn's end from
//!   `assistant_response` (debounced, since one also precedes each tool call).
//!
//! When a session has hooks, they own its status and tools, and telemetry adds
//! only token counts, so the two never double up. Prompt, response and tool
//! text is never read: only names, ids and timings.

use std::collections::HashMap;

use agentstat_core::Event;

use crate::otlp::Record;

/// What the mapper produced for one record.
#[derive(Clone, Debug, PartialEq)]
pub enum Output {
    /// A session's display name (when first seen, or when it learns its project).
    New {
        id: String,
        name: String,
    },
    Event {
        id: String,
        event: Event,
    },
    /// Something the person should know about now (see [`Reason`]).
    Attention {
        id: String,
        reason: Reason,
        message: String,
        /// The app the session runs in (its bundle id), to bring it forward.
        app: Option<String>,
        time: f64,
    },
    /// What a model call cost (for the day's history), in US dollars.
    Cost {
        id: String,
        usd: f64,
    },
}

/// What a model call (or a Codex turn) cost, when telemetry reports a sane amount.
fn cost_of(tool: Tool, r: &Record, key: &str, attr: &str) -> Option<Output> {
    let usd = r.num(attr).filter(|c| c.is_finite() && *c > 0.0 && *c < 1_000.0)?;
    Some(Output::Cost { id: tool.agent_id(key), usd })
}

/// The coding agent a mapper reads.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Tool {
    #[default]
    Claude,
    Codex,
    Cursor,
    Gemini,
}

impl Tool {
    /// The agent id for a session key (`<session>` or `<session>/<subagent>`).
    pub fn agent_id(self, key: &str) -> String {
        format!("{}{key}", self.prefix())
    }

    fn prefix(self) -> &'static str {
        match self {
            Tool::Claude => "claude:",
            Tool::Codex => "codex:",
            Tool::Cursor => "cursor:",
            Tool::Gemini => "gemini:",
        }
    }

    /// Shown until a session learns its project.
    fn label(self) -> &'static str {
        match self {
            Tool::Claude => "Claude Code",
            Tool::Codex => "Codex",
            Tool::Cursor => "Cursor",
            Tool::Gemini => "Gemini CLI",
        }
    }
}

/// Why an agent needs attention.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Reason {
    /// Waiting on the person: a permission prompt or a question.
    NeedsYou,
    /// A long turn finished.
    Done,
    /// A turn ended in an error.
    Failed,
    /// Critical stall (from the detectors).
    Stalled,
    /// Critical runaway (from the detectors).
    Runaway,
    /// The day's cost or output tokens reached a share of the budget.
    Budget,
}

/// Sessions tracked at once; records for more are ignored (a local process
/// could otherwise grow the service without bound).
pub const MAX_SESSIONS: usize = 200;
const MAX_ID_LEN: usize = 128;
/// A finished turn is worth a notification only if it took at least this long.
pub const DONE_MIN_MS: f64 = 60_000.0;
const MAX_APP_LEN: usize = 100;
/// A complete assistant message is the end of the turn only if no more work
/// follows this soon (the message that asks for a tool comes just before it runs).
pub const FINISH_DELAY_MS: f64 = 1_500.0;
/// Gemini CLI without hooks: a turn is over after this long without news.
pub const GEMINI_QUIET_MS: f64 = 30_000.0;

#[derive(Default)]
struct Session {
    /// Tools approved and not yet returned: (tool_use_id, name).
    tools: Vec<(String, String)>,
    /// The name that went out last (with its first event, or after a rename).
    announced: Option<String>,
    /// Its display name, once known (the project, from hooks).
    name: Option<String>,
    /// Hooks report this session, so telemetry only adds tokens.
    hooks: bool,
    /// Between turns (after a finish, before the next start): late token
    /// counts are recorded without making the agent look busy again.
    idle: bool,
    /// Latest event time emitted, so backdated starts never go before it.
    last_t: f64,
    /// A finish waiting to see if more work follows: (its time, when received).
    finish: Option<(f64, f64)>,
    /// When the current turn started (hooks), for "finished after …".
    turn_since: Option<f64>,
    /// The app the session runs in (bundle id from the plugin), if known.
    app: Option<String>,
    /// When the model call in flight started (Codex reports its tokens
    /// separately from its timing).
    call_since: Option<f64>,
    /// Cursor: it reports prompts (the editor does; its CLI doesn't).
    prompted: bool,
    /// When a hook last came for it.
    heard: f64,
}

/// Turns one coding agent's hooks and telemetry into AgentStat events.
#[derive(Default)]
pub struct Mapper {
    tool: Tool,
    sessions: HashMap<String, Session>,
    /// Codex subagent ids (from hooks) to their session keys: a subagent's
    /// telemetry carries its own id, its hooks its parent's session.
    aliases: HashMap<String, String>,
}

/// Whether a record comes from Claude Code.
pub fn is_claude(r: &Record) -> bool {
    r.name.starts_with("claude_code.") || r.resource.get("service.name").and_then(|v| v.as_str()) == Some("claude-code")
}

/// Whether a record comes from Codex (its event name is an attribute).
pub fn is_codex(r: &Record) -> bool {
    codex_event(r).is_some()
}

/// Whether a record comes from Gemini CLI (its event name is an attribute).
pub fn is_gemini(r: &Record) -> bool {
    r.str("event.name").is_some_and(|n| n.starts_with("gemini_cli."))
}

/// A Codex record's event name without its `codex.` prefix.
fn codex_event(r: &Record) -> Option<&str> {
    r.str("event.name").unwrap_or(&r.name).strip_prefix("codex.")
}

/// Emit `events` for a session: its name first if it isn't out yet (or
/// changed), and every time kept at or after the last one emitted.
fn emit(tool: Tool, key: &str, s: &mut Session, events: Vec<Event>, out: &mut Vec<Output>) {
    let name =
        s.name.clone().unwrap_or_else(|| format!("{} {}", tool.label(), key.chars().take(8).collect::<String>()));
    // Nothing new to say: no events, and no (new) name worth announcing on its own.
    if events.is_empty() && (s.name.is_none() || s.announced.as_ref() == Some(&name)) {
        return;
    }
    let id = tool.agent_id(key);
    if s.announced.as_ref() != Some(&name) {
        s.announced = Some(name.clone());
        out.push(Output::New { id: id.clone(), name });
    }
    for mut event in events {
        let t = event.time().unwrap_or(s.last_t).max(s.last_t);
        set_time(&mut event, t);
        s.last_t = t;
        out.push(Output::Event { id: id.clone(), event });
    }
}

/// "45s", "4m 12s", "1h 03m".
fn duration(ms: f64) -> String {
    let s = (ms / 1000.0).round() as u64;
    match s {
        0..60 => format!("{s}s"),
        60..3600 => format!("{}m {:02}s", s / 60, s % 60),
        _ => format!("{}h {:02}m", s / 3600, s % 3600 / 60),
    }
}

fn set_time(e: &mut Event, t: f64) {
    match e {
        Event::Start { time }
        | Event::Tokens { time, .. }
        | Event::ToolStart { time, .. }
        | Event::ToolEnd { time, .. }
        | Event::Error { time }
        | Event::Finish { time }
        | Event::Cost { time, .. } => *time = Some(t),
    }
}

impl Mapper {
    /// A mapper for `tool`'s sessions.
    pub fn new(tool: Tool) -> Self {
        Mapper { tool, ..Mapper::default() }
    }

    /// Map one record received at `now` (records must arrive oldest first per session).
    pub fn map(&mut self, r: &Record, now: f64) -> Vec<Output> {
        if self.tool == Tool::Codex {
            return self.map_codex(r, now);
        }
        if self.tool == Tool::Gemini {
            return self.map_gemini(r, now);
        }
        let tool = self.tool;
        let mut out = Vec::new();
        let Some(sid) = r.str("session.id").filter(|s| !s.is_empty() && s.len() <= MAX_ID_LEN) else {
            return out;
        };
        if !self.sessions.contains_key(sid) {
            if self.sessions.len() >= MAX_SESSIONS {
                return out;
            }
            self.sessions.insert(sid.to_string(), Session::default());
        }
        let s = self.sessions.get_mut(sid).expect("inserted above");
        let t = r.time;
        let mut events = Vec::new();
        let event = r.name.strip_prefix("claude_code.").unwrap_or(&r.name);
        // With hooks, turns and tools come from them; telemetry adds the tokens.
        if s.hooks {
            if event == "api_request" {
                let since = t - r.num("duration_ms").unwrap_or(0.0);
                let count = r.num("output_tokens").unwrap_or(0.0);
                events.push(Event::Tokens { count: Some(count), total: None, since: Some(since), time: Some(t) });
                // A turn's last call is exported about a second after it ended:
                // count it, and leave the agent finished.
                if s.idle {
                    events.push(Event::Finish { time: Some(t) });
                }
            }
            emit(tool, sid, s, events, &mut out);
            if event == "api_request" {
                out.extend(cost_of(tool, r, sid, "cost_usd"));
            }
            return out;
        }
        match event {
            "user_prompt" => {
                s.tools.clear();
                s.finish = None;
                events.push(Event::Start { time: Some(t) });
            }
            "tool_decision" if r.str("decision") == Some("accept") => {
                s.finish = None;
                let name = r.str("tool_name").unwrap_or_default().to_string();
                s.tools.push((r.str("tool_use_id").unwrap_or_default().to_string(), name.clone()));
                events.push(Event::ToolStart { name: Some(name), time: Some(t) });
            }
            "tool_result" => {
                s.finish = None;
                let name = r.str("tool_name").unwrap_or_default().to_string();
                let use_id = r.str("tool_use_id").unwrap_or_default();
                // The call with this id; by name only when the id is unknown (parallel
                // calls of one tool must each close their own).
                let open = s
                    .tools
                    .iter()
                    .rposition(|(u, _)| !use_id.is_empty() && u == use_id)
                    .or_else(|| s.tools.iter().rposition(|(_, n)| *n == name));
                match open {
                    Some(i) => {
                        s.tools.remove(i);
                    }
                    // Ran without a decision event: it began `duration_ms` ago.
                    None => {
                        let since = t - r.num("duration_ms").unwrap_or(0.0);
                        events.push(Event::ToolStart { name: Some(name.clone()), time: Some(since) });
                    }
                }
                let error =
                    r.str("success").map(|v| v != "true").or_else(|| r.attrs.get("success")?.as_bool().map(|b| !b));
                events.push(Event::ToolEnd { name: Some(name), error, time: Some(t) });
            }
            "api_request" => {
                s.finish = None;
                // One block of output over the call. A call made while a tool
                // runs (logged when it finished) doesn't end the wait.
                let since = t - r.num("duration_ms").unwrap_or(0.0);
                if s.tools.is_empty() {
                    events.push(Event::Start { time: Some(since) });
                }
                let count = r.num("output_tokens").unwrap_or(0.0);
                events.push(Event::Tokens { count: Some(count), total: None, since: Some(since), time: Some(t) });
            }
            "api_error" => events.push(Event::Error { time: Some(t) }),
            "assistant_response" if s.tools.is_empty() => s.finish = Some((t, now)),
            _ => {}
        }
        emit(tool, sid, s, events, &mut out);
        if event == "api_request" {
            out.extend(cost_of(tool, r, sid, "cost_usd"));
        }
        out
    }

    /// Map one Codex telemetry record. Codex logs each finished model call's
    /// tokens (`sse_event` of kind `response.completed`), its timing
    /// (`api_request`), each tool's decision and result, and an estimated cost
    /// per turn (`turn_cost`). It reads only names, ids, counts and timings:
    /// never the prompt, output or account fields Codex also sends.
    fn map_codex(&mut self, r: &Record, now: f64) -> Vec<Output> {
        let tool = self.tool;
        let mut out = Vec::new();
        let Some(event) = codex_event(r) else { return out };
        let Some(cid) = r.str("conversation.id").filter(|s| !s.is_empty() && s.len() <= MAX_ID_LEN) else {
            return out;
        };
        // A subagent's records carry its own id; its hooks put it under its parent.
        let key = self.aliases.get(cid).cloned().unwrap_or_else(|| cid.to_string());
        if !self.sessions.contains_key(&key) {
            if self.sessions.len() >= MAX_SESSIONS {
                return out;
            }
            self.sessions.insert(key.clone(), Session::default());
        }
        let s = self.sessions.get_mut(&key).expect("inserted above");
        let t = r.time;
        let mut events = Vec::new();
        let completed = event == "sse_event"
            && r.str("event.kind") == Some("response.completed")
            && r.str("error.message").is_none_or(str::is_empty);
        if event == "api_request" {
            // The call's request; its tokens come when its response completes.
            s.call_since = Some(t - r.num("duration_ms").unwrap_or(0.0));
        }
        // The block of output since the call started (a second, if its start was missed).
        let tokens = |s: &mut Session| {
            let since = s.call_since.take().filter(|c| *c <= t && t - c < 600_000.0).unwrap_or(t - 1_000.0);
            let count = r.num("output_token_count").unwrap_or(0.0);
            (since, Event::Tokens { count: Some(count), total: None, since: Some(since), time: Some(t) })
        };
        // With hooks, turns and tools come from them; telemetry adds tokens and cost.
        if s.hooks {
            if completed {
                events.push(tokens(s).1);
                if s.idle {
                    events.push(Event::Finish { time: Some(t) });
                }
            }
            emit(tool, &key, s, events, &mut out);
            if event == "turn_cost" {
                out.extend(cost_of(tool, r, &key, "usage.estimated_usd"));
            }
            return out;
        }
        match event {
            "user_prompt" => {
                s.tools.clear();
                s.finish = None;
                events.push(Event::Start { time: Some(t) });
            }
            "api_request" => {
                s.finish = None;
                let failed = r.str("error.message").is_some_and(|m| !m.is_empty());
                if failed {
                    events.push(Event::Error { time: Some(t) });
                }
            }
            "tool_decision" if r.str("decision").is_some_and(|d| d.starts_with("approved")) => {
                s.finish = None;
                let name = r.str("tool_name").unwrap_or_default().to_string();
                s.tools.push((r.str("call_id").unwrap_or_default().to_string(), name.clone()));
                events.push(Event::ToolStart { name: Some(name), time: Some(t) });
            }
            "tool_result" => {
                s.finish = None;
                let name = r.str("tool_name").unwrap_or_default().to_string();
                let call = r.str("call_id").unwrap_or_default();
                let open = s
                    .tools
                    .iter()
                    .rposition(|(u, _)| !call.is_empty() && u == call)
                    .or_else(|| s.tools.iter().rposition(|(_, n)| *n == name));
                match open {
                    Some(i) => {
                        s.tools.remove(i);
                    }
                    // Ran without asking (approved by policy): it began `duration_ms` ago.
                    None => {
                        let since = t - r.num("duration_ms").unwrap_or(0.0);
                        events.push(Event::ToolStart { name: Some(name.clone()), time: Some(since) });
                    }
                }
                let error = r.str("success").map(|v| v != "true");
                events.push(Event::ToolEnd { name: Some(name), error, time: Some(t) });
            }
            _ if completed => {
                let (since, ev) = tokens(s);
                if s.tools.is_empty() {
                    events.push(Event::Start { time: Some(since) });
                    // The turn's last reply, unless more work follows soon.
                    s.finish = Some((t, now));
                }
                events.push(ev);
            }
            // The turn is over (Codex logs its cost when it ends).
            "turn_cost" => {
                s.tools.clear();
                s.finish = None;
                events.push(Event::Finish { time: Some(t) });
            }
            _ => {}
        }
        emit(tool, &key, s, events, &mut out);
        if event == "turn_cost" {
            out.extend(cost_of(tool, r, &key, "usage.estimated_usd"));
        }
        out
    }

    /// Map one Gemini CLI telemetry record. Gemini logs each model response's
    /// tokens and timing (`api_response`), each finished tool (`tool_call`,
    /// with its start time), each prompt and each failed request. It reads only
    /// names, counts and timings: never the prompt or response text Gemini
    /// also logs unless told not to.
    fn map_gemini(&mut self, r: &Record, now: f64) -> Vec<Output> {
        let tool = self.tool;
        let mut out = Vec::new();
        let Some(event) = r.str("event.name").and_then(|n| n.strip_prefix("gemini_cli.")) else { return out };
        let Some(sid) = r.str("session.id").filter(|s| !s.is_empty() && s.len() <= MAX_ID_LEN) else { return out };
        if !self.sessions.contains_key(sid) {
            if self.sessions.len() >= MAX_SESSIONS {
                return out;
            }
            self.sessions.insert(sid.to_string(), Session::default());
        }
        let s = self.sessions.get_mut(sid).expect("inserted above");
        let t = r.time;
        let mut events = Vec::new();
        // Output of a model response: its answer and its thinking.
        let response = || {
            let since = t - r.num("duration_ms").unwrap_or(0.0);
            let count = r.num("output_token_count").unwrap_or(0.0) + r.num("thoughts_token_count").unwrap_or(0.0);
            (since, Event::Tokens { count: Some(count), total: None, since: Some(since), time: Some(t) })
        };
        if s.hooks {
            if event == "api_response" {
                events.push(response().1);
                if s.idle {
                    events.push(Event::Finish { time: Some(t) });
                }
            }
            emit(tool, sid, s, events, &mut out);
            return out;
        }
        match event {
            "user_prompt" => {
                s.tools.clear();
                s.finish = None;
                events.push(Event::Start { time: Some(t) });
            }
            "api_response" => {
                let (since, ev) = response();
                if s.tools.is_empty() {
                    events.push(Event::Start { time: Some(since) });
                    // The turn's last reply, unless more work follows. Gemini
                    // logs a tool only once it's done, so a reply that asked
                    // for one looks the same: wait for a longer quiet.
                    s.finish = Some((t, now + GEMINI_QUIET_MS - FINISH_DELAY_MS));
                }
                events.push(ev);
            }
            "tool_call" => {
                s.finish = None;
                let name = r.str("function_name").unwrap_or_default().to_string();
                let start = r.num("start_time").filter(|x| *x <= t).unwrap_or(t - r.num("duration_ms").unwrap_or(0.0));
                let error =
                    r.str("success").map(|v| v != "true").or_else(|| r.attrs.get("success")?.as_bool().map(|b| !b));
                events.push(Event::ToolStart { name: Some(name.clone()), time: Some(start) });
                events.push(Event::ToolEnd { name: Some(name), error, time: Some(t) });
            }
            "api_error" => {
                s.finish = None;
                events.push(Event::Error { time: Some(t) });
            }
            _ => {}
        }
        emit(tool, sid, s, events, &mut out);
        out
    }

    /// Map one hook call (its JSON input) received at `now`. Hooks carry no
    /// time of their own; they run as things happen, so `now` is the time.
    pub fn map_hook(&mut self, v: &serde_json::Value, now: f64) -> Vec<Output> {
        self.map_hook_in(v, None, now)
    }

    /// [`map_hook`](Self::map_hook), with the bundle id of the app the session
    /// runs in (Terminal, iTerm, VS Code, …) when the plugin sent it.
    pub fn map_hook_in(&mut self, v: &serde_json::Value, app: Option<&str>, now: f64) -> Vec<Output> {
        if self.tool == Tool::Cursor {
            return crate::cursor::translate(self, v)
                .iter()
                .flat_map(|shaped| self.map_shaped(shaped, app, now))
                .collect();
        }
        if self.tool == Tool::Gemini {
            return crate::gemini::translate(v).iter().flat_map(|shaped| self.map_shaped(shaped, app, now)).collect();
        }
        self.map_shaped(v, app, now)
    }

    /// Whether a session has a tool call open with this id (Cursor's turn marker).
    #[cfg(test)]
    pub(crate) fn has_open(&self, key: &str, tool_use_id: &str) -> bool {
        self.sessions.get(key).is_some_and(|s| s.tools.iter().any(|(id, _)| id == tool_use_id))
    }

    /// A Cursor session, if known: whether a turn is open, and whether it
    /// reports prompts.
    pub(crate) fn cursor_state(&self, key: &str) -> Option<(bool, bool)> {
        let s = self.sessions.get(key)?;
        Some((s.tools.iter().any(|(id, _)| id == crate::cursor::TURN), s.prompted))
    }

    /// One hook call in Claude Code's shape (Codex's are already; Cursor's
    /// are translated first).
    fn map_shaped(&mut self, v: &serde_json::Value, app: Option<&str>, now: f64) -> Vec<Output> {
        let agent = self.tool;
        let mut out = Vec::new();
        let str_of = |k: &str| v.get(k).and_then(|x| x.as_str()).filter(|x| !x.is_empty() && x.len() <= MAX_ID_LEN);
        let Some(sid) = str_of("session_id") else { return out };
        let event = str_of("hook_event_name").unwrap_or_default();
        // A subagent is its own agent; its tool calls carry its id.
        let sub = str_of("agent_id").map(|a| (a, str_of("agent_type").unwrap_or("subagent")));
        let key = match sub {
            Some((a, _)) => format!("{sid}/{a}"),
            None => sid.to_string(),
        };
        // The project, from the working directory: "agentstat", not a session id.
        let project = v
            .get("cwd")
            .and_then(|c| c.as_str())
            .and_then(|c| std::path::Path::new(c).file_name())
            .map(|n| n.to_string_lossy().chars().take(64).collect::<String>());
        if !self.sessions.contains_key(&key) {
            if self.sessions.len() >= MAX_SESSIONS {
                return out;
            }
            // Two sessions in one project tell themselves apart by a short id.
            let taken = |n: &str| self.sessions.values().any(|o| o.name.as_deref() == Some(n));
            let name = project.clone().map(|p| match sub {
                Some((a, kind)) if taken(&format!("{p} · {kind}")) => {
                    format!("{p} · {kind} {}", a.chars().take(4).collect::<String>())
                }
                Some((_, kind)) => format!("{p} · {kind}"),
                None if taken(&p) => format!("{p} · {}", sid.chars().take(6).collect::<String>()),
                None => p,
            });
            self.sessions.insert(key.clone(), Session { name, hooks: true, ..Session::default() });
            if let Some((a, _)) = sub
                && agent == Tool::Codex
            {
                self.aliases.insert(a.to_string(), key.clone());
            }
        }
        let s = self.sessions.get_mut(&key).expect("inserted above");
        s.heard = now;
        if v.get("agentstat_prompt").and_then(|b| b.as_bool()) == Some(true) {
            s.prompted = true;
        }
        let t = Some(now);
        let mut events = Vec::new();
        if let Some(a) = app.filter(|a| {
            !a.is_empty()
                && a.len() <= MAX_APP_LEN
                && a.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        }) {
            s.app = Some(a.to_string());
        }
        // Built from names and timings only: Claude Code's own message text isn't forwarded.
        let mut attention: Option<(Reason, String)> = None;
        // A session telemetry was reporting until now: hooks take over cleanly.
        // It learns its project, what telemetry left open is closed, and a turn
        // end it was waiting to confirm is applied.
        if !s.hooks {
            s.hooks = true;
            if sub.is_none()
                && let Some(p) = project.clone()
            {
                s.name = Some(p);
            }
            for (_, name) in s.tools.drain(..) {
                events.push(Event::ToolEnd { name: Some(name), error: None, time: t });
            }
            if let Some((ft, _)) = s.finish.take() {
                events.push(Event::Finish { time: Some(ft) });
            }
        }
        let tool = || v.get("tool_name").and_then(|x| x.as_str()).unwrap_or_default().to_string();
        match (event, sub.is_some()) {
            ("UserPromptSubmit", false) | ("SubagentStart", true) => {
                s.tools.clear();
                s.idle = false;
                s.turn_since = Some(now);
                events.push(Event::Start { time: t });
            }
            ("PreToolUse", _) => {
                s.idle = false;
                let name = tool();
                s.tools.push((str_of("tool_use_id").unwrap_or_default().to_string(), name.clone()));
                events.push(Event::ToolStart { name: Some(name), time: t });
            }
            ("PostToolUse" | "PostToolUseFailure" | "PermissionDenied", _) => {
                let name = tool();
                let use_id = str_of("tool_use_id").unwrap_or_default();
                let open = s
                    .tools
                    .iter()
                    .rposition(|(u, _)| !use_id.is_empty() && u == use_id)
                    .or_else(|| s.tools.iter().rposition(|(u, n)| *n == name && u != crate::cursor::TURN));
                match open {
                    Some(i) => {
                        s.tools.remove(i);
                    }
                    // Its start was missed (the plugin was enabled mid-call): it began `duration_ms` ago.
                    None => {
                        let since = now - v.get("duration_ms").and_then(|d| d.as_f64()).unwrap_or(0.0);
                        events.push(Event::ToolStart { name: Some(name.clone()), time: Some(since) });
                    }
                }
                // Interrupted by the user, or denied: not an error of the agent's.
                let interrupted = v.get("is_interrupt").and_then(|b| b.as_bool()).unwrap_or(false);
                let error = event == "PostToolUseFailure" && !interrupted;
                events.push(Event::ToolEnd { name: Some(name), error: Some(error), time: t });
                // Esc during a tool ends the turn, and no Stop follows an interrupt.
                if interrupted {
                    s.tools.clear();
                    s.idle = true;
                    events.push(Event::Finish { time: t });
                }
            }
            ("StopFailure", _) => {
                s.tools.clear();
                s.idle = true;
                if sub.is_none() {
                    attention = Some((Reason::Failed, "turn ended with an error".into()));
                }
                s.turn_since = None;
                events.extend([Event::Error { time: t }, Event::Finish { time: t }]);
            }
            ("Stop" | "SessionEnd" | "Interrupt", false) | ("SubagentStop", true) => {
                s.tools.clear();
                s.idle = true;
                if event == "Stop"
                    && let Some(since) = s.turn_since
                    && now - since >= DONE_MIN_MS
                {
                    attention = Some((Reason::Done, format!("finished after {}", duration(now - since))));
                }
                s.turn_since = None;
                events.push(Event::Finish { time: t });
            }
            // Waiting on the person: a permission prompt (for the tool just
            // requested) or a question.
            ("Notification", false)
                if matches!(
                    v.get("notification_type").and_then(|x| x.as_str()),
                    Some("permission_prompt" | "elicitation_dialog")
                ) =>
            {
                let message = match (v.get("notification_type").and_then(|x| x.as_str()), s.tools.last()) {
                    (Some("permission_prompt"), Some((_, tool))) if !tool.is_empty() => {
                        format!("needs your permission for {}", tool.chars().take(64).collect::<String>())
                    }
                    (Some("permission_prompt"), _) => "needs your permission".into(),
                    _ => "has a question for you".into(),
                };
                attention = Some((Reason::NeedsYou, message));
            }
            // Codex asking to approve a tool call (any agent, subagents too:
            // the person has to answer either way).
            ("PermissionRequest", _) => {
                let name = tool();
                let message = if name.is_empty() {
                    "needs your permission".into()
                } else {
                    format!("needs your permission for {}", name.chars().take(64).collect::<String>())
                };
                attention = Some((Reason::NeedsYou, message));
            }
            // Claude Code waiting for input for a while: a turn left open (an
            // interrupt mid-reply sends no other signal) has ended.
            ("Notification", false)
                if v.get("notification_type").and_then(|x| x.as_str()) == Some("idle_prompt") && !s.idle =>
            {
                s.tools.clear();
                s.idle = true;
                events.push(Event::Finish { time: t });
            }
            // Known from its start, before any work: shows up idle under its project's name.
            ("SessionStart", false) => {}
            _ => {}
        }
        emit(agent, &key, s, events, &mut out);
        if let Some((reason, message)) = attention {
            out.push(Output::Attention { id: agent.agent_id(&key), reason, message, app: s.app.clone(), time: now });
        }
        out
    }

    /// The app a session runs in, by agent id (for detector notifications).
    pub fn app_of(&self, agent_id: &str) -> Option<String> {
        agent_id.strip_prefix(self.tool.prefix()).and_then(|k| self.sessions.get(k)).and_then(|s| s.app.clone())
    }

    /// Finishes whose turn saw no more work for `FINISH_DELAY_MS`.
    pub fn flush(&mut self, now: f64) -> Vec<Output> {
        let mut out = Vec::new();
        for (sid, s) in &mut self.sessions {
            // A Cursor turn that went quiet without its stop (the CLI sends
            // none; a prompt another hook blocked): over, well before it
            // would count as stalled. The next tool reopens it.
            let quiet = if s.prompted { crate::cursor::QUIET_PROMPTED_MS } else { crate::cursor::QUIET_MS };
            if self.tool == Tool::Cursor
                && now - s.heard >= quiet
                && let Some(i) = s.tools.iter().position(|(id, _)| id == crate::cursor::TURN)
            {
                s.tools.remove(i);
                let mut events = vec![Event::ToolEnd { name: Some(String::new()), error: None, time: Some(now) }];
                if s.tools.is_empty() {
                    s.idle = true;
                    s.turn_since = None;
                    events.push(Event::Finish { time: Some(now) });
                }
                emit(self.tool, sid, s, events, &mut out);
            }
            if let Some((t, received)) = s.finish
                && now - received >= FINISH_DELAY_MS
            {
                s.finish = None;
                if s.tools.is_empty() {
                    emit(self.tool, sid, s, vec![Event::Finish { time: Some(t) }], &mut out);
                }
            }
        }
        out
    }

    /// Drop a session's state (its agent was removed).
    pub fn forget(&mut self, agent_id: &str) {
        if let Some(key) = agent_id.strip_prefix(self.tool.prefix()) {
            self.sessions.remove(key);
            self.aliases.retain(|_, k| k != key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn rec(t: f64, name: &str, attrs: Value) -> Record {
        let mut a: HashMap<String, Value> = attrs.as_object().unwrap().clone().into_iter().collect();
        a.insert("session.id".into(), json!("d76e4ebe-dde0"));
        Record { time: t, name: format!("claude_code.{name}"), attrs: a, resource: HashMap::new() }
    }

    fn events(out: Vec<Output>) -> Vec<Event> {
        out.into_iter()
            .filter_map(|o| match o {
                Output::Event { event, .. } => Some(event),
                _ => None,
            })
            .collect()
    }

    /// The sequence captured from a real Claude Code run (tool call in the middle).
    #[test]
    fn maps_a_real_turn() {
        let mut m = Mapper::default();
        let first = m.map(&rec(1000.0, "user_prompt", json!({})), 0.0);
        assert_eq!(first[0], Output::New { id: "claude:d76e4ebe-dde0".into(), name: "Claude Code d76e4ebe".into() });
        assert_eq!(events(first), vec![Event::Start { time: Some(1000.0) }]);
        assert_eq!(
            events(m.map(&rec(1818.0, "api_request", json!({"output_tokens": 19, "duration_ms": "800"})), 0.0)),
            vec![
                Event::Start { time: Some(1018.0) },
                Event::Tokens { count: Some(19.0), total: None, since: Some(1018.0), time: Some(1818.0) }
            ]
        );
        // The message that asks for the tool: no finish while the tool follows.
        assert_eq!(events(m.map(&rec(1819.0, "assistant_response", json!({})), 0.0)), vec![]);
        let tool = json!({"decision": "accept", "tool_name": "Bash", "tool_use_id": "toolu_1"});
        assert_eq!(
            events(m.map(&rec(3537.0, "tool_decision", tool), 100.0)),
            vec![Event::ToolStart { name: Some("Bash".into()), time: Some(3537.0) }]
        );
        // The call that asked for the tool, logged after the decision: no new start.
        assert_eq!(
            events(m.map(&rec(3566.0, "api_request", json!({"output_tokens": 91, "duration_ms": "1500"})), 100.0)),
            vec![Event::Tokens { count: Some(91.0), total: None, since: Some(2066.0), time: Some(3566.0) }]
        );
        let result = json!({"tool_name": "Bash", "tool_use_id": "toolu_1", "success": "true", "duration_ms": "4500"});
        assert_eq!(
            events(m.map(&rec(8094.0, "tool_result", result), 5000.0)),
            vec![Event::ToolEnd { name: Some("Bash".into()), error: Some(false), time: Some(8094.0) }]
        );
        assert_eq!(events(m.flush(9000.0)), vec![]);
        // The final message: a finish once nothing follows for a moment.
        m.map(&rec(10136.0, "assistant_response", json!({})), 7000.0);
        assert_eq!(events(m.flush(8000.0)), vec![]);
        assert_eq!(events(m.flush(8500.0)), vec![Event::Finish { time: Some(10136.0) }]);
    }

    #[test]
    fn parallel_calls_of_one_tool_close_their_own() {
        let mut m = Mapper::default();
        for id in ["toolu_1", "toolu_2"] {
            m.map(
                &rec(100.0, "tool_decision", json!({"decision": "accept", "tool_name": "Bash", "tool_use_id": id})),
                0.0,
            );
        }
        m.map(
            &rec(200.0, "tool_result", json!({"tool_name": "Bash", "tool_use_id": "toolu_1", "success": "true"})),
            0.0,
        );
        m.map(
            &rec(300.0, "tool_result", json!({"tool_name": "Bash", "tool_use_id": "toolu_2", "success": "true"})),
            0.0,
        );
        // Both closed: the next call starts a new stretch of work.
        let next = events(m.map(&rec(900.0, "api_request", json!({"output_tokens": 5, "duration_ms": "100"})), 0.0));
        assert_eq!(next[0], Event::Start { time: Some(800.0) });
    }

    #[test]
    fn backdated_starts_never_precede_earlier_events() {
        let mut m = Mapper::default();
        m.map(&rec(8094.0, "tool_result", json!({"tool_name": "Bash", "success": "true"})), 0.0);
        let next = events(m.map(&rec(10000.0, "api_request", json!({"output_tokens": 5, "duration_ms": "2500"})), 0.0));
        assert_eq!(next[0], Event::Start { time: Some(8094.0) });
    }

    fn hook(event: &str, extra: Value) -> Value {
        let mut v = json!({"session_id": "d76e4ebe-dde0", "cwd": "/Users/me/code/agentstat", "hook_event_name": event});
        v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        v
    }

    fn attention(out: Vec<Output>) -> Vec<(Reason, String, Option<String>)> {
        out.into_iter()
            .filter_map(|o| match o {
                Output::Attention { reason, message, app, .. } => Some((reason, message, app)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn attention_for_a_permission_prompt_a_long_turn_and_a_failure() {
        let mut m = Mapper::default();
        let app = Some("com.googlecode.iterm2");
        m.map_hook_in(&hook("UserPromptSubmit", json!({"prompt": "secret"})), app, 1_000.0);
        m.map_hook_in(&hook("PreToolUse", json!({"tool_name": "Bash", "tool_use_id": "t1"})), app, 2_000.0);
        // Claude Code's own message text is never forwarded.
        let prompt = json!({"notification_type": "permission_prompt", "message": "Claude needs your permission to use Bash: rm -rf x"});
        assert_eq!(
            attention(m.map_hook_in(&hook("Notification", prompt), app, 2_500.0)),
            vec![(Reason::NeedsYou, "needs your permission for Bash".into(), Some("com.googlecode.iterm2".into()))]
        );
        m.map_hook(&hook("PostToolUse", json!({"tool_name": "Bash", "tool_use_id": "t1"})), 9_000.0);
        // A turn of 4m 12s: "done", with the app remembered from earlier hooks.
        assert_eq!(
            attention(m.map_hook(&hook("Stop", json!({})), 253_000.0)),
            vec![(Reason::Done, "finished after 4m 12s".into(), Some("com.googlecode.iterm2".into()))]
        );
        // A short turn: nothing.
        m.map_hook(&hook("UserPromptSubmit", json!({})), 300_000.0);
        assert_eq!(attention(m.map_hook(&hook("Stop", json!({})), 320_000.0)), vec![]);
        // A failed turn, however short.
        m.map_hook(&hook("UserPromptSubmit", json!({})), 400_000.0);
        assert_eq!(
            attention(m.map_hook(&hook("StopFailure", json!({"error": "rate_limit"})), 401_000.0)),
            vec![(Reason::Failed, "turn ended with an error".into(), Some("com.googlecode.iterm2".into()))]
        );
        // A question; the idle reminder is not a notification.
        assert_eq!(
            attention(m.map_hook(&hook("Notification", json!({"notification_type": "elicitation_dialog"})), 402_000.0)),
            vec![(Reason::NeedsYou, "has a question for you".into(), Some("com.googlecode.iterm2".into()))]
        );
        assert_eq!(
            attention(m.map_hook(&hook("Notification", json!({"notification_type": "idle_prompt"})), 403_000.0)),
            vec![]
        );
        assert_eq!(m.app_of("claude:d76e4ebe-dde0").as_deref(), Some("com.googlecode.iterm2"));
    }

    #[test]
    fn an_odd_app_id_is_ignored_and_subagents_do_not_notify_done() {
        let mut m = Mapper::default();
        m.map_hook_in(&hook("UserPromptSubmit", json!({})), Some("bad id; rm"), 0.0);
        assert_eq!(m.app_of("claude:d76e4ebe-dde0"), None);
        let sub = json!({"agent_id": "a1", "agent_type": "Explore"});
        m.map_hook(&hook("SubagentStart", sub.clone()), 1_000.0);
        assert_eq!(attention(m.map_hook(&hook("SubagentStop", sub), 200_000.0)), vec![]);
        assert_eq!(duration(45_000.0), "45s");
        assert_eq!(duration(3_780_000.0), "1h 03m");
    }

    #[test]
    fn hooks_drive_a_turn_in_real_time() {
        let mut m = Mapper::default();
        // SessionStart: the agent appears under its project's name, before any work.
        assert_eq!(
            m.map_hook(&hook("SessionStart", json!({"source": "startup"})), 1.0),
            vec![Output::New { id: "claude:d76e4ebe-dde0".into(), name: "agentstat".into() }]
        );
        let e = |out: Vec<Output>| events(out);
        assert_eq!(
            e(m.map_hook(&hook("UserPromptSubmit", json!({"prompt": "secret"})), 2.0)),
            vec![Event::Start { time: Some(2.0) }]
        );
        let pre = json!({"tool_name": "Bash", "tool_use_id": "toolu_1", "tool_input": {"command": "ls"}});
        assert_eq!(
            e(m.map_hook(&hook("PreToolUse", pre), 3.0)),
            vec![Event::ToolStart { name: Some("Bash".into()), time: Some(3.0) }]
        );
        let post = json!({"tool_name": "Bash", "tool_use_id": "toolu_1", "error": "exit 1"});
        assert_eq!(
            e(m.map_hook(&hook("PostToolUseFailure", post), 4.0)),
            vec![Event::ToolEnd { name: Some("Bash".into()), error: Some(true), time: Some(4.0) }]
        );
        assert_eq!(e(m.map_hook(&hook("Stop", json!({})), 5.0)), vec![Event::Finish { time: Some(5.0) }]);
        // The turn's last call, exported after the turn ended: counted, and the agent stays finished.
        assert_eq!(
            e(m.map(&rec(5_500.0, "api_request", json!({"output_tokens": 40, "duration_ms": "500"})), 6_000.0)),
            vec![
                Event::Tokens { count: Some(40.0), total: None, since: Some(5_000.0), time: Some(5_500.0) },
                Event::Finish { time: Some(5_500.0) }
            ]
        );
        assert_eq!(
            e(m.map(&rec(5_600.0, "tool_decision", json!({"decision": "accept", "tool_name": "Bash"})), 6_000.0)),
            vec![]
        );
        assert_eq!(e(m.map(&rec(5_700.0, "assistant_response", json!({})), 6_000.0)), vec![]);
        assert_eq!(e(m.flush(60_000.0)), vec![]);
    }

    #[test]
    fn interrupts_and_idle_end_a_turn() {
        let mut m = Mapper::default();
        m.map_hook(&hook("UserPromptSubmit", json!({})), 1.0);
        m.map_hook(&hook("PreToolUse", json!({"tool_name": "Bash", "tool_use_id": "t1"})), 2.0);
        let esc = json!({"tool_name": "Bash", "tool_use_id": "t1", "is_interrupt": true, "error": "interrupted"});
        assert_eq!(
            events(m.map_hook(&hook("PostToolUseFailure", esc), 3.0)),
            vec![
                Event::ToolEnd { name: Some("Bash".into()), error: Some(false), time: Some(3.0) },
                Event::Finish { time: Some(3.0) }
            ]
        );
        // Interrupted mid-reply: no hook then, but the idle notification ends the turn.
        m.map_hook(&hook("UserPromptSubmit", json!({})), 4.0);
        let idle = json!({"notification_type": "idle_prompt", "message": "Claude is waiting"});
        assert_eq!(
            events(m.map_hook(&hook("Notification", idle.clone()), 64.0)),
            vec![Event::Finish { time: Some(64.0) }]
        );
        assert_eq!(events(m.map_hook(&hook("Notification", idle), 65.0)), vec![]);
    }

    #[test]
    fn a_session_moves_from_telemetry_to_hooks_cleanly() {
        let mut m = Mapper::default();
        m.map(&rec(1_000.0, "user_prompt", json!({})), 1_000.0);
        m.map(
            &rec(1_100.0, "tool_decision", json!({"decision": "accept", "tool_name": "Read", "tool_use_id": "t9"})),
            1_100.0,
        );
        // The plugin is enabled now: the open tool is closed and the session learns its project.
        let out = m.map_hook(&hook("PreToolUse", json!({"tool_name": "Bash", "tool_use_id": "t10"})), 2_000.0);
        assert_eq!(out[0], Output::New { id: "claude:d76e4ebe-dde0".into(), name: "agentstat".into() });
        assert_eq!(
            events(out),
            vec![
                Event::ToolEnd { name: Some("Read".into()), error: None, time: Some(2_000.0) },
                Event::ToolStart { name: Some("Bash".into()), time: Some(2_000.0) }
            ]
        );
    }

    #[test]
    fn subagents_are_their_own_agents() {
        let mut m = Mapper::default();
        m.map_hook(&hook("SessionStart", json!({})), 1.0);
        let start = m.map_hook(&hook("SubagentStart", json!({"agent_id": "ag1", "agent_type": "Explore"})), 2.0);
        assert_eq!(start[0], Output::New { id: "claude:d76e4ebe-dde0/ag1".into(), name: "agentstat · Explore".into() });
        let tool = m.map_hook(
            &hook("PreToolUse", json!({"agent_id": "ag1", "agent_type": "Explore", "tool_name": "Grep"})),
            3.0,
        );
        assert!(matches!(&tool[0], Output::Event { id, .. } if id == "claude:d76e4ebe-dde0/ag1"));
        // Another session in the same project is told apart by a short id.
        let mut other = hook("SessionStart", json!({}));
        other["session_id"] = json!("5cd1b02c-95c6");
        assert_eq!(
            m.map_hook(&other, 4.0),
            vec![Output::New { id: "claude:5cd1b02c-95c6".into(), name: "agentstat · 5cd1b0".into() }]
        );
    }

    #[test]
    fn ignored_records_do_not_create_agents() {
        let mut m = Mapper::default();
        assert!(m.map(&rec(1.0, "tool_decision", json!({"decision": "reject", "tool_name": "Bash"})), 0.0).is_empty());
        assert!(m.map(&rec(2.0, "mcp_server_connection", json!({})), 0.0).is_empty());
        assert!(matches!(m.map(&rec(3.0, "user_prompt", json!({})), 0.0)[0], Output::New { .. }));
    }

    #[test]
    fn a_failed_tool_without_a_decision_still_has_a_start() {
        let mut m = Mapper::default();
        let r = json!({"tool_name": "Read", "success": "false", "duration_ms": "300"});
        assert_eq!(
            events(m.map(&rec(5000.0, "tool_result", r), 0.0)),
            vec![
                Event::ToolStart { name: Some("Read".into()), time: Some(4700.0) },
                Event::ToolEnd { name: Some("Read".into()), error: Some(true), time: Some(5000.0) }
            ]
        );
    }

    // Codex. Records and hook inputs follow its source (openai/codex rust-v0.172.0):
    // the event name is an attribute, the session is `conversation.id`, and hooks
    // have Claude Code's shape.

    fn codex_rec(t: f64, name: &str, attrs: Value) -> Record {
        let mut a: HashMap<String, Value> = attrs.as_object().unwrap().clone().into_iter().collect();
        a.insert("event.name".into(), json!(format!("codex.{name}")));
        a.insert("conversation.id".into(), json!("019a-main"));
        a.insert("user.email".into(), json!("someone@example.com"));
        Record { time: t, name: String::new(), attrs: a, resource: HashMap::new() }
    }

    fn codex_hook(event: &str, extra: Value) -> Value {
        let mut v = json!({
            "session_id": "019a-main", "cwd": "/Users/me/code/shop", "hook_event_name": event,
            "model": "gpt-5.5-codex", "permission_mode": "default", "transcript_path": null, "turn_id": "turn-1"
        });
        v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        v
    }

    fn completed(t: f64, tokens: u32) -> Record {
        codex_rec(t, "sse_event", json!({"event.kind": "response.completed", "output_token_count": tokens.to_string()}))
    }

    #[test]
    fn codex_records_are_told_apart_from_claude_code() {
        assert!(is_codex(&codex_rec(1.0, "api_request", json!({}))));
        assert!(!is_claude(&codex_rec(1.0, "api_request", json!({}))));
        assert!(!is_codex(&rec(1.0, "api_request", json!({}))));
        // No session id: nothing to attach it to.
        let mut r = codex_rec(1.0, "user_prompt", json!({}));
        r.attrs.remove("conversation.id");
        assert_eq!(Mapper::new(Tool::Codex).map(&r, 1.0), vec![]);
    }

    #[test]
    fn codex_hooks_drive_a_turn_and_ask_for_permission() {
        let mut m = Mapper::new(Tool::Codex);
        assert_eq!(
            m.map_hook(&codex_hook("SessionStart", json!({"source": "startup"})), 1.0),
            vec![Output::New { id: "codex:019a-main".into(), name: "shop".into() }]
        );
        let e = |out: Vec<Output>| events(out);
        assert_eq!(
            e(m.map_hook(&codex_hook("UserPromptSubmit", json!({"prompt": "secret"})), 2.0)),
            vec![Event::Start { time: Some(2.0) }]
        );
        let pre = json!({"tool_name": "shell", "tool_use_id": "call_1", "tool_input": {"command": ["ls"]}});
        assert_eq!(
            e(m.map_hook(&codex_hook("PreToolUse", pre), 3.0)),
            vec![Event::ToolStart { name: Some("shell".into()), time: Some(3.0) }]
        );
        let ask = json!({"tool_name": "shell", "tool_input": {"command": ["rm", "-rf", "build"]}});
        assert_eq!(
            m.map_hook_in(&codex_hook("PermissionRequest", ask), Some("com.apple.Terminal"), 3.5),
            vec![Output::Attention {
                id: "codex:019a-main".into(),
                reason: Reason::NeedsYou,
                message: "needs your permission for shell".into(),
                app: Some("com.apple.Terminal".into()),
                time: 3.5
            }]
        );
        let post = json!({"tool_name": "shell", "tool_use_id": "call_1", "tool_response": "ok"});
        assert_eq!(
            e(m.map_hook(&codex_hook("PostToolUse", post), 4.0)),
            vec![Event::ToolEnd { name: Some("shell".into()), error: Some(false), time: Some(4.0) }]
        );
        assert_eq!(
            e(m.map_hook(&codex_hook("Stop", json!({"stop_hook_active": false})), 5.0)),
            vec![Event::Finish { time: Some(5.0) }]
        );
        // Esc: Codex sends Interrupt, and no Stop.
        m.map_hook(&codex_hook("UserPromptSubmit", json!({})), 6.0);
        assert_eq!(e(m.map_hook(&codex_hook("Interrupt", json!({})), 7.0)), vec![Event::Finish { time: Some(7.0) }]);
        // Quitting mid-turn: SessionEnd, and no Stop.
        m.map_hook(&codex_hook("UserPromptSubmit", json!({})), 8.0);
        assert_eq!(
            e(m.map_hook(&codex_hook("SessionEnd", json!({"reason": "exit"})), 9.0)),
            vec![Event::Finish { time: Some(9.0) }]
        );
    }

    #[test]
    fn codex_telemetry_adds_tokens_and_cost_to_a_session_with_hooks() {
        let mut m = Mapper::new(Tool::Codex);
        m.map_hook(&codex_hook("UserPromptSubmit", json!({})), 1_000.0);
        let e = |out: Vec<Output>| events(out);
        // The call's request, then its tokens when the response completes.
        assert_eq!(e(m.map(&codex_rec(2_900.0, "api_request", json!({"duration_ms": "1800"})), 3_000.0)), vec![]);
        assert_eq!(
            e(m.map(&completed(4_100.0, 180), 4_200.0)),
            vec![Event::Tokens { count: Some(180.0), total: None, since: Some(1_100.0), time: Some(4_100.0) }]
        );
        // Tools and turns are the hooks' job: telemetry about them is ignored.
        let decision = json!({"tool_name": "shell", "call_id": "c", "decision": "approved"});
        assert_eq!(e(m.map(&codex_rec(4_200.0, "tool_decision", decision), 4_300.0)), vec![]);
        m.map_hook(&codex_hook("Stop", json!({})), 5_000.0);
        // Cost arrives per turn, as a decimal string.
        let cost = codex_rec(5_050.0, "turn_cost", json!({"turn.id": "turn-1", "usage.estimated_usd": "0.0123"}));
        assert_eq!(m.map(&cost, 5_100.0), vec![Output::Cost { id: "codex:019a-main".into(), usd: 0.0123 }]);
        // A missed call start: a second's worth of output.
        assert_eq!(
            e(m.map(&completed(9_000.0, 40), 9_100.0)),
            vec![
                Event::Tokens { count: Some(40.0), total: None, since: Some(8_000.0), time: Some(9_000.0) },
                Event::Finish { time: Some(9_000.0) }
            ]
        );
    }

    #[test]
    fn codex_telemetry_alone_still_shows_turns_and_tools() {
        let mut m = Mapper::new(Tool::Codex);
        let e = |out: Vec<Output>| events(out);
        let out = m.map(&codex_rec(100.0, "user_prompt", json!({"prompt": "[REDACTED]"})), 200.0);
        assert_eq!(out[0], Output::New { id: "codex:019a-main".into(), name: "Codex 019a-mai".into() });
        assert_eq!(e(out), vec![Event::Start { time: Some(100.0) }]);
        m.map(&codex_rec(1_900.0, "api_request", json!({"duration_ms": "1800"})), 2_000.0);
        // The reply asks for a tool: more work follows, so the turn doesn't end.
        assert_eq!(
            e(m.map(&completed(4_100.0, 180), 4_200.0)),
            vec![
                Event::Start { time: Some(100.0) },
                Event::Tokens { count: Some(180.0), total: None, since: Some(100.0), time: Some(4_100.0) }
            ]
        );
        let decision = json!({"tool_name": "shell", "call_id": "c1", "decision": "approved_for_session"});
        assert_eq!(
            e(m.map(&codex_rec(4_300.0, "tool_decision", decision), 4_400.0)),
            vec![Event::ToolStart { name: Some("shell".into()), time: Some(4_300.0) }]
        );
        assert_eq!(e(m.flush(60_000.0)), vec![]);
        let result = json!({"tool_name": "shell", "call_id": "c1", "duration_ms": "2100", "success": "false"});
        assert_eq!(
            e(m.map(&codex_rec(6_400.0, "tool_result", result), 6_500.0)),
            vec![Event::ToolEnd { name: Some("shell".into()), error: Some(true), time: Some(6_400.0) }]
        );
        // A tool approved by policy has no decision record: its start is backdated.
        let auto = json!({"tool_name": "read_file", "call_id": "c2", "duration_ms": "300", "success": "true"});
        assert_eq!(
            e(m.map(&codex_rec(7_000.0, "tool_result", auto), 7_100.0)),
            vec![
                Event::ToolStart { name: Some("read_file".into()), time: Some(6_700.0) },
                Event::ToolEnd { name: Some("read_file".into()), error: Some(false), time: Some(7_000.0) }
            ]
        );
        // The last reply, and no more work for a moment: the turn is over.
        m.map(&completed(9_000.0, 240), 9_000.0);
        assert_eq!(e(m.flush(9_000.0 + FINISH_DELAY_MS)), vec![Event::Finish { time: Some(9_000.0) }]);
        // The turn's cost also ends it, at once.
        m.map(&codex_rec(10_000.0, "user_prompt", json!({})), 10_000.0);
        let cost = codex_rec(11_000.0, "turn_cost", json!({"usage.estimated_usd": "0.02"}));
        let out = m.map(&cost, 11_000.0);
        assert!(
            out.contains(&Output::Event {
                id: "codex:019a-main".into(),
                event: Event::Finish { time: Some(11_000.0) }
            })
        );
        assert!(out.contains(&Output::Cost { id: "codex:019a-main".into(), usd: 0.02 }));
        // A denied call never ran.
        let denied = json!({"tool_name": "shell", "call_id": "c3", "decision": "denied"});
        assert_eq!(e(m.map(&codex_rec(12_000.0, "tool_decision", denied), 12_000.0)), vec![]);
    }

    #[test]
    fn a_codex_subagent_gets_its_own_telemetry() {
        let mut m = Mapper::new(Tool::Codex);
        m.map_hook(&codex_hook("UserPromptSubmit", json!({})), 1.0);
        let start = json!({"agent_id": "019b-child", "agent_type": "explorer"});
        assert_eq!(
            m.map_hook(&codex_hook("SubagentStart", start), 2.0)[0],
            Output::New { id: "codex:019a-main/019b-child".into(), name: "shop · explorer".into() }
        );
        // Its records carry its own conversation id.
        let mut r = completed(3_000.0, 50);
        r.attrs.insert("conversation.id".into(), json!("019b-child"));
        let out = m.map(&r, 3_000.0);
        assert!(out.iter().all(|o| matches!(o, Output::Event { id, .. } if id == "codex:019a-main/019b-child")));
        assert_eq!(out.len(), 1);
        // Forgetting the subagent forgets its alias too.
        m.forget("codex:019a-main/019b-child");
        let out = m.map(&r, 4_000.0);
        assert_eq!(out[0], Output::New { id: "codex:019b-child".into(), name: "Codex 019b-chi".into() });
    }

    #[test]
    fn each_mapper_keeps_to_its_own_agents() {
        let mut claude = Mapper::default();
        claude.map_hook_in(&hook("SessionStart", json!({})), Some("com.apple.Terminal"), 1.0);
        assert_eq!(claude.app_of("claude:d76e4ebe-dde0").as_deref(), Some("com.apple.Terminal"));
        assert_eq!(claude.app_of("codex:d76e4ebe-dde0"), None);
        claude.forget("codex:d76e4ebe-dde0");
        assert!(claude.app_of("claude:d76e4ebe-dde0").is_some());
    }
}

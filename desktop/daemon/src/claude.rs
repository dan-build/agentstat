//! Claude Code as AgentStat events: one agent per session (and per subagent).
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
}

/// Sessions tracked at once; records for more are ignored (a local process
/// could otherwise grow the service without bound).
pub const MAX_SESSIONS: usize = 200;
const MAX_ID_LEN: usize = 128;
/// A complete assistant message is the end of the turn only if no more work
/// follows this soon (the message that asks for a tool comes just before it runs).
pub const FINISH_DELAY_MS: f64 = 1_500.0;

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
}

#[derive(Default)]
pub struct ClaudeMapper {
    sessions: HashMap<String, Session>,
}

/// Whether a record comes from Claude Code.
pub fn is_claude(r: &Record) -> bool {
    r.name.starts_with("claude_code.") || r.resource.get("service.name").and_then(|v| v.as_str()) == Some("claude-code")
}

/// The agent id for a session key (`<session>` or `<session>/<subagent>`).
fn agent_id(key: &str) -> String {
    format!("claude:{key}")
}

/// Emit `events` for a session: its name first if it isn't out yet (or
/// changed), and every time kept at or after the last one emitted.
fn emit(key: &str, s: &mut Session, events: Vec<Event>, out: &mut Vec<Output>) {
    let name = s.name.clone().unwrap_or_else(|| format!("Claude Code {}", key.chars().take(8).collect::<String>()));
    // Nothing new to say: no events, and no (new) name worth announcing on its own.
    if events.is_empty() && (s.name.is_none() || s.announced.as_ref() == Some(&name)) {
        return;
    }
    let id = agent_id(key);
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

fn set_time(e: &mut Event, t: f64) {
    match e {
        Event::Start { time }
        | Event::Tokens { time, .. }
        | Event::ToolStart { time, .. }
        | Event::ToolEnd { time, .. }
        | Event::Error { time }
        | Event::Finish { time } => *time = Some(t),
    }
}

impl ClaudeMapper {
    /// Map one record received at `now` (records must arrive oldest first per session).
    pub fn map(&mut self, r: &Record, now: f64) -> Vec<Output> {
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
            emit(sid, s, events, &mut out);
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
        emit(sid, s, events, &mut out);
        out
    }

    /// Map one hook call (its JSON input) received at `now`. Hooks carry no
    /// time of their own; they run as things happen, so `now` is the time.
    pub fn map_hook(&mut self, v: &serde_json::Value, now: f64) -> Vec<Output> {
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
        }
        let s = self.sessions.get_mut(&key).expect("inserted above");
        let t = Some(now);
        let mut events = Vec::new();
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
                    .or_else(|| s.tools.iter().rposition(|(_, n)| *n == name));
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
                events.extend([Event::Error { time: t }, Event::Finish { time: t }]);
            }
            ("Stop" | "SessionEnd", false) | ("SubagentStop", true) => {
                s.tools.clear();
                s.idle = true;
                events.push(Event::Finish { time: t });
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
        emit(&key, s, events, &mut out);
        out
    }

    /// Finishes whose turn saw no more work for `FINISH_DELAY_MS`.
    pub fn flush(&mut self, now: f64) -> Vec<Output> {
        let mut out = Vec::new();
        for (sid, s) in &mut self.sessions {
            if let Some((t, received)) = s.finish
                && now - received >= FINISH_DELAY_MS
            {
                s.finish = None;
                if s.tools.is_empty() {
                    emit(sid, s, vec![Event::Finish { time: Some(t) }], &mut out);
                }
            }
        }
        out
    }

    /// Drop a session's state (its agent was removed).
    pub fn forget(&mut self, agent_id: &str) {
        if let Some(key) = agent_id.strip_prefix("claude:") {
            self.sessions.remove(key);
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
        let mut m = ClaudeMapper::default();
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
        let mut m = ClaudeMapper::default();
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
        let mut m = ClaudeMapper::default();
        m.map(&rec(8094.0, "tool_result", json!({"tool_name": "Bash", "success": "true"})), 0.0);
        let next = events(m.map(&rec(10000.0, "api_request", json!({"output_tokens": 5, "duration_ms": "2500"})), 0.0));
        assert_eq!(next[0], Event::Start { time: Some(8094.0) });
    }

    fn hook(event: &str, extra: Value) -> Value {
        let mut v = json!({"session_id": "d76e4ebe-dde0", "cwd": "/Users/me/code/agentstat", "hook_event_name": event});
        v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        v
    }

    #[test]
    fn hooks_drive_a_turn_in_real_time() {
        let mut m = ClaudeMapper::default();
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
        let mut m = ClaudeMapper::default();
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
        let mut m = ClaudeMapper::default();
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
        let mut m = ClaudeMapper::default();
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
        let mut m = ClaudeMapper::default();
        assert!(m.map(&rec(1.0, "tool_decision", json!({"decision": "reject", "tool_name": "Bash"})), 0.0).is_empty());
        assert!(m.map(&rec(2.0, "mcp_server_connection", json!({})), 0.0).is_empty());
        assert!(matches!(m.map(&rec(3.0, "user_prompt", json!({})), 0.0)[0], Output::New { .. }));
    }

    #[test]
    fn a_failed_tool_without_a_decision_still_has_a_start() {
        let mut m = ClaudeMapper::default();
        let r = json!({"tool_name": "Read", "success": "false", "duration_ms": "300"});
        assert_eq!(
            events(m.map(&rec(5000.0, "tool_result", r), 0.0)),
            vec![
                Event::ToolStart { name: Some("Read".into()), time: Some(4700.0) },
                Event::ToolEnd { name: Some("Read".into()), error: Some(true), time: Some(5000.0) }
            ]
        );
    }
}

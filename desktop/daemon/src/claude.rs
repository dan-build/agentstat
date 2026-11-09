//! Claude Code's OpenTelemetry events as AgentStat events, one agent per
//! session.
//!
//! Claude Code logs a model call when it finishes (`api_request`, with its
//! output tokens and duration), a tool when it is approved to run
//! (`tool_decision`) and when it returns (`tool_result`), and an assistant
//! message when it is complete (`assistant_response`). Prompt and response
//! text is redacted by default and never read here.

use std::collections::HashMap;

use agentstat_core::Event;

use crate::otlp::Record;

/// What the mapper produced for one record.
#[derive(Clone, Debug, PartialEq)]
pub enum Output {
    /// A session seen for the first time: its display name.
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
    /// Whether its name went out (with its first event).
    announced: bool,
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

fn agent_id(sid: &str) -> String {
    format!("claude:{sid}")
}

/// Emit `events` for a session: its name first if this is its first event, and
/// every time kept at or after the last one emitted.
fn emit(sid: &str, s: &mut Session, events: Vec<Event>, out: &mut Vec<Output>) {
    if events.is_empty() {
        return;
    }
    let id = agent_id(sid);
    if !s.announced {
        s.announced = true;
        let short: String = sid.chars().take(8).collect();
        out.push(Output::New { id: id.clone(), name: format!("Claude Code {short}") });
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
        if let Some(sid) = agent_id.strip_prefix("claude:") {
            self.sessions.remove(sid);
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

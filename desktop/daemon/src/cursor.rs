//! Cursor's hooks, in Claude Code's shape for the shared mapper.
//!
//! AgentStat only observes Cursor, through hooks that can't decide anything:
//! session start and end, a prompt submitted, a tool finished (with its
//! duration, so its start is known), and the turn's stop. Cursor's hooks that
//! run before an action (`preToolUse`, `beforeShellExecution`, …) decide
//! whether it may run, and a reply there could block or approve it, so they
//! are never used.
//!
//! What runs between a prompt and the next finished tool isn't reported, so a
//! Cursor turn holds one unnamed open call from its start to its stop: the
//! agent reads as waiting while it works, and only a turn quiet for minutes
//! counts as stalled (seconds of silence are normal here). Cursor's CLI sends
//! no prompt or stop events, so a session there opens that call at its first
//! tool and closes it when the session ends.

use serde_json::{Value, json};

/// The open call that stands for a Cursor turn's unreported work.
pub const TURN: &str = "cursor-turn";
/// A turn quiet this long without its stop is over: sessions that report no
/// prompts (the CLI) close sooner; all of them well before the 5 minutes
/// after which waiting counts as stalled.
pub const QUIET_MS: f64 = 90_000.0;
pub const QUIET_PROMPTED_MS: f64 = 240_000.0;

/// Claude Code-shaped hook inputs for one Cursor hook call (none for events
/// AgentStat doesn't use).
pub fn translate(m: &crate::claude::Mapper, v: &Value) -> Vec<Value> {
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default();
    let session = s("conversation_id");
    if session.is_empty() {
        return vec![];
    }
    let cwd = v
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty())
        .or_else(|| v.get("workspace_roots").and_then(Value::as_array)?.first()?.as_str())
        .unwrap_or_default();
    let base = |event: &str| json!({"session_id": session, "cwd": cwd, "hook_event_name": event});
    let open_turn = || {
        let mut p = base("PreToolUse");
        p["tool_name"] = json!("");
        p["tool_use_id"] = json!(TURN);
        p
    };
    let state = m.cursor_state(session);
    let in_turn = state.is_some_and(|(open, _)| open);
    let event = s("hook_event_name");
    match event {
        "sessionStart" => vec![base("SessionStart")],
        "beforeSubmitPrompt" => {
            let mut p = base("UserPromptSubmit");
            p["agentstat_prompt"] = json!(true);
            vec![p, open_turn()]
        }
        "postToolUse" | "postToolUseFailure" => {
            // A conversation never seen start (a subagent's own, or one from
            // before the hooks were added): not an agent of its own.
            let Some((_, prompted)) = state else { return vec![] };
            let mut out = vec![];
            // A tool without a prompt first (the CLI): the turn starts here.
            if !in_turn && !prompted {
                out.push(base("UserPromptSubmit"));
                out.push(open_turn());
            }
            let mut p = base(if event == "postToolUse" { "PostToolUse" } else { "PostToolUseFailure" });
            p["tool_name"] = json!(s("tool_name"));
            p["tool_use_id"] = json!(s("tool_use_id"));
            if let Some(d) = v.get("duration").and_then(Value::as_f64) {
                p["duration_ms"] = json!(d);
            }
            if let Some(i) = v.get("is_interrupt").and_then(Value::as_bool) {
                p["is_interrupt"] = json!(i);
            }
            out.push(p);
            // A late tool after the editor's turn stopped: shown, and over again.
            if !in_turn && prompted {
                out.push(base("Stop"));
            }
            out
        }
        "stop" if state.is_none() => vec![],
        "stop" => match s("status") {
            "error" => vec![base("StopFailure")],
            // Stopped by the person: over, but not "done" worth a notification.
            "aborted" => vec![base("Interrupt")],
            _ => vec![base("Stop")],
        },
        "sessionEnd" => {
            let mut out = vec![];
            if s("reason") == "error" && in_turn {
                out.push(base("StopFailure"));
            }
            out.push(base("SessionEnd"));
            out
        }
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::{Mapper, Output, Reason, Tool};
    use agentstat_core::Event;

    fn hook(event: &str, extra: Value) -> Value {
        let mut v = json!({
            "conversation_id": "c-1", "generation_id": "g-1", "hook_event_name": event,
            "workspace_roots": ["/Users/me/code/shop"], "cursor_version": "2.4.1", "user_email": "me@example.com"
        });
        v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        v
    }

    fn events(out: Vec<Output>) -> Vec<Event> {
        out.into_iter()
            .filter_map(|o| match o {
                Output::Event { event, .. } => Some(event),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn an_editor_turn_waits_while_it_works_and_shows_tools_as_they_finish() {
        let mut m = Mapper::new(Tool::Cursor);
        assert_eq!(
            m.map_hook(&hook("sessionStart", json!({"session_id": "s", "is_background_agent": false})), 1.0),
            vec![Output::New { id: "cursor:c-1".into(), name: "shop".into() }]
        );
        // The prompt: a turn, with its unreported work open.
        assert_eq!(
            events(m.map_hook(&hook("beforeSubmitPrompt", json!({"prompt": "secret"})), 2.0)),
            vec![Event::Start { time: Some(2.0) }, Event::ToolStart { name: Some(String::new()), time: Some(2.0) }]
        );
        // A tool that took 3 s, reported when it ended: started 3 s before.
        let done =
            json!({"tool_name": "Shell", "tool_use_id": "t1", "cwd": "/Users/me/code/shop/web", "duration": 3000.0});
        assert_eq!(
            events(m.map_hook(&hook("postToolUse", done), 10_000.0)),
            vec![
                Event::ToolStart { name: Some("Shell".into()), time: Some(7_000.0) },
                Event::ToolEnd { name: Some("Shell".into()), error: Some(false), time: Some(10_000.0) }
            ]
        );
        // Still in the turn: the unnamed call holds.
        assert!(m.has_open("c-1", TURN));
        let failed = json!({"tool_name": "Read", "tool_use_id": "t2", "duration": 5.0, "error_message": "no file"});
        assert_eq!(
            events(m.map_hook(&hook("postToolUseFailure", failed), 11_000.0))[1],
            Event::ToolEnd { name: Some("Read".into()), error: Some(true), time: Some(11_000.0) }
        );
        assert_eq!(
            events(m.map_hook(&hook("stop", json!({"status": "completed", "loop_count": 0})), 12_000.0)),
            vec![Event::Finish { time: Some(12_000.0) }]
        );
        assert!(!m.has_open("c-1", TURN));
    }

    #[test]
    fn stops_that_were_aborted_or_failed() {
        let mut m = Mapper::new(Tool::Cursor);
        m.map_hook(&hook("beforeSubmitPrompt", json!({})), 1.0);
        // Stopped by the person: finished, no notification.
        let out = m.map_hook(&hook("stop", json!({"status": "aborted"})), 120_000.0);
        assert!(!out.iter().any(|o| matches!(o, Output::Attention { .. })));
        m.map_hook(&hook("beforeSubmitPrompt", json!({})), 130_000.0);
        let out = m.map_hook(&hook("stop", json!({"status": "error"})), 131_000.0);
        assert!(out.iter().any(|o| matches!(o, Output::Attention { reason: Reason::Failed, .. })));
    }

    #[test]
    fn a_cli_session_without_prompt_or_stop_events() {
        let mut m = Mapper::new(Tool::Cursor);
        m.map_hook(&hook("sessionStart", json!({"session_id": "s"})), 1.0);
        // The first tool starts the turn.
        let e = events(
            m.map_hook(&hook("postToolUse", json!({"tool_name": "Edit", "tool_use_id": "t1", "duration": 1.0})), 5.0),
        );
        assert_eq!(e[0], Event::Start { time: Some(5.0) });
        assert_eq!(e[1], Event::ToolStart { name: Some(String::new()), time: Some(5.0) });
        // The session's end ends it.
        assert_eq!(
            events(m.map_hook(&hook("sessionEnd", json!({"reason": "completed", "duration_ms": 9000})), 9.0)),
            vec![Event::Finish { time: Some(9.0) }]
        );
    }

    #[test]
    fn hooks_it_does_not_use_change_nothing() {
        let mut m = Mapper::new(Tool::Cursor);
        for e in ["preToolUse", "beforeShellExecution", "beforeReadFile", "afterFileEdit", "subagentStart"] {
            assert_eq!(m.map_hook(&hook(e, json!({"tool_name": "Shell"})), 1.0), vec![]);
        }
        assert_eq!(m.map_hook(&json!({"hook_event_name": "stop"}), 1.0), vec![]);
    }

    #[test]
    fn a_quiet_turn_closes_before_it_could_count_as_stalled() {
        // The CLI: no prompts, no stop. Its turn closes after 90 s of quiet.
        let mut m = Mapper::new(Tool::Cursor);
        m.map_hook(&hook("sessionStart", json!({})), 0.0);
        m.map_hook(&hook("postToolUse", json!({"tool_name": "Edit", "tool_use_id": "t1", "duration": 1.0})), 1_000.0);
        assert_eq!(events(m.flush(60_000.0)), vec![]);
        assert_eq!(
            events(m.flush(1_000.0 + QUIET_MS)),
            vec![
                Event::ToolEnd { name: Some(String::new()), error: None, time: Some(91_000.0) },
                Event::Finish { time: Some(91_000.0) }
            ]
        );
        assert!(!m.has_open("c-1", TURN));
        // The editor, after a prompt another hook blocked: 4 minutes.
        let mut m = Mapper::new(Tool::Cursor);
        m.map_hook(&hook("beforeSubmitPrompt", json!({})), 0.0);
        assert_eq!(events(m.flush(QUIET_MS + 1.0)), vec![]);
        assert_eq!(events(m.flush(QUIET_PROMPTED_MS)).last(), Some(&Event::Finish { time: Some(QUIET_PROMPTED_MS) }));
    }

    #[test]
    fn late_tools_unknown_conversations_and_unnamed_tools() {
        let mut m = Mapper::new(Tool::Cursor);
        // A conversation never seen start (a subagent's own): ignored.
        assert_eq!(m.map_hook(&hook("postToolUse", json!({"tool_name": "Read", "tool_use_id": "x"})), 1.0), vec![]);
        m.map_hook(&hook("beforeSubmitPrompt", json!({})), 2.0);
        // A tool with no name doesn't close the turn.
        m.map_hook(&hook("postToolUse", json!({"tool_use_id": "t0", "duration": 1.0})), 3.0);
        assert!(m.has_open("c-1", TURN));
        m.map_hook(&hook("stop", json!({"status": "completed"})), 4.0);
        // A tool reported after the stop: shown, and the agent is over again.
        let e = events(
            m.map_hook(&hook("postToolUse", json!({"tool_name": "Shell", "tool_use_id": "t1", "duration": 1.0})), 5.0),
        );
        assert_eq!(e.last(), Some(&Event::Finish { time: Some(5.0) }));
        assert!(!m.has_open("c-1", TURN));
    }
}

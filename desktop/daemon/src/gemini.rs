//! Gemini CLI's hooks, in Claude Code's shape for the shared mapper.
//!
//! Gemini's hooks carry `session_id`, `cwd` and `hook_event_name` like Claude
//! Code's; tool calls have no id, so a call ends the most recent open one of
//! its name. A hook that prints nothing and exits 0 changes nothing in Gemini
//! (any text it printed would be read as its decision), which is all ours do.

use serde_json::{Value, json};

/// Claude Code-shaped hook inputs for one Gemini CLI hook call.
pub fn translate(v: &Value) -> Vec<Value> {
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default();
    let session = s("session_id");
    if session.is_empty() {
        return vec![];
    }
    let base = |event: &str| json!({"session_id": session, "cwd": s("cwd"), "hook_event_name": event});
    let tool = |event: &str| {
        let mut p = base(event);
        p["tool_name"] = json!(s("tool_name"));
        p
    };
    match s("hook_event_name") {
        "SessionStart" => vec![base("SessionStart")],
        "BeforeAgent" => vec![base("UserPromptSubmit")],
        "BeforeTool" => vec![tool("PreToolUse")],
        "AfterTool" => {
            let failed = v
                .get("tool_response")
                .and_then(|r| r.get("error"))
                .is_some_and(|e| !e.is_null() && e.as_str() != Some(""));
            vec![tool(if failed { "PostToolUseFailure" } else { "PostToolUse" })]
        }
        "AfterAgent" => vec![base("Stop")],
        "SessionEnd" => vec![base("SessionEnd")],
        // Gemini is about to ask the person to approve a tool.
        "Notification" if s("notification_type") == "ToolPermission" => {
            let d = v.get("details");
            let what = |k: &str| d.and_then(|d| d.get(k)).and_then(Value::as_str).filter(|x| !x.is_empty());
            let mut p = base("PermissionRequest");
            p["tool_name"] =
                json!(what("toolDisplayName").or(what("rootCommand")).or(what("title")).unwrap_or_default());
            vec![p]
        }
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::{Mapper, Output, Reason, Tool};
    use crate::otlp::Record;
    use agentstat_core::Event;
    use std::collections::HashMap;

    fn hook(event: &str, extra: Value) -> Value {
        let mut v = json!({"session_id": "g-1", "transcript_path": "/x", "cwd": "/Users/me/code/shop",
            "hook_event_name": event, "timestamp": "2026-11-26T10:00:00Z"});
        v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        v
    }

    fn rec(t: f64, name: &str, attrs: Value) -> Record {
        let mut a: HashMap<String, Value> = attrs.as_object().unwrap().clone().into_iter().collect();
        a.insert("event.name".into(), json!(format!("gemini_cli.{name}")));
        a.insert("session.id".into(), json!("g-1"));
        a.insert("prompt".into(), json!("never read"));
        Record { time: t, name: format!("Gemini event {name}"), attrs: a, resource: HashMap::new() }
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
    fn hooks_drive_a_turn_with_tools_and_a_permission_prompt() {
        let mut m = Mapper::new(Tool::Gemini);
        assert_eq!(
            m.map_hook(&hook("SessionStart", json!({"source": "startup"})), 1.0),
            vec![Output::New { id: "gemini:g-1".into(), name: "shop".into() }]
        );
        assert_eq!(
            events(m.map_hook(&hook("BeforeAgent", json!({"prompt": "secret"})), 2.0)),
            vec![Event::Start { time: Some(2.0) }]
        );
        assert_eq!(
            events(m.map_hook(&hook("BeforeTool", json!({"tool_name": "run_shell_command", "tool_input": {}})), 3.0)),
            vec![Event::ToolStart { name: Some("run_shell_command".into()), time: Some(3.0) }]
        );
        let ask = json!({"notification_type": "ToolPermission", "message": "Tool Shell requires execution",
            "details": {"type": "exec", "title": "Shell", "command": "rm -rf build", "rootCommand": "rm"}});
        assert_eq!(
            m.map_hook(&hook("Notification", ask), 3.5),
            vec![Output::Attention {
                id: "gemini:g-1".into(),
                reason: Reason::NeedsYou,
                message: "needs your permission for rm".into(),
                app: None,
                time: 3.5
            }]
        );
        let failed = json!({"tool_name": "run_shell_command", "tool_response": {"llmContent": "", "error": "exit 1"}});
        assert_eq!(
            events(m.map_hook(&hook("AfterTool", failed), 4.0)),
            vec![Event::ToolEnd { name: Some("run_shell_command".into()), error: Some(true), time: Some(4.0) }]
        );
        assert_eq!(
            events(m.map_hook(&hook("AfterAgent", json!({"stop_hook_active": false})), 5.0)),
            vec![Event::Finish { time: Some(5.0) }]
        );
        // Telemetry adds the tokens of the response: answer and thinking.
        let resp = rec(
            5_500.0,
            "api_response",
            json!({"duration_ms": 500, "output_token_count": 30, "thoughts_token_count": 10}),
        );
        assert_eq!(
            events(m.map(&resp, 6_000.0)),
            vec![
                Event::Tokens { count: Some(40.0), total: None, since: Some(5_000.0), time: Some(5_500.0) },
                Event::Finish { time: Some(5_500.0) }
            ]
        );
    }

    #[test]
    fn telemetry_alone_shows_turns_and_tools() {
        let mut m = Mapper::new(Tool::Gemini);
        assert_eq!(
            events(m.map(&rec(100.0, "user_prompt", json!({"prompt_length": 5})), 100.0)),
            vec![Event::Start { time: Some(100.0) }]
        );
        let call = json!({"function_name": "read_file", "duration_ms": 12, "success": true, "start_time": 1_000.0, "decision": "auto_accept"});
        assert_eq!(
            events(m.map(&rec(1_012.0, "tool_call", call), 1_012.0)),
            vec![
                Event::ToolStart { name: Some("read_file".into()), time: Some(1_000.0) },
                Event::ToolEnd { name: Some("read_file".into()), error: Some(false), time: Some(1_012.0) }
            ]
        );
        m.map(&rec(3_000.0, "api_response", json!({"duration_ms": 1000, "output_token_count": 50})), 3_000.0);
        // A tool may be running (Gemini logs it when done): not over yet.
        assert_eq!(events(m.flush(3_000.0 + 10_000.0)), vec![]);
        assert_eq!(
            events(m.flush(3_000.0 + crate::claude::GEMINI_QUIET_MS)),
            vec![Event::Finish { time: Some(3_000.0) }]
        );
        assert_eq!(
            events(m.map(&rec(4_000.0, "api_error", json!({"status_code": 429})), 4_000.0))[0],
            Event::Error { time: Some(4_000.0) }
        );
        // Not Gemini's: ignored.
        let mut other = rec(5_000.0, "user_prompt", json!({}));
        other.attrs.insert("event.name".into(), json!("gen_ai.client.inference.operation.details"));
        assert!(!crate::claude::is_gemini(&other));
    }

    #[test]
    fn hooks_it_does_not_use_change_nothing() {
        let mut m = Mapper::new(Tool::Gemini);
        for e in ["BeforeModel", "AfterModel", "BeforeToolSelection", "PreCompress"] {
            assert_eq!(m.map_hook(&hook(e, json!({})), 1.0), vec![]);
        }
        assert_eq!(m.map_hook(&hook("Notification", json!({"notification_type": "Other"})), 1.0), vec![]);
        assert_eq!(m.map_hook(&json!({"hook_event_name": "BeforeAgent"}), 1.0), vec![]);
    }
}

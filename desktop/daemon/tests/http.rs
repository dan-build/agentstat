//! The service end to end: a real Claude Code turn (sanitized capture) posted
//! as OTLP, read back from the agent list and the live stream.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agentstat_daemon::server::{Daemon, Snapshot, router, spawn_ticker};
use serde_json::Value;

const TURN: &str = include_str!("fixtures/claude-code-turn.json");

/// Start the router on a free port; returns the port.
fn start() -> u16 {
    let std_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = std_listener.local_addr().unwrap().port();
    std_listener.set_nonblocking(true).unwrap();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async move {
            let listener = tokio::net::TcpListener::from_std(std_listener).unwrap();
            let state = Arc::new(Mutex::new(Daemon::new()));
            spawn_ticker(state.clone());
            axum::serve(listener, router(state, port)).await.unwrap();
        });
    });
    port
}

/// One HTTP request; returns (status, headers + body as text).
fn request(port: u16, method: &str, path: &str, host: &str, headers: &[(&str, &str)], body: &str) -> (u16, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut req =
        format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nContent-Length: {}\r\n", body.len());
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    req.push_str(body);
    s.write_all(req.as_bytes()).unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    let status = out.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    (status, out)
}

fn post_turn(port: u16) {
    let host = format!("127.0.0.1:{port}");
    let (status, _) = request(port, "POST", "/v1/logs", &host, &[("Content-Type", "application/json")], TURN);
    assert_eq!(status, 200);
}

fn body_of(resp: &str) -> &str {
    body(resp)
}

fn body(resp: &str) -> &str {
    resp.split_once("\r\n\r\n").map_or("", |(_, b)| b)
}

#[test]
fn a_claude_code_turn_becomes_an_agent() {
    let port = start();
    post_turn(port);
    let list = || {
        let (status, resp) = request(port, "GET", "/v1/agents", "localhost", &[], "");
        assert_eq!(status, 200);
        serde_json::from_str::<Snapshot>(body(&resp)).unwrap()
    };
    let snap = list();
    assert_eq!(snap.agents.len(), 1);
    assert_eq!(snap.agents[0].status, "active");
    // The turn ended with a complete message, no tool open and nothing after it.
    std::thread::sleep(Duration::from_millis(2_200));
    let snap = list();
    let a = &snap.agents[0];
    assert_eq!(a.id, "claude:00000000-test-session");
    assert_eq!(a.name, "Claude Code 00000000");
    assert_eq!(a.status, "complete");
    assert_eq!(a.tool, None);
    // Output tokens of the three model calls.
    assert_eq!(a.total_tokens, 19.0 + 91.0 + 4.0);
}

/// Read SSE frames until `n` messages arrived.
fn read_frames(port: u16, last_event_id: Option<&str>, n: usize) -> Vec<(String, Value)> {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let resume = last_event_id.map(|id| format!("Last-Event-ID: {id}\r\n")).unwrap_or_default();
    write!(s, "GET /v1/stream HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{resume}\r\n").unwrap();
    let mut buf = Vec::new();
    let mut frames = Vec::new();
    let mut chunk = [0u8; 4096];
    while frames.len() < n {
        let k = s.read(&mut chunk).expect("stream ended early");
        assert!(k > 0, "stream closed");
        buf.extend_from_slice(&chunk[..k]);
        let text = String::from_utf8_lossy(&buf).to_string();
        frames = text
            .split("\n\n")
            .filter_map(|f| {
                let id = f.lines().find_map(|l| l.strip_prefix("id: "))?;
                let data = f.lines().find_map(|l| l.strip_prefix("data: "))?;
                Some((id.to_string(), serde_json::from_str(data).ok()?))
            })
            .collect();
    }
    frames
}

#[test]
fn the_stream_speaks_the_npm_wire_format_and_resumes() {
    let port = start();
    post_turn(port);
    let frames = read_frames(port, None, 3);
    let (id, first) = &frames[0];
    // The description comes first, then the session's events with their ages.
    assert_eq!(first["m"]["type"], "agent");
    assert_eq!(first["m"]["name"], "Claude Code 00000000");
    assert!(first["sent"].as_f64().is_some());
    let (inst, seq) = id.split_once(':').unwrap();
    assert_eq!(seq, "1");
    let ev = &frames[1].1;
    assert_eq!(ev["m"]["type"], "event");
    assert_eq!(ev["m"]["event"]["type"], "start");
    assert!(ev["age"].as_f64().unwrap() > 0.0);

    // Resuming after message 2 starts at 3; a stale instance id replays from the start.
    let resumed = read_frames(port, Some(&format!("{inst}:2")), 1);
    assert_eq!(resumed[0].1["m"]["seq"], 3);
    let restarted = read_frames(port, Some("deadbeef:2"), 1);
    assert_eq!(restarted[0].1["m"]["seq"], 1);
}

#[test]
fn plugin_hooks_drive_an_agent_named_after_its_project() {
    let port = start();
    let host = format!("127.0.0.1:{port}");
    let post = |body: serde_json::Value| {
        let (status, _) = request(
            port,
            "POST",
            "/v1/hooks/claude",
            &host,
            &[("Content-Type", "application/json")],
            &body.to_string(),
        );
        assert_eq!(status, 204);
    };
    let base =
        |event: &str| serde_json::json!({"session_id": "s-1", "cwd": "/Users/me/code/shop", "hook_event_name": event});
    let mut pre = base("PreToolUse");
    pre["tool_name"] = "Bash".into();
    pre["tool_use_id"] = "toolu_1".into();
    // A large tool payload is accepted (and dropped): its end must not be lost.
    pre["tool_input"] = serde_json::json!({"command": "x".repeat(2 * 1024 * 1024)});
    post(base("SessionStart"));
    post(base("UserPromptSubmit"));
    post(pre);
    let list = || {
        let (_, resp) = request(port, "GET", "/v1/agents", "localhost", &[], "");
        serde_json::from_str::<Snapshot>(body(&resp)).unwrap()
    };
    let a = &list().agents[0];
    assert_eq!((a.name.as_str(), a.status.as_str(), a.tool.as_deref()), ("shop", "waiting", Some("Bash")));
    let mut done = base("PostToolUse");
    done["tool_name"] = "Bash".into();
    done["tool_use_id"] = "toolu_1".into();
    post(done);
    post(base("Stop"));
    let a = &list().agents[0];
    assert_eq!((a.status.as_str(), a.tool.as_deref()), ("complete", None));
}

#[test]
fn the_stream_names_its_run_before_any_message() {
    let port = start();
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    write!(s, "GET /v1/stream HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").unwrap();
    let mut buf = [0u8; 2048];
    let n = s.read(&mut buf).unwrap();
    let head = String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase();
    let inst = head.lines().find_map(|l| l.strip_prefix("x-agentstat-instance: ")).expect("instance header");
    assert_eq!(inst.trim().len(), 8);
}

#[test]
fn refuses_writes_from_web_pages() {
    let port = start();
    let host = format!("127.0.0.1:{port}");
    let body = r#"{"session_id":"x","hook_event_name":"SessionStart","cwd":"/evil"}"#;
    // A page's "simple" request (no preflight): text/plain, with an Origin.
    let (status, _) = request(
        port,
        "POST",
        "/v1/hooks/claude",
        &host,
        &[("Content-Type", "text/plain"), ("Origin", "https://evil.example")],
        body,
    );
    assert_eq!(status, 403);
    let (status, _) = request(port, "POST", "/v1/hooks/claude", &host, &[("Content-Type", "text/plain")], body);
    assert_eq!(status, 415);
    let (_, resp) = request(port, "GET", "/v1/agents", "localhost", &[], "");
    assert!(serde_json::from_str::<Snapshot>(body_of(&resp)).unwrap().agents.is_empty());
}

#[test]
fn refuses_other_hosts_and_protobuf() {
    let port = start();
    let (status, _) = request(port, "GET", "/v1/agents", "evil.example", &[], "");
    assert_eq!(status, 403);
    let host = format!("127.0.0.1:{port}");
    let (status, resp) = request(port, "POST", "/v1/logs", &host, &[("Content-Type", "application/x-protobuf")], "x");
    assert_eq!(status, 415);
    assert!(body(&resp).contains("http/json"));
}

#[test]
fn the_day_s_history_counts_tools_tokens_and_cost() {
    let port = start();
    let host = format!("127.0.0.1:{port}");
    let post = |path: &str, body: serde_json::Value| {
        let (status, _) =
            request(port, "POST", path, &host, &[("Content-Type", "application/json")], &body.to_string());
        assert!(status == 200 || status == 204, "{path}: {status}");
    };
    let hook =
        |event: &str| serde_json::json!({"session_id": "s-h", "cwd": "/Users/me/code/shop", "hook_event_name": event});
    let mut pre = hook("PreToolUse");
    pre["tool_name"] = "Bash".into();
    pre["tool_use_id"] = "toolu_1".into();
    post("/v1/hooks/claude", hook("UserPromptSubmit"));
    post("/v1/hooks/claude", pre);
    let now_ns = format!("{}", (agentstat_daemon::now_ms() as u64) * 1_000_000);
    let attr = |k: &str, v: serde_json::Value| serde_json::json!({"key": k, "value": v});
    post(
        "/v1/logs",
        serde_json::json!({"resourceLogs": [{
            "resource": {"attributes": [attr("service.name", serde_json::json!({"stringValue": "claude-code"}))]},
            "scopeLogs": [{"scope": {"name": "com.anthropic.claude_code.events"}, "logRecords": [{
                "timeUnixNano": now_ns,
                "body": {"stringValue": "claude_code.api_request"},
                "attributes": [
                    attr("event.name", serde_json::json!({"stringValue": "api_request"})),
                    attr("session.id", serde_json::json!({"stringValue": "s-h"})),
                    attr("output_tokens", serde_json::json!({"intValue": 50})),
                    attr("duration_ms", serde_json::json!({"intValue": 400})),
                    attr("cost_usd", serde_json::json!({"doubleValue": 0.0125})),
                ]
            }]}]
        }]}),
    );
    let (status, resp) = request(port, "GET", "/v1/history", "localhost", &[], "");
    assert_eq!(status, 200);
    let v: Value = serde_json::from_str(body(&resp)).unwrap();
    let r = &v["agents"]["claude:s-h"];
    assert_eq!(r["name"], "shop");
    assert_eq!(r["tools"], 1);
    assert_eq!(r["outputTokens"], 50.0);
    assert_eq!(r["costUsd"], 0.0125);
    assert_eq!(v["dates"][0], v["date"]);
    // Prompt and tool text never reach history.
    assert!(!body(&resp).contains("toolu_1"));
    let (status, _) = request(port, "GET", "/v1/history?date=../../etc", "localhost", &[], "");
    assert_eq!(status, 404);
}

#[test]
fn crossing_the_daily_budget_alerts_once() {
    use agentstat_core::history::Budget;
    let mut d = Daemon::new();
    d.set_budget(Budget { daily_cost_usd: Some(1.0), daily_output_tokens: None });
    let now = agentstat_daemon::now_ms();
    let call = |cost: f64, t: f64| {
        let attr = |k: &str, v: Value| serde_json::json!({"key": k, "value": v});
        serde_json::json!({"resourceLogs": [{
            "resource": {"attributes": [attr("service.name", serde_json::json!({"stringValue": "claude-code"}))]},
            "scopeLogs": [{"logRecords": [{
                "timeUnixNano": format!("{}", (t as u64) * 1_000_000),
                "body": {"stringValue": "claude_code.api_request"},
                "attributes": [
                    attr("event.name", serde_json::json!({"stringValue": "api_request"})),
                    attr("session.id", serde_json::json!({"stringValue": "s-b"})),
                    attr("output_tokens", serde_json::json!({"intValue": 10})),
                    attr("cost_usd", serde_json::json!({"doubleValue": cost})),
                ]
            }]}]
        }]})
    };
    d.ingest_logs(&call(0.5, now), now);
    d.tick(now);
    assert!(d.history(None).unwrap().day.alerts.is_empty());
    d.ingest_logs(&call(0.4, now + 1_000.0), now + 1_000.0);
    d.tick(now + 1_000.0);
    assert_eq!(d.history(None).unwrap().day.alerts, vec!["cost-80@1"]);
    d.ingest_logs(&call(0.4, now + 2_000.0), now + 2_000.0);
    d.tick(now + 2_000.0);
    d.tick(now + 2_500.0);
    let view = d.history(None).unwrap();
    assert_eq!(view.day.alerts, vec!["cost-80@1", "cost-100@1"]);
    assert_eq!(view.budget.daily_cost_usd, Some(1.0));
}

/// A Codex turn as its OTLP/HTTP JSON export (built from Codex's own event
/// definitions, openai/codex rust-v0.172.0: names in `event.name`, the session
/// in `conversation.id`, tokens on `response.completed`, cost per turn).
const CODEX_TURN: &str = include_str!("fixtures/codex-turn.json");

#[test]
fn a_codex_turn_becomes_an_agent_with_tokens_and_cost() {
    let port = start();
    let host = format!("127.0.0.1:{port}");
    let (status, _) = request(port, "POST", "/v1/logs", &host, &[("Content-Type", "application/json")], CODEX_TURN);
    assert_eq!(status, 200);
    let (_, resp) = request(port, "GET", "/v1/agents", "localhost", &[], "");
    let snap = serde_json::from_str::<Snapshot>(body(&resp)).unwrap();
    assert_eq!(snap.agents.len(), 1);
    let a = &snap.agents[0];
    assert_eq!(a.id, "codex:019a6f3c-7e2b-7c41-9d0e-5b8f1a2c3d4e");
    assert_eq!(a.name, "Codex 019a6f3c");
    // The turn's cost record ended it.
    assert_eq!((a.status.as_str(), a.tool.as_deref()), ("complete", None));
    assert_eq!(a.total_tokens, 180.0 + 240.0);
    let (_, resp) = request(port, "GET", "/v1/history", "localhost", &[], "");
    let v: Value = serde_json::from_str(body(&resp)).unwrap();
    let r = &v["agents"]["codex:019a6f3c-7e2b-7c41-9d0e-5b8f1a2c3d4e"];
    assert_eq!(r["tools"], 1);
    assert_eq!(r["costUsd"], 0.0123);
    // Codex sends account fields with every record; none of it is kept.
    let (_, agents) = request(port, "GET", "/v1/agents", "localhost", &[], "");
    for text in [body(&resp), body(&agents)] {
        assert!(!text.contains("example.com") && !text.contains("acct-"));
    }
}

#[test]
fn codex_hooks_drive_an_agent_named_after_its_project() {
    let port = start();
    let host = format!("127.0.0.1:{port}");
    let post = |body: serde_json::Value| {
        let (status, _) =
            request(port, "POST", "/v1/hooks/codex", &host, &[("Content-Type", "application/json")], &body.to_string());
        assert_eq!(status, 204);
    };
    let base = |event: &str| {
        serde_json::json!({"session_id": "019a-x", "cwd": "/Users/me/code/shop", "hook_event_name": event,
            "model": "gpt-5.5-codex", "permission_mode": "default", "turn_id": "t1"})
    };
    let mut pre = base("PreToolUse");
    pre["tool_name"] = "shell".into();
    pre["tool_use_id"] = "call_1".into();
    post(base("SessionStart"));
    post(base("UserPromptSubmit"));
    post(pre);
    let list = || {
        let (_, resp) = request(port, "GET", "/v1/agents", "localhost", &[], "");
        serde_json::from_str::<Snapshot>(body(&resp)).unwrap()
    };
    let a = &list().agents[0];
    assert_eq!(a.id, "codex:019a-x");
    assert_eq!((a.name.as_str(), a.status.as_str(), a.tool.as_deref()), ("shop", "waiting", Some("shell")));
    post(base("Stop"));
    assert_eq!(list().agents[0].status, "complete");
    // Like the Claude Code route, it refuses what a web page could send.
    let (status, _) = request(port, "POST", "/v1/hooks/codex", &host, &[("Content-Type", "text/plain")], "{}");
    assert_ne!(status, 204);
}

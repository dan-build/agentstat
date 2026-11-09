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

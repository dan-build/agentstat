//! `agentstat`: the local service and its command line.
//!
//!   agentstat run -- claude …   run a command with its telemetry going to AgentStat
//!   agentstat watch              live table of every agent
//!   agentstat status             the table once
//!   agentstat serve              run the service in the foreground
//!   agentstat connect claude     set Claude Code up to report here (asks first)
//!   agentstat service install    start the service at login
//!   agentstat doctor             check that everything is in place

use std::io::Write;
use std::os::unix::process::CommandExt;
use std::process::{Command, ExitCode, Stdio};
use std::time::{Duration, Instant};

use agentstat_daemon::server::Snapshot;
use agentstat_daemon::{DEFAULT_PORT, client, setup};

const HELP: &str = "\
agentstat — live telemetry for your coding agents

Get started:
  agentstat connect claude       Set Claude Code up to report here: starts the
                                 service at login, installs the AgentStat plugin,
                                 points its telemetry here. Shows every change
                                 and asks first (--yes to skip, --dry-run to look).
  agentstat doctor               Check that everything is in place.

Usage:
  agentstat run [--port N] [--] <command> [args…]
      Run a command (e.g. claude) with its OpenTelemetry sent to AgentStat.
      Starts the service in the background if it isn't running. Options go
      before the command; everything after it is the command's own.
  agentstat watch [--port N]     Live table of every agent (Ctrl-C to quit).
  agentstat mcp [--port N]       MCP server (stdio) so an agent can read the fleet.
  agentstat status [--port N]    Print the table once.
  agentstat serve [--port N]     Run the service in the foreground.
  agentstat service install|uninstall|status
                                 Start the service at login (launchd), or stop.
  agentstat disconnect claude    Undo `connect claude` (asks first).

The service listens on 127.0.0.1 only (default port 4318, or $AGENTSTAT_PORT).
";

fn parse_port(s: &str) -> Option<u16> {
    s.trim().parse::<u16>().ok().filter(|p| *p != 0)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut port = match std::env::var("AGENTSTAT_PORT") {
        Ok(v) => match parse_port(&v) {
            Some(p) => p,
            None => return fail("AGENTSTAT_PORT must be a port number (1–65535)"),
        },
        Err(_) => DEFAULT_PORT,
    };
    let Some((cmd, rest)) = args.split_first() else {
        print!("{HELP}");
        return ExitCode::SUCCESS;
    };
    // Options come right after the command. For `run`, the program begins at the
    // first other argument (or after `--`), and everything from there is its own.
    // Setup commands take one word (`connect claude`, `service install`) and
    // --yes / --dry-run, anywhere after the command.
    let takes_word = matches!(cmd.as_str(), "connect" | "disconnect" | "service");
    let mut word: Option<&str> = None;
    let mut confirm = setup::Confirm::default();
    let mut i = 0;
    while i < rest.len() {
        match rest[i].as_str() {
            "--port" => {
                port = match rest.get(i + 1).and_then(|p| parse_port(p)) {
                    Some(p) => p,
                    None => return fail("--port needs a port number (1–65535)"),
                };
                i += 2;
            }
            "--" if cmd == "run" => {
                i += 1;
                break;
            }
            _ if cmd == "run" => break,
            "-y" | "--yes" if takes_word => {
                confirm.yes = true;
                i += 1;
            }
            "--dry-run" if takes_word => {
                confirm.dry_run = true;
                i += 1;
            }
            w if takes_word && word.is_none() && !w.starts_with('-') => {
                word = Some(w);
                i += 1;
            }
            other => return fail(&format!("unexpected argument `{other}` (see `agentstat --help`)")),
        }
    }
    let rest = &rest[i..];
    match cmd.as_str() {
        "serve" => serve(port),
        "run" => run(port, rest),
        "watch" => watch(port),
        "status" => status(port),
        "mcp" => mcp(port),
        "connect" => setup::connect(word, port, confirm),
        "disconnect" => setup::disconnect(word, port, confirm),
        "service" => setup::service(word, port, confirm),
        "doctor" => setup::doctor(port),
        "-V" | "--version" => {
            println!("agentstat {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        "-h" | "--help" | "help" => {
            print!("{HELP}");
            ExitCode::SUCCESS
        }
        other => fail(&format!("unknown command `{other}` (see `agentstat --help`)")),
    }
}

fn fail(msg: &str) -> ExitCode {
    eprintln!("agentstat: {msg}");
    ExitCode::FAILURE
}

fn serve(port: u16) -> ExitCode {
    let rt = match tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build() {
        Ok(rt) => rt,
        Err(e) => return fail(&e.to_string()),
    };
    eprintln!("agentstat: listening on http://127.0.0.1:{port}");
    match rt.block_on(agentstat_daemon::server::serve(port)) {
        Ok(()) => ExitCode::SUCCESS,
        // Another copy already serves (the app's, or one started by hand): that's
        // the job done, and a clean exit keeps launchd from restarting this one.
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse && client::is_up(port) => {
            eprintln!("agentstat: already running on port {port}");
            ExitCode::SUCCESS
        }
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            fail(&format!("port {port} is in use (another agentstat or an OpenTelemetry collector?); try --port"))
        }
        Err(e) => fail(&e.to_string()),
    }
}

/// Start the service in the background, detached from this terminal, and wait
/// until it answers.
fn ensure_service(port: u16) -> Result<(), String> {
    if client::is_up(port) {
        return Ok(());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(exe);
    cmd.args(["serve", "--port", &port.to_string()]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    // Its own session: Ctrl-C in this terminal must not stop it.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    cmd.spawn().map_err(|e| format!("couldn't start the service: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if client::is_up(port) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(format!("the service didn't start on port {port} (is the port in use? try --port)"))
}

fn run(port: u16, args: &[String]) -> ExitCode {
    let Some((program, rest)) = args.split_first() else {
        return fail("nothing to run: agentstat run -- <command> [args…]");
    };
    if let Err(e) = ensure_service(port) {
        return fail(&e);
    }
    let endpoint = format!("http://127.0.0.1:{port}");
    let mut cmd = Command::new(program);
    // Signal-specific settings would win over the ones below and send the
    // telemetry elsewhere (or compressed, or as protobuf).
    for signal in ["LOGS", "METRICS", "TRACES"] {
        for what in ["ENDPOINT", "PROTOCOL", "COMPRESSION", "HEADERS"] {
            cmd.env_remove(format!("OTEL_EXPORTER_OTLP_{signal}_{what}"));
        }
    }
    // Replace this process, so the command keeps the terminal and its exit code.
    let err = cmd
        .args(rest)
        // Claude Code
        .env("CLAUDE_CODE_ENABLE_TELEMETRY", "1")
        // Any OpenTelemetry SDK
        .env("OTEL_LOGS_EXPORTER", "otlp")
        .env("OTEL_METRICS_EXPORTER", "otlp")
        .env("OTEL_EXPORTER_OTLP_PROTOCOL", "http/json")
        .env("OTEL_EXPORTER_OTLP_ENDPOINT", &endpoint)
        .env("OTEL_EXPORTER_OTLP_COMPRESSION", "none")
        // The AgentStat plugin's hooks post to the same service.
        .env("AGENTSTAT_PORT", port.to_string())
        // Events in about a second, not the SDK default of five.
        .env("OTEL_LOGS_EXPORT_INTERVAL", "1000")
        .env("OTEL_METRIC_EXPORT_INTERVAL", "10000")
        .exec();
    fail(&format!("couldn't run `{program}`: {err}"))
}

fn fetch(port: u16) -> Result<Snapshot, String> {
    let body = client::get(port, "/v1/agents").map_err(|_| {
        format!("no AgentStat service on port {port}; start one with `agentstat serve` or `agentstat run`")
    })?;
    serde_json::from_str(&body).map_err(|e| format!("unexpected answer from the service: {e}"))
}

fn duration(ms: f64) -> String {
    let s = (ms / 1000.0).floor() as u64;
    match s {
        0..60 => format!("{s}s"),
        60..3600 => format!("{}m {:02}s", s / 60, s % 60),
        _ => format!("{}h {:02}m", s / 3600, s / 60 % 60),
    }
}

/// Fit `s` in `w` columns (cut with an ellipsis).
fn fit(s: &str, w: usize) -> String {
    let n = s.chars().count();
    if n <= w { format!("{s:<w$}") } else { format!("{}…", s.chars().take(w - 1).collect::<String>()) }
}

fn table(snap: &Snapshot) -> String {
    let mut out = String::new();
    if snap.agents.is_empty() {
        out.push_str("No agents yet. Start one with: agentstat run -- claude\n");
        return out;
    }
    out.push_str(&format!(
        "{:<22} {:<18} {:>8} {:>9} {:>7}  {:<14} {}\n",
        "AGENT", "STATUS", "TOK/S", "TOKENS", "HEALTH", "TOOL", "ANOMALY"
    ));
    for a in &snap.agents {
        let status = format!("{} {}", a.status, duration(a.status_ms));
        let health = a.health.map_or("–".into(), |h| format!("{h:.0}"));
        out.push_str(&format!(
            "{} {} {:>8.1} {:>9.0} {:>7}  {} {}\n",
            fit(&a.name, 22),
            fit(&status, 18),
            a.rate,
            a.total_tokens,
            health,
            fit(a.tool.as_deref().unwrap_or("–"), 14),
            a.anomalies.first().map_or("", String::as_str),
        ));
    }
    let recent: Vec<_> = snap.recent.iter().rev().take(3).collect();
    if !recent.is_empty() {
        out.push_str("\nRecent:\n");
        for r in recent {
            let what = if r.resolved { "resolved" } else { r.severity.as_str() };
            out.push_str(&format!("  {} — {} ({what})\n", r.name, r.message));
        }
    }
    out
}

/// A minimal MCP server over stdio (newline-delimited JSON-RPC): one tool,
/// `fleet_status`, returning the same table as `agentstat status`.
fn mcp(port: u16) -> ExitCode {
    use serde_json::{Value, json};
    use std::io::BufRead;
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let mut reply = |v: Value| writeln!(out, "{v}").and_then(|_| out.flush());
        let Ok(req) = serde_json::from_str::<Value>(&line) else {
            if reply(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "parse error" } }))
                .is_err()
            {
                break;
            }
            continue;
        };
        if req.is_array() {
            if reply(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32600, "message": "batches aren't supported" } }))
                .is_err()
            {
                break;
            }
            continue;
        }
        // Notifications (no id) and the client's own responses (no method) get no reply.
        let (Some(id), Some(method)) = (req.get("id").cloned(), req.get("method").and_then(Value::as_str)) else {
            continue;
        };
        let result = match method {
            "initialize" => Ok(json!({
                // The client's version when it's one this server speaks; else the newest it does.
                "protocolVersion": req["params"]["protocolVersion"]
                    .as_str()
                    .filter(|v| ["2025-06-18", "2025-03-26", "2024-11-05"].contains(v))
                    .unwrap_or("2025-06-18"),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "agentstat", "version": env!("CARGO_PKG_VERSION") },
            })),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": [{
                "name": "fleet_status",
                "description": "Every agent AgentStat sees on this machine (Claude Code sessions and \
                    subagents, and anything else reporting to it): status and for how long, output \
                    tokens, the tool running, health, active anomalies, and recent anomalies.",
                "inputSchema": { "type": "object", "properties": {} },
            }]})),
            "tools/call" if req["params"]["name"] == "fleet_status" => Ok(match fetch(port) {
                Ok(snap) => json!({ "content": [{ "type": "text", "text": table(&snap) }] }),
                Err(e) => json!({ "content": [{ "type": "text", "text": e }], "isError": true }),
            }),
            "tools/call" => Err((-32602, "unknown tool")),
            _ => Err((-32601, "method not found")),
        };
        let message = match result {
            Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
            Err((code, msg)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": msg } }),
        };
        if reply(message).is_err() {
            break;
        }
    }
    ExitCode::SUCCESS
}

fn status(port: u16) -> ExitCode {
    match fetch(port) {
        Ok(s) => {
            print!("{}", table(&s));
            ExitCode::SUCCESS
        }
        Err(e) => fail(&e),
    }
}

fn watch(port: u16) -> ExitCode {
    let mut out = std::io::stdout();
    let _ = write!(out, "\x1b[2J");
    loop {
        let frame = match fetch(port) {
            Ok(s) => table(&s),
            Err(e) => format!("{e}\n"),
        };
        // Home, draw, clear what's left of the previous frame.
        let _ = write!(out, "\x1b[H{}\x1b[J", frame.replace('\n', "\x1b[K\n"));
        let _ = out.flush();
        std::thread::sleep(Duration::from_millis(500));
    }
}

//! `agentstat`: the local service and its command line.
//!
//!   agentstat run -- claude …   run a command with its telemetry going to AgentStat
//!   agentstat watch              live table of every agent
//!   agentstat status             the table once
//!   agentstat today              what each project did today
//!   agentstat budget --cost 20   a daily budget, with an alert at 80% and 100%
//!   agentstat serve              run the service in the foreground
//!   agentstat connect claude     set Claude Code up to report here (asks first)
//!   agentstat connect codex      the same for Codex
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
  agentstat connect codex        The same for Codex: points its telemetry here
                                 and adds hooks for live turns and tools (trust
                                 them once in Codex: /hooks, then t).
  agentstat doctor               Check that everything is in place.

Usage:
  agentstat run [--port N] [--] <command> [args…]
      Run a command (e.g. claude) with its OpenTelemetry sent to AgentStat.
      Starts the service in the background if it isn't running. Options go
      before the command; everything after it is the command's own.
  agentstat watch [--port N]     Live table of every agent (Ctrl-C to quit).
  agentstat mcp [--port N]       MCP server (stdio) so an agent can read the fleet.
  agentstat status [--port N]    Print the table once.
  agentstat today [--port N] [--date YYYY-MM-DD]
                                 What each project did today (or that day):
                                 sessions, time working, tokens, cost,
                                 anomalies. Kept for 7 days.
  agentstat budget [--cost USD] [--tokens N] | budget off
                                 A daily budget for cost and/or output tokens
                                 (e.g. --tokens 2M). The app notifies at 80%
                                 and at 100%. Without options: today against it.
  agentstat serve [--port N]     Run the service in the foreground.
  agentstat service install|uninstall|status
                                 Start the service at login (launchd), or stop.
  agentstat disconnect claude|codex
                                 Undo `connect` (asks first).

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
    let takes_word = matches!(cmd.as_str(), "connect" | "disconnect" | "service" | "budget");
    let mut word: Option<&str> = None;
    let mut confirm = setup::Confirm::default();
    let mut date: Option<String> = None;
    let (mut cost, mut tokens): (Option<f64>, Option<f64>) = (None, None);
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
            "--date" if cmd == "today" => {
                date = match rest.get(i + 1).filter(|d| agentstat_daemon::history::is_date(d)) {
                    Some(d) => Some(d.clone()),
                    None => return fail("--date needs a date like 2026-11-21"),
                };
                i += 2;
            }
            "--cost" | "--tokens" if cmd == "budget" => {
                let Some(v) = rest.get(i + 1).and_then(|v| parse_amount(v)) else {
                    return fail(&format!("{} needs an amount, like 20 or 2M", rest[i]));
                };
                if rest[i] == "--cost" {
                    cost = Some(v);
                } else {
                    tokens = Some(v);
                }
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
        "today" => today(port, date.as_deref()),
        "budget" => budget(port, word, cost, tokens),
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
    // Codex reads its telemetry settings from its config file only.
    if std::path::Path::new(program).file_name().is_some_and(|n| n == "codex") {
        eprintln!(
            "agentstat: Codex ignores the environment this sets; its telemetry and hooks are set up once with `agentstat connect codex`"
        );
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
        out.push_str("No agents yet. Connect one with: agentstat connect claude (or codex)\n");
        return out;
    }
    out.push_str(&format!(
        "{:<22} {:<18} {:>8} {:>9} {:>7}  {:<14} {}\n",
        "AGENT", "STATUS", "TOK/S", "TOKENS", "HEALTH", "TOOL", "ANOMALY"
    ));
    for a in &snap.agents {
        // Waiting on you says so first: only you can unblock it.
        let word = if a.needs_you.is_some() { "needs you" } else { a.status.as_str() };
        let status = format!("{word} {}", duration(a.status_ms));
        let health = a.health.map_or("–".into(), |h| format!("{h:.0}"));
        out.push_str(&format!(
            "{} {} {:>8.1} {:>9.0} {:>7}  {} {}\n",
            fit(&a.name, 22),
            fit(&status, 18),
            a.rate,
            a.total_tokens,
            health,
            fit(a.tool.as_deref().unwrap_or("–"), 14),
            a.needs_you.as_deref().or(a.anomalies.first().map(String::as_str)).unwrap_or(""),
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

fn today(port: u16, date: Option<&str>) -> ExitCode {
    use agentstat_core::history::{Day, summarize};
    let path = date.map_or("/v1/history".to_string(), |d| format!("/v1/history?date={d}"));
    let day: Day = match client::get(port, &path) {
        Ok(body) => match serde_json::from_str(&body) {
            Ok(d) => d,
            Err(e) => return fail(&format!("unexpected answer from the service: {e}")),
        },
        Err(_) if !client::is_up(port) => {
            return fail(&format!("no AgentStat service on port {port} (start it with `agentstat serve`)"));
        }
        Err(_) => return fail(&format!("no history for {}", date.unwrap_or("today"))),
    };
    let (rows, total) = summarize(&day);
    if rows.is_empty() {
        println!("Nothing recorded on {} yet.", day.date);
        return ExitCode::SUCCESS;
    }
    println!(
        "{:<22} {:>8} {:>9} {:>10} {:>9} {:>6} {:>6} {:>9}",
        "PROJECT", "SESSIONS", "WORKING", "TOKENS", "COST", "TOOLS", "ERRORS", "ANOMALIES"
    );
    let line = |r: &agentstat_core::history::Row, name: &str| {
        println!(
            "{} {:>8} {:>9} {:>10.0} {:>9} {:>6} {:>6} {:>9}",
            fit(name, 22),
            r.sessions,
            duration(r.working_ms),
            r.output_tokens,
            format!("${:.2}", r.cost_usd),
            r.tools,
            r.errors,
            r.anomalies
        );
    };
    for r in &rows {
        line(r, &r.project);
    }
    if rows.len() > 1 {
        line(&total, &format!("All ({})", day.date));
    }
    ExitCode::SUCCESS
}

/// "20", "$20", "2.5M", "500k": a positive amount.
fn parse_amount(s: &str) -> Option<f64> {
    let s = s.trim().trim_start_matches('$').replace(',', "");
    let (num, mul) = match s.chars().last()? {
        'k' | 'K' => (&s[..s.len() - 1], 1e3),
        'm' | 'M' => (&s[..s.len() - 1], 1e6),
        _ => (s.as_str(), 1.0),
    };
    num.parse::<f64>().ok().map(|v| v * mul).filter(|v| v.is_finite() && *v > 0.0)
}

fn budget(port: u16, word: Option<&str>, cost: Option<f64>, tokens: Option<f64>) -> ExitCode {
    use agentstat_core::history::{Budget, format_tokens, summarize};
    use agentstat_daemon::history::{budget_file, read_budget, write_budget};
    let Some(path) = budget_file(port) else { return fail("HOME isn't set") };
    let mut b = match read_budget(&path) {
        Ok(b) => b,
        // Don't overwrite what someone wrote by hand; `off` replaces it.
        Err(_) if word == Some("off") => Budget::default(),
        Err(e) => return fail(&format!("{}: {e} (fix it, or start over with `agentstat budget off`)", path.display())),
    };
    match word {
        Some("off") if cost.is_some() || tokens.is_some() => {
            return fail("`off` removes the whole budget; to change one limit, give just --cost or --tokens");
        }
        Some("off") => b = Budget::default(),
        Some(other) => return fail(&format!("unexpected argument `{other}` (budget takes --cost, --tokens or off)")),
        None => {
            b.daily_cost_usd = cost.or(b.daily_cost_usd);
            b.daily_output_tokens = tokens.or(b.daily_output_tokens);
        }
    }
    if (word.is_some() || cost.is_some() || tokens.is_some())
        && let Err(e) = write_budget(&path, &b)
    {
        return fail(&format!("couldn't save the budget: {e}"));
    }
    if !b.is_set() {
        println!("No daily budget. Set one with: agentstat budget --cost 20 (or --tokens 2M)");
        return ExitCode::SUCCESS;
    }
    let today = client::get(port, "/v1/history")
        .ok()
        .and_then(|body| serde_json::from_str::<agentstat_core::history::Day>(&body).ok())
        .map(|d| summarize(&d).1);
    let share = |used: f64, limit: f64| format!("{:.0}%", used / limit * 100.0);
    println!("Daily budget (alerts at 80% and 100%):");
    if let Some(l) = b.daily_cost_usd {
        let now =
            today.as_ref().map_or(String::new(), |t| format!("today ${:.2}, {}", t.cost_usd, share(t.cost_usd, l)));
        println!("  cost           {:<9}{now}", format!("${l:.2}"));
    }
    if let Some(l) = b.daily_output_tokens {
        let now = today.as_ref().map_or(String::new(), |t| {
            format!("today {}, {}", format_tokens(t.output_tokens), share(t.output_tokens, l))
        });
        println!("  output tokens  {:<9}{now}", format_tokens(l));
    }
    if today.is_none() {
        println!("(The service isn't running, so today's use isn't shown.)");
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

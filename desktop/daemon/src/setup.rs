//! Setting AgentStat up on this machine: starting the service at login,
//! connecting Claude Code to it, and checking that everything is in place
//! (`agentstat service`, `agentstat connect`, `agentstat doctor`).
//!
//! Every change is shown before it's made and needs a yes; every change has a
//! command that undoes it. Nothing here talks to anything but this machine.

use std::fmt::Write as _;
use std::io::{BufRead, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};

use serde_json::{Map, Value};

use crate::{DEFAULT_PORT, client};

/// The launchd job's label (and its plist's file name).
pub const LABEL: &str = "io.github.dan-build.agentstat";
/// Where Claude Code's plugin comes from: this repository's marketplace.
const MARKETPLACE: &str = "dan-build/agentstat";
const PLUGIN_ID: &str = "agentstat@agentstat";

// ---------------------------------------------------------------- output

struct Out {
    color: bool,
}

impl Out {
    fn new() -> Self {
        Out { color: std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none() }
    }
    fn paint(&self, code: &str, s: &str) -> String {
        if self.color { format!("\x1b[{code}m{s}\x1b[0m") } else { s.to_string() }
    }
    fn ok(&self, msg: &str) {
        println!("  {} {msg}", self.paint("32", "✓"));
    }
    fn warn(&self, msg: &str) {
        println!("  {} {msg}", self.paint("33", "!"));
    }
    fn bad(&self, msg: &str) {
        println!("  {} {msg}", self.paint("31", "✗"));
    }
    fn note(&self, msg: &str) {
        println!("  {} {msg}", self.paint("2", "·"));
    }
    fn dim(&self, s: &str) -> String {
        self.paint("2", s)
    }
}

/// `--yes` / `--dry-run`, shared by the commands that change things.
#[derive(Clone, Copy, Default)]
pub struct Confirm {
    pub yes: bool,
    pub dry_run: bool,
}

/// Ask before applying a plan. False (with the reason printed) when the
/// answer is no, it's a dry run, or there's no one to ask.
fn confirm(c: Confirm) -> bool {
    if c.dry_run {
        println!("\nDry run: nothing was changed.");
        return false;
    }
    if c.yes {
        return true;
    }
    if !std::io::stdin().is_terminal() {
        println!("\nNothing was changed. Run again with --yes to apply.");
        return false;
    }
    print!("\nApply? [y/N] ");
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    let _ = std::io::stdin().lock().read_line(&mut line);
    let yes = matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes");
    if !yes {
        println!("Nothing was changed.");
    }
    yes
}

fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME").filter(|h| !h.is_empty()).map(PathBuf::from).ok_or_else(|| "HOME isn't set".into())
}

/// `~/…` for paths under the home folder, so plans read short.
fn tilde(p: &Path) -> String {
    match home() {
        Ok(h) => match p.strip_prefix(&h) {
            Ok(rest) => format!("~/{}", rest.display()),
            Err(_) => p.display().to_string(),
        },
        Err(_) => p.display().to_string(),
    }
}

/// Write a file by replacing it in one step (a crash can't leave half a file),
/// keeping the old file's permissions.
fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    // A symlinked file (settings kept in a dotfiles repo) stays a link: write
    // where it points.
    let resolved = std::fs::canonicalize(path).ok().filter(|_| path.is_symlink());
    let path = resolved.as_deref().unwrap_or(path);
    let dir = path.parent().ok_or("no parent folder")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("couldn't create {}: {e}", tilde(dir)))?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = dir.join(format!(".{name}.agentstat-{}", std::process::id()));
    std::fs::write(&tmp, contents).map_err(|e| format!("couldn't write {}: {e}", tilde(&tmp)))?;
    if let Ok(meta) = std::fs::metadata(path) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("couldn't replace {}: {e}", tilde(path))
    })
}

/// The first file named `name` in PATH, plus the usual install folders that
/// a non-login shell's PATH may lack.
fn which(name: &str, extra: &[PathBuf]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path).chain(extra.iter().cloned()).map(|d| d.join(name)).find(|p| p.is_file())
}

// ---------------------------------------------------------------- service

/// The binary launchd should start: this one, except that a Homebrew install
/// is named by its stable link (`…/bin/agentstat`), not the versioned Cellar
/// path an upgrade deletes.
pub fn stable_exe(exe: &Path) -> PathBuf {
    let s = exe.to_string_lossy();
    if let Some(i) = s.find("/Cellar/") {
        let link = PathBuf::from(format!("{}/bin/agentstat", &s[..i]));
        if link.is_file() {
            return link;
        }
    }
    exe.to_path_buf()
}

/// Why a path is no place for a login item to point at, if it isn't.
pub fn temporary_location(exe: &Path) -> Option<&'static str> {
    let s = exe.to_string_lossy();
    if s.contains("/AppTranslocation/") {
        Some("a quarantined copy macOS made (move AgentStat.app to Applications and open it once)")
    } else if s.starts_with("/Volumes/") {
        Some("a mounted disk image")
    } else if s.contains("/target/debug/") || s.starts_with("/private/tmp/") || s.starts_with("/tmp/") {
        Some("a build or temporary folder")
    } else {
        None
    }
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// The launchd job: `agentstat serve` at login, restarted if it crashes (not
/// when it exits on its own — e.g. because another copy already serves).
pub fn plist(exe: &Path, port: u16, log: &Path) -> String {
    let exe = xml_escape(&exe.to_string_lossy());
    let log = xml_escape(&log.to_string_lossy());
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>{exe}</string>
		<string>serve</string>
		<string>--port</string>
		<string>{port}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>{log}</string>
	<key>StandardErrorPath</key>
	<string>{log}</string>
</dict>
</plist>
"#
    )
}

/// The program and port a written plist starts (for `doctor`).
fn plist_program(text: &str) -> Option<(String, Option<u16>)> {
    let args = text.split("<key>ProgramArguments</key>").nth(1)?.split("</array>").next()?;
    let strings: Vec<String> = args
        .split("<string>")
        .skip(1)
        .filter_map(|s| s.split("</string>").next())
        .map(|s| s.replace("&quot;", "\"").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&"))
        .collect();
    let port = strings.iter().position(|s| s == "--port").and_then(|i| strings.get(i + 1)?.parse().ok());
    Some((strings.first()?.clone(), port))
}

fn plist_path(home: &Path) -> PathBuf {
    home.join("Library/LaunchAgents").join(format!("{LABEL}.plist"))
}

fn log_path(home: &Path) -> PathBuf {
    home.join("Library/Logs/AgentStat/service.log")
}

fn gui_domain() -> String {
    format!("gui/{}", unsafe { libc::getuid() })
}

/// launchd's view of the job: None when it isn't loaded, else its pid if running.
fn launchd_job() -> Option<Option<u32>> {
    let out = Command::new("launchctl")
        .args(["print", &format!("{}/{LABEL}", gui_domain())])
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Some(text.lines().find_map(|l| l.trim().strip_prefix("pid = ")?.trim().parse().ok()))
}

fn launchctl(args: &[&str]) -> Result<(), String> {
    let out = Command::new("launchctl").args(args).output().map_err(|e| format!("couldn't run launchctl: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(format!("launchctl {} failed: {}", args.first().unwrap_or(&""), err.trim()))
    }
}

/// The start-at-login step of a plan, or None when it's already in place.
fn service_step(port: u16) -> Result<Option<(PathBuf, String)>, String> {
    let home = home()?;
    let exe = stable_exe(&std::env::current_exe().map_err(|e| e.to_string())?);
    if let Some(why) = temporary_location(&exe) {
        return Err(format!(
            "this agentstat runs from {why} ({}), which goes away; install it first \
             (the installer, or copy AgentStat.app to Applications) and run this again",
            exe.display()
        ));
    }
    if !client::is_up(port) && std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
        return Err(format!(
            "port {port} is taken by something that isn't AgentStat (an OpenTelemetry collector?); \
             free it, or pick another with --port"
        ));
    }
    let path = plist_path(&home);
    let wanted = plist(&exe, port, &log_path(&home));
    let current = std::fs::read_to_string(&path).ok();
    if current.as_deref() == Some(wanted.as_str()) && launchd_job().is_some() {
        return Ok(None);
    }
    Ok(Some((path, wanted)))
}

fn apply_service(path: &Path, plist: &str) -> Result<(), String> {
    let home = home()?;
    let _ = std::fs::create_dir_all(log_path(&home).parent().unwrap_or(&home));
    write_atomic(path, plist)?;
    // Reload, so a changed plist takes effect now (bootout fails harmlessly
    // when the job isn't loaded).
    let domain = gui_domain();
    if launchd_job().is_some() {
        let _ = launchctl(&["bootout", &format!("{domain}/{LABEL}")]);
        // The old copy must be gone (and its port free) before the new one
        // starts, or it would find the port busy and step aside for good.
        for _ in 0..60 {
            if launchd_job().is_none() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
    let plist = path.to_string_lossy();
    launchctl(&["bootstrap", &domain, &plist]).or_else(|_| {
        // launchd can refuse briefly right after a bootout.
        std::thread::sleep(std::time::Duration::from_millis(500));
        launchctl(&["bootstrap", &domain, &plist])
    })
}

pub fn service(cmd: Option<&str>, port: u16, c: Confirm) -> ExitCode {
    let out = Out::new();
    let result = match cmd {
        Some("install") => service_install(&out, port, c),
        Some("uninstall") => service_uninstall(&out, c),
        Some("status") | None => {
            service_report(&out, port);
            Ok(true)
        }
        Some(other) => Err(format!("unknown `service` command `{other}` (install, uninstall or status)")),
    };
    finish(result)
}

fn finish(result: Result<bool, String>) -> ExitCode {
    match result {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(e) => {
            eprintln!("agentstat: {e}");
            ExitCode::FAILURE
        }
    }
}

fn service_install(out: &Out, port: u16, c: Confirm) -> Result<bool, String> {
    let Some((path, plist)) = service_step(port)? else {
        out.ok("The service already starts at login.");
        return Ok(true);
    };
    println!("Start the AgentStat service at login (127.0.0.1:{port} only):\n");
    println!("  write  {}", tilde(&path));
    println!("  load   launchctl bootstrap {} …", gui_domain());
    println!("  {}", out.dim(&format!("undo: agentstat service uninstall · log: {}", tilde(&log_path(&home()?)))));
    if !confirm(c) {
        return Ok(c.dry_run);
    }
    apply_service(&path, &plist)?;
    out.ok("The service starts at login.");
    Ok(true)
}

fn service_uninstall(out: &Out, c: Confirm) -> Result<bool, String> {
    let path = plist_path(&home()?);
    let loaded = launchd_job().is_some();
    if !path.exists() && !loaded {
        out.ok("The service doesn't start at login; nothing to undo.");
        return Ok(true);
    }
    println!("Stop starting the AgentStat service at login:\n");
    if loaded {
        println!("  stop    launchctl bootout {}/{LABEL}", gui_domain());
    }
    if path.exists() {
        println!("  remove  {}", tilde(&path));
    }
    if !confirm(c) {
        return Ok(c.dry_run);
    }
    if loaded {
        launchctl(&["bootout", &format!("{}/{LABEL}", gui_domain())])?;
    }
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("couldn't remove {}: {e}", tilde(&path)))?;
    }
    out.ok("The service no longer starts at login.");
    Ok(true)
}

/// One line on the service, for `service status` and `doctor`. False when
/// something is wrong.
fn service_report(out: &Out, port: u16) -> bool {
    let mut fine = true;
    match client::is_up(port) {
        true => out.ok(&format!("Service answering on 127.0.0.1:{port}")),
        false if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() => {
            out.bad(&format!(
                "Port {port} is taken by something that isn't AgentStat (an OpenTelemetry collector?). \
                 Free it, or use another port with --port / AGENTSTAT_PORT."
            ));
            fine = false;
        }
        false => {
            out.bad(&format!(
                "No service on 127.0.0.1:{port}. Start it: agentstat service install (or agentstat serve)"
            ));
            fine = false;
        }
    }
    let Ok(home) = home() else { return false };
    let path = plist_path(&home);
    let written = std::fs::read_to_string(&path).ok();
    match (written.as_deref().and_then(plist_program), launchd_job()) {
        (None, None) => out.warn("Doesn't start at login (agentstat service install)"),
        (Some((exe, _)), _) if !Path::new(&exe).is_file() => {
            out.bad(&format!(
                "Start at login points to a missing program ({exe}). Run agentstat service install again."
            ));
            fine = false;
        }
        (Some((_, Some(p))), _) if p != port => {
            out.warn(&format!("Starts at login on port {p}, not {port}"));
        }
        (Some(_), Some(Some(pid))) => out.ok(&format!("Starts at login (launchd, running as pid {pid})")),
        (Some(_), Some(None)) => {
            out.note("Starts at login (launchd; another copy is serving now, launchd's takes over at next login)")
        }
        (Some(_), None) => out.warn("Start-at-login file exists but isn't loaded (agentstat service install)"),
        (None, Some(_)) => out.warn("A launchd job is loaded without its file (agentstat service uninstall)"),
    }
    fine
}

// ---------------------------------------------------------------- Claude Code

fn claude_dir(home: &Path) -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()).map(PathBuf::from).unwrap_or(home.join(".claude"))
}

fn find_claude(home: &Path) -> Option<PathBuf> {
    which("claude", &[home.join(".local/bin"), home.join(".claude/local"), PathBuf::from("/opt/homebrew/bin")])
}

/// The settings Claude Code needs to send its telemetry here: token counts and
/// cost per call (the plugin's hooks carry turns and tools, not tokens).
pub fn claude_env(port: u16) -> Vec<(&'static str, String)> {
    let mut env = vec![
        ("CLAUDE_CODE_ENABLE_TELEMETRY", "1".to_string()),
        ("OTEL_LOGS_EXPORTER", "otlp".to_string()),
        ("OTEL_EXPORTER_OTLP_PROTOCOL", "http/json".to_string()),
        ("OTEL_EXPORTER_OTLP_ENDPOINT", format!("http://127.0.0.1:{port}")),
        ("OTEL_EXPORTER_OTLP_COMPRESSION", "none".to_string()),
        // Events in about a second, not the default five.
        ("OTEL_LOGS_EXPORT_INTERVAL", "1000".to_string()),
    ];
    if port != DEFAULT_PORT {
        // The plugin's hooks read it to find the service.
        env.push(("AGENTSTAT_PORT", port.to_string()));
    }
    env
}

/// Settings that would send the logs somewhere else even with ours in place.
const OVERRIDES: [&str; 4] = [
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
    "OTEL_EXPORTER_OTLP_LOGS_COMPRESSION",
    "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
];

/// What connecting changes in Claude Code's `settings.json` `env`.
#[derive(Debug, Default, PartialEq)]
pub struct EnvPlan {
    pub add: Vec<(String, String)>,
    /// Keys already set to something else: telemetry goes elsewhere, and we
    /// leave it alone.
    pub conflicts: Vec<(String, String)>,
}

pub fn plan_env(settings: &Value, port: u16) -> EnvPlan {
    let env = settings.get("env").and_then(Value::as_object);
    let get = |k: &str| env.and_then(|e| e.get(k)).map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_string));
    let mut plan = EnvPlan::default();
    for (k, v) in claude_env(port) {
        match get(k) {
            Some(cur) if cur == v => {}
            Some(cur) => plan.conflicts.push((k.to_string(), cur)),
            None => plan.add.push((k.to_string(), v)),
        }
    }
    for k in OVERRIDES {
        if let Some(cur) = get(k) {
            plan.conflicts.push((k.to_string(), cur));
        }
    }
    plan
}

/// The keys `connect` added (as recorded), removed only where they still hold
/// the values it wrote: settings the user had before, or changed since, stay.
pub fn plan_env_removal(settings: &Value, added: &Map<String, Value>) -> Vec<String> {
    let Some(env) = settings.get("env").and_then(Value::as_object) else { return vec![] };
    added.iter().filter(|(k, v)| env.get(k.as_str()) == Some(*v)).map(|(k, _)| k.clone()).collect()
}

/// What `connect` changed, so `disconnect` undoes exactly that and nothing
/// the user had already set.
fn state_path(home: &Path) -> PathBuf {
    home.join("Library/Application Support/AgentStat/connected.json")
}

fn read_state(home: &Path) -> Map<String, Value> {
    std::fs::read_to_string(state_path(home))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn write_state(home: &Path, state: &Map<String, Value>) -> Result<(), String> {
    let path = state_path(home);
    if state.is_empty() {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    let mut text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    text.push('\n');
    write_atomic(&path, &text)
}

/// The env keys `connect` recorded adding to Claude Code's settings.
fn claude_added(state: &Map<String, Value>) -> Map<String, Value> {
    state.get("claude").and_then(|c| c.get("env")).and_then(Value::as_object).cloned().unwrap_or_default()
}

fn read_settings(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(Value::Object(Map::new())),
        Ok(text) => {
            let v: Value = serde_json::from_str(&text)
                .map_err(|e| format!("{} isn't valid JSON ({e}); fix it first, nothing was changed", tilde(path)))?;
            if !v.is_object() || v.get("env").is_some_and(|e| !e.is_object()) {
                return Err(format!("{} has an unexpected shape; nothing was changed", tilde(path)));
            }
            Ok(v)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Object(Map::new())),
        Err(e) => Err(format!("couldn't read {}: {e}", tilde(path))),
    }
}

/// Save settings, keeping a copy of what was there just before.
fn write_settings(path: &Path, v: &Value) -> Result<(), String> {
    if path.exists() {
        let backup = path.with_extension("json.agentstat-backup");
        std::fs::copy(path, &backup).map_err(|e| format!("couldn't back up {}: {e}", tilde(path)))?;
    }
    let mut text = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    text.push('\n');
    write_atomic(path, &text)
}

/// Whether `claude plugin list --json` shows our plugin. None when it can't tell.
pub fn plugin_listed(json: &str) -> Option<bool> {
    fn find(v: &Value) -> bool {
        match v {
            Value::String(s) => s == PLUGIN_ID,
            Value::Array(a) => a.iter().any(find),
            Value::Object(o) => {
                (o.get("name").and_then(Value::as_str) == Some("agentstat")
                    && o.get("marketplace").and_then(Value::as_str).is_none_or(|m| m == "agentstat"))
                    || o.values().any(find)
            }
            _ => false,
        }
    }
    let v: Value = serde_json::from_str(json.trim()).ok()?;
    Some(find(&v))
}

fn plugin_installed(claude: &Path) -> Option<bool> {
    let out = Command::new(claude).args(["plugin", "list", "--json"]).stderr(Stdio::null()).output().ok()?;
    if !out.status.success() {
        return None;
    }
    plugin_listed(&String::from_utf8_lossy(&out.stdout))
}

fn run_claude(claude: &Path, args: &[&str]) -> Result<(), String> {
    let status = Command::new(claude).args(args).status().map_err(|e| format!("couldn't run claude: {e}"))?;
    if status.success() { Ok(()) } else { Err(format!("`claude {}` failed", args.join(" "))) }
}

pub fn connect(target: Option<&str>, port: u16, c: Confirm) -> ExitCode {
    let out = Out::new();
    finish(match target {
        Some("claude") => connect_claude(&out, port, c),
        Some(other) => Err(format!(
            "`{other}` isn't supported yet; today: claude. Anything that speaks OpenTelemetry can \
             already report with `agentstat run -- <command>`."
        )),
        None => Err("connect what? agentstat connect claude".into()),
    })
}

pub fn disconnect(target: Option<&str>, _port: u16, c: Confirm) -> ExitCode {
    let out = Out::new();
    finish(match target {
        Some("claude") => disconnect_claude(&out, c),
        Some(other) => Err(format!("`{other}` isn't supported; today: claude")),
        None => Err("disconnect what? agentstat disconnect claude".into()),
    })
}

fn connect_claude(out: &Out, port: u16, c: Confirm) -> Result<bool, String> {
    let home = home()?;
    let claude = find_claude(&home);
    let settings_path = claude_dir(&home).join("settings.json");
    let settings = read_settings(&settings_path)?;
    let env = plan_env(&settings, port);
    let service = service_step(port)?;
    let plugin = claude.as_deref().map(plugin_installed);

    println!("Connect Claude Code to AgentStat (everything stays on 127.0.0.1):\n");
    let mut n = 0;
    let mut step = |title: &str| {
        n += 1;
        println!("  {n}. {title}");
    };
    match &service {
        Some((path, _)) => {
            step("Start the AgentStat service at login");
            println!("     {}", out.dim(&format!("write {} and load it with launchctl", tilde(path))));
        }
        None => out.ok("The service starts at login"),
    }
    if !env.conflicts.is_empty() {
        out.warn(&format!(
            "Claude Code's telemetry already goes elsewhere ({}), so it's left as is. Token counts \
             need it; for one session use: agentstat run -- claude",
            env.conflicts.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(", ")
        ));
    } else if env.add.is_empty() {
        out.ok("Claude Code's telemetry goes to AgentStat");
    } else {
        step("Send Claude Code's telemetry here: token counts and cost per call");
        println!("     {}", out.dim(&format!("add to \"env\" in {}:", tilde(&settings_path))));
        for (k, v) in &env.add {
            println!("     {}", out.dim(&format!("  {k} = \"{v}\"")));
        }
    }
    match (&claude, plugin) {
        (None, _) => out.warn("Claude Code (`claude`) not found, so the plugin step is skipped. Install Claude Code, then run this again."),
        (Some(_), Some(Some(true))) => out.ok("The AgentStat plugin is installed"),
        (Some(_), _) => {
            step("Install the AgentStat plugin: live turns, tools and subagents");
            println!("     {}", out.dim(&format!("claude plugin install agentstat --marketplace {MARKETPLACE}")));
        }
    }
    let todo_env = env.conflicts.is_empty() && !env.add.is_empty();
    let todo_plugin = claude.is_some() && plugin != Some(Some(true));
    if service.is_none() && !todo_plugin && !todo_env {
        println!("\nAll set. Check any time with: agentstat doctor");
        return Ok(true);
    }
    println!("  {}", out.dim("undo: agentstat disconnect claude · agentstat service uninstall"));
    if !confirm(c) {
        return Ok(c.dry_run);
    }
    println!();
    if let Some((path, plist)) = &service {
        apply_service(path, plist)?;
        out.ok("The service starts at login");
    }
    if todo_env {
        let mut settings = settings;
        let obj = settings.as_object_mut().ok_or("settings aren't an object")?;
        let env_map = obj.entry("env").or_insert_with(|| Value::Object(Map::new()));
        let env_map = env_map.as_object_mut().ok_or("settings env isn't an object")?;
        for (k, v) in &env.add {
            env_map.insert(k.clone(), Value::String(v.clone()));
        }
        // Record first: if saving the settings then fails, the record only
        // names keys that disconnect will find missing and skip.
        let mut state = read_state(&home);
        let mut added = claude_added(&state);
        for (k, v) in &env.add {
            added.insert(k.clone(), Value::String(v.clone()));
        }
        let entry = state.entry("claude").or_insert_with(|| Value::Object(Map::new()));
        if let Some(entry) = entry.as_object_mut() {
            entry.insert("settings".into(), Value::String(settings_path.to_string_lossy().into_owned()));
            entry.insert("env".into(), Value::Object(added));
        }
        write_state(&home, &state)?;
        write_settings(&settings_path, &settings)?;
        out.ok("Claude Code's telemetry goes to AgentStat");
    }
    if todo_plugin {
        let claude = claude.as_deref().unwrap_or(Path::new("claude"));
        // No --yes: anything Claude Code wants confirmed, it asks itself.
        run_claude(claude, &["plugin", "install", "agentstat", "--marketplace", MARKETPLACE]).map_err(|e| {
            format!("{e}. The steps above are done; install the plugin with `claude plugin install agentstat --marketplace {MARKETPLACE}` or run this again")
        })?;
        // Recorded, so disconnect also removes the marketplace this added.
        let mut state = read_state(&home);
        let entry = state.entry("claude").or_insert_with(|| Value::Object(Map::new()));
        if let Some(entry) = entry.as_object_mut() {
            entry.insert("plugin".into(), Value::Bool(true));
        }
        write_state(&home, &state)?;
        out.ok("The AgentStat plugin is installed");
    }
    println!("\nDone. New Claude Code sessions report to AgentStat; check with: agentstat doctor");
    Ok(true)
}

fn disconnect_claude(out: &Out, c: Confirm) -> Result<bool, String> {
    let home = home()?;
    let claude = find_claude(&home);
    let mut state = read_state(&home);
    // The settings file connect edited, even if CLAUDE_CONFIG_DIR changed since.
    let settings_path = state
        .get("claude")
        .and_then(|c| c.get("settings"))
        .and_then(Value::as_str)
        .map_or_else(|| claude_dir(&home).join("settings.json"), PathBuf::from);
    let settings = read_settings(&settings_path)?;
    let remove = plan_env_removal(&settings, &claude_added(&state));
    let plugin = claude.as_deref().and_then(plugin_installed) == Some(true);
    if remove.is_empty() && !plugin {
        out.ok("Claude Code isn't connected; nothing to undo.");
        return Ok(true);
    }
    println!("Disconnect Claude Code from AgentStat:\n");
    if plugin {
        println!("  uninstall  the AgentStat plugin (claude plugin uninstall {PLUGIN_ID})");
    }
    if !remove.is_empty() {
        println!("  remove     {} from \"env\" in {}", remove.join(", "), tilde(&settings_path));
    }
    println!("  {}", out.dim("the service keeps running; to stop it at login: agentstat service uninstall"));
    if !confirm(c) {
        return Ok(c.dry_run);
    }
    println!();
    if plugin && let Some(claude) = &claude {
        run_claude(claude, &["plugin", "uninstall", PLUGIN_ID])?;
        // Only when connect added it: a marketplace the user added stays.
        let ours = state.get("claude").and_then(|c| c.get("plugin")).and_then(Value::as_bool) == Some(true);
        if ours {
            let _ = run_claude(claude, &["plugin", "marketplace", "remove", "agentstat"]);
        }
        out.ok("The AgentStat plugin is uninstalled");
    }
    if !remove.is_empty() {
        // Read again: `claude plugin` rewrote the file just now, and writing
        // the copy from before would undo its changes.
        let mut settings = read_settings(&settings_path)?;
        let remove = plan_env_removal(&settings, &claude_added(&state));
        if let Some(env) = settings.get_mut("env").and_then(Value::as_object_mut) {
            for k in &remove {
                env.remove(k);
            }
            if env.is_empty()
                && let Some(obj) = settings.as_object_mut()
            {
                obj.remove("env");
            }
        }
        write_settings(&settings_path, &settings)?;
        out.ok("Claude Code's telemetry no longer comes here");
    }
    state.remove("claude");
    write_state(&home, &state)?;
    Ok(true)
}

// ---------------------------------------------------------------- doctor

pub fn doctor(port: u16) -> ExitCode {
    let out = Out::new();
    let mut fine = true;
    println!("AgentStat doctor\n");

    let exe = std::env::current_exe().ok();
    let shown = exe.as_deref().map_or("?".into(), |e| tilde(&stable_exe(e)));
    out.ok(&format!("agentstat {}  {}", env!("CARGO_PKG_VERSION"), out.dim(&shown)));
    let canon = |p: &Path| std::fs::canonicalize(p).ok();
    match which("agentstat", &[]) {
        Some(found) if exe.as_deref().and_then(canon) == canon(&found) => {
            out.ok("On PATH (the Claude Code plugin runs `agentstat mcp`)")
        }
        Some(found) => out.warn(&format!("PATH finds a different agentstat first: {}", tilde(&found))),
        None => {
            let link = exe.as_deref().map_or("~/.local/bin/agentstat".into(), |e| {
                format!("ln -s '{}' ~/.local/bin/agentstat", stable_exe(e).display())
            });
            out.warn(&format!(
                "Not on PATH, so the Claude Code plugin can't start `agentstat mcp`. Link it into a folder on PATH: {link}"
            ))
        }
    }

    fine &= service_report(&out, port);

    let Ok(home) = home() else { return ExitCode::FAILURE };
    match find_claude(&home) {
        None => out.note("Claude Code not found (skipping its checks)"),
        Some(claude) => {
            let version = Command::new(&claude)
                .arg("--version")
                .stderr(Stdio::null())
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "found".into());
            out.ok(&format!("Claude Code {version}"));
            match plugin_installed(&claude) {
                Some(true) => out.ok("AgentStat plugin installed"),
                Some(false) => {
                    out.warn("AgentStat plugin not installed: no live turns or tools (agentstat connect claude)")
                }
                None => out.note("Couldn't tell whether the AgentStat plugin is installed"),
            }
            let path = claude_dir(&home).join("settings.json");
            match read_settings(&path) {
                Err(e) => {
                    out.bad(&e);
                    fine = false;
                }
                Ok(s) => {
                    let plan = plan_env(&s, port);
                    if !plan.conflicts.is_empty() {
                        let mut list = String::new();
                        for (k, v) in &plan.conflicts {
                            let _ = write!(list, "{}{k}={v}", if list.is_empty() { "" } else { ", " });
                        }
                        out.warn(&format!("Claude Code's telemetry goes elsewhere ({list})"));
                    } else if plan.add.is_empty() {
                        out.ok(&format!("Claude Code's telemetry comes here (127.0.0.1:{port})"));
                    } else {
                        out.warn("Claude Code's telemetry isn't sent here: no token counts (agentstat connect claude)");
                    }
                    // Organization-managed settings win over the user's.
                    let managed = Path::new("/Library/Application Support/ClaudeCode/managed-settings.json");
                    if let Ok(m) = read_settings(managed)
                        && let Some(env) = m.get("env").and_then(Value::as_object)
                        && env.keys().any(|k| k.starts_with("OTEL_") || k == "CLAUDE_CODE_ENABLE_TELEMETRY")
                    {
                        out.warn(
                            "Managed settings (set by your organization) also configure telemetry and take precedence",
                        );
                    }
                }
            }
        }
    }

    if let Ok(body) = client::get(port, "/v1/agents")
        && let Ok(v) = serde_json::from_str::<Value>(&body)
    {
        let n = v.get("agents").and_then(Value::as_array).map_or(0, Vec::len);
        out.note(&match n {
            0 => "No agents reporting right now".to_string(),
            1 => "1 agent reporting".to_string(),
            n => format!("{n} agents reporting"),
        });
    }
    println!();
    if fine {
        println!("Everything needed is in place.");
        ExitCode::SUCCESS
    } else {
        println!("Fix the ✗ items above, then run agentstat doctor again.");
        ExitCode::FAILURE
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn env_plan_adds_only_whats_missing() {
        let s = json!({ "env": { "CLAUDE_CODE_ENABLE_TELEMETRY": "1", "FOO": "bar" } });
        let plan = plan_env(&s, DEFAULT_PORT);
        assert!(plan.conflicts.is_empty());
        assert_eq!(plan.add.len(), claude_env(DEFAULT_PORT).len() - 1);
        assert!(!plan.add.iter().any(|(k, _)| k == "AGENTSTAT_PORT"));
    }

    #[test]
    fn env_plan_never_overrides_someone_elses_telemetry() {
        let s = json!({ "env": { "OTEL_EXPORTER_OTLP_ENDPOINT": "https://collector.example:4318" } });
        let plan = plan_env(&s, DEFAULT_PORT);
        assert_eq!(
            plan.conflicts,
            vec![("OTEL_EXPORTER_OTLP_ENDPOINT".into(), "https://collector.example:4318".into())]
        );
        let s = json!({ "env": { "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://x" } });
        assert_eq!(plan_env(&s, DEFAULT_PORT).conflicts.len(), 1);
        // Non-string values compare as written: 1 is already on, 0 is a choice we keep.
        assert!(plan_env(&json!({ "env": { "CLAUDE_CODE_ENABLE_TELEMETRY": 1 } }), DEFAULT_PORT).conflicts.is_empty());
        let s = json!({ "env": { "CLAUDE_CODE_ENABLE_TELEMETRY": 0 } });
        assert_eq!(plan_env(&s, DEFAULT_PORT).conflicts, vec![("CLAUDE_CODE_ENABLE_TELEMETRY".into(), "0".into())]);
    }

    #[test]
    fn other_ports_tell_the_hooks() {
        let plan = plan_env(&json!({}), 4400);
        assert!(plan.add.contains(&("AGENTSTAT_PORT".into(), "4400".into())));
        assert!(plan.add.contains(&("OTEL_EXPORTER_OTLP_ENDPOINT".into(), "http://127.0.0.1:4400".into())));
    }

    #[test]
    fn removal_takes_only_what_connect_added() {
        // The user already had telemetry on; connect added the exporter and an
        // endpoint on another port; the user changed the interval since.
        let s = json!({ "env": {
            "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
            "OTEL_LOGS_EXPORTER": "otlp",
            "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:4400",
            "OTEL_LOGS_EXPORT_INTERVAL": "5000",
        }});
        let added = json!({
            "OTEL_LOGS_EXPORTER": "otlp",
            "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:4400",
            "OTEL_LOGS_EXPORT_INTERVAL": "1000",
        });
        let removed = plan_env_removal(&s, added.as_object().unwrap());
        assert_eq!(removed, vec!["OTEL_LOGS_EXPORTER", "OTEL_EXPORTER_OTLP_ENDPOINT"]);
        // Nothing recorded: nothing removed.
        assert!(plan_env_removal(&s, &Map::new()).is_empty());
    }

    #[test]
    fn login_items_never_point_at_temporary_copies() {
        assert!(temporary_location(Path::new("/Volumes/AgentStat/AgentStat.app/Contents/MacOS/agentstat")).is_some());
        let translocated = "/private/var/folders/x/AppTranslocation/ABC/d/AgentStat.app/Contents/MacOS/agentstat";
        assert!(temporary_location(Path::new(translocated)).is_some());
        assert!(temporary_location(Path::new("/Applications/AgentStat.app/Contents/MacOS/agentstat")).is_none());
        assert!(temporary_location(Path::new("/Users/me/.local/bin/agentstat")).is_none());
    }

    #[test]
    fn settings_keep_their_key_order() {
        let text = r#"{"theme":"dark","env":{"B":"2","A":"1"},"model":"x"}"#;
        let mut v: Value = serde_json::from_str(text).unwrap();
        v["env"].as_object_mut().unwrap().insert("C".into(), json!("3"));
        assert_eq!(
            serde_json::to_string(&v).unwrap(),
            r#"{"theme":"dark","env":{"B":"2","A":"1","C":"3"},"model":"x"}"#
        );
    }

    #[test]
    fn plugin_detection() {
        assert_eq!(plugin_listed(r#"[{"id":"agentstat@agentstat","enabled":true}]"#), Some(true));
        assert_eq!(plugin_listed(r#"{"plugins":[{"name":"agentstat","marketplace":"agentstat"}]}"#), Some(true));
        assert_eq!(plugin_listed(r#"[{"name":"agentstat","marketplace":"someone-else"}]"#), Some(false));
        assert_eq!(plugin_listed("[]"), Some(false));
        assert_eq!(plugin_listed("No plugins installed."), None);
    }

    #[test]
    fn plist_round_trips_program_and_port() {
        let p = plist(Path::new("/Applications/A & B.app/Contents/MacOS/agentstat"), 4400, Path::new("/tmp/l.log"));
        assert!(p.contains("A &amp; B.app"));
        assert!(p.contains(&format!("<string>{LABEL}</string>")));
        assert_eq!(
            plist_program(&p),
            Some(("/Applications/A & B.app/Contents/MacOS/agentstat".to_string(), Some(4400)))
        );
    }

    #[test]
    fn homebrew_paths_use_the_stable_link() {
        let dir = std::env::temp_dir().join(format!("agentstat-brew-{}", std::process::id()));
        let cellar = dir.join("Cellar/agentstat/0.1.0/bin/agentstat");
        std::fs::create_dir_all(cellar.parent().unwrap()).unwrap();
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        std::fs::write(&cellar, "").unwrap();
        // No link yet: keep the real path.
        assert_eq!(stable_exe(&cellar), cellar);
        std::fs::write(dir.join("bin/agentstat"), "").unwrap();
        assert_eq!(stable_exe(&cellar), dir.join("bin/agentstat"));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(stable_exe(Path::new("/usr/local/bin/agentstat")), PathBuf::from("/usr/local/bin/agentstat"));
    }
}

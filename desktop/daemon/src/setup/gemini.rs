//! `agentstat connect gemini` / `disconnect gemini`: Gemini CLI's telemetry
//! (tokens per model call) and hooks (turns, tools, permission prompts),
//! pointed at the local service.
//!
//! Both live in `~/.gemini/settings.json`: `telemetry` and `hooks`. Ours go
//! after any hooks already there. Each hook prints nothing and exits 0, which
//! Gemini treats as no opinion (any text would be read as a decision).

use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use super::{
    Confirm, Out, apply_service, confirm, home, read_state, service_step, tilde, which, write_atomic, write_state,
};

/// The events AgentStat listens to.
pub const EVENTS: [&str; 7] =
    ["SessionStart", "BeforeAgent", "BeforeTool", "AfterTool", "Notification", "AfterAgent", "SessionEnd"];

/// How AgentStat's hooks are recognized (any port): their command posts here.
const MARKER: &str = "/v1/hooks/gemini";

pub fn gemini_dir(home: &Path) -> PathBuf {
    home.join(".gemini")
}

fn installed(home: &Path) -> bool {
    gemini_dir(home).is_dir()
        || which("gemini", &[home.join(".local/bin"), PathBuf::from("/opt/homebrew/bin")]).is_some()
}

pub fn hook_command(port: u16) -> String {
    format!(
        "curl -s -m 1 -o /dev/null -H \"Content-Type: application/json\" -H \"X-AgentStat-App: ${{__CFBundleIdentifier:-}}\" --data-binary @- \"http://127.0.0.1:{port}{MARKER}\" >/dev/null 2>&1 || true"
    )
}

/// What `telemetry` needs to send its logs here. Prompt and response text
/// stay out of them: AgentStat never reads them.
pub fn telemetry(port: u16) -> Map<String, Value> {
    let mut t = Map::new();
    t.insert("enabled".into(), json!(true));
    t.insert("target".into(), json!("local"));
    t.insert("otlpEndpoint".into(), json!(format!("http://127.0.0.1:{port}")));
    t.insert("otlpProtocol".into(), json!("http"));
    t.insert("logPrompts".into(), json!(false));
    t
}

/// Where `telemetry` stands.
#[derive(Debug, PartialEq)]
pub enum Telemetry {
    /// Off or unset: set ours.
    Add,
    Present,
    /// Sent elsewhere (shown): left alone.
    Elsewhere(String),
}

pub fn plan_telemetry(settings: &Value, port: u16) -> Telemetry {
    let Some(t) = settings.get("telemetry").and_then(Value::as_object) else { return Telemetry::Add };
    let ours = telemetry(port);
    if ["enabled", "otlpEndpoint", "otlpProtocol"].iter().all(|k| t.get(*k) == ours.get(*k)) {
        return Telemetry::Present;
    }
    let going = t.get("enabled") == Some(&json!(true))
        || t.contains_key("otlpEndpoint")
        || t.contains_key("outfile")
        || t.get("target") == Some(&json!("gcp"));
    if going {
        let to = t
            .get("outfile")
            .or(t.get("otlpEndpoint"))
            .or(t.get("target"))
            .map_or_else(|| "on".to_string(), |v| v.as_str().map_or_else(|| v.to_string(), str::to_string));
        Telemetry::Elsewhere(to)
    } else {
        Telemetry::Add
    }
}

/// Set ours; returns the keys it set (with what they held before, if
/// anything), so disconnect can put them back.
pub fn add_telemetry(settings: &mut Value, port: u16) -> Result<Map<String, Value>, String> {
    let root = settings.as_object_mut().ok_or("settings.json isn't an object")?;
    let t = root.entry("telemetry").or_insert_with(|| Value::Object(Map::new()));
    let t = t.as_object_mut().ok_or("`telemetry` in settings.json isn't an object")?;
    let mut before = Map::new();
    for (k, v) in telemetry(port) {
        before.insert(k.clone(), t.get(&k).cloned().unwrap_or(Value::Null));
        t.insert(k, v);
    }
    Ok(before)
}

/// Put back what `add_telemetry` replaced, where the values are still ours.
pub fn remove_telemetry(settings: &mut Value, port: u16, before: &Map<String, Value>) -> bool {
    let ours = telemetry(port);
    let Some(t) = settings.get_mut("telemetry").and_then(Value::as_object_mut) else { return false };
    if t.get("otlpEndpoint") != ours.get("otlpEndpoint") {
        return false;
    }
    for (k, v) in &ours {
        if t.get(k) != Some(v) {
            continue;
        }
        match before.get(k) {
            Some(old) if !old.is_null() => {
                t.insert(k.clone(), old.clone());
            }
            _ => {
                t.remove(k);
            }
        }
    }
    if t.is_empty()
        && let Some(root) = settings.as_object_mut()
    {
        root.remove("telemetry");
    }
    true
}

fn ours(h: &Value) -> bool {
    h["command"].as_str().is_some_and(|c| c.contains(MARKER))
}

pub fn missing(settings: &Value, port: u16) -> Vec<&'static str> {
    let cmd = hook_command(port);
    EVENTS
        .into_iter()
        .filter(|e| {
            !settings["hooks"][*e]
                .as_array()
                .into_iter()
                .flatten()
                .any(|g| g["hooks"].as_array().into_iter().flatten().any(|h| h["command"].as_str() == Some(&cmd)))
        })
        .collect()
}

fn group(port: u16) -> Value {
    json!({"matcher": "*", "hooks": [{"type": "command", "name": "agentstat", "command": hook_command(port), "timeout": 2000}]})
}

/// Ours at the end of each event's list; one of ours already there (another
/// port) is updated where it is.
pub fn add_hooks(settings: &mut Value, port: u16) -> Result<(), String> {
    let root = settings.as_object_mut().ok_or("settings.json isn't an object")?;
    let map = root.entry("hooks").or_insert_with(|| Value::Object(Map::new()));
    let map = map.as_object_mut().ok_or("`hooks` in settings.json isn't an object")?;
    for e in EVENTS {
        let list = map.entry(e).or_insert_with(|| Value::Array(vec![]));
        let list = list.as_array_mut().ok_or_else(|| format!("`hooks.{e}` in settings.json isn't a list"))?;
        let mut found = false;
        list.retain_mut(|g| {
            let has = g["hooks"].as_array().is_some_and(|hs| hs.iter().any(ours));
            if !has {
                return true;
            }
            if found {
                return false;
            }
            *g = group(port);
            found = true;
            true
        });
        if !found {
            list.push(group(port));
        }
    }
    Ok(())
}

/// Remove ours (any port), and lists this emptied. How many went.
pub fn remove_hooks(settings: &mut Value) -> usize {
    let Some(map) = settings.get_mut("hooks").and_then(Value::as_object_mut) else { return 0 };
    let mut n = 0;
    let mut emptied = Vec::new();
    for (event, list) in map.iter_mut() {
        let Some(groups) = list.as_array_mut() else { continue };
        let before = groups.len();
        groups.retain(|g| {
            let mine = g["hooks"].as_array().is_some_and(|hs| !hs.is_empty() && hs.iter().all(ours));
            if mine {
                n += 1;
            }
            !mine
        });
        if groups.is_empty() && before > 0 {
            emptied.push(event.clone());
        }
    }
    for e in emptied {
        map.remove(&e);
    }
    if map.is_empty()
        && let Some(root) = settings.as_object_mut()
    {
        root.remove("hooks");
    }
    n
}

fn read(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(t) if t.trim().is_empty() => Ok(json!({})),
        Ok(t) => serde_json::from_str(&t).map_err(|e| {
            format!("couldn't read {} ({e}); if it has comments, add the settings by hand (agentstat connect gemini --dry-run shows them)", tilde(path))
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(format!("couldn't read {}: {e}", tilde(path))),
    }
}

fn text(v: &Value) -> Result<String, String> {
    let mut t = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    t.push('\n');
    Ok(t)
}

pub fn connect(out: &Out, port: u16, c: Confirm) -> Result<bool, String> {
    let home = home()?;
    if !installed(&home) {
        return Err(
            "Gemini CLI isn't installed here (no `gemini` command, no ~/.gemini). Install it, then run this again."
                .into(),
        );
    }
    let path = gemini_dir(&home).join("settings.json");
    let mut settings = read(&path)?;
    let tel = plan_telemetry(&settings, port);
    let todo = missing(&settings, port);
    let service = service_step(port)?;

    println!("Connect Gemini CLI to AgentStat (everything stays on 127.0.0.1):\n");
    let mut n = 0;
    let mut step = |title: &str| {
        n += 1;
        println!("  {n}. {title}");
    };
    match &service {
        Some((p, _)) => {
            step("Start the AgentStat service at login");
            println!("     {}", out.dim(&format!("write {} and load it with launchctl", tilde(p))));
        }
        None => out.ok("The service starts at login"),
    }
    match &tel {
        Telemetry::Present => out.ok("Gemini CLI's telemetry goes to AgentStat"),
        Telemetry::Elsewhere(to) => out.warn(&format!(
            "Gemini CLI's telemetry already goes elsewhere ({to}), so it's left as is. Without it, AgentStat shows turns and tools but not tokens."
        )),
        Telemetry::Add => {
            step("Send Gemini CLI's telemetry here: tokens per model call (prompt text left out)");
            println!("     {}", out.dim(&format!("set \"telemetry\" in {}:", tilde(&path))));
            println!("     {}", out.dim(&format!("  {}", Value::Object(telemetry(port)))));
        }
    }
    if todo.is_empty() {
        out.ok("AgentStat's Gemini CLI hooks are in place");
    } else {
        step("Add hooks: live turns, tools and permission prompts");
        println!("     {}", out.dim(&format!("add to \"hooks\" in {}, after any already there:", tilde(&path))));
        println!("     {}", out.dim(&format!("  {} → {}", EVENTS.join(", "), hook_command(port))));
    }
    if service.is_none() && tel != Telemetry::Add && todo.is_empty() {
        println!("\nAll set. Check any time with: agentstat doctor");
        return Ok(true);
    }
    println!("  {}", out.dim("undo: agentstat disconnect gemini · agentstat service uninstall"));
    if !confirm(c) {
        return Ok(c.dry_run);
    }
    println!();
    if let Some((p, plist)) = &service {
        apply_service(p, plist)?;
        out.ok("The service starts at login");
    }
    let before = if tel == Telemetry::Add { Some(add_telemetry(&mut settings, port)?) } else { None };
    if !todo.is_empty() {
        add_hooks(&mut settings, port)?;
    }
    let mut state = read_state(&home);
    let mut entry = Map::new();
    entry.insert("settings".into(), json!(path.to_string_lossy()));
    entry.insert("port".into(), json!(port));
    let earlier = state.get("gemini").and_then(|g| g.get("telemetry")).cloned();
    if let Some(b) = before.map(Value::Object).or(earlier) {
        entry.insert("telemetry".into(), b);
    }
    state.insert("gemini".into(), Value::Object(entry));
    write_state(&home, &state)?;
    write_atomic(&path, &text(&settings)?)?;
    if tel == Telemetry::Add {
        out.ok("Gemini CLI's telemetry goes to AgentStat");
    }
    if !todo.is_empty() {
        out.ok("AgentStat's hooks are added");
    }
    println!("\nDone. New Gemini CLI sessions report to AgentStat; check with: agentstat doctor");
    Ok(true)
}

pub fn disconnect(out: &Out, c: Confirm) -> Result<bool, String> {
    let home = home()?;
    let mut state = read_state(&home);
    let rec = state.get("gemini").cloned().unwrap_or(Value::Null);
    let path = rec
        .get("settings")
        .and_then(Value::as_str)
        .map_or_else(|| gemini_dir(&home).join("settings.json"), PathBuf::from);
    let port =
        rec.get("port").and_then(Value::as_u64).and_then(|p| u16::try_from(p).ok()).unwrap_or(crate::DEFAULT_PORT);
    // No record (lost, or from before): ours, if it's still exactly ours, goes
    // with nothing to put back.
    let before = rec.get("telemetry").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut settings = read(&path)?;
    let mut plan = settings.clone();
    let tel = remove_telemetry(&mut plan, port, &before);
    let hooks = remove_hooks(&mut plan);
    if !tel && hooks == 0 {
        state.remove("gemini");
        write_state(&home, &state)?;
        out.ok("Gemini CLI isn't connected; nothing to undo.");
        return Ok(true);
    }
    println!("Disconnect Gemini CLI from AgentStat:\n");
    if tel {
        println!("  restore  \"telemetry\" in {} to what it was", tilde(&path));
    }
    if hooks > 0 {
        println!("  remove   {hooks} AgentStat hooks from {}", tilde(&path));
    }
    println!("  {}", out.dim("the service keeps running; to stop it at login: agentstat service uninstall"));
    if !confirm(c) {
        return Ok(c.dry_run);
    }
    println!();
    remove_telemetry(&mut settings, port, &before);
    remove_hooks(&mut settings);
    write_atomic(&path, &text(&settings)?)?;
    state.remove("gemini");
    write_state(&home, &state)?;
    out.ok("Gemini CLI no longer reports to AgentStat");
    Ok(true)
}

/// `agentstat doctor`'s Gemini CLI checks.
pub fn doctor(out: &Out, home: &Path, port: u16) {
    if !installed(home) {
        out.note("Gemini CLI not found (skipping its checks)");
        return;
    }
    let settings = match read(&gemini_dir(home).join("settings.json")) {
        Ok(s) => s,
        Err(e) => return out.warn(&e),
    };
    match plan_telemetry(&settings, port) {
        Telemetry::Present => out.ok(&format!("Gemini CLI's telemetry comes here (127.0.0.1:{port})")),
        Telemetry::Elsewhere(to) => out.warn(&format!("Gemini CLI's telemetry goes elsewhere ({to}): no tokens")),
        Telemetry::Add => out.warn("Gemini CLI's telemetry isn't sent here: no tokens (agentstat connect gemini)"),
    }
    let gone = missing(&settings, port);
    if gone.is_empty() {
        out.ok("AgentStat's Gemini CLI hooks are in place");
    } else if gone.len() == EVENTS.len() {
        out.warn("AgentStat's Gemini CLI hooks aren't set up: no live turns or tools (agentstat connect gemini)");
    } else {
        out.warn(&format!(
            "Some AgentStat Gemini CLI hooks are missing ({}): agentstat connect gemini",
            gone.join(", ")
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn telemetry_is_set_and_put_back() {
        let mine = json!({"theme": "Dracula", "telemetry": {"logPrompts": true}});
        let mut s = mine.clone();
        assert_eq!(plan_telemetry(&s, 4318), Telemetry::Add);
        let before = add_telemetry(&mut s, 4318).unwrap();
        assert_eq!(plan_telemetry(&s, 4318), Telemetry::Present);
        assert_eq!(s["telemetry"]["logPrompts"], false);
        assert!(remove_telemetry(&mut s, 4318, &before));
        assert_eq!(s, mine);
        // Unset before: nothing left behind.
        let mut s = json!({});
        let before = add_telemetry(&mut s, 4318).unwrap();
        remove_telemetry(&mut s, 4318, &before);
        assert_eq!(s, json!({}));
        // No record of what was there: ours still goes, the person's stays.
        let mut s = json!({"telemetry": {"outfile": "/tmp/t.log"}});
        add_telemetry(&mut s, 4318).unwrap();
        assert!(remove_telemetry(&mut s, 4318, &Map::new()));
        assert_eq!(s, json!({"telemetry": {"outfile": "/tmp/t.log"}}));
        // Someone else's endpoint: not ours to touch.
        let mut s = json!({"telemetry": {"enabled": true, "otlpEndpoint": "http://127.0.0.1:4317"}});
        assert!(!remove_telemetry(&mut s, 4318, &Map::new()));
    }

    #[test]
    fn telemetry_sent_elsewhere_is_left_alone() {
        let s = json!({"telemetry": {"enabled": true, "target": "gcp"}});
        assert!(matches!(plan_telemetry(&s, 4318), Telemetry::Elsewhere(t) if t == "gcp"));
        let s = json!({"telemetry": {"enabled": true, "otlpEndpoint": "http://localhost:4317"}});
        assert!(matches!(plan_telemetry(&s, 4318), Telemetry::Elsewhere(t) if t.contains("4317")));
        // Off: ours can go in.
        assert_eq!(plan_telemetry(&json!({"telemetry": {"enabled": false}}), 4318), Telemetry::Add);
    }

    #[test]
    fn hooks_go_after_the_person_s_and_come_out_alone() {
        let mine = json!({"hooks": {"BeforeTool": [{"matcher": "run_shell_command", "hooks": [{"type": "command", "command": "./guard.sh"}]}]}});
        let mut s = mine.clone();
        add_hooks(&mut s, 4318).unwrap();
        assert!(missing(&s, 4318).is_empty());
        assert_eq!(s["hooks"]["BeforeTool"][0]["hooks"][0]["command"], "./guard.sh");
        assert_eq!(s["hooks"]["BeforeTool"][1]["hooks"][0]["timeout"], 2000);
        add_hooks(&mut s, 4422).unwrap();
        assert_eq!(s["hooks"]["BeforeTool"].as_array().unwrap().len(), 2);
        assert_eq!(remove_hooks(&mut s), EVENTS.len());
        assert_eq!(s, mine);
    }

    #[test]
    fn the_hook_prints_nothing_and_always_exits_0() {
        let cmd = hook_command(4318);
        assert!(cmd.ends_with(">/dev/null 2>&1 || true") && cmd.contains("127.0.0.1:4318/v1/hooks/gemini"));
    }
}

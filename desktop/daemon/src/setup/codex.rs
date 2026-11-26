//! `agentstat connect codex` / `disconnect codex`: Codex's OpenTelemetry
//! export (tokens and cost) and its hooks (turns, tools, subagents, permission
//! prompts), pointed at the local service.
//!
//! Codex reads both from its config folder (`$CODEX_HOME`, else `~/.codex`):
//! telemetry from `[otel]` in `config.toml`, hooks from `[hooks]` there or from
//! `hooks.json` beside it. It warns when both hold hooks, so ours go wherever
//! the person keeps theirs. Codex identifies each hook by its file, event and
//! position, so ours go at the end of each list: hooks already there keep
//! their place, and the trust given to them.
//!
//! New hooks run only once trusted, in Codex: `/hooks`, then `t` (trust all).

use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};
use toml_edit::{ArrayOfTables, DocumentMut, InlineTable, Item, Table};

use super::{
    Confirm, Out, apply_service, confirm, home, read_state, service_step, tilde, which, write_atomic, write_state,
};

/// The events AgentStat listens to, in the order Codex sends them.
pub const EVENTS: [&str; 9] = [
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "Interrupt",
    // Quitting mid-turn (Ctrl-D, closing the terminal) sends no Stop.
    "SessionEnd",
];

/// How AgentStat's hooks are recognized (any port): their command posts here.
const MARKER: &str = "/v1/hooks/codex";
/// The hook's name in Codex's `/hooks` list.
const TITLE: &str = "AgentStat";

/// Codex's config folder.
pub fn codex_dir(home: &Path) -> PathBuf {
    std::env::var_os("CODEX_HOME").filter(|d| !d.is_empty()).map(PathBuf::from).unwrap_or(home.join(".codex"))
}

fn find_codex(home: &Path) -> Option<PathBuf> {
    which("codex", &[home.join(".local/bin"), PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")])
}

/// The command each hook runs: post its input to the service, quickly, and
/// never fail Codex's turn (nothing happens when the service isn't running).
pub fn hook_command(port: u16) -> String {
    format!(
        "curl -s -m 1 -o /dev/null -H \"Content-Type: application/json\" -H \"X-AgentStat-App: ${{__CFBundleIdentifier:-}}\" --data-binary @- \"http://127.0.0.1:{port}{MARKER}\" || true"
    )
}

pub fn logs_endpoint(port: u16) -> String {
    format!("http://127.0.0.1:{port}/v1/logs")
}

fn ours(command: &str) -> bool {
    command.contains(MARKER)
}

// ---------------------------------------------------------------- telemetry

/// Where `[otel] exporter` stands.
#[derive(Debug, PartialEq)]
pub enum Otel {
    /// Not set: add ours.
    Add,
    /// Already ours.
    Present,
    /// Set to something else (shown as is): left alone.
    Elsewhere(String),
}

fn parse(text: &str, path: &Path) -> Result<DocumentMut, String> {
    text.parse::<DocumentMut>().map_err(|e| format!("couldn't read {}: {e}", tilde(path)))
}

/// The `otlp-http` exporter table, if `exporter` is one.
fn otlp_http(exporter: &Item) -> Option<&dyn toml_edit::TableLike> {
    exporter.as_table_like()?.get("otlp-http")?.as_table_like()
}

pub fn plan_otel(doc: &DocumentMut, port: u16) -> Otel {
    let Some(exporter) = doc.get("otel").and_then(|o| o.get("exporter")) else { return Otel::Add };
    let endpoint = otlp_http(exporter).and_then(|t| t.get("endpoint")).and_then(Item::as_str);
    let protocol = otlp_http(exporter).and_then(|t| t.get("protocol")).and_then(Item::as_str);
    if endpoint == Some(logs_endpoint(port).as_str()) && protocol == Some("json") {
        return Otel::Present;
    }
    // `exporter = "none"` is the person's own choice too.
    Otel::Elsewhere(exporter.to_string().trim().to_string())
}

/// `[otel] exporter = { otlp-http = { endpoint = "…/v1/logs", protocol = "json" } }`.
pub fn add_otel(doc: &mut DocumentMut, port: u16) -> Result<(), String> {
    let otel = doc.entry("otel").or_insert_with(|| Item::Table(Table::new()));
    let otel = otel.as_table_like_mut().ok_or("`otel` in config.toml isn't a table")?;
    let mut http = InlineTable::new();
    http.insert("endpoint", logs_endpoint(port).into());
    http.insert("protocol", "json".into());
    let mut exporter = InlineTable::new();
    exporter.insert("otlp-http", toml_edit::Value::InlineTable(http));
    otel.insert("exporter", Item::Value(toml_edit::Value::InlineTable(exporter)));
    Ok(())
}

/// Remove the exporter `connect` wrote (to exactly `endpoint`), and `[otel]`
/// if that left it empty. False when the exporter is anything else: a
/// collector of the person's own on this machine stays.
pub fn remove_otel(doc: &mut DocumentMut, endpoint: &str) -> bool {
    let is_ours = doc
        .get("otel")
        .and_then(|o| o.get("exporter"))
        .and_then(otlp_http)
        .and_then(|t| t.get("endpoint"))
        .and_then(Item::as_str)
        == Some(endpoint);
    if !is_ours {
        return false;
    }
    if let Some(otel) = doc.get_mut("otel").and_then(Item::as_table_like_mut) {
        otel.remove("exporter");
        if otel.is_empty() {
            doc.remove("otel");
        }
    }
    true
}

// ---------------------------------------------------------------- hooks: hooks.json

/// Events (of `EVENTS`) whose hook list lacks ours with this exact command.
pub fn missing_json(hooks: &Value, port: u16) -> Vec<&'static str> {
    let cmd = hook_command(port);
    EVENTS
        .into_iter()
        .filter(|e| {
            !hooks["hooks"][*e]
                .as_array()
                .into_iter()
                .flatten()
                .any(|g| g["hooks"].as_array().into_iter().flatten().any(|h| h["command"].as_str() == Some(&cmd)))
        })
        .collect()
}

/// Whether a `hooks.json` holds any hook (ours or not).
pub fn json_has_hooks(hooks: &Value) -> bool {
    hooks["hooks"].as_object().is_some_and(|m| m.values().any(|g| g.as_array().is_some_and(|a| !a.is_empty())))
}

fn json_handler(port: u16) -> Value {
    json!({"type": "command", "command": hook_command(port), "timeout": 2, "statusMessage": TITLE})
}

/// Ours, at the end of each event's list. One of ours already there (another
/// port, an older command) is updated where it is, so no hook moves.
pub fn add_json(hooks: &mut Value, port: u16) -> Result<(), String> {
    let root = hooks.as_object_mut().ok_or("hooks.json isn't an object")?;
    let map = root.entry("hooks").or_insert_with(|| Value::Object(Map::new()));
    let map = map.as_object_mut().ok_or("`hooks` in hooks.json isn't an object")?;
    for e in EVENTS {
        let list = map.entry(e).or_insert_with(|| Value::Array(vec![]));
        let list = list.as_array_mut().ok_or_else(|| format!("`hooks.{e}` in hooks.json isn't a list"))?;
        let mut found = false;
        for g in list.iter_mut() {
            let Some(hs) = g.get_mut("hooks").and_then(Value::as_array_mut) else { continue };
            for h in hs.iter_mut().filter(|h| h["command"].as_str().is_some_and(ours)) {
                if !found {
                    *h = json_handler(port);
                    found = true;
                } else {
                    // A second one of ours would post every event twice.
                    *h = Value::Null;
                }
            }
            hs.retain(|h| !h.is_null());
        }
        list.retain(|g| g["hooks"].as_array().is_none_or(|h| !h.is_empty()));
        if !found {
            list.push(json!({"hooks": [json_handler(port)]}));
        }
    }
    Ok(())
}

/// Hooks of the person's after ours in a list: removing ours moves them, and
/// Codex then asks to trust them again.
pub fn later_json(hooks: &Value) -> usize {
    let Some(map) = hooks["hooks"].as_object() else { return 0 };
    map.values()
        .filter_map(Value::as_array)
        .map(|groups| {
            let has_ours = |g: &Value| {
                g["hooks"].as_array().into_iter().flatten().any(|h| h["command"].as_str().is_some_and(ours))
            };
            match groups.iter().position(has_ours) {
                Some(i) => groups[i + 1..]
                    .iter()
                    .flat_map(|g| g["hooks"].as_array().into_iter().flatten())
                    .filter(|h| !h["command"].as_str().is_some_and(ours))
                    .count(),
                None => 0,
            }
        })
        .sum()
}

/// Remove ours (any port), and lists and groups left empty. How many went.
pub fn remove_json(hooks: &mut Value) -> usize {
    let Some(map) = hooks.get_mut("hooks").and_then(Value::as_object_mut) else { return 0 };
    let mut n = 0;
    for list in map.values_mut() {
        let Some(groups) = list.as_array_mut() else { continue };
        // Only groups this emptied go; anything else of the person's stays as it was.
        groups.retain_mut(|g| {
            let Some(hs) = g.get_mut("hooks").and_then(Value::as_array_mut) else { return true };
            let before = hs.len();
            hs.retain(|h| !h["command"].as_str().is_some_and(ours));
            n += before - hs.len();
            !(hs.is_empty() && before > 0)
        });
    }
    map.retain(|_, list| list.as_array().is_none_or(|a| !a.is_empty()));
    n
}

// ---------------------------------------------------------------- hooks: config.toml

fn groups<'a>(doc: &'a DocumentMut, event: &str) -> impl Iterator<Item = &'a Table> {
    doc.get("hooks").and_then(|h| h.get(event)).and_then(Item::as_array_of_tables).into_iter().flat_map(|a| a.iter())
}

fn handlers(group: &Table) -> impl Iterator<Item = &Table> {
    group.get("hooks").and_then(Item::as_array_of_tables).into_iter().flat_map(|a| a.iter())
}

/// Whether `config.toml` holds any hook (`[hooks.<Event>]`, not just trust state).
pub fn toml_has_hooks(doc: &DocumentMut) -> bool {
    doc.get("hooks")
        .and_then(Item::as_table_like)
        .is_some_and(|t| t.iter().any(|(k, v)| k != "state" && v.as_array_of_tables().is_some_and(|a| !a.is_empty())))
}

pub fn missing_toml(doc: &DocumentMut, port: u16) -> Vec<&'static str> {
    let cmd = hook_command(port);
    EVENTS
        .into_iter()
        .filter(|e| !groups(doc, e).any(|g| handlers(g).any(|h| h.get("command").and_then(Item::as_str) == Some(&cmd))))
        .collect()
}

fn toml_handler(port: u16) -> Table {
    let mut handler = Table::new();
    handler.insert("type", "command".into());
    handler.insert("command", hook_command(port).into());
    handler.insert("timeout", 2.into());
    handler.insert("statusMessage", TITLE.into());
    handler
}

/// [`add_json`] for `config.toml`.
pub fn add_toml(doc: &mut DocumentMut, port: u16) -> Result<(), String> {
    let hooks = doc.entry("hooks").or_insert_with(|| {
        let mut t = Table::new();
        t.set_implicit(true);
        Item::Table(t)
    });
    let hooks = hooks.as_table_mut().ok_or("`hooks` in config.toml isn't a table")?;
    for e in EVENTS {
        let list = hooks.entry(e).or_insert_with(|| Item::ArrayOfTables(ArrayOfTables::new()));
        let list = list.as_array_of_tables_mut().ok_or_else(|| format!("`hooks.{e}` in config.toml isn't a list"))?;
        let mut found = false;
        let mut emptied = Vec::new();
        for (i, g) in list.iter_mut().enumerate() {
            let Some(hs) = g.get_mut("hooks").and_then(Item::as_array_of_tables_mut) else { continue };
            let before = hs.len();
            let mut j = 0;
            while j < hs.len() {
                let is_ours = hs.get(j).and_then(|h| h.get("command")).and_then(Item::as_str).is_some_and(ours);
                if is_ours && !found {
                    if let Some(h) = hs.get_mut(j) {
                        *h = toml_handler(port);
                    }
                    found = true;
                } else if is_ours {
                    hs.remove(j);
                    continue;
                }
                j += 1;
            }
            if hs.is_empty() && before > 0 {
                emptied.push(i);
            }
        }
        for i in emptied.into_iter().rev() {
            list.remove(i);
        }
        if !found {
            let mut inner = ArrayOfTables::new();
            inner.push(toml_handler(port));
            let mut group = Table::new();
            group.insert("hooks", Item::ArrayOfTables(inner));
            list.push(group);
        }
    }
    Ok(())
}

/// [`later_json`] for `config.toml`.
pub fn later_toml(doc: &DocumentMut) -> usize {
    let Some(hooks) = doc.get("hooks").and_then(Item::as_table_like) else { return 0 };
    hooks
        .iter()
        .filter(|(k, _)| *k != "state")
        .filter_map(|(_, v)| v.as_array_of_tables())
        .map(|list| {
            let gs: Vec<&Table> = list.iter().collect();
            let has_ours = |g: &&Table| handlers(g).any(|h| h.get("command").and_then(Item::as_str).is_some_and(ours));
            match gs.iter().position(has_ours) {
                Some(i) => gs[i + 1..]
                    .iter()
                    .flat_map(|g| handlers(g))
                    .filter(|h| !h.get("command").and_then(Item::as_str).is_some_and(ours))
                    .count(),
                None => 0,
            }
        })
        .sum()
}

pub fn remove_toml(doc: &mut DocumentMut) -> usize {
    let Some(hooks) = doc.get_mut("hooks").and_then(Item::as_table_mut) else { return 0 };
    let mut n = 0;
    let events: Vec<String> = hooks.iter().map(|(k, _)| k.to_string()).filter(|k| k != "state").collect();
    for e in events {
        let Some(list) = hooks.get_mut(&e).and_then(Item::as_array_of_tables_mut) else { continue };
        let mut emptied = Vec::new();
        for (i, g) in list.iter_mut().enumerate() {
            if let Some(hs) = g.get_mut("hooks").and_then(Item::as_array_of_tables_mut) {
                let before = hs.len();
                hs.retain(|h| !h.get("command").and_then(Item::as_str).is_some_and(ours));
                n += before - hs.len();
                if hs.is_empty() && before > 0 {
                    emptied.push(i);
                }
            }
        }
        // Only groups this emptied go, last first so the positions hold.
        for i in emptied.into_iter().rev() {
            list.remove(i);
        }
        if list.is_empty() {
            hooks.remove(&e);
        }
    }
    if hooks.is_empty() {
        doc.remove("hooks");
    }
    n
}

// ---------------------------------------------------------------- the commands

/// Where our hooks go: `hooks.json` unless the person's hooks are in `config.toml`.
fn hooks_in_toml(doc: &DocumentMut, json: &Value) -> bool {
    toml_has_hooks(doc) && !json_has_hooks(json)
}

fn read_json(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(t) if t.trim().is_empty() => Ok(json!({})),
        Ok(t) => serde_json::from_str(&t).map_err(|e| format!("couldn't read {}: {e}", tilde(path))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(format!("couldn't read {}: {e}", tilde(path))),
    }
}

fn read_text(path: &Path) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(t) => Ok(t),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("couldn't read {}: {e}", tilde(path))),
    }
}

fn json_text(v: &Value) -> Result<String, String> {
    let mut t = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    t.push('\n');
    Ok(t)
}

/// The folder `connect` edited, and the exporter it wrote (if it wrote one),
/// so `disconnect` undoes exactly that.
fn record(home: &Path, dir: &Path, endpoint: Option<&str>) -> Result<(), String> {
    let mut state = read_state(home);
    let mut entry = Map::new();
    entry.insert("dir".into(), Value::String(dir.to_string_lossy().into_owned()));
    let earlier = state.get("codex").and_then(|c| c.get("endpoint")).cloned();
    if let Some(e) = endpoint.map(|e| Value::String(e.into())).or(earlier) {
        entry.insert("endpoint".into(), e);
    }
    state.insert("codex".into(), Value::Object(entry));
    write_state(home, &state)
}

/// Which file our hooks belong in. Where they already are, else beside the
/// person's own; `hooks.json` wins if both somehow hold ours.
fn hooks_target(doc: &DocumentMut, json: &Value) -> (bool, bool) {
    let ours_json = remove_json(&mut json.clone()) > 0;
    let ours_toml = remove_toml(&mut doc.clone()) > 0;
    let in_toml = if ours_json {
        false
    } else if ours_toml {
        true
    } else {
        hooks_in_toml(doc, json)
    };
    // Ours in both files would post every event twice: the TOML copy goes.
    (in_toml, ours_json && ours_toml)
}

pub fn connect(out: &Out, port: u16, c: Confirm) -> Result<bool, String> {
    let home = home()?;
    let dir = codex_dir(&home);
    if find_codex(&home).is_none() && !dir.is_dir() {
        return Err(format!(
            "Codex isn't installed here (no `codex` command, no {}). Install it, then run this again.",
            tilde(&dir)
        ));
    }
    let config_path = dir.join("config.toml");
    let json_path = dir.join("hooks.json");
    let mut doc = parse(&read_text(&config_path)?, &config_path)?;
    let mut hooks = read_json(&json_path)?;
    let (in_toml, duplicate) = hooks_target(&doc, &hooks);
    let otel = plan_otel(&doc, port);
    let missing = if in_toml { missing_toml(&doc, port) } else { missing_json(&hooks, port) };
    let hooks_path = if in_toml { &config_path } else { &json_path };
    let service = service_step(port)?;

    println!("Connect Codex to AgentStat (everything stays on 127.0.0.1):\n");
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
    match &otel {
        Otel::Present => out.ok("Codex's telemetry goes to AgentStat"),
        Otel::Elsewhere(cur) => out.warn(&format!(
            "Codex's telemetry already goes elsewhere (exporter = {cur}), so it's left as is. Without it, \
             AgentStat shows turns and tools but not tokens or cost."
        )),
        Otel::Add => {
            step("Send Codex's telemetry here: tokens per model call, cost per turn");
            println!("     {}", out.dim(&format!("add to [otel] in {}:", tilde(&config_path))));
            println!(
                "     {}",
                out.dim(&format!(
                    "  exporter = {{ otlp-http = {{ endpoint = \"{}\", protocol = \"json\" }} }}",
                    logs_endpoint(port)
                ))
            );
        }
    }
    if duplicate {
        step("Remove a second copy of AgentStat's hooks");
        println!("     {}", out.dim(&format!("from {} (they're also in {})", tilde(&config_path), tilde(&json_path))));
    }
    if missing.is_empty() {
        out.ok("AgentStat's Codex hooks are in place");
    } else {
        step("Add hooks: live turns, tools, subagents and permission prompts");
        println!("     {}", out.dim(&format!("add to {}, after any hooks already there:", tilde(hooks_path))));
        println!("     {}", out.dim(&format!("  {} → {}", EVENTS.join(", "), hook_command(port))));
    }
    if service.is_none() && otel != Otel::Add && missing.is_empty() && !duplicate {
        println!("\nAll set. In Codex, `/hooks` shows them; check any time with: agentstat doctor");
        return Ok(true);
    }
    println!("  {}", out.dim("undo: agentstat disconnect codex · agentstat service uninstall"));
    if !confirm(c) {
        return Ok(c.dry_run);
    }
    println!();
    if let Some((path, plist)) = &service {
        apply_service(path, plist)?;
        out.ok("The service starts at login");
    }
    // Recorded first, so disconnect finds the folder even if a write below fails.
    let endpoint = logs_endpoint(port);
    record(&home, &dir, (otel == Otel::Add).then_some(endpoint.as_str()))?;
    if otel == Otel::Add {
        add_otel(&mut doc, port)?;
    }
    if duplicate {
        remove_toml(&mut doc);
    }
    if !missing.is_empty() {
        if in_toml {
            add_toml(&mut doc, port)?;
        } else {
            add_json(&mut hooks, port)?;
            write_atomic(&json_path, &json_text(&hooks)?)?;
        }
    }
    if otel == Otel::Add || duplicate || (in_toml && !missing.is_empty()) {
        write_atomic(&config_path, &doc.to_string())?;
    }
    if otel == Otel::Add {
        out.ok("Codex's telemetry goes to AgentStat");
    }
    if !missing.is_empty() {
        out.ok("AgentStat's hooks are added");
        println!(
            "\nOne step in Codex: new hooks run only once you trust them. Start Codex, type /hooks, \
             and press t (trust all). Sessions started after that report to AgentStat."
        );
    } else {
        println!("\nDone. New Codex sessions report to AgentStat; check with: agentstat doctor");
    }
    Ok(true)
}

pub fn disconnect(out: &Out, port: u16, c: Confirm) -> Result<bool, String> {
    let home = home()?;
    let mut state = read_state(&home);
    // The folder connect edited, even if CODEX_HOME changed since.
    let dir = state
        .get("codex")
        .and_then(|c| c.get("dir"))
        .and_then(Value::as_str)
        .map_or_else(|| codex_dir(&home), PathBuf::from);
    let config_path = dir.join("config.toml");
    let json_path = dir.join("hooks.json");
    let mut doc = parse(&read_text(&config_path)?, &config_path)?;
    let mut hooks = read_json(&json_path)?;
    // Exactly the exporter connect wrote (else this port's): one of the
    // person's own, even on this machine, stays.
    let endpoint = state
        .get("codex")
        .and_then(|c| c.get("endpoint"))
        .and_then(Value::as_str)
        .map_or_else(|| logs_endpoint(port), str::to_string);
    let later = later_toml(&doc) + later_json(&hooks);
    let mut plan_doc = doc.clone();
    let otel = remove_otel(&mut plan_doc, &endpoint);
    let in_toml = remove_toml(&mut plan_doc);
    let in_json = remove_json(&mut hooks.clone());
    if !otel && in_toml == 0 && in_json == 0 {
        state.remove("codex");
        write_state(&home, &state)?;
        out.ok("Codex isn't connected; nothing to undo.");
        return Ok(true);
    }
    println!("Disconnect Codex from AgentStat:\n");
    if otel {
        println!("  remove  the AgentStat exporter from [otel] in {}", tilde(&config_path));
    }
    if in_toml > 0 {
        println!("  remove  {in_toml} AgentStat hooks from {}", tilde(&config_path));
    }
    if in_json > 0 {
        println!("  remove  {in_json} AgentStat hooks from {}", tilde(&json_path));
    }
    if later > 0 {
        out.warn(&format!(
            "{later} of your own hooks come after AgentStat's, so they move up: Codex will ask you to trust them again (/hooks)"
        ));
    }
    println!("  {}", out.dim("the service keeps running; to stop it at login: agentstat service uninstall"));
    if !confirm(c) {
        return Ok(c.dry_run);
    }
    println!();
    if otel || in_toml > 0 {
        remove_otel(&mut doc, &endpoint);
        remove_toml(&mut doc);
        write_atomic(&config_path, &doc.to_string())?;
    }
    if in_json > 0 {
        remove_json(&mut hooks);
        // Nothing left: the file was ours alone.
        if hooks.as_object().is_some_and(|o| o.keys().all(|k| k == "hooks")) && !json_has_hooks(&hooks) {
            let _ = std::fs::remove_file(&json_path);
        } else {
            write_atomic(&json_path, &json_text(&hooks)?)?;
        }
    }
    state.remove("codex");
    write_state(&home, &state)?;
    out.ok("Codex no longer reports to AgentStat");
    Ok(true)
}

/// `agentstat doctor`'s Codex checks.
pub fn doctor(out: &Out, home: &Path, port: u16) {
    let dir = codex_dir(home);
    if find_codex(home).is_none() && !dir.is_dir() {
        out.note("Codex not found (skipping its checks)");
        return;
    }
    let config_path = dir.join("config.toml");
    let doc = match read_text(&config_path).and_then(|t| parse(&t, &config_path)) {
        Ok(d) => d,
        Err(e) => return out.warn(&e),
    };
    match plan_otel(&doc, port) {
        Otel::Present => out.ok(&format!("Codex's telemetry comes here (127.0.0.1:{port})")),
        Otel::Elsewhere(cur) => {
            out.warn(&format!("Codex's telemetry goes elsewhere (exporter = {cur}): no tokens or cost"))
        }
        Otel::Add => out.warn("Codex's telemetry isn't sent here: no tokens or cost (agentstat connect codex)"),
    }
    let json = read_json(&dir.join("hooks.json")).unwrap_or_default();
    let missing = if hooks_in_toml(&doc, &json) { missing_toml(&doc, port) } else { missing_json(&json, port) };
    if missing.is_empty() {
        out.ok("AgentStat's Codex hooks are in place (Codex runs them once trusted: /hooks, then t)");
    } else if missing.len() == EVENTS.len() {
        out.warn("AgentStat's Codex hooks aren't set up: no live turns or tools (agentstat connect codex)");
    } else {
        out.warn(&format!("Some AgentStat Codex hooks are missing ({}): agentstat connect codex", missing.join(", ")));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(t: &str) -> DocumentMut {
        t.parse().unwrap()
    }

    #[test]
    fn telemetry_is_added_once_and_removed_cleanly() {
        let mut d = doc("model = \"gpt-5.5-codex\" # mine\n\n[otel]\nlog_user_prompt = false\n");
        assert_eq!(plan_otel(&d, 4318), Otel::Add);
        add_otel(&mut d, 4318).unwrap();
        assert_eq!(plan_otel(&d, 4318), Otel::Present);
        let text = d.to_string();
        assert!(text.starts_with("model = \"gpt-5.5-codex\" # mine\n"), "{text}");
        assert!(
            text.contains(
                "exporter = { otlp-http = { endpoint = \"http://127.0.0.1:4318/v1/logs\", protocol = \"json\" } }"
            ),
            "{text}"
        );
        // Another port is a change, not a conflict of the person's.
        assert!(matches!(plan_otel(&d, 4422), Otel::Elsewhere(_)));
        assert!(remove_otel(&mut d, "http://127.0.0.1:4318/v1/logs"));
        assert_eq!(d.to_string(), "model = \"gpt-5.5-codex\" # mine\n\n[otel]\nlog_user_prompt = false\n");
        // [otel] that only held ours goes away entirely.
        let mut d = doc("");
        add_otel(&mut d, 4318).unwrap();
        assert!(remove_otel(&mut d, "http://127.0.0.1:4318/v1/logs"));
        assert_eq!(d.to_string().trim(), "");
    }

    #[test]
    fn someone_else_s_exporter_is_left_alone() {
        let mut d = doc("[otel]\nexporter = { otlp-grpc = { endpoint = \"https://collector:4317\" } }\n");
        assert!(matches!(plan_otel(&d, 4318), Otel::Elsewhere(s) if s.contains("collector")));
        assert!(!remove_otel(&mut d, "http://127.0.0.1:4318/v1/logs"));
        let mut d = doc("[otel]\nexporter = \"none\"\n");
        assert!(matches!(plan_otel(&d, 4318), Otel::Elsewhere(_)));
        assert!(!remove_otel(&mut d, "http://127.0.0.1:4318/v1/logs"));
        // A collector of the person's own on this machine isn't ours either.
        let mut d = doc(
            "[otel]\nexporter = { otlp-http = { endpoint = \"http://127.0.0.1:4319/v1/logs\", protocol = \"json\" } }\n",
        );
        assert!(!remove_otel(&mut d, "http://127.0.0.1:4318/v1/logs"));
    }

    #[test]
    fn json_hooks_go_after_the_person_s_and_come_out_alone() {
        let mut v = json!({"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "~/check.sh"}]}]}});
        assert_eq!(missing_json(&v, 4318), EVENTS.to_vec());
        add_json(&mut v, 4318).unwrap();
        assert_eq!(missing_json(&v, 4318), Vec::<&str>::new());
        let pre = v["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(pre[0]["hooks"][0]["command"], "~/check.sh");
        assert_eq!(pre[1]["hooks"][0]["statusMessage"], "AgentStat");
        assert_eq!(pre[1]["hooks"][0]["timeout"], 2);
        // A hook the person adds after ours.
        v["hooks"]["PreToolUse"]
            .as_array_mut()
            .unwrap()
            .push(json!({"hooks": [{"type": "command", "command": "~/later.sh"}]}));
        assert_eq!(later_json(&v), 1);
        // Connecting again on another port updates ours where they are: nothing moves.
        add_json(&mut v, 4422).unwrap();
        let pre = v["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(pre.len(), 3);
        assert!(pre[1]["hooks"][0]["command"].as_str().unwrap().contains(":4422/"));
        assert_eq!(pre[2]["hooks"][0]["command"], "~/later.sh");
        // A duplicate of ours is dropped.
        v["hooks"]["Stop"].as_array_mut().unwrap().push(json!({"hooks": [json_handler(4318)]}));
        add_json(&mut v, 4422).unwrap();
        assert_eq!(v["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert_eq!(remove_json(&mut v), EVENTS.len());
        v["hooks"]["PreToolUse"].as_array_mut().unwrap().pop();
        assert_eq!(
            v,
            json!({"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "~/check.sh"}]}]}})
        );
    }

    #[test]
    fn toml_hooks_keep_the_person_s_hooks_and_trust_state() {
        let text = "[[hooks.PreToolUse]]\nmatcher = \"Bash\"\n[[hooks.PreToolUse.hooks]]\ntype = \"command\"\ncommand = \"~/check.sh\"\n\n[hooks.state.\"x\"]\ntrusted_hash = \"sha256:abc\"\n";
        let mut d = doc(text);
        assert!(toml_has_hooks(&d));
        assert!(!toml_has_hooks(&doc("[hooks.state.\"x\"]\ntrusted_hash = \"sha256:abc\"\n")));
        add_toml(&mut d, 4318).unwrap();
        assert_eq!(missing_toml(&d, 4318), Vec::<&str>::new());
        let first = groups(&d, "PreToolUse").next().unwrap();
        assert_eq!(handlers(first).next().unwrap().get("command").and_then(Item::as_str), Some("~/check.sh"));
        // What Codex reads back: our handler, in its schema.
        let again = doc(&d.to_string());
        let ours = groups(&again, "Stop").next().unwrap();
        let h = handlers(ours).next().unwrap();
        assert_eq!(h.get("type").and_then(Item::as_str), Some("command"));
        assert_eq!(h.get("timeout").and_then(Item::as_integer), Some(2));
        // Again, on another port: updated where they are.
        add_toml(&mut d, 4422).unwrap();
        assert_eq!(groups(&d, "PreToolUse").count(), 2);
        assert_eq!(missing_toml(&d, 4422), Vec::<&str>::new());
        assert_eq!(later_toml(&d), 0);
        assert_eq!(remove_toml(&mut d), EVENTS.len());
        assert_eq!(d.to_string(), text);
    }

    #[test]
    fn hooks_go_where_the_person_keeps_theirs() {
        let none = doc("");
        let toml = doc("[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = \"command\"\ncommand = \"say done\"\n");
        let json_with = json!({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "say done"}]}]}});
        assert!(!hooks_in_toml(&none, &json!({})));
        assert!(hooks_in_toml(&toml, &json!({})));
        assert!(!hooks_in_toml(&toml, &json_with));
        // Where ours already are wins; ours in both files: the TOML copy goes.
        let mut ours_toml = doc("");
        add_toml(&mut ours_toml, 4318).unwrap();
        assert_eq!(hooks_target(&ours_toml, &json_with), (true, false));
        let mut ours_json = json!({});
        add_json(&mut ours_json, 4318).unwrap();
        assert_eq!(hooks_target(&toml, &ours_json), (false, false));
        assert_eq!(hooks_target(&ours_toml, &ours_json), (false, true));
    }

    #[test]
    fn the_hook_command_never_fails_a_turn() {
        let cmd = hook_command(4318);
        assert!(
            cmd.ends_with("|| true") && cmd.contains("-m 1") && cmd.contains("http://127.0.0.1:4318/v1/hooks/codex")
        );
        assert!(ours(&cmd) && !ours("curl http://example.com/v1/hooks/claude"));
    }
}

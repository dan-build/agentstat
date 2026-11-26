//! `agentstat connect cursor` / `disconnect cursor`: Cursor's hooks, pointed
//! at the local service.
//!
//! Hooks live in `~/.cursor/hooks.json` (`{"version": 1, "hooks": {event:
//! [{command, timeout}]}}`); Cursor picks up changes without a restart. Only
//! hooks that observe are added: none that run before an action, where a
//! reply decides whether it may run. Each prints nothing and always exits 0,
//! which Cursor treats as no opinion.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use super::{
    Confirm, Out, apply_service, confirm, home, read_state, service_step, tilde, which, write_atomic, write_state,
};

/// The events AgentStat listens to: none of them can block or approve anything.
pub const EVENTS: [&str; 6] =
    ["sessionStart", "beforeSubmitPrompt", "postToolUse", "postToolUseFailure", "stop", "sessionEnd"];

/// How AgentStat's hooks are recognized (any port): their command posts here.
const MARKER: &str = "/v1/hooks/cursor";

pub fn cursor_dir(home: &Path) -> PathBuf {
    home.join(".cursor")
}

fn installed(home: &Path) -> bool {
    cursor_dir(home).is_dir()
        || Path::new("/Applications/Cursor.app").is_dir()
        || home.join("Applications/Cursor.app").is_dir()
        || which("cursor-agent", &[home.join(".local/bin")]).is_some()
}

/// What each hook runs: post its input to the service, print nothing, and
/// exit 0 whatever happens (nothing happens when the service isn't running).
pub fn hook_command(port: u16) -> String {
    format!(
        "curl -s -m 0.5 -o /dev/null -H \"Content-Type: application/json\" -H \"X-AgentStat-App: ${{__CFBundleIdentifier:-}}\" --data-binary @- \"http://127.0.0.1:{port}{MARKER}\" >/dev/null 2>&1 || true"
    )
}

fn ours(h: &Value) -> bool {
    h["command"].as_str().is_some_and(|c| c.contains(MARKER))
}

/// Events whose list lacks ours with this exact command.
pub fn missing(hooks: &Value, port: u16) -> Vec<&'static str> {
    let cmd = hook_command(port);
    EVENTS
        .into_iter()
        .filter(|e| !hooks["hooks"][*e].as_array().into_iter().flatten().any(|h| h["command"].as_str() == Some(&cmd)))
        .collect()
}

/// Ours in each event's list, after the person's; one of ours already there
/// (another port) is updated where it is.
pub fn add(hooks: &mut Value, port: u16) -> Result<(), String> {
    let root = hooks.as_object_mut().ok_or("hooks.json isn't an object")?;
    root.entry("version").or_insert(json!(1));
    let map = root.entry("hooks").or_insert_with(|| Value::Object(Map::new()));
    let map = map.as_object_mut().ok_or("`hooks` in hooks.json isn't an object")?;
    let entry = json!({"command": hook_command(port), "timeout": 2});
    for e in EVENTS {
        let list = map.entry(e).or_insert_with(|| Value::Array(vec![]));
        let list = list.as_array_mut().ok_or_else(|| format!("`hooks.{e}` in hooks.json isn't a list"))?;
        let mut found = false;
        list.retain_mut(|h| {
            if !ours(h) {
                return true;
            }
            if found {
                // A second one of ours would post every event twice.
                return false;
            }
            *h = entry.clone();
            found = true;
            true
        });
        if !found {
            list.push(entry.clone());
        }
    }
    Ok(())
}

/// Remove ours (any port), and lists left empty. How many went.
pub fn remove(hooks: &mut Value) -> usize {
    let Some(map) = hooks.get_mut("hooks").and_then(Value::as_object_mut) else { return 0 };
    let mut n = 0;
    let mut emptied = Vec::new();
    for (event, list) in map.iter_mut() {
        if let Some(l) = list.as_array_mut() {
            let before = l.len();
            l.retain(|h| !ours(h));
            n += before - l.len();
            // Only lists this emptied go; an empty one of the person's stays.
            if l.is_empty() && before > 0 {
                emptied.push(event.clone());
            }
        }
    }
    for e in emptied {
        map.remove(&e);
    }
    n
}

fn read(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(t) if t.trim().is_empty() => Ok(json!({})),
        Ok(t) => serde_json::from_str(&t).map_err(|e| format!("couldn't read {}: {e}", tilde(path))),
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
        return Err("Cursor isn't installed here (no ~/.cursor, no Cursor.app, no `cursor-agent`). Install it, then run this again.".into());
    }
    let path = cursor_dir(&home).join("hooks.json");
    let mut hooks = read(&path)?;
    let todo = missing(&hooks, port);
    let service = service_step(port)?;

    println!("Connect Cursor to AgentStat (everything stays on 127.0.0.1):\n");
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
    if todo.is_empty() {
        out.ok("AgentStat's Cursor hooks are in place");
    } else {
        step("Add hooks: live turns and tools (they only observe: none can block or approve anything)");
        println!("     {}", out.dim(&format!("add to {}, after any hooks already there:", tilde(&path))));
        println!("     {}", out.dim(&format!("  {} → {}", EVENTS.join(", "), hook_command(port))));
    }
    out.note("Cursor reports no tokens or cost to local hooks, so AgentStat shows turns and tools for it");
    if service.is_none() && todo.is_empty() {
        println!("\nAll set. Check any time with: agentstat doctor");
        return Ok(true);
    }
    println!("  {}", out.dim("undo: agentstat disconnect cursor · agentstat service uninstall"));
    if !confirm(c) {
        return Ok(c.dry_run);
    }
    println!();
    if let Some((p, plist)) = &service {
        apply_service(p, plist)?;
        out.ok("The service starts at login");
    }
    if !todo.is_empty() {
        add(&mut hooks, port)?;
        let mut state = read_state(&home);
        state.insert("cursor".into(), json!({"hooks": path.to_string_lossy()}));
        write_state(&home, &state)?;
        write_atomic(&path, &text(&hooks)?)?;
        out.ok("AgentStat's hooks are added");
    }
    println!("\nDone. Cursor picks them up as you work; check with: agentstat doctor");
    Ok(true)
}

pub fn disconnect(out: &Out, c: Confirm) -> Result<bool, String> {
    let home = home()?;
    let mut state = read_state(&home);
    let path = state
        .get("cursor")
        .and_then(|c| c.get("hooks"))
        .and_then(Value::as_str)
        .map_or_else(|| cursor_dir(&home).join("hooks.json"), PathBuf::from);
    let mut hooks = read(&path)?;
    let n = remove(&mut hooks.clone());
    if n == 0 {
        state.remove("cursor");
        write_state(&home, &state)?;
        out.ok("Cursor isn't connected; nothing to undo.");
        return Ok(true);
    }
    println!("Disconnect Cursor from AgentStat:\n");
    println!("  remove  {n} AgentStat hooks from {}", tilde(&path));
    println!("  {}", out.dim("the service keeps running; to stop it at login: agentstat service uninstall"));
    if !confirm(c) {
        return Ok(c.dry_run);
    }
    println!();
    remove(&mut hooks);
    let empty = hooks["hooks"].as_object().is_none_or(Map::is_empty)
        && hooks.as_object().is_some_and(|o| o.keys().all(|k| k == "hooks" || k == "version"));
    if empty {
        let _ = std::fs::remove_file(&path);
    } else {
        write_atomic(&path, &text(&hooks)?)?;
    }
    state.remove("cursor");
    write_state(&home, &state)?;
    out.ok("Cursor no longer reports to AgentStat");
    Ok(true)
}

/// `agentstat doctor`'s Cursor checks.
pub fn doctor(out: &Out, home: &Path, port: u16) {
    if !installed(home) {
        out.note("Cursor not found (skipping its checks)");
        return;
    }
    let hooks = match read(&cursor_dir(home).join("hooks.json")) {
        Ok(h) => h,
        Err(e) => return out.warn(&e),
    };
    let gone = missing(&hooks, port);
    if gone.is_empty() {
        out.ok("AgentStat's Cursor hooks are in place");
    } else if gone.len() == EVENTS.len() {
        out.warn("AgentStat's Cursor hooks aren't set up: no live turns or tools (agentstat connect cursor)");
    } else {
        out.warn(&format!("Some AgentStat Cursor hooks are missing ({}): agentstat connect cursor", gone.join(", ")));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hooks_go_after_the_person_s_and_come_out_alone() {
        let mine = json!({"version": 1, "hooks": {"afterFileEdit": [{"command": "./format.sh"}], "stop": [{"command": "say done"}]}});
        let mut v = mine.clone();
        assert_eq!(missing(&v, 4318), EVENTS.to_vec());
        add(&mut v, 4318).unwrap();
        assert!(missing(&v, 4318).is_empty());
        assert_eq!(v["hooks"]["stop"][0]["command"], "say done");
        assert_eq!(v["hooks"]["stop"][1]["timeout"], 2);
        // Again, on another port: updated where they are, no duplicates.
        add(&mut v, 4422).unwrap();
        assert_eq!(v["hooks"]["stop"].as_array().unwrap().len(), 2);
        assert!(missing(&v, 4422).is_empty());
        assert_eq!(remove(&mut v), EVENTS.len());
        assert_eq!(v, mine);
    }

    #[test]
    fn it_never_hooks_anything_that_decides() {
        for e in EVENTS {
            assert!(
                !["preToolUse", "beforeShellExecution", "beforeMCPExecution", "beforeReadFile", "subagentStart"]
                    .contains(&e)
            );
        }
        let cmd = hook_command(4318);
        assert!(cmd.ends_with(">/dev/null 2>&1 || true") && cmd.contains("127.0.0.1:4318/v1/hooks/cursor"));
    }

    #[test]
    fn a_new_file_gets_a_version() {
        let mut v = json!({});
        add(&mut v, 4318).unwrap();
        assert_eq!(v["version"], 1);
    }
}

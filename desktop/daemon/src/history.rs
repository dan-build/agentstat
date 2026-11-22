//! Session history: what each agent did today, kept for a week.
//!
//! One small JSON file per local day (`YYYY-MM-DD.json`) holding a record per
//! agent: when it was first and last heard from, how long it was working, its
//! output tokens, cost, tool calls, errors and anomalies. Names and numbers
//! only: no prompt, response or tool text. Rewritten whole (it's small) when
//! something changed, at most every [`SAVE_EVERY_MS`], and at a day's end.

use std::path::{Path, PathBuf};

pub use agentstat_core::history::{Day, Record, is_date};

/// Days of files kept, today included.
pub const KEEP_DAYS: usize = 7;
/// A changed day is written at most this often.
pub const SAVE_EVERY_MS: f64 = 30_000.0;
/// Agents recorded per day; more are ignored (bounds the file).
pub const MAX_RECORDS: usize = 500;

/// The local calendar date of `ms` (since the epoch), as `YYYY-MM-DD`.
pub fn local_date(ms: f64) -> String {
    let secs = (ms / 1000.0).floor() as libc::time_t;
    // SAFETY: localtime_r writes only into `tm`.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::localtime_r(&secs, &mut tm) }.is_null() {
        return "1970-01-01".into();
    }
    format!("{:04}-{:02}-{:02}", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday)
}

/// Where the files go: `~/Library/Application Support/AgentStat/history`.
pub fn default_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").filter(|h| !h.is_empty())?;
    Some(Path::new(&home).join("Library/Application Support/AgentStat/history"))
}

pub struct History {
    /// None keeps history in memory only (tests).
    dir: Option<PathBuf>,
    day: Day,
    dirty: bool,
    saved_at: f64,
}

impl History {
    /// Today's history, continuing a file an earlier run left. Prunes files
    /// older than [`KEEP_DAYS`].
    pub fn open(dir: Option<PathBuf>, now: f64) -> Self {
        let date = local_date(now);
        let day = dir.as_deref().and_then(|d| read_day(d, &date)).unwrap_or(Day { date, ..Day::default() });
        let h = History { dir, day, dirty: false, saved_at: now };
        h.prune();
        h
    }

    /// The record for `id`, after rolling over to a new day if `now` is one.
    /// None when the day is full.
    pub fn record(&mut self, id: &str, name: Option<&str>, now: f64) -> Option<&mut Record> {
        self.roll(now);
        if !self.day.agents.contains_key(id) && self.day.agents.len() >= MAX_RECORDS {
            return None;
        }
        self.dirty = true;
        let r = self.day.agents.entry(id.to_string()).or_insert_with(|| Record { first: now, ..Record::default() });
        if let Some(n) = name.filter(|n| !n.is_empty()) {
            n.clone_into(&mut r.name);
        }
        r.last = r.last.max(now);
        Some(r)
    }

    /// Today's records.
    pub fn today(&self) -> &Day {
        &self.day
    }

    /// The records for `date`: today's live, an earlier day's from its file.
    pub fn day(&self, date: &str) -> Option<Day> {
        if date == self.day.date {
            return Some(self.day.clone());
        }
        if !is_date(date) {
            return None;
        }
        read_day(self.dir.as_deref()?, date)
    }

    /// Dates with history, newest first (today always).
    pub fn dates(&self) -> Vec<String> {
        let mut out: Vec<String> = self
            .dir
            .as_deref()
            .and_then(|d| std::fs::read_dir(d).ok())
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok()?.file_name().to_str()?.strip_suffix(".json").map(str::to_string))
            .filter(|d| is_date(d))
            .collect();
        if !out.contains(&self.day.date) {
            out.push(self.day.date.clone());
        }
        out.sort_unstable_by(|a, b| b.cmp(a));
        out
    }

    /// Write the day if it changed and the last write was long enough ago.
    pub fn maybe_save(&mut self, now: f64) {
        self.roll(now);
        if self.dirty && now - self.saved_at >= SAVE_EVERY_MS {
            self.save(now);
        }
    }

    /// Write the day if it changed.
    pub fn save(&mut self, now: f64) {
        self.saved_at = now;
        if !self.dirty {
            return;
        }
        self.dirty = false;
        let Some(dir) = self.dir.as_deref() else { return };
        if let Err(e) = write_day(dir, &self.day) {
            eprintln!("agentstat: couldn't save history: {e}");
        }
    }

    fn roll(&mut self, now: f64) {
        let date = local_date(now);
        if date != self.day.date {
            self.save(now);
            self.day = Day { date, ..Day::default() };
            self.prune();
        }
    }

    fn prune(&self) {
        let Some(dir) = self.dir.as_deref() else { return };
        for old in self.dates().into_iter().skip(KEEP_DAYS) {
            let _ = std::fs::remove_file(dir.join(format!("{old}.json")));
        }
    }
}

fn read_day(dir: &Path, date: &str) -> Option<Day> {
    let text = std::fs::read_to_string(dir.join(format!("{date}.json"))).ok()?;
    let mut day: Day = serde_json::from_str(&text).ok()?;
    day.date = date.to_string();
    Some(day)
}

/// Atomically: a half-written file never replaces a good one.
fn write_day(dir: &Path, day: &Day) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".{}.json.tmp", day.date));
    std::fs::write(&tmp, serde_json::to_vec(day).map_err(std::io::Error::other)?)?;
    std::fs::rename(tmp, dir.join(format!("{}.json", day.date)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("agentstat-history-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn dates_are_validated_before_they_reach_a_path() {
        assert!(is_date("2026-11-21"));
        for bad in ["../../etc/x", "2026-11-2", "2026/11/21", "2026-11-21.json", "abcd-ef-gh"] {
            assert!(!is_date(bad), "{bad}");
        }
        assert!(is_date(&local_date(1_790_000_000_000.0)));
    }

    #[test]
    fn a_day_survives_a_restart_and_rolls_over_at_midnight() {
        let dir = tmp_dir("roll");
        let noon = 1_790_000_000_000.0;
        let mut h = History::open(Some(dir.clone()), noon);
        let r = h.record("s1", Some("api"), noon).unwrap();
        r.output_tokens += 120.0;
        r.tools += 2;
        h.save(noon);

        let mut again = History::open(Some(dir.clone()), noon + 1_000.0);
        let r = again.record("s1", None, noon + 1_000.0).unwrap();
        assert_eq!((r.name.as_str(), r.output_tokens, r.tools, r.first), ("api", 120.0, 2, noon));

        // Two days later: yesterday's file is written, today starts empty.
        let later = noon + 2.0 * 86_400_000.0;
        again.record("s2", Some("web"), later).unwrap();
        assert_eq!(again.today().agents.keys().collect::<Vec<_>>(), vec!["s2"]);
        let first = local_date(noon);
        assert_eq!(again.day(&first).unwrap().agents["s1"].output_tokens, 120.0);
        assert_eq!(again.dates().len(), 2);
        assert!(again.day("../x").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn only_a_week_is_kept_and_records_are_bounded() {
        let dir = tmp_dir("prune");
        let day0 = 1_790_000_000_000.0;
        let mut h = History::open(Some(dir.clone()), day0);
        for d in 0..10 {
            let now = day0 + d as f64 * 86_400_000.0;
            h.record("s", Some("api"), now).unwrap();
            h.save(now);
        }
        assert_eq!(h.dates().len(), KEEP_DAYS);
        for i in 0..MAX_RECORDS + 5 {
            h.record(&format!("x{i}"), None, day0 + 9.0 * 86_400_000.0);
        }
        assert_eq!(h.today().agents.len(), MAX_RECORDS);
        let _ = std::fs::remove_dir_all(dir);
    }
}

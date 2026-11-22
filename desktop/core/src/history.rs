//! A day of session history: the records the service keeps per agent, and
//! the per-project summary the app and `agentstat today` show.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

/// One agent on one day.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Record {
    /// Its display name ("agentstat", "agentstat · Explore").
    pub name: String,
    /// First and last activity that day (ms since the epoch).
    pub first: f64,
    pub last: f64,
    /// Time spent working (not finished), in ms.
    pub working_ms: f64,
    pub output_tokens: f64,
    pub cost_usd: f64,
    pub tools: u64,
    pub errors: u64,
    pub stalls: u64,
    pub runaways: u64,
    pub thrash: u64,
}

impl Record {
    /// The project: the name without a subagent or session suffix.
    pub fn project(&self) -> &str {
        self.name.split(" · ").next().unwrap_or(&self.name)
    }
}

/// A day's records, by agent id.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Day {
    pub date: String,
    pub agents: BTreeMap<String, Record>,
}

/// Whether `s` looks like a date this module wrote (so it's safe in a path).
pub fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10 && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}

/// One project's day: its sessions and subagents added up.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Row {
    pub project: String,
    /// Top-level sessions (subagents counted apart).
    pub sessions: usize,
    pub subagents: usize,
    pub first: f64,
    pub last: f64,
    pub working_ms: f64,
    pub output_tokens: f64,
    pub cost_usd: f64,
    pub tools: u64,
    pub errors: u64,
    pub anomalies: u64,
}

/// The day by project, most recently active first, and the day's total
/// (its `project` is empty).
pub fn summarize(day: &Day) -> (Vec<Row>, Row) {
    let mut rows: BTreeMap<&str, Row> = BTreeMap::new();
    let mut total = Row::default();
    let mut sessions: HashSet<&str> = HashSet::new();
    for (id, r) in &day.agents {
        let row = rows.entry(r.project()).or_insert_with(|| Row {
            project: r.project().to_string(),
            first: r.first,
            ..Row::default()
        });
        // A subagent's id is its session's id and its own: `<session>/<agent>`.
        let session = id.split('/').next().unwrap_or(id);
        if id.contains('/') {
            row.subagents += 1;
            total.subagents += 1;
        }
        if sessions.insert(session) {
            row.sessions += 1;
            total.sessions += 1;
        }
        for x in [&mut *row, &mut total] {
            x.first = if x.first == 0.0 { r.first } else { x.first.min(r.first) };
            x.last = x.last.max(r.last);
            x.working_ms += r.working_ms;
            x.output_tokens += r.output_tokens;
            x.cost_usd += r.cost_usd;
            x.tools += r.tools;
            x.errors += r.errors;
            x.anomalies += r.stalls + r.runaways + r.thrash;
        }
    }
    let mut rows: Vec<Row> = rows.into_values().collect();
    rows.sort_by(|a, b| b.last.total_cmp(&a.last));
    (rows, total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_project_drops_a_subagent_or_session_suffix() {
        let r = |n: &str| Record { name: n.into(), ..Record::default() };
        assert_eq!(r("agentstat · Explore").project(), "agentstat");
        assert_eq!(r("agentstat").project(), "agentstat");
    }

    #[test]
    fn a_day_adds_up_by_project_with_subagents_in_their_session() {
        let rec = |name: &str, last: f64, tokens: f64| Record {
            name: name.into(),
            first: 1.0,
            last,
            output_tokens: tokens,
            working_ms: 1_000.0,
            stalls: 1,
            ..Record::default()
        };
        let mut day = Day::default();
        day.agents.insert("claude:s1".into(), rec("api", 10.0, 100.0));
        day.agents.insert("claude:s1/a1".into(), rec("api · Explore", 12.0, 50.0));
        day.agents.insert("claude:s2".into(), rec("api · s2abcd", 5.0, 10.0));
        day.agents.insert("claude:s3".into(), rec("web", 20.0, 1.0));
        let (rows, total) = summarize(&day);
        assert_eq!(rows.iter().map(|r| r.project.as_str()).collect::<Vec<_>>(), vec!["web", "api"]);
        let api = &rows[1];
        assert_eq!((api.sessions, api.subagents, api.output_tokens, api.anomalies), (2, 1, 160.0, 3));
        assert_eq!((total.sessions, total.subagents, total.working_ms, total.last), (3, 1, 4_000.0, 20.0));
    }
}

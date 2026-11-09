//! Sparse per-agent status history (mirrors `src/statuslog.ts`): only
//! transitions are stored, and "status at time T" is a binary search.

use crate::types::Status;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transition {
    /// When this status began.
    pub t: f64,
    pub status: Status,
}

#[derive(Clone, Debug)]
pub struct StatusLog {
    transitions: Vec<Transition>,
    hard_cap: usize,
}

impl Default for StatusLog {
    fn default() -> Self {
        StatusLog { transitions: Vec::new(), hard_cap: 2_000 }
    }
}

impl StatusLog {
    pub fn len(&self) -> usize {
        self.transitions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.transitions.is_empty()
    }

    /// Record that `status` holds from `t` (no-op if it matches the latest).
    pub fn record(&mut self, t: f64, status: Status) {
        if self.transitions.last().is_some_and(|x| x.status == status) {
            return;
        }
        self.transitions.push(Transition { t, status });
        if self.transitions.len() > self.hard_cap {
            let excess = self.transitions.len() - self.hard_cap;
            self.transitions.drain(..excess);
        }
    }

    /// The status in effect at `t`, or None before the first transition.
    pub fn status_at(&self, t: f64) -> Option<Status> {
        let a = &self.transitions;
        if a.is_empty() || t < a[0].t {
            return None;
        }
        let i = a.partition_point(|x| x.t <= t);
        Some(a[i - 1].status)
    }

    /// Drop transitions older than `t`, keeping the one in effect at `t`.
    pub fn evict_older_than(&mut self, t: f64) {
        let mut keep_from = 0;
        for (i, x) in self.transitions.iter().enumerate() {
            if x.t <= t {
                keep_from = i;
            } else {
                break;
            }
        }
        if keep_from > 0 {
            self.transitions.drain(..keep_from);
        }
    }

    /// Transitions within (from, to], preceded by the status in effect at `from`.
    pub fn transitions_in_range(&self, from: f64, to: f64) -> Vec<Transition> {
        let mut out = Vec::new();
        if let Some(status) = self.status_at(from) {
            out.push(Transition { t: from, status });
        }
        out.extend(self.transitions.iter().filter(|x| x.t > from && x.t <= to).copied());
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_transitions_only() {
        let mut log = StatusLog::default();
        log.record(0.0, Status::Active);
        log.record(5.0, Status::Active);
        log.record(10.0, Status::Thinking);
        assert_eq!(log.len(), 2);
        assert_eq!(log.status_at(-1.0), None);
        assert_eq!(log.status_at(9.9), Some(Status::Active));
        assert_eq!(log.status_at(10.0), Some(Status::Thinking));
        let r = log.transitions_in_range(5.0, 20.0);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0], Transition { t: 5.0, status: Status::Active });
        log.evict_older_than(12.0);
        assert_eq!(log.len(), 1);
    }
}

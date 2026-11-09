//! Time-indexed sample buffer (the storage half of `src/timeseries.ts`).

use std::collections::VecDeque;

/// One sample: time (ms, the store's clock) and value.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub t: f64,
    pub v: f64,
}

/// A ring buffer of samples sorted by time, with time-based eviction and a hard
/// cap on its length.
#[derive(Clone, Debug)]
pub struct TimeSeries {
    points: VecDeque<Point>,
    hard_cap: usize,
}

impl TimeSeries {
    pub fn new(hard_cap: usize) -> Self {
        TimeSeries { points: VecDeque::new(), hard_cap: hard_cap.max(2) }
    }

    pub fn len(&self) -> usize {
        self.points.len()
    }

    pub fn is_empty(&self) -> bool {
        self.points.is_empty()
    }

    /// Time of the newest sample, or -∞ when empty.
    pub fn last_t(&self) -> f64 {
        self.points.back().map_or(f64::NEG_INFINITY, |p| p.t)
    }

    /// Append a sample. A time earlier than the newest sample is clamped forward
    /// so the buffer stays sorted; non-finite input is ignored. When full, the
    /// oldest sample goes.
    pub fn push(&mut self, t: f64, v: f64) {
        if !t.is_finite() || !v.is_finite() {
            return;
        }
        let last = self.last_t();
        if self.points.len() >= self.hard_cap {
            self.points.pop_front();
        }
        self.points.push_back(Point { t: if t < last { last } else { t }, v });
    }

    /// Drop samples older than `now - retention_ms`.
    pub fn evict_older_than(&mut self, now: f64, retention_ms: f64) {
        let k = self.lower_bound(now - retention_ms);
        self.points.drain(..k);
    }

    /// Samples with time ≥ `t`, oldest first.
    pub fn since(&self, t: f64) -> Vec<Point> {
        self.points.range(self.lower_bound(t)..).copied().collect()
    }

    /// Values of samples with time ≥ `t`.
    pub fn values_since(&self, t: f64) -> Vec<f64> {
        self.points.range(self.lower_bound(t)..).map(|p| p.v).collect()
    }

    /// All samples, oldest first.
    pub fn iter(&self) -> impl Iterator<Item = &Point> {
        self.points.iter()
    }

    /// Index of the first sample with time ≥ `t`.
    fn lower_bound(&self, t: f64) -> usize {
        self.points.partition_point(|p| p.t < t)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_order_and_evicts_by_time() {
        let mut s = TimeSeries::new(100);
        s.push(10.0, 1.0);
        s.push(5.0, 2.0); // clamped forward to 10
        s.push(20.0, 3.0);
        s.push(f64::NAN, 4.0);
        assert_eq!(s.len(), 3);
        assert_eq!(s.since(10.0).len(), 3);
        assert_eq!(s.values_since(11.0), vec![3.0]);
        s.evict_older_than(25.0, 10.0);
        assert_eq!(s.values_since(f64::NEG_INFINITY), vec![3.0]);
    }

    #[test]
    fn hard_cap_drops_oldest() {
        let mut s = TimeSeries::new(2);
        for i in 0..5 {
            s.push(i as f64, i as f64);
        }
        assert_eq!(s.values_since(f64::NEG_INFINITY), vec![3.0, 4.0]);
    }
}

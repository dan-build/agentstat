//! Drawing a token-rate line: a triangle strip with mitered joins (no general
//! tessellator, measured ~30% faster on the oldest Mac we support) and a soft
//! area under it. The line ends where the data ends: nothing is extrapolated.

use agentstat_core::series::Point;
use gpui::{Bounds, Hsla, Path, Pixels, Window, fill, point, px, size};

use crate::theme::{Theme, alpha};

/// A sample older than this (from the right edge) isn't extended to "now".
pub const STALE_MS: f64 = 2_500.0;

fn pt(x: f32, y: f32) -> gpui::Point<Pixels> {
    point(px(x), px(y))
}

const SOLID: (gpui::Point<f32>, gpui::Point<f32>, gpui::Point<f32>) =
    (gpui::Point { x: 0., y: 1. }, gpui::Point { x: 0., y: 1. }, gpui::Point { x: 0., y: 1. });

/// The line through `pts` as one path of triangles, `width` px wide.
fn stroke(pts: &[(f32, f32)], width: f32) -> Option<Path<Pixels>> {
    // Repeated points have no direction; they'd draw stray slivers at the joins.
    let mut uniq: Vec<(f32, f32)> = Vec::with_capacity(pts.len());
    for &p in pts {
        if uniq.last().is_none_or(|q: &(f32, f32)| (q.0 - p.0).abs() + (q.1 - p.1).abs() > 0.25) {
            uniq.push(p);
        }
    }
    let pts = uniq.as_slice();
    if pts.len() < 2 {
        return None;
    }
    let half = width / 2.0;
    let normal = |a: (f32, f32), b: (f32, f32)| {
        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
        let len = (dx * dx + dy * dy).sqrt().max(1e-6);
        (-dy / len, dx / len)
    };
    let side = |i: usize| {
        let n = if i == 0 {
            normal(pts[0], pts[1])
        } else if i == pts.len() - 1 {
            normal(pts[i - 1], pts[i])
        } else {
            let a = normal(pts[i - 1], pts[i]);
            let b = normal(pts[i], pts[i + 1]);
            let (mx, my) = (a.0 + b.0, a.1 + b.1);
            let len = (mx * mx + my * my).sqrt().max(1e-6);
            let m = (mx / len, my / len);
            // Cap the miter so sharp turns stay tidy.
            let k = (1.0 / (m.0 * a.0 + m.1 * a.1).max(0.5)).min(2.0);
            (m.0 * k, m.1 * k)
        };
        let p = pts[i];
        ((p.0 + n.0 * half, p.1 + n.1 * half), (p.0 - n.0 * half, p.1 - n.1 * half))
    };
    let (mut l0, mut r0) = side(0);
    let mut path = Path::new(pt(l0.0, l0.1));
    for i in 1..pts.len() {
        let (l1, r1) = side(i);
        path.push_triangle((pt(l0.0, l0.1), pt(r0.0, r0.1), pt(l1.0, l1.1)), SOLID);
        path.push_triangle((pt(r0.0, r0.1), pt(r1.0, r1.1), pt(l1.0, l1.1)), SOLID);
        (l0, r0) = (l1, r1);
    }
    Some(path)
}

/// The area between the line and `base`.
fn area(pts: &[(f32, f32)], base: f32) -> Option<Path<Pixels>> {
    if pts.len() < 2 {
        return None;
    }
    let mut path = Path::new(pt(pts[0].0, base));
    for w in pts.windows(2) {
        let (a, b) = (w[0], w[1]);
        path.push_triangle((pt(a.0, a.1), pt(b.0, b.1), pt(a.0, base)), SOLID);
        path.push_triangle((pt(b.0, b.1), pt(b.0, base), pt(a.0, base)), SOLID);
    }
    Some(path)
}

/// A round axis ceiling at or above `v` (1, 2, 5 × 10ⁿ).
pub fn nice_ceiling(v: f64) -> f64 {
    // Also catches NaN.
    if v.is_nan() || v <= 0.0 {
        return 10.0;
    }
    let mag = 10f64.powf(v.log10().floor());
    for step in [1.0, 2.0, 5.0, 10.0] {
        if v <= step * mag {
            return step * mag;
        }
    }
    10.0 * mag
}

/// The time span drawn: [now − window, now].
#[derive(Clone, Copy, Debug)]
pub struct Span {
    pub now: f64,
    pub window_ms: f64,
}

/// Output reported as one block when a call ends: `count` tokens over
/// [since, t]. Drawn at its average rate across the whole call.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Block {
    pub since: f64,
    pub t: f64,
    pub count: f64,
}

impl Block {
    pub fn rate(&self) -> f64 {
        self.count * 1000.0 / (self.t - self.since).max(100.0)
    }
}

/// What a line is drawn from.
#[derive(Clone, Debug)]
pub enum Series {
    /// Rate samples (streamed output, or rates the caller computes).
    Samples(Vec<Point>),
    /// Calls reported when they end: plateaus at each call's average rate.
    Blocks(Vec<Block>),
}

impl Series {
    pub fn peak(&self) -> f64 {
        match self {
            Series::Samples(s) => s.iter().map(|p| p.v).fold(0.0, f64::max),
            Series::Blocks(b) => b.iter().map(Block::rate).fold(0.0, f64::max),
        }
    }
}

/// Map a series in [now − window, now] to points in `bounds`. Samples hold
/// their last value to the right edge only while it's fresh.
fn project(series: &Series, span: Span, ceiling: f64, b: Bounds<Pixels>) -> Vec<(f32, f32)> {
    let Span { now, window_ms } = span;
    let (x0, y0) = (f32::from(b.origin.x), f32::from(b.origin.y));
    let (w, h) = (f32::from(b.size.width), f32::from(b.size.height));
    let from = now - window_ms;
    let x = |t: f64| x0 + ((t.max(from) - from) / window_ms) as f32 * w;
    let y = |v: f64| y0 + h - (v / ceiling).clamp(0.0, 1.0) as f32 * h;
    match series {
        Series::Samples(samples) => {
            let mut pts: Vec<(f32, f32)> = samples.iter().map(|s| (x(s.t), y(s.v))).collect();
            if let Some(last) = samples.last()
                && now - last.t < STALE_MS
            {
                pts.push((x(now), y(last.v)));
            }
            pts
        }
        Series::Blocks(blocks) => {
            let mut pts = vec![(x(from), y(0.0))];
            let mut prev_end = f64::NEG_INFINITY;
            // Blocks are in order of their end; an overlapping call starts where
            // the earlier one ended, and one wholly inside it adds nothing.
            for bl in blocks.iter().filter(|bl| bl.t >= from) {
                let start = bl.since.max(prev_end);
                if start >= bl.t {
                    continue;
                }
                let r = y(bl.rate());
                pts.extend([(x(start), y(0.0)), (x(start), r), (x(bl.t), r), (x(bl.t), y(0.0))]);
                prev_end = bl.t;
            }
            pts.push((x(now), y(0.0)));
            pts
        }
    }
}

/// The detail chart: gridlines, the area and the line.
pub fn paint_chart(
    window: &mut Window,
    b: Bounds<Pixels>,
    series: &Series,
    span: Span,
    ceiling: f64,
    color: Hsla,
    theme: &Theme,
) {
    let (x0, y0) = (f32::from(b.origin.x), f32::from(b.origin.y));
    let (w, h) = (f32::from(b.size.width), f32::from(b.size.height));
    for i in 0..=4 {
        let y = (y0 + h * i as f32 / 4.0).round();
        window.paint_quad(fill(Bounds::new(pt(x0, y), size(px(w), px(1.0))), theme.grid));
    }
    let pts = project(series, span, ceiling, b);
    if let Some(a) = area(&pts, y0 + h) {
        window.paint_path(a, alpha(color, if theme.dark { 0.16 } else { 0.10 }));
    }
    if let Some(l) = stroke(&pts, 1.75) {
        window.paint_path(l, color);
    }
}

/// A row's sparkline: the line only, scaled to its own peak.
pub fn paint_sparkline(window: &mut Window, b: Bounds<Pixels>, series: &Series, span: Span, color: Hsla) {
    let pts = project(series, span, nice_ceiling(series.peak().max(1.0)), b);
    if let Some(l) = stroke(&pts, 1.25) {
        window.paint_path(l, color);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn xs(series: &Series) -> Vec<f32> {
        let b = Bounds::new(point(px(0.), px(0.)), size(px(100.), px(100.)));
        project(series, Span { now: 100.0, window_ms: 100.0 }, 10.0, b).iter().map(|p| p.0).collect()
    }

    #[test]
    fn blocks_never_fold_back() {
        // Ordered by end; the second overlaps the first, the third lies inside it.
        let blocks = vec![
            Block { since: 10.0, t: 40.0, count: 1.0 },
            Block { since: 20.0, t: 60.0, count: 1.0 },
            Block { since: 45.0, t: 55.0, count: 1.0 },
        ];
        let x = xs(&Series::Blocks(blocks));
        assert!(x.windows(2).all(|w| w[1] >= w[0]), "x went backwards: {x:?}");
    }

    #[test]
    fn ceilings_are_round() {
        assert_eq!(nice_ceiling(0.0), 10.0);
        assert_eq!(nice_ceiling(3.2), 5.0);
        assert_eq!(nice_ceiling(18.0), 20.0);
        assert_eq!(nice_ceiling(51.0), 100.0);
        assert_eq!(nice_ceiling(100.0), 100.0);
    }
}

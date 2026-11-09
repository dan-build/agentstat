//! The token-rate chart, drawn like the npm component: a monotone cubic through
//! the samples (it never overshoots, so a peak shows at its true height), a
//! fill that fades to nothing, a line that fades in from the left, and a dot
//! with a soft halo at "now" for agents that are reporting. Lines are triangle
//! strips (no general tessellator, measured faster on the oldest Mac we support).

use std::rc::Rc;

use agentstat_core::series::Point;
use gpui::{
    Background, Bounds, Corners, Hsla, Path, Pixels, Window, fill, linear_color_stop, linear_gradient, point, px, quad,
    size, transparent_black,
};

use crate::theme::{Theme, alpha};

/// A sample older than this (from the right edge) isn't extended to "now".
pub const STALE_MS: f64 = 2_500.0;

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

    /// The value at `t`: the call in progress then (0 between calls), or the
    /// samples around it interpolated. None where nothing is drawn: outside the
    /// data, or across a gap the line doesn't bridge.
    pub fn value_at(&self, t: f64) -> Option<f64> {
        match self {
            Series::Blocks(b) => Some(b.iter().find(|bl| bl.since <= t && t <= bl.t).map_or(0.0, Block::rate)),
            Series::Samples(s) => {
                let i = s.partition_point(|p| p.t < t);
                match (i.checked_sub(1).and_then(|j| s.get(j)), s.get(i)) {
                    (Some(a), Some(b)) if b.t - a.t <= STALE_MS => {
                        let k = if b.t > a.t { (t - a.t) / (b.t - a.t) } else { 0.0 };
                        Some(a.v + (b.v - a.v) * k)
                    }
                    (None, Some(b)) if b.t == t => Some(b.v),
                    (Some(a), None) if t - a.t <= STALE_MS => Some(a.v),
                    _ => None,
                }
            }
        }
    }
}

/// One agent's line on the chart.
pub struct Layer {
    pub series: Rc<Series>,
    pub color: Hsla,
    /// The selected agent: drawn last and at full strength.
    pub emphasis: bool,
}

/// What the chart draws besides the lines.
pub struct Overlay {
    /// The hovered time, if the pointer is over the chart.
    pub hover_t: Option<f64>,
    /// 0–1 breathing of the live halo (constant when motion is reduced).
    pub pulse: f32,
}

type Pt = (f32, f32);

fn pt(p: Pt) -> gpui::Point<Pixels> {
    point(px(p.0), px(p.1))
}

const SOLID: (gpui::Point<f32>, gpui::Point<f32>, gpui::Point<f32>) =
    (gpui::Point { x: 0., y: 1. }, gpui::Point { x: 0., y: 1. }, gpui::Point { x: 0., y: 1. });

/// The line through `pts` as one path of triangles, `width` px wide.
fn stroke(pts: &[Pt], width: f32) -> Option<Path<Pixels>> {
    // Repeated points have no direction; they'd draw stray slivers at the joins.
    let mut uniq: Vec<Pt> = Vec::with_capacity(pts.len());
    for &p in pts {
        if uniq.last().is_none_or(|q| (q.0 - p.0).abs() + (q.1 - p.1).abs() > 0.25) {
            uniq.push(p);
        }
    }
    let pts = uniq.as_slice();
    if pts.len() < 2 {
        return None;
    }
    let half = width / 2.0;
    let normal = |a: Pt, b: Pt| {
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
    let mut path = Path::new(pt(l0));
    for i in 1..pts.len() {
        let (l1, r1) = side(i);
        path.push_triangle((pt(l0), pt(r0), pt(l1)), SOLID);
        path.push_triangle((pt(r0), pt(r1), pt(l1)), SOLID);
        (l0, r0) = (l1, r1);
    }
    Some(path)
}

/// The area between the line and `base`.
fn area(pts: &[Pt], base: f32) -> Option<Path<Pixels>> {
    if pts.len() < 2 {
        return None;
    }
    let mut path = Path::new(pt((pts[0].0, base)));
    for w in pts.windows(2) {
        let (a, b) = (w[0], w[1]);
        path.push_triangle((pt(a), pt(b), pt((a.0, base))), SOLID);
        path.push_triangle((pt(b), pt((b.0, base)), pt((a.0, base))), SOLID);
    }
    Some(path)
}

/// Tangents of the monotone cubic through `p` (Steffen): one-sided at the ends
/// and beside a vertical step, 0 at extrema, never more than twice the smaller
/// neighbouring slope, so every segment stays within its two samples.
fn tangents(p: &[Pt]) -> Vec<f32> {
    let n = p.len();
    let mut m = vec![0.0; n];
    if n < 2 {
        return m;
    }
    let h: Vec<f32> = (0..n - 1).map(|i| p[i + 1].0 - p[i].0).collect();
    let d: Vec<f32> = (0..n - 1).map(|i| if h[i] > 0.0 { (p[i + 1].1 - p[i].1) / h[i] } else { 0.0 }).collect();
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for i in 1..n - 1 {
        m[i] = if h[i - 1] <= 0.0 {
            d[i]
        } else if h[i] <= 0.0 {
            d[i - 1]
        } else if d[i - 1] * d[i] <= 0.0 {
            0.0
        } else {
            let q = (d[i - 1] * h[i] + d[i] * h[i - 1]) / (h[i - 1] + h[i]);
            d[i].signum() * 2.0 * d[i - 1].abs().min(d[i].abs()).min(0.5 * q.abs())
        };
    }
    m
}

/// The monotone cubic through `p`, flattened to points about 2 px apart.
fn smooth(p: &[Pt]) -> Vec<Pt> {
    if p.len() < 3 {
        return p.to_vec();
    }
    let m = tangents(p);
    let mut out = vec![p[0]];
    for i in 0..p.len() - 1 {
        let (a, b) = (p[i], p[i + 1]);
        let w = b.0 - a.0;
        if w <= 0.0 {
            out.push(b);
            continue;
        }
        let k = w / 3.0;
        let (c1, c2) = ((a.0 + k, a.1 + m[i] * k), (b.0 - k, b.1 - m[i + 1] * k));
        let steps = (w / 2.0).ceil().clamp(1.0, 32.0) as usize;
        for s in 1..=steps {
            let t = s as f32 / steps as f32;
            let u = 1.0 - t;
            let (w0, w1, w2, w3) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
            out.push((w0 * a.0 + w1 * c1.0 + w2 * c2.0 + w3 * b.0, w0 * a.1 + w1 * c1.1 + w2 * c2.1 + w3 * b.1));
        }
    }
    out
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

/// Map a series in [now − window, now] to points in `bounds`. Samples become a
/// smooth curve held to the right edge only while fresh; blocks keep their
/// true shape. Returns the points and whether the line is live.
fn project(series: &Series, span: Span, ceiling: f64, b: Bounds<Pixels>) -> (Vec<Pt>, bool) {
    let Span { now, window_ms } = span;
    let (x0, y0) = (f32::from(b.origin.x), f32::from(b.origin.y));
    let (w, h) = (f32::from(b.size.width), f32::from(b.size.height));
    let from = now - window_ms;
    // Inside the chart only: nothing left of its start or right of "now" (data
    // newer than a paused view's "now" isn't part of it).
    let x = |t: f64| x0 + ((t.clamp(from, now) - from) / window_ms) as f32 * w;
    let y = |v: f64| y0 + h - (v / ceiling).clamp(0.0, 1.0) as f32 * h;
    match series {
        Series::Samples(all) => {
            let samples = &all[..all.partition_point(|p| p.t <= now)];
            let mut pts: Vec<Pt> = samples.iter().map(|s| (x(s.t), y(s.v))).collect();
            let live = samples.last().is_some_and(|l| (0.0..STALE_MS).contains(&(now - l.t)));
            if let Some(last) = samples.last()
                && live
            {
                pts.push((x(now), y(last.v)));
            }
            (smooth(&pts), live)
        }
        Series::Blocks(blocks) => {
            let mut pts = vec![(x(from), y(0.0))];
            let mut prev_end = f64::NEG_INFINITY;
            // Blocks are in order of their end; an overlapping call starts where
            // the earlier one ended, and one wholly inside it adds nothing.
            for bl in blocks.iter().filter(|bl| bl.t >= from && bl.t <= now) {
                let start = bl.since.max(prev_end);
                if start >= bl.t {
                    continue;
                }
                let r = y(bl.rate());
                pts.extend([(x(start), y(0.0)), (x(start), r), (x(bl.t), r), (x(bl.t), y(0.0))]);
                prev_end = bl.t;
            }
            pts.push((x(now), y(0.0)));
            // Per-call data is never live at the edge: a call is known once it ended.
            (pts, false)
        }
    }
}

/// A filled circle.
fn dot(window: &mut Window, c: Pt, r: f32, color: Hsla) {
    let b = Bounds::new(point(px(c.0 - r), px(c.1 - r)), size(px(2.0 * r), px(2.0 * r)));
    window.paint_quad(quad(b, Corners::all(px(r)), color, px(0.0), transparent_black(), Default::default()));
}

/// Split a line at `x` (interpolating the crossing), for a gradient in two parts.
fn split_at(pts: &[Pt], x: f32) -> (Vec<Pt>, Vec<Pt>) {
    let mut left = Vec::new();
    let mut right = Vec::new();
    for (i, &p) in pts.iter().enumerate() {
        if p.0 <= x {
            left.push(p);
        } else {
            if right.is_empty() && i > 0 && pts[i - 1].0 <= x {
                let a = pts[i - 1];
                let k = (x - a.0) / (p.0 - a.0);
                let mid = (x, a.1 + (p.1 - a.1) * k);
                left.push(mid);
                right.push(mid);
            }
            right.push(p);
        }
    }
    (left, right)
}

fn gradient(angle: f32, from: Hsla, to: Hsla) -> Background {
    linear_gradient(angle, linear_color_stop(from, 0.0), linear_color_stop(to, 1.0))
}

/// The line's height at `x`, read off the drawn points.
fn y_on(pts: &[Pt], x: f32) -> Option<f32> {
    let i = pts.partition_point(|p| p.0 < x);
    let b = pts.get(i)?;
    let a = if i > 0 { pts[i - 1] } else { *b };
    let k = if b.0 > a.0 { (x - a.0) / (b.0 - a.0) } else { 1.0 };
    Some(a.1 + (b.1 - a.1) * k)
}

/// The detail chart: gridlines, every agent's fill and line (the selected one
/// last and strongest), live tips, and the hover cursor.
pub fn paint_chart(
    window: &mut Window,
    b: Bounds<Pixels>,
    layers: &[Layer],
    span: Span,
    ceiling: f64,
    theme: &Theme,
    overlay: &Overlay,
) {
    let (x0, y0) = (f32::from(b.origin.x), f32::from(b.origin.y));
    let (w, h) = (f32::from(b.size.width), f32::from(b.size.height));
    for i in 0..=4 {
        let y = (y0 + h * i as f32 / 4.0).round();
        window.paint_quad(fill(Bounds::new(point(px(x0), px(y)), size(px(w), px(1.0))), theme.grid));
    }
    // Fills stack where lines overlap, so they thin out as agents are added.
    let stack = (layers.len().max(1) as f32).sqrt();
    let mut ordered: Vec<&Layer> = layers.iter().filter(|l| !l.emphasis).collect();
    ordered.extend(layers.iter().filter(|l| l.emphasis));
    let mut tips = Vec::new();
    let mut selected_pts = Vec::new();
    for layer in ordered {
        let strength = if layer.emphasis { 1.0 } else { 0.45 };
        let (pts, live) = project(&layer.series, span, ceiling, b);
        let top = if theme.dark { 0.20 } else { 0.12 } / stack * strength;
        if let Some(a) = area(&pts, y0 + h) {
            window.paint_path(a, gradient(180.0, alpha(layer.color, top), alpha(layer.color, 0.0)));
        }
        // The line fades in from the left edge: 0.15 → 0.75 over the first 22%, then to full.
        let (left, right) = split_at(&pts, x0 + 0.22 * w);
        let c = |a: f32| alpha(layer.color, a * strength);
        if let Some(l) = stroke(&left, 1.75) {
            window.paint_path(l, gradient(90.0, c(0.15), c(0.75)));
        }
        if let Some(l) = stroke(&right, 1.75) {
            window.paint_path(l, gradient(90.0, c(0.75), c(1.0)));
        }
        if live && let Some(&tip) = pts.last() {
            tips.push((tip, layer.color, strength));
        }
        if layer.emphasis {
            selected_pts = pts;
        }
    }
    // Live dots: a soft halo that breathes (still when motion is reduced), a
    // colored core and a background-colored pip for a crisp eye.
    for (tip, color, strength) in tips {
        let p = overlay.pulse;
        dot(window, tip, 7.0 + 2.0 * p, alpha(color, (0.10 + 0.06 * p) * strength));
        dot(window, tip, 4.5, alpha(color, 0.22 * strength));
        dot(window, tip, 2.75, alpha(color, strength));
        dot(window, tip, 1.0, theme.bg.into());
    }
    // Hover: a hairline at the inspected time and a dot on the selected line.
    if let Some(t) = overlay.hover_t {
        let x = x0 + ((t - (span.now - span.window_ms)) / span.window_ms) as f32 * w;
        window.paint_quad(fill(Bounds::new(point(px(x.round()), px(y0)), size(px(1.0), px(h))), theme.cursor));
        // On the drawn line itself, and only where there is one.
        if let Some(sel) = layers.iter().find(|l| l.emphasis)
            && sel.series.value_at(t).is_some()
            && let Some(y) = y_on(&selected_pts, x)
        {
            dot(window, (x, y), 4.0, theme.bg.into());
            dot(window, (x, y), 3.0, sel.color);
        }
    }
}

/// A row's sparkline: the line only, scaled to its own peak.
pub fn paint_sparkline(window: &mut Window, b: Bounds<Pixels>, series: &Series, span: Span, color: Hsla) {
    // (Shares `project` with the chart, so it obeys the same edges.)
    let (pts, _) = project(series, span, nice_ceiling(series.peak().max(1.0)), b);
    if let Some(l) = stroke(&pts, 1.25) {
        window.paint_path(l, color);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn xs(series: &Series) -> Vec<f32> {
        let b = Bounds::new(point(px(0.), px(0.)), size(px(100.), px(100.)));
        project(series, Span { now: 100.0, window_ms: 100.0 }, 10.0, b).0.iter().map(|p| p.0).collect()
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
    fn the_curve_never_overshoots_its_samples() {
        // A dip between flats: a plain cubic would undershoot 0 and overshoot 50.
        let p = [(0.0, 50.0), (10.0, 50.0), (20.0, 0.0), (30.0, 50.0), (40.0, 50.0)];
        let s = smooth(&p);
        // A thousandth of a pixel allows for f32 rounding, not for overshoot.
        assert!(s.iter().all(|q| (-1e-3..=50.0 + 1e-3).contains(&q.1)), "overshoot: {s:?}");
        assert!(s.windows(2).all(|w| w[1].0 >= w[0].0));
    }

    #[test]
    fn a_paused_view_never_draws_past_now() {
        // Data that arrived after the view's "now" is not drawn (and nothing folds back).
        let samples: Vec<Point> = (0..20).map(|i| Point { t: i as f64 * 10.0, v: 5.0 }).collect();
        let b = Bounds::new(point(px(0.), px(0.)), size(px(100.), px(100.)));
        let (pts, live) = project(&Series::Samples(samples), Span { now: 100.0, window_ms: 100.0 }, 10.0, b);
        assert!(pts.iter().all(|p| p.0 <= 100.0));
        assert!(pts.windows(2).all(|w| w[1].0 >= w[0].0));
        assert!(live);
    }

    #[test]
    fn hover_values_exist_only_where_a_line_is_drawn() {
        let s = Series::Samples(vec![Point { t: 0.0, v: 0.0 }, Point { t: 1000.0, v: 10.0 }]);
        assert_eq!(s.value_at(500.0), Some(5.0));
        assert_eq!(s.value_at(-1.0), None);
        assert_eq!(s.value_at(1000.0 + STALE_MS + 1.0), None);
        let gap = Series::Samples(vec![Point { t: 0.0, v: 3.0 }, Point { t: 10_000.0, v: 3.0 }]);
        assert_eq!(gap.value_at(5_000.0), None);
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

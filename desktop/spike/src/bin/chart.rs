//! Spike: can GPUI draw a live multi-agent chart smoothly on the oldest Mac we support?
//!
//! Env: SERIES (50), POINTS per series (600 = 30 s at 20 Hz), MODE ("frames" redraws every
//! display frame, the worst case; "data" redraws only when samples arrive at 20 Hz), SECS (20), STROKE ("custom" strip, or "lyon" for GPUI's general stroker).
//! Prints frame pacing, paint cost and process CPU, then quits.

use std::{
    cell::RefCell,
    collections::VecDeque,
    rc::Rc,
    time::{Duration, Instant},
};

use gpui::{
    App, Application, Bounds, Context, Hsla, Path, PathBuilder, Pixels, Point, Window, WindowBounds, WindowOptions, canvas, div,
    fill, point, prelude::*, px, rgb, size,
};

const PALETTE: [u32; 8] = [0x2563eb, 0xd9480f, 0x0f8a5f, 0xc2255c, 0x7048e8, 0x0b7285, 0xa16207, 0x3f3f46];

/// A polyline as a triangle strip with mitered joins: one pair of vertices per point, so
/// joins have no gaps and no overlap. Pure arithmetic; no general tessellator.
fn stroke_strip(pts: &[(f32, f32)], width: f32) -> Option<Path<Pixels>> {
    let mut path = None;
    append_strip(&mut path, pts, width);
    path
}

/// Appends a strip to `path` (created on first use), so several lines can share one path.
fn append_strip(path: &mut Option<Path<Pixels>>, pts: &[(f32, f32)], width: f32) {
    if pts.len() < 2 {
        return;
    }
    let half = width / 2.0;
    let unit_normal = |a: (f32, f32), b: (f32, f32)| {
        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
        let len = (dx * dx + dy * dy).sqrt().max(1e-6);
        (-dy / len, dx / len)
    };
    let side = |i: usize| -> ((f32, f32), (f32, f32)) {
        let n = if i == 0 {
            unit_normal(pts[0], pts[1])
        } else if i == pts.len() - 1 {
            unit_normal(pts[i - 1], pts[i])
        } else {
            let a = unit_normal(pts[i - 1], pts[i]);
            let b = unit_normal(pts[i], pts[i + 1]);
            let (mx, my) = (a.0 + b.0, a.1 + b.1);
            let len = (mx * mx + my * my).sqrt().max(1e-6);
            let m = (mx / len, my / len);
            // Miter length grows as the turn sharpens; cap it so spikes stay tidy.
            let scale = (1.0 / (m.0 * a.0 + m.1 * a.1).max(0.5)).min(2.0);
            (m.0 * scale, m.1 * scale)
        };
        let p = pts[i];
        ((p.0 + n.0 * half, p.1 + n.1 * half), (p.0 - n.0 * half, p.1 - n.1 * half))
    };
    let pt = |p: (f32, f32)| -> Point<Pixels> { point(px(p.0), px(p.1)) };
    let solid = (point(0., 1.), point(0., 1.), point(0., 1.));
    let (mut l0, mut r0) = side(0);
    let path = path.get_or_insert_with(|| Path::new(pt(l0)));
    for i in 1..pts.len() {
        let (l1, r1) = side(i);
        path.push_triangle((pt(l0), pt(r0), pt(l1)), solid);
        path.push_triangle((pt(r0), pt(r1), pt(l1)), solid);
        (l0, r0) = (l1, r1);
    }
}

fn env(name: &str, default: usize) -> usize {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// Tiny xorshift so the spike has no dependencies besides GPUI.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 40) as f32 / (1u64 << 24) as f32
    }
}

#[derive(Default)]
struct Stats {
    frames: Vec<Instant>,
    paint: Vec<Duration>,
}

struct Chart {
    series: Vec<VecDeque<f32>>,
    capacity: usize,
    rng: Rng,
    every_frame: bool,
    stats: Rc<RefCell<Stats>>,
}

impl Chart {
    fn new(cx: &mut Context<Self>) -> Self {
        let n = env("SERIES", 50);
        let capacity = env("POINTS", 600);
        let mut rng = Rng(0x9e3779b97f4a7c15);
        let series = (0..n)
            .map(|_| {
                let mut s = VecDeque::with_capacity(capacity);
                let mut v = 20.0 + rng.next() * 20.0;
                for _ in 0..capacity {
                    v = (v + (rng.next() - 0.5) * 3.0).clamp(0.0, 50.0);
                    s.push_back(v);
                }
                s
            })
            .collect();

        // Samples arrive at 20 Hz, like a busy fleet.
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(50)).await;
                if this.update(cx, |chart, cx| chart.tick(cx)).is_err() {
                    break;
                }
            }
        })
        .detach();

        Self {
            series,
            capacity,
            rng,
            every_frame: std::env::var("MODE").as_deref() != Ok("data"),
            stats: Rc::default(),
        }
    }

    fn tick(&mut self, cx: &mut Context<Self>) {
        for s in &mut self.series {
            let last = *s.back().unwrap_or(&25.0);
            if s.len() == self.capacity {
                s.pop_front();
            }
            s.push_back((last + (self.rng.next() - 0.5) * 3.0).clamp(0.0, 50.0));
        }
        if !self.every_frame {
            cx.notify();
        }
    }
}

impl Render for Chart {
    fn render(&mut self, window: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        if self.every_frame {
            window.request_animation_frame();
        }
        self.stats.borrow_mut().frames.push(Instant::now());

        // Snapshot for the paint closure (the cost of copying is part of what we measure).
        let series: Vec<Vec<f32>> = self.series.iter().map(|s| s.iter().copied().collect()).collect();
        let stats = self.stats.clone();
        let custom = std::env::var("STROKE").as_deref() != Ok("lyon");
        let grouped = std::env::var("GROUP").as_deref() == Ok("1");

        div().size_full().bg(rgb(0xfcfbf8)).p_6().child(
            canvas(
                |_, _, _| {},
                move |bounds: Bounds<Pixels>, _, window, _| {
                    let t0 = Instant::now();
                    let x0 = f32::from(bounds.origin.x);
                    let y0 = f32::from(bounds.origin.y);
                    let w = f32::from(bounds.size.width);
                    let h = f32::from(bounds.size.height);

                    // Gridlines.
                    for i in 0..=4 {
                        let y = y0 + h * i as f32 / 4.0;
                        window.paint_quad(fill(
                            Bounds::new(point(px(x0), px(y)), size(px(w), px(1.))),
                            rgb(0xe8e6e1),
                        ));
                    }

                    if grouped {
                        // One path per color: far less atlas area for the GPU to rasterize.
                        let mut paths: Vec<Option<Path<Pixels>>> = (0..PALETTE.len()).map(|_| None).collect();
                        for (i, s) in series.iter().enumerate() {
                            let step = w / (s.len().max(2) - 1) as f32;
                            let pts: Vec<(f32, f32)> = s
                                .iter()
                                .enumerate()
                                .map(|(j, v)| (x0 + j as f32 * step, y0 + h - v / 50.0 * h))
                                .collect();
                            append_strip(&mut paths[i % PALETTE.len()], &pts, 1.5);
                        }
                        for (c, path) in paths.into_iter().enumerate() {
                            if let Some(path) = path {
                                window.paint_path(path, Hsla::from(rgb(PALETTE[c])));
                            }
                        }
                        stats.borrow_mut().paint.push(t0.elapsed());
                        return;
                    }
                    for (i, s) in series.iter().enumerate() {
                        if s.len() < 2 {
                            continue;
                        }
                        let step = w / (s.len() - 1) as f32;
                        let color: Hsla = rgb(PALETTE[i % PALETTE.len()]).into();
                        if custom {
                            let pts: Vec<(f32, f32)> = s
                                .iter()
                                .enumerate()
                                .map(|(j, v)| (x0 + j as f32 * step, y0 + h - v / 50.0 * h))
                                .collect();
                            if let Some(path) = stroke_strip(&pts, 1.5) {
                                window.paint_path(path, color);
                            }
                            continue;
                        }
                        let mut b = PathBuilder::stroke(px(1.5));
                        for (j, v) in s.iter().enumerate() {
                            let p = point(px(x0 + j as f32 * step), px(y0 + h - v / 50.0 * h));
                            if j == 0 { b.move_to(p) } else { b.line_to(p) }
                        }
                        if let Ok(path) = b.build() {
                            window.paint_path(path, color);
                        }
                    }
                    stats.borrow_mut().paint.push(t0.elapsed());
                },
            )
            .size_full(),
        )
    }
}

fn cpu_seconds() -> f64 {
    let mut u: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut u) };
    let tv = |t: libc::timeval| t.tv_sec as f64 + t.tv_usec as f64 / 1e6;
    tv(u.ru_utime) + tv(u.ru_stime)
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    sorted[((sorted.len() - 1) as f64 * p).round() as usize]
}

fn report(stats: &Stats, wall: f64, cpu: f64) {
    // Skip the first second (window creation, shader compilation).
    let start = stats.frames.first().copied();
    let frames: Vec<Instant> = stats
        .frames
        .iter()
        .copied()
        .filter(|t| start.is_some_and(|s| t.duration_since(s) > Duration::from_secs(1)))
        .collect();
    let mut gaps: Vec<f64> = frames.windows(2).map(|w| (w[1] - w[0]).as_secs_f64() * 1e3).collect();
    gaps.sort_by(f64::total_cmp);
    let skip = stats.paint.len().saturating_sub(frames.len());
    let mut paint: Vec<f64> = stats.paint[skip..].iter().map(|d| d.as_secs_f64() * 1e3).collect();
    paint.sort_by(f64::total_cmp);
    let span = frames.last().zip(frames.first()).map(|(a, b)| (*a - *b).as_secs_f64()).unwrap_or(1.0);
    println!(
        "series={} points={} mode={} stroke={} | fps={:.1} gap p50={:.1}ms p95={:.1}ms max={:.1}ms | paint p50={:.2}ms p95={:.2}ms | cpu={:.0}% of one core",
        env("SERIES", 50),
        env("POINTS", 600),
        std::env::var("MODE").unwrap_or_else(|_| "frames".into()),
        std::env::var("STROKE").unwrap_or_else(|_| "custom".into()),
        frames.len().saturating_sub(1) as f64 / span,
        percentile(&gaps, 0.5),
        percentile(&gaps, 0.95),
        gaps.last().copied().unwrap_or(0.0),
        percentile(&paint, 0.5),
        percentile(&paint, 0.95),
        cpu / wall * 100.0,
    );
}

fn main() {
    let secs = env("SECS", 20) as u64;
    Application::new().run(move |cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(1100.), px(640.)), cx);
        let window = cx
            .open_window(
                WindowOptions { window_bounds: Some(WindowBounds::Windowed(bounds)), focus: true, ..Default::default() },
                |_, cx| cx.new(Chart::new),
            )
            .unwrap();
        cx.activate(true);

        let started = Instant::now();
        let cpu0 = cpu_seconds();
        cx.spawn(async move |cx| {
            cx.background_executor().timer(Duration::from_secs(secs)).await;
            let wall = started.elapsed().as_secs_f64();
            let cpu = cpu_seconds() - cpu0;
            window
                .update(cx, |chart, _, _| report(&chart.stats.borrow(), wall, cpu))
                .ok();
            cx.update(|cx| cx.quit()).ok();
        })
        .detach();
    });
}

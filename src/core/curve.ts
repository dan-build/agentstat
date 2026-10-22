// src/core/curve.ts — line shaping helpers for the renderer.

import type { TSPoint } from '../timeseries';

/**
 * Display-only exponential moving average over a point series. Returns a new
 * array; never mutates input. 0 returns the input unchanged.
 */
export const emaPoints = (pts: TSPoint[], factor: number): TSPoint[] => {
  if (!(factor > 0) || pts.length === 0) return pts;
  const a = Math.min(0.95, factor);
  const out = new Array<TSPoint>(pts.length);
  let prev = pts[0].v;
  out[0] = pts[0];
  for (let i = 1; i < pts.length; i++) {
    prev = prev * a + pts[i].v * (1 - a);
    out[i] = { t: pts[i].t, v: prev };
  }
  return out;
};

/**
 * Round an upper bound up to a "nice" axis maximum (1/2/5 × 10ⁿ), at least
 * `floor`. Non-finite input falls back to `floor`.
 */
export const niceMax = (raw: number, floor = 10): number => {
  const v = Number.isFinite(raw) ? Math.max(raw, floor) : floor;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const frac = v / base;
  const niceFrac = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return niceFrac * base;
};

/**
 * Build (don't stroke) a smooth path through `points` that never overshoots:
 * a monotone cubic (Steffen, 1990). Between two samples the curve stays within
 * their range, so a peak is drawn at its true height, a fall to zero never dips
 * below it, and time never runs backwards. Shared by the stroked line and the
 * area fill so both follow the identical curve. Points must be sorted by x;
 * equal x (simultaneous samples) is drawn as a vertical step.
 */
export const splinePath = (ctx: CanvasRenderingContext2D, points: { x: number; y: number }[]) => {
  const n = points.length;
  if (n < 2) return;
  // Segment widths and slopes; a zero-width segment has slope 0.
  const h = new Array<number>(n - 1);
  const d = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = points[i + 1].x - points[i].x;
    d[i] = h[i] > 0 ? (points[i + 1].y - points[i].y) / h[i] : 0;
  }
  // Tangents: one-sided at the ends, Steffen's limited average inside. A
  // tangent is 0 at local extrema and never more than twice the smaller
  // neighbouring slope, which keeps every segment monotone.
  const m = new Array<number>(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    const hs = h[i - 1] + h[i];
    if (!(hs > 0) || d[i - 1] * d[i] <= 0) {
      m[i] = 0;
      continue;
    }
    const p = (d[i - 1] * h[i] + d[i] * h[i - 1]) / hs;
    m[i] = Math.sign(d[i]) * 2 * Math.min(Math.abs(d[i - 1]), Math.abs(d[i]), 0.5 * Math.abs(p));
  }
  for (let i = 0; i < n - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (!(h[i] > 0)) {
      ctx.lineTo(b.x, b.y);
      continue;
    }
    const k = h[i] / 3;
    ctx.bezierCurveTo(a.x + k, a.y + m[i] * k, b.x - k, b.y - m[i + 1] * k, b.x, b.y);
  }
};

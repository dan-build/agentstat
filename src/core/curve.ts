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

// Scratch storage reused across calls (the renderer draws hundreds of curves
// per second); grown on demand, never shrunk.
let scratchH = new Float64Array(0);
let scratchD = new Float64Array(0);
let scratchM = new Float64Array(0);

/**
 * Tangents of the monotone cubic through `points` (Steffen, 1990): one-sided at
 * the ends and next to a vertical step, 0 at local extrema, and never more than
 * twice the smaller neighbouring slope, which keeps every segment monotone.
 *
 * Returns shared scratch storage, valid until the next call; pass it straight
 * to `splinePath` (e.g. once for the fill and once for the stroke).
 */
export const splineTangents = (points: { x: number; y: number }[]): Float64Array => {
  const n = points.length;
  if (scratchM.length < n) {
    const size = Math.max(n, scratchM.length * 2, 64);
    scratchH = new Float64Array(size);
    scratchD = new Float64Array(size);
    scratchM = new Float64Array(size);
  }
  const h = scratchH;
  const d = scratchD;
  const m = scratchM;
  if (n < 2) return m;
  // Segment widths and slopes; a zero-width segment (a vertical step) has slope 0.
  for (let i = 0; i < n - 1; i++) {
    h[i] = points[i + 1].x - points[i].x;
    d[i] = h[i] > 0 ? (points[i + 1].y - points[i].y) / h[i] : 0;
  }
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (!(h[i - 1] > 0)) m[i] = d[i]; // after a vertical step: one-sided
    else if (!(h[i] > 0)) m[i] = d[i - 1]; // before one: one-sided
    else if (d[i - 1] * d[i] <= 0) m[i] = 0; // local extremum or flat
    else {
      const p = (d[i - 1] * h[i] + d[i] * h[i - 1]) / (h[i - 1] + h[i]);
      m[i] = Math.sign(d[i]) * 2 * Math.min(Math.abs(d[i - 1]), Math.abs(d[i]), 0.5 * Math.abs(p));
    }
  }
  return m;
};

/**
 * Build (don't stroke) a smooth path through `points` that never overshoots:
 * a monotone cubic. Between two samples the curve stays within their range, so
 * a peak is drawn at its true height, a fall to zero never dips below it, and
 * time never runs backwards. Points must be sorted by x; equal x
 * (simultaneous samples) is drawn as a vertical step. Pass `tangents` from
 * `splineTangents` to reuse them across several paths through the same points.
 */
export const splinePath = (
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
  tangents: Float64Array = splineTangents(points)
) => {
  const m = tangents;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const w = b.x - a.x;
    if (!(w > 0)) {
      ctx.lineTo(b.x, b.y);
      continue;
    }
    const k = w / 3;
    ctx.bezierCurveTo(a.x + k, a.y + m[i] * k, b.x - k, b.y - m[i + 1] * k, b.x, b.y);
  }
};

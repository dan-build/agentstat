// src/core/curve.ts — line shaping helpers for the renderer.

import type { TSPoint } from '../timeseries';
import { clamp } from './constants';

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
 * Build (don't stroke) a Catmull-Rom path through `points`. Shared by the
 * stroked line and the area fill so both follow the identical curve. Control
 * points are clamped to each segment's span to prevent loops.
 */
export const splinePath = (
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
  tension = 0.4
) => {
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const c1x = p1.x + ((p2.x - p0.x) * tension) / 3;
    let c1y = p1.y + ((p2.y - p0.y) * tension) / 3;
    const c2x = p2.x - ((p3.x - p1.x) * tension) / 3;
    let c2y = p2.y - ((p3.y - p1.y) * tension) / 3;
    const loY = Math.min(p1.y, p2.y);
    const hiY = Math.max(p1.y, p2.y);
    const slack = (hiY - loY) * 0.5 + 0.01;
    c1y = clamp(c1y, loY - slack, hiY + slack);
    c2y = clamp(c2y, loY - slack, hiY + slack);
    ctx.bezierCurveTo(clamp(c1x, p1.x, p2.x), c1y, clamp(c2x, p1.x, p2.x), c2y, p2.x, p2.y);
  }
};

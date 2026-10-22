// The drawn line must not invent values: between two samples the curve stays
// within their range (no overshoot past a peak, no dip below zero) and never
// runs backwards in time.
import { describe, it, expect } from 'vitest';
import { splinePath } from '../src/core/curve';
import { mulberry32 } from '../src/simulator';

type Pt = { x: number; y: number };
type Seg = { p0: Pt; c1: Pt; c2: Pt; p1: Pt };

/** Run splinePath and collect the cubic segments it emits. */
function segments(points: Pt[]): Seg[] {
  const segs: Seg[] = [];
  let cur = points[0];
  const ctx = {
    bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number) {
      segs.push({ p0: cur, c1: { x: c1x, y: c1y }, c2: { x: c2x, y: c2y }, p1: { x, y } });
      cur = { x, y };
    },
    lineTo(x: number, y: number) {
      segs.push({ p0: cur, c1: cur, c2: { x, y }, p1: { x, y } });
      cur = { x, y };
    },
  } as unknown as CanvasRenderingContext2D;
  splinePath(ctx, points);
  return segs;
}

const bez = (a: number, b: number, c: number, d: number, t: number) =>
  (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * d;

/** Largest overshoot (px) past the segment endpoints' range, and any backwards x. */
function violations(points: Pt[]) {
  let overshoot = 0;
  let backwards = 0;
  const segs = segments(points);
  expect(segs).toHaveLength(points.length - 1);
  for (const s of segs) {
    const lo = Math.min(s.p0.y, s.p1.y);
    const hi = Math.max(s.p0.y, s.p1.y);
    let prevX = s.p0.x;
    for (let i = 1; i <= 64; i++) {
      const t = i / 64;
      const x = bez(s.p0.x, s.c1.x, s.c2.x, s.p1.x, t);
      const y = bez(s.p0.y, s.c1.y, s.c2.y, s.p1.y, t);
      overshoot = Math.max(overshoot, lo - y, y - hi);
      backwards = Math.max(backwards, prevX - x);
      prevX = x;
    }
  }
  return { overshoot, backwards };
}

describe('drawn curve', () => {
  it('does not overshoot a peak (progress 0 → 90 → 100 → 80 must not draw above 100%)', () => {
    // y grows downward on canvas: 100% is y = 0.
    const pts = [0, 90, 100, 80].map((v, i) => ({ x: i * 40, y: 100 - v }));
    expect(violations(pts).overshoot).toBeLessThan(1e-9);
  });

  it('does not dip below zero after a fall to zero', () => {
    const pts = [20, 18, 0, 0, 0, 12].map((v, i) => ({ x: i * 30, y: 200 - v * 5 }));
    expect(violations(pts).overshoot).toBeLessThan(1e-9);
  });

  it('never runs backwards in time with uneven spacing', () => {
    const xs = [0, 1, 2, 60, 61, 200, 201.5, 202];
    const pts = xs.map((x, i) => ({ x, y: i % 2 ? 10 : 90 }));
    expect(violations(pts).backwards).toBeLessThan(1e-9);
  });

  it('stays within every segment for random series', () => {
    const rng = mulberry32(99);
    for (let n = 0; n < 300; n++) {
      let x = 0;
      const pts: Pt[] = [];
      const len = 2 + Math.floor(rng() * 40);
      for (let i = 0; i < len; i++) {
        x += rng() < 0.1 ? 0 : rng() * 20; // occasional duplicate x
        pts.push({ x, y: rng() < 0.2 ? 0 : rng() * 300 });
      }
      const v = violations(pts);
      expect(v.overshoot, `case ${n}`).toBeLessThan(1e-9);
      expect(v.backwards, `case ${n}`).toBeLessThan(1e-9);
    }
  });

  it('passes through every sample', () => {
    const pts = [5, 40, 12, 33, 33, 0].map((v, i) => ({ x: i * 10, y: v }));
    const segs = segments(pts);
    segs.forEach((s, i) => {
      expect(s.p0).toEqual(pts[i]);
      expect(s.p1).toEqual(pts[i + 1]);
    });
  });
});

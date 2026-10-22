// tests/timeseries-model.test.ts
//
// Model-based contract test for TimeSeriesBuffer. It pins down the *observable*
// behaviour of the buffer so a reimplementation (typed-array ring buffer,
// different downsampler) can be verified against it. A naive reference model
// (a plain array of {t, v}) runs side by side with the real buffer under seeded
// random operation sequences, and every query is compared after every op.
//
// Only the public API is used: private members (`_`-prefixed) are mangled at
// build time and the rewrite will not have the same ones.
//
// A failure message names the seed and the op index. To reproduce, set
// ONLY_SEED below (or run the single scenario from the message).

import { describe, it, expect } from 'vitest';
import {
  TimeSeriesBuffer,
  nearestValueAt as nearestValueAtFn,
  lttb,
  type TSPoint,
  type DownsampleResult,
} from '../src/timeseries';

/**
 * Maximum number of points windowed() may return for a slice longer than
 * `targetPoints`, downsampled or not: M4 over `targetPoints / 4` columns
 * returns at most 4 per column (first/min/max/last), and slices that wouldn't
 * shrink are returned as-is.
 */
const MAX_DOWNSAMPLED_POINTS = (targetPoints: number): number => Math.max(targetPoints, 4);

const SCENARIOS = 300;
const MIN_OPS = 200;
const MAX_OPS = 2000;
const BASE_SEED = 0x5eed_0001;
/** Set to a seed number to run only that scenario while debugging. */
const ONLY_SEED: number | null = null;

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Rng {
  next(): number;
  int(lo: number, hi: number): number; // inclusive
  pick<T>(xs: readonly T[]): T;
  chance(p: number): boolean;
}

function makeRng(seed: number): Rng {
  const r = mulberry32(seed);
  return {
    next: r,
    int: (lo, hi) => lo + Math.floor(r() * (hi - lo + 1)),
    pick: (xs) => xs[Math.floor(r() * xs.length)],
    chance: (p) => r() < p,
  };
}

// ---------------------------------------------------------------------------
// Reference model — deliberately naive, O(n) everywhere.
// ---------------------------------------------------------------------------

class ModelBuffer {
  samples: TSPoint[] = [];
  readonly cap: number;

  constructor(hardCap = 100_000) {
    // The cap is floored at 2 (a buffer of 0 or 1 samples is never allowed).
    this.cap = Math.max(2, hardCap);
  }

  get length(): number {
    return this.samples.length;
  }
  get lastT(): number {
    return this.samples.length ? this.samples[this.samples.length - 1].t : -Infinity;
  }
  get firstT(): number {
    return this.samples.length ? this.samples[0].t : Infinity;
  }
  last(): TSPoint | undefined {
    return this.samples.length ? this.samples[this.samples.length - 1] : undefined;
  }

  push(t: number, v: number): void {
    // Non-finite t or v: silently rejected.
    if (!Number.isFinite(t) || !Number.isFinite(v)) return;
    // Out-of-order t is clamped forward to the newest *live* sample's t (after
    // everything is evicted, any t is accepted again).
    const clampedT = t < this.lastT ? this.lastT : t;
    this.samples.push({ t: clampedT, v });
    // Hard cap: keep the newest `cap` samples.
    while (this.samples.length > this.cap) this.samples.shift();
  }

  evictOlderThan(now: number, retentionMs: number): void {
    const cutoff = now - retentionMs;
    // Strict: a sample exactly at the cutoff survives.
    this.samples = this.samples.filter((s) => !(s.t < cutoff));
  }

  since(t: number): TSPoint[] {
    return this.samples.filter((s) => s.t >= t);
  }
  valuesSince(t: number): number[] {
    return this.since(t).map((s) => s.v);
  }
  toArray(): TSPoint[] {
    return this.samples.slice();
  }
  values(): number[] {
    return this.samples.map((s) => s.v);
  }

  /**
   * Value of the sample closest in time to `t`. Tie-breaking, matching the
   * current implementation exactly:
   *  - t at/before the oldest sample → the OLDEST sample (first of any run of
   *    equal timestamps at the head).
   *  - t at/after the newest sample → the NEWEST sample (last of any run of
   *    equal timestamps at the tail).
   *  - otherwise, let `hi` be the first sample with s.t >= t and `lo` the
   *    sample just before it. `hi` wins only if strictly closer; an exact tie
   *    goes to the earlier sample `lo`. With duplicate timestamps this means
   *    an exact hit returns the FIRST of the duplicates, and a tie between two
   *    runs returns the LAST sample of the earlier run.
   */
  nearestValueAt(t: number): number | undefined {
    return modelNearest(this.samples, t);
  }

  /** Samples visible in windowed(now, windowMs, ...), before downsampling. */
  // In window and not after `now` (a paused view must not grow).
  windowSlice(now: number, windowMs: number | undefined): TSPoint[] {
    const from = windowMs === undefined ? this.toArray() : this.since(now - windowMs);
    return from.filter((p) => p.t <= now);
  }
}

function modelNearest(arr: TSPoint[], t: number): number | undefined {
  const n = arr.length;
  if (n === 0) return undefined;
  if (t <= arr[0].t) return arr[0].v;
  if (t >= arr[n - 1].t) return arr[n - 1].v;
  let hi = 0;
  while (arr[hi].t < t) hi++; // linear scan; n is small enough
  const lo = hi - 1;
  return Math.abs(arr[hi].t - t) < Math.abs(t - arr[lo].t) ? arr[hi].v : arr[lo].v;
}

// ---------------------------------------------------------------------------
// Comparison helpers (hand-rolled loops: expect().toEqual in the hot loop is
// far too slow for ~300k ops × several queries).
// ---------------------------------------------------------------------------

class Mismatch extends Error {}

function sameNum(a: number | undefined, b: number | undefined): boolean {
  return Object.is(a, b);
}

function samePoints(a: TSPoint[], b: TSPoint[]): string | null {
  if (a.length !== b.length) return `length ${a.length} !== ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    if (!sameNum(a[i].t, b[i].t) || !sameNum(a[i].v, b[i].v)) {
      return `index ${i}: ${JSON.stringify(a[i])} !== ${JSON.stringify(b[i])}`;
    }
  }
  return null;
}

function sameNums(a: number[], b: number[]): string | null {
  if (a.length !== b.length) return `length ${a.length} !== ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    if (!sameNum(a[i], b[i])) return `index ${i}: ${a[i]} !== ${b[i]}`;
  }
  return null;
}

function fail(ctx: string, what: string, detail: string): never {
  throw new Mismatch(`${ctx} — ${what}: ${detail}`);
}

/**
 * Properties any faithful downsampler must have. Deliberately does NOT check
 * downsampler-specific choices, and does NOT check min/max preservation (a
 * separate test). Returns an error string or null.
 */
function checkDownsampleProps(
  slice: TSPoint[],
  res: DownsampleResult,
  targetPoints: number
): string | null {
  const pts = res.points;
  if (!res.downsampled) {
    // Too short to reduce: must be the exact slice, and still within bounds.
    const exact = samePoints(pts, slice);
    if (exact) return `not downsampled, yet not the exact slice: ${exact}`;
    if (pts.length > MAX_DOWNSAMPLED_POINTS(targetPoints)) {
      return `returned the raw slice of ${pts.length} points > allowed ${MAX_DOWNSAMPLED_POINTS(targetPoints)}`;
    }
    return null;
  }
  if (pts.length > MAX_DOWNSAMPLED_POINTS(targetPoints)) {
    return `returned ${pts.length} points > allowed ${MAX_DOWNSAMPLED_POINTS(targetPoints)}`;
  }
  if (pts.length >= slice.length) {
    return `downsampled result (${pts.length}) not smaller than slice (${slice.length})`;
  }
  if (pts.length < 2) return `downsampled result has ${pts.length} points`;
  const first = slice[0];
  const lastP = slice[slice.length - 1];
  if (pts[0].t !== first.t || pts[0].v !== first.v) {
    return `first point ${JSON.stringify(pts[0])} is not slice first ${JSON.stringify(first)}`;
  }
  const pl = pts[pts.length - 1];
  if (pl.t !== lastP.t || pl.v !== lastP.v) {
    return `last point ${JSON.stringify(pl)} is not slice last ${JSON.stringify(lastP)}`;
  }
  // Sorted by t, and each output point is a distinct sample of the slice,
  // taken in slice order (a subsequence). Matching by (t, v) value, since the
  // rewrite may not hand out the same object identities.
  let j = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0 && pts[i].t < pts[i - 1].t) return `not sorted at ${i}`;
    while (j < slice.length && !(slice[j].t === pts[i].t && slice[j].v === pts[i].v)) j++;
    if (j === slice.length) return `point ${i} ${JSON.stringify(pts[i])} is not in the slice (in order)`;
    j++;
  }
  return null;
}

function extremesPresent(slice: TSPoint[], pts: TSPoint[]): string | null {
  let max = -Infinity;
  let min = Infinity;
  for (const s of slice) {
    if (s.v > max) max = s.v;
    if (s.v < min) min = s.v;
  }
  const hasMax = pts.some((p) => p.v === max);
  const hasMin = pts.some((p) => p.v === min);
  if (!hasMax) return `global max ${max} missing`;
  if (!hasMin) return `global min ${min} missing`;
  return null;
}

// ---------------------------------------------------------------------------
// Full state comparison after every op
// ---------------------------------------------------------------------------

function compareAll(
  ctx: string,
  impl: TimeSeriesBuffer,
  model: ModelBuffer,
  rng: Rng,
  probeTs: number[]
): void {
  if (impl.length !== model.length) fail(ctx, 'length', `${impl.length} !== ${model.length}`);
  if (!sameNum(impl.lastT, model.lastT)) fail(ctx, 'lastT', `${impl.lastT} !== ${model.lastT}`);
  if (!sameNum(impl.firstT, model.firstT)) fail(ctx, 'firstT', `${impl.firstT} !== ${model.firstT}`);

  const modelArr = model.toArray();
  let d = samePoints(impl.toArray(), modelArr);
  if (d) fail(ctx, 'toArray()', d);
  d = sameNums(impl.values(), model.values());
  if (d) fail(ctx, 'values()', d);

  for (const t of probeTs) {
    d = samePoints(impl.since(t), model.since(t));
    if (d) fail(ctx, `since(${t})`, d);
    d = sameNums(impl.valuesSince(t), model.valuesSince(t));
    if (d) fail(ctx, `valuesSince(${t})`, d);
    const a = impl.nearestValueAt(t);
    const b = model.nearestValueAt(t);
    if (!sameNum(a, b)) fail(ctx, `nearestValueAt(${t})`, `${a} !== ${b}`);
    // The free function must agree with the method on the same data.
    const c = nearestValueAtFn(modelArr, t);
    if (!sameNum(c, b)) fail(ctx, `nearestValueAt(arr, ${t})`, `${c} !== ${b}`);
  }

  // windowed(), exact path (recomputeMs = 0). Called every op so a stale cache
  // entry surviving a push / eviction / compaction shows up as a mismatch.
  const now = model.lastT === -Infinity ? 0 : model.lastT + rng.pick([0, 0, 5, 50]);
  const windowMs = rng.pick([undefined, 0, 10, 100, 500, 5000, 1e9]);
  const targetPoints = rng.pick([0, 2, 3, 4, 16, 64, 1e6]);
  const res = impl.windowed(now, windowMs, targetPoints);
  const slice = model.windowSlice(now, windowMs);
  const wctx = `windowed(${now}, ${windowMs}, ${targetPoints})`;
  if (slice.length <= targetPoints || targetPoints < 3) {
    if (res.downsampled) fail(ctx, wctx, 'downsampled=true on exact path');
    d = samePoints(res.points, slice);
    if (d) fail(ctx, wctx, d);
  } else {
    d = checkDownsampleProps(slice, res, targetPoints);
    if (d) fail(ctx, wctx, d);
  }
  // Repeat call with identical args must return an equal result.
  const again = impl.windowed(now, windowMs, targetPoints);
  d = samePoints(again.points, res.points);
  if (d || again.downsampled !== res.downsampled) fail(ctx, `${wctx} (repeat)`, d ?? 'flag differs');
}

// ---------------------------------------------------------------------------
// Random scenario driver
// ---------------------------------------------------------------------------

function runScenario(seed: number): number {
  const rng = makeRng(seed);
  const capMode = rng.next();
  const hardCap =
    capMode < 0.05
      ? rng.pick([0, 1, 2]) // pins the floor of 2
      : capMode < 0.5
        ? rng.int(2, 50)
        : capMode < 0.6
          ? undefined // default cap
          : rng.int(500, 5000);
  const impl = hardCap === undefined ? new TimeSeriesBuffer() : new TimeSeriesBuffer(hardCap);
  const model = hardCap === undefined ? new ModelBuffer() : new ModelBuffer(hardCap);

  const nOps = rng.int(MIN_OPS, MAX_OPS);
  // Integer-ish timestamps make equal-t and exact-tie cases common.
  const dtChoices = rng.chance(0.5) ? [0, 1, 1, 2, 5, 10] : [0, 3, 7, 10, 10, 25, 100];
  let clock = rng.int(-1000, 1000);
  const log: string[] = [];

  for (let i = 0; i < nOps; i++) {
    const r = rng.next();
    let op: string;
    if (r < 0.7) {
      // push
      let t: number;
      const k = rng.next();
      if (k < 0.8) {
        clock += rng.pick(dtChoices); // mostly increasing, sometimes equal
        t = clock;
      } else if (k < 0.9) {
        t = clock - rng.int(1, 200); // out of order → clamped
      } else if (k < 0.95) {
        t = clock + rng.next(); // fractional
      } else {
        t = rng.pick([NaN, Infinity, -Infinity]);
      }
      let v: number;
      const vk = rng.next();
      if (vk < 0.9) v = Math.round((rng.next() * 200 - 100) * 100) / 100;
      else if (vk < 0.95) v = rng.int(-3, 3); // repeated values
      else v = rng.pick([NaN, Infinity, -Infinity]);
      op = `push(${t}, ${v})`;
      impl.push(t, v);
      model.push(t, v);
    } else if (r < 0.85) {
      const base = model.lastT === -Infinity ? clock : model.lastT;
      const now = base + rng.pick([0, 0, 10, 100]);
      const retention = rng.pick([0, 1, 5, 20, 50, 100, 500, 2000, 1e9, -10]);
      op = `evictOlderThan(${now}, ${retention})`;
      impl.evictOlderThan(now, retention);
      model.evictOlderThan(now, retention);
    } else {
      op = 'query';
    }
    log.push(op);

    // Probe timestamps: around live samples, exact hits, midpoints (ties),
    // and far outside the range.
    const probes: number[] = [rng.pick([-Infinity, Infinity, clock + 1000, clock - 1e6])];
    const arr = model.samples;
    if (arr.length) {
      for (let p = 0; p < 2; p++) {
        const a = arr[rng.int(0, arr.length - 1)];
        const b = arr[rng.int(0, arr.length - 1)];
        probes.push(a.t, (a.t + b.t) / 2, a.t + rng.pick([-1, 0.5, 1]));
      }
    }
    const ctx = `seed=${seed} hardCap=${hardCap} op#${i} ${op} (last ops: ${log.slice(-5).join('; ')})`;
    compareAll(ctx, impl, model, rng, probes);
  }
  return nOps;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TimeSeriesBuffer — model-based contract', () => {
  // Chunked so each `it` stays well under the default timeout.
  const CHUNK = 50;
  for (let c = 0; c < SCENARIOS; c += CHUNK) {
    const seeds =
      ONLY_SEED !== null
        ? c === 0
          ? [ONLY_SEED]
          : []
        : Array.from({ length: Math.min(CHUNK, SCENARIOS - c) }, (_, i) => BASE_SEED + c + i);
    if (seeds.length === 0) continue;
    it(`matches the reference model (seeds ${seeds[0]}..${seeds[seeds.length - 1]})`, () => {
      let totalOps = 0;
      for (const seed of seeds) totalOps += runScenario(seed);
      expect(totalOps).toBeGreaterThan(0);
    });
  }

  it('pins equal-timestamp and tie-breaking behaviour of nearestValueAt', () => {
    const b = new TimeSeriesBuffer();
    b.push(10, 1);
    b.push(10, 2); // equal t at head
    b.push(20, 3);
    b.push(20, 4); // equal t interior
    b.push(30, 5);
    b.push(30, 6); // equal t at tail
    expect(b.nearestValueAt(5)).toBe(1); // before head → oldest
    expect(b.nearestValueAt(10)).toBe(1); // at head → oldest of duplicates
    expect(b.nearestValueAt(15)).toBe(2); // exact tie → earlier run's last sample
    expect(b.nearestValueAt(20)).toBe(3); // exact interior hit → first duplicate
    expect(b.nearestValueAt(25)).toBe(4); // exact tie → earlier
    expect(b.nearestValueAt(26)).toBe(5); // strictly closer to later
    expect(b.nearestValueAt(30)).toBe(6); // at tail → newest
    expect(b.nearestValueAt(99)).toBe(6);
    expect(nearestValueAtFn(b.toArray(), 15)).toBe(2);
    expect(new TimeSeriesBuffer().nearestValueAt(0)).toBeUndefined();
  });

  it('clamps out-of-order pushes against live samples only', () => {
    const b = new TimeSeriesBuffer();
    b.push(100, 1);
    b.push(50, 2); // clamped to 100
    expect(b.toArray()).toEqual([
      { t: 100, v: 1 },
      { t: 100, v: 2 },
    ]);
    b.evictOlderThan(1000, 10); // empties the buffer
    expect(b.length).toBe(0);
    expect(b.firstT).toBe(Infinity);
    expect(b.lastT).toBe(-Infinity);
    b.push(5, 3); // nothing live → accepted as-is
    expect(b.toArray()).toEqual([{ t: 5, v: 3 }]);
  });

  it('floors the hard cap at 2', () => {
    for (const cap of [0, 1, -5]) {
      const b = new TimeSeriesBuffer(cap);
      for (let i = 0; i < 10; i++) b.push(i, i);
      expect(b.values()).toEqual([8, 9]);
    }
  });
});

// ---------------------------------------------------------------------------
// windowed() contract
// ---------------------------------------------------------------------------

function filledBuffer(seed: number, n: number, shape: 'noise' | 'spiky' | 'walk'): TimeSeriesBuffer {
  const rng = makeRng(seed);
  const b = new TimeSeriesBuffer();
  let t = 0;
  let v = 0;
  for (let i = 0; i < n; i++) {
    t += rng.pick([0, 1, 1, 2, 5]);
    if (shape === 'noise') v = Math.round(rng.next() * 1000) / 10;
    else if (shape === 'spiky') v = rng.chance(0.01) ? rng.int(-500, 500) : rng.int(0, 10);
    else v += rng.int(-3, 3);
    b.push(t, v);
  }
  return b;
}

describe('TimeSeriesBuffer.windowed — exact path', () => {
  it('returns exactly the in-window samples when they fit (or targetPoints < 3)', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rng = makeRng(seed * 7919);
      const b = filledBuffer(seed, rng.int(0, 400), 'noise');
      const all = b.toArray();
      const now = (all.length ? all[all.length - 1].t : 0) + rng.int(0, 20);
      for (const windowMs of [undefined, 0, 1, 50, 200, 1e9]) {
        const slice = all.filter((p) => (windowMs === undefined || p.t >= now - windowMs) && p.t <= now);
        for (const targetPoints of [0, 1, 2, slice.length, slice.length + 1, 1e6]) {
          if (!(slice.length <= targetPoints || targetPoints < 3)) continue;
          const res = b.windowed(now, windowMs, targetPoints);
          expect(res.downsampled, `seed=${seed} w=${windowMs} tp=${targetPoints}`).toBe(false);
          expect(res.points, `seed=${seed} w=${windowMs} tp=${targetPoints}`).toEqual(slice);
        }
      }
    }
  });

  it('ignores recomputeMs when the slice is not downsampled (never stale)', () => {
    const b = new TimeSeriesBuffer();
    for (let i = 0; i < 10; i++) b.push(i, i);
    expect(b.windowed(1000, undefined, 100, 250).points).toHaveLength(10);
    b.push(10, 10);
    expect(b.windowed(1000, undefined, 100, 250).points).toHaveLength(11);
    b.evictOlderThan(1000, 995); // drop t < 5
    expect(b.windowed(1000, undefined, 100, 250).points.map((p) => p.v)).toEqual([
      5, 6, 7, 8, 9, 10,
    ]);
  });
});

describe('TimeSeriesBuffer.windowed — downsampled path', () => {
  const cases: Array<{ seed: number; n: number; shape: 'noise' | 'spiky' | 'walk'; tp: number }> = [];
  for (let seed = 1; seed <= 60; seed++) {
    const rng = makeRng(seed);
    cases.push({
      seed,
      n: rng.int(50, 3000),
      shape: rng.pick(['noise', 'spiky', 'walk'] as const),
      tp: rng.pick([3, 4, 7, 20, 100, 300]),
    });
  }

  it('keeps generic downsampler properties (bounds, endpoints, sorted subset)', () => {
    let downsampledCount = 0;
    for (const c of cases) {
      const b = filledBuffer(c.seed, c.n, c.shape);
      const all = b.toArray();
      const now = all[all.length - 1].t;
      for (const windowMs of [undefined, 500, 2000]) {
        const slice = all.filter((p) => (windowMs === undefined || p.t >= now - windowMs) && p.t <= now);
        if (slice.length <= c.tp) continue;
        const res = b.windowed(now, windowMs, c.tp);
        const err = checkDownsampleProps(slice, res, c.tp);
        expect(err, `seed=${c.seed} n=${c.n} shape=${c.shape} tp=${c.tp} w=${windowMs}`).toBeNull();
        downsampledCount++;
      }
    }
    expect(downsampledCount).toBeGreaterThan(50);
  });

  // M4 keeps every column's min and max, so the slice's global extremes always
  // survive. (The previous LTTB downsampler dropped them in most of these
  // cases, e.g. seed=1.)
  it('preserves the global maximum and minimum value of the slice', () => {
    for (const c of cases) {
      const b = filledBuffer(c.seed, c.n, c.shape);
      const all = b.toArray();
      const now = all[all.length - 1].t;
      for (const windowMs of [undefined, 500, 2000]) {
        const slice = all.filter((p) => (windowMs === undefined || p.t >= now - windowMs) && p.t <= now);
        if (slice.length <= c.tp) continue;
        const res = b.windowed(now, windowMs, c.tp);
        const err = extremesPresent(slice, res.points);
        expect(err, `seed=${c.seed} n=${c.n} shape=${c.shape} tp=${c.tp} w=${windowMs}`).toBeNull();
      }
    }
  });

  it('lttb() keeps endpoints and returns a sorted subset of length threshold', () => {
    for (const c of cases) {
      const data = filledBuffer(c.seed, c.n, c.shape).toArray();
      if (data.length <= c.tp) continue;
      const out = lttb(data, c.tp);
      expect(checkDownsampleProps(data, { points: out, downsampled: true }, c.tp)).toBeNull();
    }
    const small = [
      { t: 0, v: 1 },
      { t: 1, v: 2 },
    ];
    expect(lttb(small, 10)).toEqual(small);
    expect(lttb(small, 10)).not.toBe(small); // copy, not alias
    expect(lttb(filledBuffer(1, 100, 'noise').toArray(), 2)).toHaveLength(100);
  });
});

describe('TimeSeriesBuffer.windowed — cache correctness (recomputeMs = 0)', () => {
  function checkFresh(b: TimeSeriesBuffer, now: number, windowMs: number | undefined, tp: number) {
    const all = b.toArray();
    const slice = all.filter((p) => (windowMs === undefined || p.t >= now - windowMs) && p.t <= now);
    const r1 = b.windowed(now, windowMs, tp);
    const r2 = b.windowed(now, windowMs, tp);
    expect(r2).toEqual(r1);
    if (slice.length <= tp || tp < 3) {
      expect(r1).toEqual({ points: slice, downsampled: false });
    } else {
      expect(checkDownsampleProps(slice, r1, tp)).toBeNull();
    }
    return r1;
  }

  for (const tp of [1000, 20]) {
    const label = tp === 1000 ? 'exact slice' : 'downsampled slice';
    it(`reflects pushes, evictions and window moves immediately (${label})`, () => {
      const b = new TimeSeriesBuffer();
      for (let i = 0; i < 200; i++) b.push(i * 10, i % 17);
      let r = checkFresh(b, 2000, 500, tp);
      const before = r.points[r.points.length - 1];

      b.push(2000, 99);
      r = checkFresh(b, 2000, 500, tp);
      expect(r.points[r.points.length - 1]).toEqual({ t: 2000, v: 99 });
      expect(r.points[r.points.length - 1]).not.toEqual(before);

      // Same now, but eviction removes in-window samples.
      b.evictOlderThan(2000, 200);
      r = checkFresh(b, 2000, 500, tp);
      expect(r.points[0].t).toBe(1800);

      // Eviction that touches nothing in the window.
      b.evictOlderThan(2000, 1e6);
      checkFresh(b, 2000, 500, tp);

      // Moving `now` slides the window with no data change.
      r = checkFresh(b, 2090, 100, tp);
      expect(r.points[0].t).toBe(1990);
      r = checkFresh(b, 2195, 100, tp);
      expect(r.points).toEqual([]);

      // Switching between windowMs values and back.
      checkFresh(b, 2000, undefined, tp);
      checkFresh(b, 2000, 50, tp);
      checkFresh(b, 2000, undefined, tp);

      // Equal-timestamp push (same lastT) must still invalidate.
      b.push(2000, 7);
      r = checkFresh(b, 2000, 50, tp);
      expect(r.points[r.points.length - 1]).toEqual({ t: 2000, v: 7 });

      // Rejected push changes nothing.
      const prev = b.windowed(2000, 50, tp);
      b.push(NaN, 1);
      b.push(2001, Infinity);
      expect(b.windowed(2000, 50, tp)).toEqual(prev);
    });
  }

  it('stays fresh across hard-cap trimming and internal compaction', () => {
    const b = new TimeSeriesBuffer(300);
    for (let i = 0; i < 5000; i++) {
      b.push(i, (i * 31) % 97);
      if (i % 97 === 0) checkFresh(b, i, undefined, 1000);
      if (i % 89 === 0) checkFresh(b, i, 100, 1000);
      if (i % 83 === 0) checkFresh(b, i, undefined, 50);
    }
    expect(b.length).toBe(300);
  });

  // A long gap of pushes with no windowed() call in between. With a capped
  // buffer the internal layout can return to an identical shape (same counts,
  // same offsets) holding different data — a cache keyed on layout alone would
  // then serve stale points. Gaps include a full compaction period of the
  // current implementation (1025 pushes at cap 100), but the assertion is
  // implementation-agnostic: the second call must reflect the new data.
  it('stays fresh after long push gaps with no intervening windowed() call', () => {
    for (const cap of [100, 500]) {
      for (const windowMs of [undefined, 50, 1e9]) {
        for (const tp of [1000, 30]) {
          const b = new TimeSeriesBuffer(cap);
          let t = 0;
          for (let i = 0; i < cap * 2; i++) b.push(t++, t % 13);
          for (const gap of [1, 2, 100, 1024, 1025, 1026, 525, 2050]) {
            checkFresh(b, t, windowMs, tp);
            for (let i = 0; i < gap; i++) b.push(t++, (t * 7) % 101);
            checkFresh(b, t, windowMs, tp);
          }
        }
      }
    }
  });
});

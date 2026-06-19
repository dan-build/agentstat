// src/timeseries.ts
//
// Time-indexed sample buffer for AgentStat. Extracted as a standalone module so
// the append / eviction / windowing / downsampling logic can be unit-tested in
// isolation, away from the canvas and React. The component holds one
// TimeSeriesBuffer per (agent, series) instead of a raw number[].
//
// Design goals:
//   - O(1) amortized append.
//   - Time-based eviction: drop samples older than a retention horizon.
//   - Window slicing: return only samples within the last `windowMs`.
//   - Downsampling: when a sliced window has far more points than the canvas has
//     pixels, reduce to a visually faithful subset via LTTB (Largest-Triangle-
//     Three-Buckets), which preserves peaks/troughs far better than naive
//     stride sampling. Results are cached on (windowMs, targetPoints, lastT,
//     length) so a static view costs nothing per frame.

export interface TSPoint {
  /** Timestamp in ms (performance.now() domain or Date.now() — caller's choice, must be consistent). */
  t: number;
  /** Sample value. */
  v: number;
}

export interface DownsampleResult {
  points: TSPoint[];
  /** True if the result was downsampled (fewer points than the raw slice). */
  downsampled: boolean;
}

const DEFAULT_CAP = 20_000;

/**
 * Return the value of the sample whose timestamp is closest to `t`, or
 * undefined if the array is empty. The array is assumed sorted ascending by `t`
 * (TimeSeriesBuffer guarantees this), so this binary-searches in O(log n) rather
 * than scanning — important for hover, which calls this against the full buffer.
 */
export function nearestValueAt(arr: TSPoint[], t: number): number | undefined {
  const n = arr.length;
  if (n === 0) return undefined;
  if (t <= arr[0].t) return arr[0].v;
  if (t >= arr[n - 1].t) return arr[n - 1].v;
  let lo = 0;
  let hi = n - 1;
  // Find the insertion point: smallest index with arr[idx].t >= t.
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  // lo is the first element >= t; compare it with its predecessor.
  const hiPt = arr[lo];
  const loPt = arr[lo - 1];
  return Math.abs(hiPt.t - t) < Math.abs(t - loPt.t) ? hiPt.v : loPt.v;
}

export class TimeSeriesBuffer {
  // Ring-free implementation: a plain array with head-trim eviction. We keep a
  // start index to avoid O(n) shifts on every append; compaction happens lazily.
  private buf: TSPoint[] = [];
  private start = 0;
  private readonly hardCap: number;

  // Downsample cache — keyed on the inputs that affect the result.
  private cacheKey = '';
  private cacheVal: DownsampleResult | null = null;

  constructor(hardCap: number = DEFAULT_CAP) {
    this.hardCap = Math.max(2, hardCap);
  }

  /** Number of live samples (excludes trimmed head). */
  get length(): number {
    return this.buf.length - this.start;
  }

  /** Timestamp of the most recent sample, or -Infinity if empty. */
  get lastT(): number {
    return this.length > 0 ? this.buf[this.buf.length - 1].t : -Infinity;
  }

  /** Append a sample. Monotonic time is assumed (caller passes increasing t). */
  push(t: number, v: number): void {
    this.buf.push({ t, v });
    // Hard cap by count to bound memory even if eviction-by-time isn't called.
    if (this.buf.length - this.start > this.hardCap) {
      this.start = this.buf.length - this.hardCap;
    }
    // Compact when the dead head grows large, to reclaim memory. Compaction
    // shifts indices and resets start, so it MUST invalidate the cache (the
    // start-index component of the bucketed key would otherwise collide).
    if (this.start > this.hardCap) {
      this.buf = this.buf.slice(this.start);
      this.start = 0;
      this.cacheVal = null;
    }
    // NOTE: we deliberately do NOT null cacheVal on the normal path. The cache
    // key encodes everything that affects the result — on the exact path it
    // includes lastT and length (self-invalidates every push); on the bucketed
    // path it includes the time bucket and start index (stable within a bucket
    // by design). Manual invalidation there would defeat the bucketing.
  }

  /** Drop samples older than (now - retentionMs). */
  evictOlderThan(now: number, retentionMs: number): void {
    const cutoff = now - retentionMs;
    let s = this.start;
    while (s < this.buf.length && this.buf[s].t < cutoff) s++;
    if (s !== this.start) {
      this.start = s;
    }
    if (this.start > this.hardCap) {
      this.buf = this.buf.slice(this.start);
      this.start = 0;
      this.cacheVal = null;
    }
  }

  /** All live samples (no copy of individual points; slices the live window). */
  toArray(): TSPoint[] {
    return this.buf.slice(this.start);
  }

  /**
   * Value of the sample whose timestamp is closest to `t`, searching the
   * buffer's internal storage directly (no array copy). O(log n) binary search.
   * Used by the hover hit-test, which runs on every mouse move — avoiding the
   * per-hover toArray() allocation here is what keeps hovering cheap on large
   * buffers.
   */
  nearestValueAt(t: number): number | undefined {
    const lo0 = this.start;
    const hi0 = this.buf.length - 1;
    if (hi0 < lo0) return undefined;
    if (t <= this.buf[lo0].t) return this.buf[lo0].v;
    if (t >= this.buf[hi0].t) return this.buf[hi0].v;
    let lo = lo0;
    let hi = hi0;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.buf[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    const hiPt = this.buf[lo];
    const loPt = this.buf[lo - 1];
    return Math.abs(hiPt.t - t) < Math.abs(t - loPt.t) ? hiPt.v : loPt.v;
  }

  /** Raw values only (for code paths that just need numbers, e.g. health). */
  values(): number[] {
    const out: number[] = [];
    for (let i = this.start; i < this.buf.length; i++) out.push(this.buf[i].v);
    return out;
  }

  /**
   * Return samples within the last `windowMs` (relative to `now`), downsampled
   * to at most `targetPoints` via LTTB if necessary. Cached per input tuple.
   *
   * `recomputeMs` (default 0 = exact): when the slice is large enough to be
   * downsampled, recomputing LTTB on every single new sample is wasteful — one
   * sample out of thousands doesn't visibly change the downsampled shape, and at
   * 20Hz that recompute dominates the frame budget (measured: ~3.5ms/frame for
   * 10 agents vs ~0.008ms on a cache hit). Passing e.g. 250 quantizes the cache
   * key so LTTB recomputes at most every 250ms. The live "tip" is drawn
   * separately by the consumer, so the lag is invisible. This coarsening is
   * applied ONLY on the downsampled path; small (un-downsampled) slices keep
   * exact per-sample invalidation so their values are never stale.
   */
  windowed(
    now: number,
    windowMs: number | undefined,
    targetPoints: number,
    recomputeMs = 0
  ): DownsampleResult {
    // Decide up front whether this call will downsample, so we can pick the
    // right cache-key granularity. Cheap: just a length check against target.
    const sliceLenEstimate = this.length;
    const willDownsample =
      sliceLenEstimate > targetPoints && targetPoints >= 3;

    // On the downsampled path, optionally quantize lastT into recomputeMs
    // buckets so the key is stable across frames within a bucket. We also drop
    // the exact `length` from the key there — within a bucket, a few added
    // samples don't change the downsampled shape, and including length would
    // force a recompute on every push and defeat the bucketing. The `start`
    // index (head eviction) IS included so a window slide still invalidates.
    let key: string;
    if (willDownsample && recomputeMs > 0) {
      const bucket = Math.floor(this.lastT / recomputeMs);
      key = `${windowMs ?? 'all'}:${targetPoints}:b${bucket}:s${this.start}`;
    } else {
      key = `${windowMs ?? 'all'}:${targetPoints}:${this.lastT}:${this.length}`;
    }
    if (this.cacheVal && this.cacheKey === key) return this.cacheVal;

    // Slice to window.
    let lo = this.start;
    if (windowMs !== undefined) {
      const cutoff = now - windowMs;
      while (lo < this.buf.length && this.buf[lo].t < cutoff) lo++;
    }
    const slice = this.buf.slice(lo);

    let result: DownsampleResult;
    if (slice.length <= targetPoints || targetPoints < 3) {
      result = { points: slice, downsampled: false };
    } else {
      result = { points: lttb(slice, targetPoints), downsampled: true };
    }

    this.cacheKey = key;
    this.cacheVal = result;
    return result;
  }
}

/**
 * Largest-Triangle-Three-Buckets downsampling. Keeps the first and last points,
 * and for each interior bucket picks the point forming the largest triangle with
 * the previous selected point and the average of the next bucket. Preserves the
 * visual shape (peaks/valleys) of the series. O(n).
 *
 * Reference: Sveinn Steinarsson, "Downsampling Time Series for Visual
 * Representation" (2013).
 */
export function lttb(data: TSPoint[], threshold: number): TSPoint[] {
  const n = data.length;
  if (threshold >= n || threshold < 3) return data.slice();

  const sampled: TSPoint[] = [];
  const bucketSize = (n - 2) / (threshold - 2);

  let a = 0; // index of last selected point
  sampled.push(data[0]); // always keep first

  for (let i = 0; i < threshold - 2; i++) {
    // Next bucket's average point (for the third triangle vertex).
    const avgRangeStart = Math.floor((i + 1) * bucketSize) + 1;
    let avgRangeEnd = Math.floor((i + 2) * bucketSize) + 1;
    avgRangeEnd = avgRangeEnd < n ? avgRangeEnd : n;

    let avgT = 0;
    let avgV = 0;
    const avgCount = avgRangeEnd - avgRangeStart || 1;
    for (let j = avgRangeStart; j < avgRangeEnd; j++) {
      avgT += data[j].t;
      avgV += data[j].v;
    }
    avgT /= avgCount;
    avgV /= avgCount;

    // Current bucket range.
    const rangeStart = Math.floor(i * bucketSize) + 1;
    const rangeEnd = Math.floor((i + 1) * bucketSize) + 1;

    const paT = data[a].t;
    const paV = data[a].v;

    let maxArea = -1;
    let nextA = rangeStart;
    let chosen = data[rangeStart];
    for (let j = rangeStart; j < rangeEnd; j++) {
      const area =
        Math.abs(
          (paT - avgT) * (data[j].v - paV) - (paT - data[j].t) * (avgV - paV)
        ) * 0.5;
      if (area > maxArea) {
        maxArea = area;
        chosen = data[j];
        nextA = j;
      }
    }
    sampled.push(chosen);
    a = nextA;
  }

  sampled.push(data[n - 1]); // always keep last
  return sampled;
}

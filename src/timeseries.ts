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
//     stride sampling. Results are cached on the slice bounds (or a wall-time
//     bucket when downsampling) so a static view costs nothing per frame.

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

// Safety cap only — retention is normally governed by time-based eviction.
// 100k samples covers a 1h window at ~25 Hz.
const DEFAULT_CAP = 100_000;

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
  // Plain array with head-trim eviction. A start index avoids O(n) shifts on
  // every append; compaction happens lazily once the dead head dominates.
  private _buf: TSPoint[] = [];
  private _start = 0;
  private readonly _hardCap: number;

  // Downsample cache — keyed on the inputs that affect the result.
  private _cacheKey = '';
  private _cacheVal: DownsampleResult | null = null;

  constructor(hardCap: number = DEFAULT_CAP) {
    this._hardCap = Math.max(2, hardCap);
  }

  /** Number of live samples (excludes trimmed head). */
  get length(): number {
    return this._buf.length - this._start;
  }

  /** Timestamp of the most recent sample, or -Infinity if empty. */
  get lastT(): number {
    return this.length > 0 ? this._buf[this._buf.length - 1].t : -Infinity;
  }

  /** Timestamp of the oldest live sample, or +Infinity if empty. */
  get firstT(): number {
    return this.length > 0 ? this._buf[this._start].t : Infinity;
  }

  /** The most recent sample, or undefined if empty. */
  last(): TSPoint | undefined {
    return this.length > 0 ? this._buf[this._buf.length - 1] : undefined;
  }

  /**
   * Append a sample. Time must be non-decreasing; a sample older than the
   * newest one is clamped forward so the buffer stays sorted (binary searches
   * and the time axis both depend on that). Non-finite values are rejected.
   */
  push(t: number, v: number): void {
    if (!Number.isFinite(t) || !Number.isFinite(v)) return;
    const lastT = this.lastT;
    this._buf.push({ t: t < lastT ? lastT : t, v });
    // Hard cap by count to bound memory even if eviction-by-time isn't called.
    if (this._buf.length - this._start > this._hardCap) {
      this._start = this._buf.length - this._hardCap;
    }
    this._maybeCompact();
  }

  /** Drop samples older than (now - retentionMs). */
  evictOlderThan(now: number, retentionMs: number): void {
    const s = this._lowerBound(now - retentionMs);
    if (s > this._start) this._start = s;
    this._maybeCompact();
  }

  // Reclaim the dead head once it outweighs the live samples. Compaction
  // shifts indices, so it must drop the cache (exact keys embed indices).
  private _maybeCompact(): void {
    if (this._start > 1024 && this._start >= this._buf.length - this._start) {
      this._buf = this._buf.slice(this._start);
      this._start = 0;
      this._cacheVal = null;
    }
  }

  // First live index whose timestamp is >= t (buf.length if none). O(log n).
  private _lowerBound(t: number): number {
    let lo = this._start;
    let hi = this._buf.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this._buf[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Live samples with timestamp >= t, as a new array. O(log n + k). Used by the
   * detectors and health scoring so they read a bounded recent span instead of
   * copying the whole buffer.
   */
  since(t: number): TSPoint[] {
    return this._buf.slice(this._lowerBound(t));
  }

  /** Values of live samples with timestamp >= t. */
  valuesSince(t: number): number[] {
    const out: number[] = [];
    for (let i = this._lowerBound(t); i < this._buf.length; i++) out.push(this._buf[i].v);
    return out;
  }

  /** All live samples (no copy of individual points; slices the live window). */
  toArray(): TSPoint[] {
    return this._buf.slice(this._start);
  }

  /**
   * Value of the sample whose timestamp is closest to `t`, searching the
   * buffer's internal storage directly (no array copy). O(log n) binary search.
   * Used by the hover hit-test, which runs on every mouse move — avoiding the
   * per-hover toArray() allocation here is what keeps hovering cheap on large
   * buffers.
   */
  nearestValueAt(t: number): number | undefined {
    const lo0 = this._start;
    const hi0 = this._buf.length - 1;
    if (hi0 < lo0) return undefined;
    if (t <= this._buf[lo0].t) return this._buf[lo0].v;
    if (t >= this._buf[hi0].t) return this._buf[hi0].v;
    let lo = lo0;
    let hi = hi0;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this._buf[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    const hiPt = this._buf[lo];
    const loPt = this._buf[lo - 1];
    return Math.abs(hiPt.t - t) < Math.abs(t - loPt.t) ? hiPt.v : loPt.v;
  }

  /** Raw values only (for code paths that just need numbers, e.g. health). */
  values(): number[] {
    const out: number[] = [];
    for (let i = this._start; i < this._buf.length; i++) out.push(this._buf[i].v);
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
    // Slice bounds first (binary search), so the cache key can reflect exactly
    // which samples are in view. Without the cutoff in the key, a quiet agent
    // kept serving points that had already scrolled out of the window.
    const lo =
      windowMs !== undefined ? this._lowerBound(now - windowMs) : this._start;
    const sliceLen = this._buf.length - lo;
    const willDownsample = sliceLen > targetPoints && targetPoints >= 3;

    // Downsampled path: quantize on wall time so LTTB reruns at most once per
    // `recomputeMs`, regardless of how many samples arrive in between (the live
    // tip is drawn separately, so the lag is invisible). Exact path: key on the
    // slice bounds so every new or expired sample is reflected immediately.
    const key =
      willDownsample && recomputeMs > 0
        ? `d:${windowMs ?? 'all'}:${targetPoints}:${Math.floor(now / recomputeMs)}`
        : `e:${windowMs ?? 'all'}:${targetPoints}:${lo}:${this._buf.length}`;
    if (this._cacheVal && this._cacheKey === key) return this._cacheVal;

    const slice = this._buf.slice(lo);

    let result: DownsampleResult;
    if (slice.length <= targetPoints || targetPoints < 3) {
      result = { points: slice, downsampled: false };
    } else {
      result = { points: lttb(slice, targetPoints), downsampled: true };
    }

    this._cacheKey = key;
    this._cacheVal = result;
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

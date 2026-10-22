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
//   - Downsampling: when a sliced window has far more points than the canvas
//     can show, reduce it per time column to first/min/max/last (M4). Every
//     column keeps its highest and lowest sample, so the slice's extremes and
//     any isolated spike or dip always survive (two spikes within one column
//     show as one). Results are cached on the slice bounds (or a wall-time
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
// Smallest storage allocated (and shrunk back to), in samples.
const MIN_CAPACITY = 256;

// Each buffer recomputes its downsampled view on its own phase, so a chart
// with many series spreads that work across frames instead of doing all of it
// in one (golden-ratio spacing keeps phases evenly spread for any count).
let phaseSeed = 0;
const nextPhase = () => (phaseSeed = (phaseSeed + 0.6180339887) % 1);

const pow2AtLeast = (n: number): number => {
  let p = 1;
  while (p < n) p *= 2;
  return p;
};

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
  // Ring buffer of parallel typed arrays: 16 bytes per sample, no per-sample
  // objects, no garbage on push. Capacity is a power of two that grows on
  // demand up to the hard cap and shrinks after large evictions, so memory
  // follows the live window rather than the cap.
  private _t: Float64Array;
  private _v: Float64Array;
  private _mask: number;
  /** Physical index of the oldest live sample. */
  private _head = 0;
  /** Number of live samples. */
  private _n = 0;
  /** Samples ever removed from the head; `_base + i` identifies a sample. */
  private _base = 0;
  private readonly _hardCap: number;

  // Downsample cache, keyed on the inputs that affect the result.
  private _ckMode = 0; // 0 = empty, 1 = exact, 2 = downsampled
  private _ckWindow = NaN;
  private _ckTarget = 0;
  private _ckA = 0;
  private _ckB = 0;
  private _cacheVal: DownsampleResult | null = null;
  private readonly _phase: number;

  /**
   * @param hardCap  maximum samples kept (memory bound; retention is time-based)
   * @param phase    fraction of a recompute bucket this buffer is offset by;
   *                 defaults to a spread sequence (fixed values are for tests)
   */
  constructor(hardCap: number = DEFAULT_CAP, phase: number = nextPhase()) {
    this._hardCap = Math.max(2, Math.floor(hardCap) || 2);
    this._phase = phase;
    const cap = Math.min(MIN_CAPACITY, pow2AtLeast(this._hardCap));
    this._t = new Float64Array(cap);
    this._v = new Float64Array(cap);
    this._mask = cap - 1;
  }

  /** Number of live samples. */
  get length(): number {
    return this._n;
  }

  /** Timestamp of the most recent sample, or -Infinity if empty. */
  get lastT(): number {
    return this._n > 0 ? this._t[(this._head + this._n - 1) & this._mask] : -Infinity;
  }

  /** Timestamp of the oldest live sample, or +Infinity if empty. */
  get firstT(): number {
    return this._n > 0 ? this._t[this._head] : Infinity;
  }

  /**
   * Append a sample. Time must be non-decreasing; a sample older than the
   * newest one is clamped forward so the buffer stays sorted (binary searches
   * and the time axis both depend on that). Non-finite values are rejected.
   */
  push(t: number, v: number): void {
    if (!Number.isFinite(t) || !Number.isFinite(v)) return;
    const lastT = this.lastT;
    if (this._n >= this._hardCap) {
      // Full: overwrite the oldest sample.
      this._head = (this._head + 1) & this._mask;
      this._n--;
      this._base++;
    } else if (this._n === this._mask + 1) {
      this._resize((this._mask + 1) * 2);
    }
    const i = (this._head + this._n) & this._mask;
    this._t[i] = t < lastT ? lastT : t;
    this._v[i] = v;
    this._n++;
  }

  /** Drop samples older than (now - retentionMs). */
  evictOlderThan(now: number, retentionMs: number): void {
    const k = this._lowerBound(now - retentionMs);
    if (k === 0) return;
    this._head = (this._head + k) & this._mask;
    this._n -= k;
    this._base += k;
    // Give memory back once the live window is far smaller than the storage.
    const cap = this._mask + 1;
    if (cap > MIN_CAPACITY && this._n * 4 < cap) this._resize(Math.max(MIN_CAPACITY, pow2AtLeast(this._n * 2)));
  }

  /** All live samples, oldest first. */
  toArray(): TSPoint[] {
    return this._points(0, this._n);
  }

  /** Live samples with timestamp >= t. O(log n + k). */
  since(t: number): TSPoint[] {
    return this._points(this._lowerBound(t), this._n);
  }

  /** Values of live samples with timestamp >= t. */
  valuesSince(t: number): number[] {
    const out: number[] = [];
    for (let i = this._lowerBound(t); i < this._n; i++) out.push(this._v[(this._head + i) & this._mask]);
    return out;
  }

  /** Values of all live samples. */
  values(): number[] {
    return this.valuesSince(-Infinity);
  }

  /**
   * Value of the sample whose timestamp is closest to `t` (the earlier one on
   * a tie), or undefined if empty. O(log n), no copying — hover calls this on
   * every mouse move.
   */
  nearestValueAt(t: number): number | undefined {
    const n = this._n;
    if (n === 0) return undefined;
    if (t <= this.firstT) return this._v[this._head];
    if (t >= this.lastT) return this._v[(this._head + n - 1) & this._mask];
    const i = this._lowerBound(t); // first sample with time >= t; i >= 1 here
    const hi = (this._head + i) & this._mask;
    const lo = (this._head + i - 1) & this._mask;
    return Math.abs(this._t[hi] - t) < Math.abs(t - this._t[lo]) ? this._v[hi] : this._v[lo];
  }

  /**
   * Samples within the last `windowMs` (relative to `now`; all samples when
   * undefined) and not after `now`. Slices longer than `targetPoints` are
   * downsampled to `targetPoints / 4` time columns, keeping each column's
   * first, last, minimum and maximum sample (M4): at most `targetPoints`
   * points, with every column's extremes kept.
   *
   * Cached. Exact results are keyed on the slice bounds, so every new or
   * expired sample shows immediately. Downsampled results are keyed on a
   * `recomputeMs` wall-time bucket (when > 0), so a long window is recomputed
   * at most once per bucket however fast samples arrive; the live tip is drawn
   * separately, so the lag is invisible.
   */
  windowed(
    now: number,
    windowMs: number | undefined,
    targetPoints: number,
    recomputeMs = 0
  ): DownsampleResult {
    const lo = windowMs !== undefined ? this._lowerBound(now - windowMs) : 0;
    // Never past `now`: a paused view keeps its slice while data keeps arriving.
    const hi = this._upperBound(now);
    const sliceLen = Math.max(0, hi - lo);
    // M4 returns at most 4 samples per column, so `targetPoints / 4` columns
    // keep the output within `targetPoints`. Downsample only slices longer
    // than both the target and that maximum, so the result is always smaller.
    const columns = Math.max(1, Math.floor(targetPoints / 4));
    const downsample = targetPoints >= 3 && sliceLen > Math.max(targetPoints, columns * 4);
    const win = windowMs ?? -1;
    let mode: number;
    let a: number;
    let b: number;
    if (downsample && recomputeMs > 0) {
      mode = 2;
      a = Math.floor(now / recomputeMs + this._phase);
      b = recomputeMs;
    } else {
      mode = 1;
      a = this._base + lo;
      b = this._base + hi;
    }
    if (
      this._cacheVal &&
      this._ckMode === mode &&
      this._ckWindow === win &&
      this._ckTarget === targetPoints &&
      this._ckA === a &&
      this._ckB === b
    ) {
      return this._cacheVal;
    }
    const result: DownsampleResult = downsample
      ? { points: this._m4(lo, hi, columns), downsampled: true }
      : { points: this._points(lo, hi), downsampled: false };
    this._ckMode = mode;
    this._ckWindow = win;
    this._ckTarget = targetPoints;
    this._ckA = a;
    this._ckB = b;
    this._cacheVal = result;
    return result;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private _point(i: number): TSPoint {
    const p = (this._head + i) & this._mask;
    return { t: this._t[p], v: this._v[p] };
  }

  private _points(from: number, to: number): TSPoint[] {
    const out = new Array<TSPoint>(Math.max(0, to - from));
    for (let i = from; i < to; i++) out[i - from] = this._point(i);
    return out;
  }

  // First logical index whose timestamp is >= t (length if none). O(log n).
  private _lowerBound(t: number): number {
    let lo = 0;
    let hi = this._n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this._t[(this._head + mid) & this._mask] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // First logical index whose timestamp is > t (length if none). O(log n).
  private _upperBound(t: number): number {
    let lo = 0;
    let hi = this._n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this._t[(this._head + mid) & this._mask] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private _resize(capacity: number): void {
    const t = new Float64Array(capacity);
    const v = new Float64Array(capacity);
    for (let i = 0; i < this._n; i++) {
      const p = (this._head + i) & this._mask;
      t[i] = this._t[p];
      v[i] = this._v[p];
    }
    this._t = t;
    this._v = v;
    this._mask = capacity - 1;
    this._head = 0;
  }

  /**
   * M4 downsampling of logical range [from, to) into `columns` equal time
   * columns: each column contributes its first, minimum, maximum and last
   * sample (deduplicated, in time order). O(n), no intermediate copies.
   */
  private _m4(from: number, to: number, columns: number): TSPoint[] {
    const out: TSPoint[] = [];
    const T = this._t;
    const V = this._v;
    const head = this._head;
    const mask = this._mask;
    const t0 = T[(head + from) & mask];
    const span = T[(head + to - 1) & mask] - t0;
    const colSpan = span / columns;
    const emit = (first: number, a: number, b: number, last: number) => {
      // The column's distinct extreme samples, in time order.
      out.push(this._point(first));
      if (a !== first) out.push(this._point(a));
      if (b !== a && b !== first) out.push(this._point(b));
      if (last !== b && last !== a && last !== first) out.push(this._point(last));
    };
    let col = 0;
    // End of the current column; the last column absorbs rounding.
    let colEnd = colSpan > 0 ? t0 + colSpan : Infinity;
    let first = from;
    let last = from;
    let min = from;
    let max = from;
    let minV = V[(head + from) & mask];
    let maxV = minV;
    for (let i = from + 1; i < to; i++) {
      const p = (head + i) & mask;
      const t = T[p];
      const v = V[p];
      if (t >= colEnd && col < columns - 1) {
        emit(first, Math.min(min, max), Math.max(min, max), last);
        // Skip empty columns.
        // Always advance: float error can map t >= colEnd back to `col`.
        col = Math.max(col + 1, Math.min(columns - 1, Math.floor((t - t0) / colSpan)));
        colEnd = col === columns - 1 ? Infinity : t0 + (col + 1) * colSpan;
        first = last = min = max = i;
        minV = maxV = v;
        continue;
      }
      last = i;
      if (v < minV) {
        minV = v;
        min = i;
      } else if (v > maxV) {
        maxV = v;
        max = i;
      }
    }
    emit(first, Math.min(min, max), Math.max(min, max), last);
    return out;
  }
}

/**
 * Largest-Triangle-Three-Buckets downsampling. No longer used by the buffer
 * (which uses M4); kept as a standalone utility. Keeps the first and last points,
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

import { describe, it, expect } from 'vitest';
import { TimeSeriesBuffer, lttb, type TSPoint } from '../src/timeseries';

describe('TimeSeriesBuffer — append & length', () => {
  it('starts empty', () => {
    const b = new TimeSeriesBuffer();
    expect(b.length).toBe(0);
    expect(b.lastT).toBe(-Infinity);
  });

  it('tracks length and lastT on push', () => {
    const b = new TimeSeriesBuffer();
    b.push(100, 1);
    b.push(200, 2);
    expect(b.length).toBe(2);
    expect(b.lastT).toBe(200);
    expect(b.values()).toEqual([1, 2]);
  });

  it('enforces the hard cap by count', () => {
    const b = new TimeSeriesBuffer(5);
    for (let i = 0; i < 20; i++) b.push(i, i);
    expect(b.length).toBe(5);
    // Should retain the most recent 5 values: 15..19
    expect(b.values()).toEqual([15, 16, 17, 18, 19]);
  });
});

describe('TimeSeriesBuffer — time eviction', () => {
  it('drops samples older than the retention horizon', () => {
    const b = new TimeSeriesBuffer();
    for (let t = 0; t <= 1000; t += 100) b.push(t, t / 100);
    // now=1000, retain 500ms → keep t >= 500
    b.evictOlderThan(1000, 500);
    const arr = b.toArray();
    expect(arr.every((p) => p.t >= 500)).toBe(true);
    expect(arr[0].t).toBe(500);
    expect(b.lastT).toBe(1000);
  });

  it('is a no-op when nothing is old enough', () => {
    const b = new TimeSeriesBuffer();
    b.push(900, 1);
    b.push(1000, 2);
    b.evictOlderThan(1000, 5000);
    expect(b.length).toBe(2);
  });

  it('can evict everything if all samples are stale', () => {
    const b = new TimeSeriesBuffer();
    b.push(0, 1);
    b.push(10, 2);
    b.evictOlderThan(100000, 100);
    expect(b.length).toBe(0);
  });
});

describe('TimeSeriesBuffer — windowed slicing', () => {
  it('returns all points when no window is given and under target', () => {
    const b = new TimeSeriesBuffer();
    for (let t = 0; t < 10; t++) b.push(t, t);
    const r = b.windowed(9, undefined, 100);
    expect(r.downsampled).toBe(false);
    expect(r.points.length).toBe(10);
  });

  it('slices to the window', () => {
    const b = new TimeSeriesBuffer();
    for (let t = 0; t <= 1000; t += 100) b.push(t, t);
    const r = b.windowed(1000, 300, 100); // keep t >= 700
    expect(r.points.every((p) => p.t >= 700)).toBe(true);
  });

  it('downsamples when the slice exceeds the target', () => {
    const b = new TimeSeriesBuffer();
    for (let t = 0; t < 5000; t++) b.push(t, Math.sin(t / 50));
    const r = b.windowed(4999, undefined, 200);
    expect(r.downsampled).toBe(true);
    expect(r.points.length).toBe(200);
    // endpoints preserved
    expect(r.points[0].t).toBe(0);
    expect(r.points[r.points.length - 1].t).toBe(4999);
  });

  it('caches the result for identical inputs', () => {
    const b = new TimeSeriesBuffer();
    for (let t = 0; t < 5000; t++) b.push(t, t);
    const r1 = b.windowed(4999, undefined, 200);
    const r2 = b.windowed(4999, undefined, 200);
    expect(r2).toBe(r1); // same object reference → cache hit
  });

  it('invalidates the cache on push', () => {
    const b = new TimeSeriesBuffer();
    for (let t = 0; t < 5000; t++) b.push(t, t);
    const r1 = b.windowed(4999, undefined, 200);
    b.push(5000, 5000);
    const r2 = b.windowed(5000, undefined, 200);
    expect(r2).not.toBe(r1);
    expect(r2.points[r2.points.length - 1].t).toBe(5000);
  });

  it('with recomputeMs, reuses the cached downsample within a time bucket', () => {
    // Windowed case (the real usage): within a 250ms bucket, an added sample
    // should NOT force a recompute — the cached downsample is reused.
    const c = new TimeSeriesBuffer();
    for (let t = 0; t < 5000; t++) c.push(t, Math.sin(t / 30));
    const winMs = 2000;
    const a1 = c.windowed(4999, winMs, 200, 250); // lastT 4999, bucket 19
    c.push(4999.5, 1); // lastT 4999.5, still bucket 19 (4999.5/250 = 19.998 → 19)
    const a2 = c.windowed(4999.5, winMs, 200, 250);
    expect(a2).toBe(a1); // cache hit — same downsample object reused
  });

  it('with recomputeMs, recomputes once the bucket advances', () => {
    const b = new TimeSeriesBuffer();
    for (let t = 0; t <= 5000; t += 1) b.push(t, Math.sin(t / 30));
    const r1 = b.windowed(5000, undefined, 200, 250); // bucket 20
    // Advance well past the bucket.
    for (let t = 5001; t <= 5300; t++) b.push(t, Math.sin(t / 30));
    const r2 = b.windowed(5300, undefined, 200, 250); // bucket 21
    expect(r2).not.toBe(r1);
  });

  it('exact mode (recomputeMs=0) still invalidates on every push', () => {
    const b = new TimeSeriesBuffer();
    for (let t = 0; t < 5000; t++) b.push(t, t);
    const r1 = b.windowed(4999, undefined, 200, 0);
    b.push(4999.1, 1);
    const r2 = b.windowed(4999.1, undefined, 200, 0);
    expect(r2).not.toBe(r1);
  });
});

describe('TimeSeriesBuffer — nearestValueAt (copy-free binary search)', () => {
  it('returns undefined for an empty buffer', () => {
    expect(new TimeSeriesBuffer().nearestValueAt(5)).toBeUndefined();
  });

  it('clamps below and above range to first/last', () => {
    const b = new TimeSeriesBuffer();
    b.push(100, 10);
    b.push(200, 20);
    b.push(300, 30);
    expect(b.nearestValueAt(-50)).toBe(10);
    expect(b.nearestValueAt(99999)).toBe(30);
  });

  it('finds the nearest sample by timestamp', () => {
    const b = new TimeSeriesBuffer();
    b.push(0, 0);
    b.push(100, 10);
    b.push(200, 20);
    expect(b.nearestValueAt(0)).toBe(0);
    expect(b.nearestValueAt(40)).toBe(0); // closer to 0 than 100
    expect(b.nearestValueAt(60)).toBe(10); // closer to 100
    expect(b.nearestValueAt(100)).toBe(10);
    expect(b.nearestValueAt(149)).toBe(10);
    expect(b.nearestValueAt(151)).toBe(20);
  });

  it('matches a brute-force linear scan over random queries', () => {
    const b = new TimeSeriesBuffer(20000);
    for (let i = 0; i < 1000; i++) b.push(i * 3, Math.sin(i / 20) * 40);
    const arr = b.toArray();
    const linear = (t: number) => {
      let best = arr[0];
      let bd = Math.abs(arr[0].t - t);
      for (const p of arr) {
        const d = Math.abs(p.t - t);
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      return best.v;
    };
    for (let k = 0; k < 500; k++) {
      const t = Math.random() * 3000;
      expect(b.nearestValueAt(t)).toBe(linear(t));
    }
  });
});

describe('lttb — downsampling correctness', () => {
  it('returns data unchanged when threshold >= length', () => {
    const data: TSPoint[] = [
      { t: 0, v: 0 },
      { t: 1, v: 1 },
      { t: 2, v: 2 },
    ];
    expect(lttb(data, 5)).toEqual(data);
    expect(lttb(data, 3)).toEqual(data);
  });

  it('always preserves first and last points', () => {
    const data: TSPoint[] = Array.from({ length: 1000 }, (_, i) => ({
      t: i,
      v: Math.sin(i / 10),
    }));
    const out = lttb(data, 50);
    expect(out.length).toBe(50);
    expect(out[0]).toEqual(data[0]);
    expect(out[out.length - 1]).toEqual(data[data.length - 1]);
  });

  it('preserves a sharp spike that naive stride sampling would miss', () => {
    // Flat line with one tall spike at index 500. Stride-by-20 sampling would
    // skip it; LTTB should retain a point at or adjacent to the peak.
    const data: TSPoint[] = Array.from({ length: 1000 }, (_, i) => ({
      t: i,
      v: i === 500 ? 100 : 0,
    }));
    const out = lttb(data, 50);
    const maxV = Math.max(...out.map((p) => p.v));
    expect(maxV).toBe(100); // the spike survived
  });

  it('produces monotonically increasing timestamps', () => {
    const data: TSPoint[] = Array.from({ length: 500 }, (_, i) => ({
      t: i * 3,
      v: Math.random(),
    }));
    const out = lttb(data, 40);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].t).toBeGreaterThan(out[i - 1].t);
    }
  });

  it('handles exactly threshold+1 points', () => {
    const data: TSPoint[] = Array.from({ length: 11 }, (_, i) => ({ t: i, v: i }));
    const out = lttb(data, 10);
    expect(out.length).toBe(10);
    expect(out[0].t).toBe(0);
    expect(out[out.length - 1].t).toBe(10);
  });
});

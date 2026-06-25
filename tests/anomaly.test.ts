import { describe, it, expect } from 'vitest';
import {
  detectStall,
  detectSpike,
  detectThrash,
  detectAnomalies,
  meanStd,
  DEFAULT_ANOMALY_CONFIG,
  type TokenSample,
  type StatusChange,
} from '../src/anomaly';

const cfg = DEFAULT_ANOMALY_CONFIG;

// Build an evenly-spaced token series ending at t=end, spacing ms apart.
const series = (values: number[], end = 10_000, spacing = 100): TokenSample[] =>
  values.map((v, i) => ({ t: end - (values.length - 1 - i) * spacing, v }));

describe('meanStd', () => {
  it('handles empty input', () => {
    expect(meanStd([])).toEqual({ mean: 0, std: 0 });
  });
  it('computes mean and population std', () => {
    const { mean, std } = meanStd([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(mean).toBe(5);
    expect(std).toBeCloseTo(2, 5);
  });
  it('std is 0 for constant series', () => {
    expect(meanStd([7, 7, 7]).std).toBe(0);
  });
});

describe('detectStall', () => {
  it('flags a sustained idle stretch while active', () => {
    // 60 samples at 0 t/s spanning 6s, status active → stall.
    const tokens = series(new Array(60).fill(0), 10_000, 100);
    const a = detectStall(tokens, 'active', 10_000, cfg);
    expect(a).not.toBeNull();
    expect(a!.kind).toBe('stall');
    expect(a!.message).toMatch(/stalled/);
  });

  it('does NOT flag when status is not active/thinking', () => {
    const tokens = series(new Array(60).fill(0), 10_000, 100);
    expect(detectStall(tokens, 'complete', 10_000, cfg)).toBeNull();
    expect(detectStall(tokens, 'stuck', 10_000, cfg)).toBeNull();
  });

  it('does NOT flag a brief idle dip below the duration threshold', () => {
    // Only 1s of idle (10 samples) — under the 5s threshold.
    const tokens = series(new Array(10).fill(0), 10_000, 100);
    expect(detectStall(tokens, 'active', 10_000, cfg)).toBeNull();
  });

  it('does NOT flag when the agent is currently producing tokens', () => {
    const vals = new Array(60).fill(0);
    vals[vals.length - 1] = 15; // latest sample is productive
    const tokens = series(vals, 10_000, 100);
    expect(detectStall(tokens, 'active', 10_000, cfg)).toBeNull();
  });

  it('escalates to critical for a very long stall', () => {
    const tokens = series(new Array(150).fill(0), 20_000, 100); // 15s idle
    const a = detectStall(tokens, 'active', 20_000, cfg);
    expect(a!.severity).toBe('critical');
  });

  it('handles empty token history', () => {
    expect(detectStall([], 'active', 1000, cfg)).toBeNull();
  });
});

describe('detectSpike', () => {
  it('flags a clear outlier above the rolling baseline', () => {
    const vals = new Array(40).fill(10); // steady ~10/s
    vals.push(80); // sudden spike
    const tokens = series(vals, 10_000, 100);
    const a = detectSpike(tokens, cfg);
    expect(a).not.toBeNull();
    expect(a!.kind).toBe('spike');
    expect(a!.value).toBe(80);
  });

  it('does NOT flag when history is too short', () => {
    const tokens = series([10, 12, 80], 10_000, 100); // < spikeMinSamples
    expect(detectSpike(tokens, cfg)).toBeNull();
  });

  it('does NOT divide by zero on a perfectly flat history', () => {
    const vals = new Array(40).fill(10);
    vals.push(10); // no spike, std of baseline is 0
    const tokens = series(vals, 10_000, 100);
    expect(detectSpike(tokens, cfg)).toBeNull();
  });

  it('does NOT flag normal variation within the baseline', () => {
    const vals = Array.from({ length: 41 }, (_, i) => 10 + (i % 3)); // 10,11,12,...
    const tokens = series(vals, 10_000, 100);
    expect(detectSpike(tokens, cfg)).toBeNull();
  });

  it('escalates to critical for an extreme spike', () => {
    const vals = new Array(40).fill(10);
    vals.push(500);
    const tokens = series(vals, 10_000, 100);
    expect(detectSpike(tokens, cfg)!.severity).toBe('critical');
  });
});

describe('detectThrash', () => {
  const changes = (ts: number[]): StatusChange[] =>
    ts.map((t, i) => ({ t, status: i % 2 ? 'stuck' : 'active' }));

  it('flags rapid status oscillation within the window', () => {
    const a = detectThrash(changes([7000, 7500, 8000, 8500, 9000]), 9000, cfg);
    expect(a).not.toBeNull();
    expect(a!.kind).toBe('thrash');
  });

  it('does NOT flag changes spread outside the window', () => {
    // 5 changes but spread over 40s, only 1 inside the 4s window.
    const a = detectThrash(changes([0, 10_000, 20_000, 30_000, 40_000]), 40_000, cfg);
    expect(a).toBeNull();
  });

  it('does NOT flag too few changes', () => {
    expect(detectThrash(changes([8000, 8500]), 9000, cfg)).toBeNull();
  });

  it('handles empty change history', () => {
    expect(detectThrash([], 1000, cfg)).toBeNull();
  });
});

describe('detectAnomalies — integration', () => {
  it('returns an empty array for a healthy agent', () => {
    const vals = Array.from({ length: 40 }, (_, i) => 12 + (i % 2)); // steady
    const tokens = series(vals, 10_000, 100);
    const out = detectAnomalies(tokens, [{ t: 0, status: 'active' }], 'active', 10_000);
    expect(out).toEqual([]);
  });

  it('can surface multiple distinct anomalies at once', () => {
    // Idle stretch (stall) + rapid status changes (thrash).
    const tokens = series(new Array(80).fill(0), 10_000, 100);
    const statusChanges: StatusChange[] = [
      { t: 7000, status: 'active' },
      { t: 7500, status: 'stuck' },
      { t: 8000, status: 'active' },
      { t: 8500, status: 'stuck' },
      { t: 9000, status: 'active' },
    ];
    const out = detectAnomalies(tokens, statusChanges, 'active', 10_000);
    const kinds = out.map((a) => a.kind);
    expect(kinds).toContain('stall');
    expect(kinds).toContain('thrash');
  });
});

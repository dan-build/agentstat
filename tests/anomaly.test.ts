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
    // 12 s at 0 t/s (over the 10 s active limit), status active → stall.
    const tokens = series(new Array(120).fill(0), 12_000, 100);
    const a = detectStall(tokens, 'active', 12_000, cfg);
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
    const tokens = series(new Array(250).fill(0), 30_000, 100); // 25s idle
    const a = detectStall(tokens, 'active', 30_000, cfg);
    expect(a!.severity).toBe('critical');
  });

  it('handles empty token history', () => {
    expect(detectStall([], 'active', 1000, cfg)).toBeNull();
  });
});

describe('detectSpike', () => {
  it('flags a clear outlier above the rolling baseline', () => {
    const vals = new Array(300).fill(10); // steady ~10/s for 30 s
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
    const vals = new Array(300).fill(10);
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
    const tokens = series(new Array(120).fill(0), 10_000, 100);
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

describe('detectors know what normal looks like', () => {
  it('allows a thinking agent to be quiet much longer than an active one', () => {
    const tokens = series(new Array(120).fill(0), 12_000, 100); // 12s idle
    expect(detectStall(tokens, 'active', 12_000, cfg)?.kind).toBe('stall');
    expect(detectStall(tokens, 'thinking', 12_000, cfg)).toBeNull();
    const long = series(new Array(320).fill(0), 40_000, 100); // 32s idle
    expect(detectStall(long, 'thinking', 40_000, cfg)?.message).toMatch(/while thinking/);
  });

  it('does not call starting to stream after a pause a spike', () => {
    const vals = [...new Array(60).fill(0), ...new Array(10).fill(18)];
    expect(detectSpike(series(vals, 10_000, 100), cfg)).toBeNull();
  });

  it('judges spikes against a baseline that earlier spikes cannot inflate', () => {
    // A noisy baseline with a few earlier spikes; a mean/std baseline would
    // widen enough to miss the new one.
    const vals = Array.from({ length: 300 }, (_, i) => 10 + (i % 3) + (i % 50 === 0 ? 60 : 0));
    vals.push(70);
    const a = detectSpike(series(vals, 40_000, 100), cfg);
    expect(a?.kind).toBe('spike');
    expect(a?.message).toMatch(/× the usual peak of ~12\/s/);
  });

  it('looks at the whole last second, not just the latest sample', () => {
    const vals = [...new Array(200).fill(10), 80, 10, 10, 10];
    expect(detectSpike(series(vals, 20_000, 100), cfg)?.value).toBe(80);
  });

  it('keeps an open spike open on weaker evidence (hysteresis)', () => {
    // Steady 10 t/s, then a second at 13 t/s (1.3×): too small to open a
    // spike, enough to keep one open against the baseline it opened with.
    const vals = [...new Array(300).fill(10), ...new Array(10).fill(13)];
    const tokens = series(vals, 31_000, 100);
    expect(detectSpike(tokens, cfg, 31_000)).toBeNull();
    expect(detectSpike(tokens, cfg, 31_000, { since: 29_000, baseline: 10 })).not.toBeNull();
    // …and closes once output is back under 1.2× that baseline.
    const calm = series([...new Array(300).fill(10), ...new Array(10).fill(11)], 31_000, 100);
    expect(detectSpike(calm, cfg, 31_000, { since: 29_000, baseline: 10 })).toBeNull();
  });

  it('keeps a sustained runaway open against the baseline it opened with', () => {
    // 60 s of runaway output: without the remembered baseline it would become
    // its own normal within seconds.
    const vals = [...new Array(300).fill(20), ...new Array(600).fill(100)];
    const tokens = series(vals, 90_000, 100);
    expect(detectSpike(tokens, cfg, 90_000, { since: 30_000, baseline: 22 })?.kind).toBe('spike');
  });

  it('accepts a new level after spikeMaxEpisodeMs', () => {
    const vals = [...new Array(300).fill(20), ...new Array(600).fill(100)];
    const tokens = series(vals, 90_000, 100);
    expect(detectSpike(tokens, { ...cfg, spikeMaxEpisodeMs: 30_000 }, 90_000, { since: 30_000, baseline: 22 })).toBeNull();
  });

  it('never calls resuming after a long pause a spike', () => {
    // 35 s thinking (0 t/s), then normal output.
    const vals = [...new Array(350).fill(0), ...new Array(20).fill(30)];
    for (let k = 5; k <= 20; k++) {
      const tokens = series(vals.slice(0, 350 + k), 35_000 + k * 100, 100);
      expect(detectSpike(tokens, cfg)).toBeNull();
    }
  });

  it('catches a slow, sustained climb', () => {
    // Rate doubles every ~20 s.
    const vals = Array.from({ length: 600 }, (_, i) => 10 * Math.pow(2, i / 200));
    expect(detectSpike(series(vals, 60_000, 100), cfg)?.message).toMatch(/climbing/);
  });

  it('stays quiet for a bursty but healthy agent', () => {
    // Chunked output alternating ~2 and ~25 t/s every second.
    const vals = Array.from({ length: 400 }, (_, i) => (Math.floor(i / 10) % 2 ? 25 + (i % 3) : 2 + (i % 2)));
    expect(detectSpike(series(vals, 40_000, 100), cfg)).toBeNull();
  });

  it('waits for enough history before judging spikes', () => {
    // 2 s of history (under the 3 s warm-up) then a burst.
    const vals = [...new Array(20).fill(10), 80];
    expect(detectSpike(series(vals, 10_000, 100), cfg)).toBeNull();
  });

  it('ignores active↔thinking alternation but counts problem states', () => {
    const benign: StatusChange[] = [6000, 6500, 7000, 7500, 8000, 8500, 9000].map((t, i) => ({
      t,
      status: i % 2 ? 'thinking' : 'active',
    }));
    expect(detectThrash(benign, 9000, cfg)).toBeNull();
    const flapping: StatusChange[] = [6000, 6500, 7000, 7500, 8000, 8500, 9000].map((t, i) => ({
      t,
      status: i % 2 ? 'stuck' : 'active',
    }));
    expect(detectThrash(flapping, 9000, cfg)?.kind).toBe('thrash');
    expect(detectThrash(flapping, 9000, cfg)?.message).toMatch(/active↔stuck/);
  });
});

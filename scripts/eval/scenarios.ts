// scripts/eval/scenarios.ts
//
// Labelled, seeded scenarios for the anomaly detectors. Entry point for
// scripts/eval-detectors.mjs, which bundles this file with esbuild.
//
// Labels mark where an alert of a kind is CORRECT (start..end, seconds). Any
// alert outside its kind's labels (+3 s tolerance) is a false positive.

import { mulberry32, type Rng } from '../../src/simulator';
import { DEFAULT_ANOMALY_CONFIG } from '../../src/anomaly';
import type { AgentSample, AgentStatus } from '../../src/types';
import { gauss, runScenario, TOLERANCE_MS, type Scenario, type ScenarioResult } from './harness';
import { ADVERSARIAL } from './adversarial';
import { HOLDOUT } from './holdout';

export { DEFAULT_ANOMALY_CONFIG, TOLERANCE_MS };

const noisy = (rng: Rng, mean: number, sd: number) => Math.max(0, mean + gauss(rng) * sd);
const act = (tokensRate: number, status: AgentStatus = 'active'): AgentSample => ({ tokensRate, status });

/** Alternating [burstS, pauseS] schedule from a seeded RNG: returns phase lookup. */
function schedule(seed: number, total: number, burst: [number, number], pause: [number, number]) {
  const r = mulberry32(seed);
  const spans: { start: number; end: number; thinking: boolean }[] = [];
  let t = 0;
  let thinking = false;
  while (t < total) {
    const [lo, hi] = thinking ? pause : burst;
    const len = lo + r() * (hi - lo);
    spans.push({ start: t, end: t + len, thinking });
    t += len;
    thinking = !thinking;
  }
  return (tS: number) => spans.find((s) => tS >= s.start && tS < s.end) ?? spans[spans.length - 1];
}

const thinkPhase = schedule(101, 120, [6, 12], [3, 20]);
const reactPhase = schedule(202, 90, [0.8, 1.4], [0.6, 1.2]);

export const SCENARIOS: Scenario[] = [
  {
    name: 'healthy-steady',
    seed: 1,
    durationS: 120,
    labels: [],
    // ~30 t/s, slow drift, Gaussian jitter.
    step: (t, _a, rng) => act(noisy(rng, 30 + 4 * Math.sin(t / 15), 3)),
  },
  {
    name: 'thinking-pauses',
    seed: 2,
    durationS: 120,
    labels: [],
    // Reasoning model: bursts of output, then 3-20 s thinking with no tokens.
    step: (t, _a, rng) => {
      const p = thinkPhase(t);
      return p.thinking ? act(0, 'thinking') : act(noisy(rng, 35, 4));
    },
  },
  {
    name: 'react-loop',
    seed: 3,
    durationS: 90,
    labels: [],
    // Thought -> tool call -> observation, ~1 s each.
    step: (t, _a, rng) => {
      const p = reactPhase(t);
      return p.thinking ? act(0, 'thinking') : act(noisy(rng, 40, 8));
    },
  },
  {
    name: 'ramp-and-resume',
    seed: 4,
    agents: 2,
    durationS: 90,
    labels: [],
    // Agent 0: 2 s TTFT at 0, 3 s ramp to ~40. Agent 1: 3 s TTFT, then first
    // chunk at full rate (no ramp). Both: 8 s thinking at 40 s; abrupt resume.
    step: (t, a, rng) => {
      if (t < 2 + a) return act(0);
      if (a === 0 && t < 5) return act(noisy(rng, ((t - 2) / 3) * 40, 2));
      if (t >= 40 && t < 48) return act(0, 'thinking');
      return act(noisy(rng, 40, 4));
    },
  },
  {
    name: 'runaway-5x',
    seed: 5,
    durationS: 90,
    labels: [{ kind: 'spike', start: 40, end: 60 }],
    step: (t, _a, rng) => act(t >= 40 && t < 60 ? noisy(rng, 100, 10) : noisy(rng, 20, 2.5)),
  },
  {
    name: 'isolated-burst',
    seed: 6,
    durationS: 90,
    labels: [
      // One sample at 5x, between health ticks.
      { kind: 'spike', start: 30.2, end: 30.3 },
      // Two samples at 5x, the second landing on a health tick.
      { kind: 'spike', start: 59.9, end: 60.1 },
    ],
    step: (t, _a, rng) => {
      const ms = Math.round(t * 1000);
      const burst = ms === 30_200 || ms === 59_900 || ms === 60_000;
      return act(burst ? noisy(rng, 100, 3) : noisy(rng, 20, 2.5));
    },
  },
  {
    name: 'level-shift-2x',
    seed: 7,
    durationS: 90,
    // Model switch: a legitimate new steady state. Spike allowed, not required.
    labels: [{ kind: 'spike', start: 40, end: 55, optional: true }],
    step: (t, _a, rng) => act(t < 40 ? noisy(rng, 20, 2.5) : noisy(rng, 40, 5)),
  },
  {
    name: 'stall-active',
    seed: 8,
    durationS: 80,
    labels: [{ kind: 'stall', start: 30, end: 45 }],
    step: (t, _a, rng) => act(t >= 30 && t < 45 ? 0 : noisy(rng, 30, 3)),
  },
  {
    name: 'dropped-stream',
    seed: 9,
    durationS: 80,
    labels: [{ kind: 'stall', start: 30, end: 42 }],
    step: (t, _a, rng) => (t >= 30 && t < 42 ? null : act(noisy(rng, 30, 3))),
  },
  {
    name: 'stuck-flapping',
    seed: 10,
    durationS: 70,
    labels: [{ kind: 'thrash', start: 30, end: 36 }],
    // stuck <-> active every 0.7 s for 6 s, tokens flowing while active.
    step: (t, _a, rng) => {
      if (t >= 30 && t < 36) {
        const stuck = Math.floor((t - 30) / 0.7) % 2 === 0;
        return stuck ? act(0, 'stuck') : act(noisy(rng, 30, 3));
      }
      return act(noisy(rng, 30, 3));
    },
  },
  {
    name: 'bursty-healthy',
    seed: 11,
    durationS: 60,
    // Warm-up (spikeMinSamples, ~2 s, +3 s tolerance) is excused.
    labels: [{ kind: 'spike', start: 0, end: 2, optional: true }],
    step: (t, _a, rng) => act(Math.floor(t) % 2 === 0 ? noisy(rng, 2, 0.5) : noisy(rng, 25, 2)),
  },
  {
    name: 'fleet-10-healthy',
    seed: 12,
    agents: 10,
    durationS: 60,
    labels: [],
    step: (t, a, rng) => act(noisy(rng, 10 + a * 6 + 3 * Math.sin(t / (8 + a)), 1 + a * 0.4)),
  },
  {
    name: 'noisy-low-rate',
    seed: 13,
    durationS: 120,
    labels: [],
    // 1-3 t/s, chunked: ~30% of samples land between chunks at 0.
    step: (_t, _a, rng) => act(rng() < 0.3 ? 0 : 1 + rng() * 2),
  },
  {
    name: 'stall-then-resume-5hz',
    seed: 14,
    durationS: 80,
    periodMs: 200,
    labels: [{ kind: 'stall', start: 25, end: 45 }],
    // 5 Hz telemetry; a 20 s stall while active, then normal output resumes.
    step: (t, _a, rng) => act(t >= 25 && t < 45 ? 0 : noisy(rng, 25, 3)),
  },
];

export function runAll(): ScenarioResult[] {
  return [
    ...SCENARIOS.map((sc) => runScenario(sc, 'original')),
    ...ADVERSARIAL.map((sc) => runScenario(sc, 'adversarial')),
    ...HOLDOUT.map((sc) => runScenario(sc, 'holdout')),
  ];
}

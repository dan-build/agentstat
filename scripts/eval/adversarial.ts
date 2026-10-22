// scripts/eval/adversarial.ts
//
// Scenarios written by an independent reviewer to probe the detectors' blind
// spots (the first rewrite scored 100% on scenarios.ts and ~23% precision on
// these). Kept as a separate set so tuning against one can't hide regressions
// on the other. Labels state what an on-call engineer would want.
import type { Rng } from '../../src/simulator';
import type { AgentSample, AgentStatus } from '../../src/types';
import { gauss, type Scenario } from './harness';

const noisy = (rng: Rng, mean: number, sd: number) => Math.max(0, mean + gauss(rng) * sd);
const act = (tokensRate: number, status: AgentStatus = 'active'): AgentSample => ({ tokensRate, status });
const logn = (rng: Rng, median: number, sigma: number) => median * Math.exp(gauss(rng) * sigma);

export const ADVERSARIAL: Scenario[] = [
  {
    name: 'R01-slow-drift',
    seed: 101, agents: 2, durationS: 120,
    // a0: 2x over 60 s (optional). a1: 8x over 60 s, geometric (runaway that never jumps).
    labels: [
      { agent: 0, kind: 'spike', start: 30, end: 120, optional: true },
      { agent: 1, kind: 'spike', start: 50, end: 120 },
    ],
    step: (t, a, rng) => {
      const g = a === 0 ? 2 : 8;
      const f = t < 30 ? 1 : Math.pow(g, Math.min(60, t - 30) / 60);
      return act(noisy(rng, 20 * f, 2.5 * f));
    },
  },
  {
    name: 'R02-low-baseline-runaway',
    seed: 102, agents: 2, durationS: 90,
    // a0: 2 -> 6 t/s (3x). a1: 0.8 -> 4 t/s (5x, below spikeMinBaselineRate) optional.
    labels: [
      { agent: 0, kind: 'spike', start: 40, end: 60 },
      { agent: 1, kind: 'spike', start: 40, end: 60, optional: true },
    ],
    step: (t, a, rng) => {
      const run = t >= 40 && t < 60;
      if (a === 0) return act(noisy(rng, run ? 6 : 2, run ? 0.6 : 0.3));
      return act(noisy(rng, run ? 4 : 0.8, run ? 0.4 : 0.1));
    },
  },
  {
    name: 'R03-early-runaway',
    seed: 103, agents: 2, durationS: 70,
    // a0: runaway 5x from t=6 s to 40 s (inside warm-up). a1: from 12 s to 40 s.
    labels: [
      { agent: 0, kind: 'spike', start: 6, end: 40 },
      { agent: 1, kind: 'spike', start: 12, end: 40 },
    ],
    step: (t, a, rng) => {
      if (t < 1) return act(0);
      const s = a === 0 ? 6 : 12;
      return act(t >= s && t < 40 ? noisy(rng, 100, 10) : noisy(rng, 20, 2.5));
    },
  },
  {
    name: 'R04-periodic-retry-bursts',
    seed: 104, durationS: 110,
    // From 40 s to 100 s a retry loop bursts 4x for 0.5 s every 3 s.
    labels: [{ kind: 'spike', start: 40, end: 100 }],
    step: (t, _a, rng) => {
      const burst = t >= 40 && t < 100 && (t - 40) % 3 < 0.5;
      return act(burst ? noisy(rng, 80, 5) : noisy(rng, 20, 2.5));
    },
  },
  {
    name: 'R05-thinking-stall-60s',
    seed: 105, durationS: 100,
    labels: [{ kind: 'stall', start: 45, end: 80 }],
    step: (t, _a, rng) => (t >= 20 && t < 80 ? act(0, 'thinking') : act(noisy(rng, 30, 3))),
  },
  {
    name: 'R06-trickle-stall',
    seed: 106, agents: 2, durationS: 90,
    // a0: 30 t/s -> 0.6 t/s trickle at 30-70 s. a1: 0 with a 1 t/s heartbeat every 3 s.
    labels: [{ kind: 'stall', start: 35, end: 70 }],
    step: (t, a, rng) => {
      if (t < 30 || t >= 70) return act(noisy(rng, 30, 3));
      if (a === 0) return act(noisy(rng, 0.6, 0.05));
      return act(Math.round(t * 10) % 30 === 0 ? 1 : 0);
    },
  },
  {
    name: 'R07-stuck-continuous',
    seed: 107, durationS: 100,
    labels: [{ kind: 'stall', start: 30, end: 90, optional: true }],
    step: (t, _a, rng) => (t >= 30 && t < 90 ? act(0, 'stuck') : act(noisy(rng, 30, 3))),
  },
  {
    name: 'R08-queue-worker-complete',
    seed: 108, agents: 2, durationS: 120,
    // a0: queue worker, 1 s active / 0.3 s complete per job. a1: human-paced chat turns.
    labels: [],
    step: (t, a, rng) => {
      if (a === 0) {
        const p = t % 1.3;
        return p < 1 ? act(noisy(rng, 40, 5)) : act(0, 'complete');
      }
      const p = t % 12;
      return p < 7 ? act(noisy(rng, 40, 5)) : act(0, 'complete');
    },
  },
  {
    name: 'R09-hallucinating-flap',
    seed: 109, agents: 2, durationS: 80,
    // a0: active <-> hallucinating every 0.8 s for 6 s. a1: hallucinating once, stays 20 s.
    labels: [
      { agent: 0, kind: 'thrash', start: 30, end: 36 },
      { agent: 1, kind: 'thrash', start: 30, end: 50, optional: true },
    ],
    step: (t, a, rng) => {
      if (a === 0 && t >= 30 && t < 36) {
        const h = Math.floor((t - 30) / 0.8) % 2 === 0;
        return h ? act(noisy(rng, 30, 3), 'hallucinating') : act(noisy(rng, 30, 3));
      }
      if (a === 1 && t >= 30 && t < 50) return act(noisy(rng, 30, 3), 'hallucinating');
      return act(noisy(rng, 30, 3));
    },
  },
  {
    name: 'R10-high-rate-noise',
    seed: 110, agents: 4, durationS: 300,
    // 500/1000/2000 t/s with 15%/30% gaussian; 800 t/s lognormal sigma .35 / .5.
    labels: [{ kind: 'spike', start: 0, end: 12, optional: true }],
    step: (_t, a, rng) => {
      if (a === 0) return act(noisy(rng, 500, 75));
      if (a === 1) return act(noisy(rng, 1000, 300));
      if (a === 2) return act(logn(rng, 2000, 0.35));
      return act(logn(rng, 800, 0.5));
    },
  },
  {
    name: 'R11-sparse-telemetry',
    seed: 111, agents: 2, durationS: 150,
    // a0: one sample every 2 s; a1: one every 1 s (via null). Runaway 5x at 60-100 s.
    periodMs: 1000,
    labels: [{ kind: 'spike', start: 60, end: 100 }],
    step: (t, a, rng) => {
      if (a === 0 && Math.round(t) % 2 === 1) return null;
      return act(t >= 60 && t < 100 ? noisy(rng, 100, 10) : noisy(rng, 20, 2.5));
    },
  },
  {
    name: 'R12-batched-delivery',
    seed: 112, agents: 2, durationS: 100, periodMs: 1000, batch: 10,
    // 10 samples at the same timestamp every 1 s. a0 runaway 5x at 50-70 s; a1 healthy.
    labels: [{ agent: 0, kind: 'spike', start: 50, end: 70 }],
    step: (t, a, rng) => act(a === 0 && t >= 50 && t < 70 ? noisy(rng, 100, 10) : noisy(rng, 20, 2.5)),
  },
  {
    name: 'R13-tool-call-pauses',
    seed: 113, agents: 2, durationS: 180,
    // a0: 6-8 s tool calls in `active` with 0 tokens every ~16 s. a1: 7 s TTFT, then normal.
    labels: [],
    step: (t, a, rng) => {
      if (a === 0) {
        const cyc = Math.floor(t / 16);
        const pause = 6 + (cyc % 3); // 6, 7, 8 s
        return t % 16 < 16 - pause ? act(noisy(rng, 35, 4)) : act(0);
      }
      return t < 7 ? act(0) : act(noisy(rng, 35, 4));
    },
  },
  {
    name: 'R14-stall-then-flush',
    seed: 114, durationS: 90,
    labels: [
      { kind: 'stall', start: 30, end: 42 },
      { kind: 'spike', start: 42, end: 44, optional: true },
    ],
    step: (t, _a, rng) => {
      if (t >= 30 && t < 42) return act(0);
      if (t >= 42 && t < 43) return act(noisy(rng, 120, 10));
      return act(noisy(rng, 30, 3));
    },
  },
  {
    name: 'R15-sustained-runaway',
    seed: 115, durationS: 140,
    labels: [{ kind: 'spike', start: 30, end: 120 }],
    step: (t, _a, rng) => act(t >= 30 && t < 120 ? noisy(rng, 100, 10) : noisy(rng, 20, 2.5)),
  },
  {
    name: 'R16-decay-to-stall',
    seed: 116, durationS: 90,
    labels: [{ kind: 'stall', start: 40, end: 70 }],
    step: (t, _a, rng) => {
      if (t < 20 || t >= 70) return act(noisy(rng, 30, 3));
      const f = Math.max(0, 1 - (t - 20) / 20);
      return act(noisy(rng, 30 * f, 3 * f));
    },
  },
];


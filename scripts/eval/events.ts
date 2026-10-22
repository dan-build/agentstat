// scripts/eval/events.ts
//
// Scenarios for event-based ingest (`push`): integrations that forward raw
// stream events (token chunks, tool calls, start/finish) and let AgentStat
// derive rate and status. Written with the event-ingest change, like
// scenarios.ts; judged separately by a holdout written without seeing it.

import { mulberry32, type Rng } from '../../src/simulator';
import type { AgentEvent, AgentSample } from '../../src/types';
import { gauss, type Scenario } from './harness';

const noisy = (rng: Rng, mean: number, sd: number) => Math.max(0, mean + gauss(rng) * sd);

/** Poisson(lambda) by multiplication (lambda is small here). */
function poisson(rng: Rng, lambda: number): number {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L);
  return k - 1;
}

/**
 * Token chunks arriving in one period [tS, tS + periodS) at `rate` tokens/s,
 * `chunk` tokens each, as a Poisson process. Times in ms from scenario start.
 */
function chunks(rng: Rng, tS: number, periodS: number, rate: number, chunk: number): AgentEvent[] {
  const n = poisson(rng, (rate / chunk) * periodS);
  const out: AgentEvent[] = [];
  for (let i = 0; i < n; i++) out.push({ type: 'tokens', count: chunk, time: (tS + (periodS * (i + rng())) / n) * 1000 });
  return out;
}

type Phase = { start: number; end: number; kind: 'gen' | 'tool' | 'think' | 'idle' | 'hang' | 'silent'; name?: string };

/** Agent loop: think → generate → tool → … from a seeded RNG. */
function loop(seed: number, total: number, gen: [number, number], tool: [number, number], think: [number, number]): Phase[] {
  const r = mulberry32(seed);
  const span = ([lo, hi]: [number, number]) => lo + r() * (hi - lo);
  const out: Phase[] = [];
  let t = 0;
  const kinds = ['think', 'gen', 'tool'] as const;
  for (let i = 0; t < total; i++) {
    const kind = kinds[i % 3];
    const len = span(kind === 'gen' ? gen : kind === 'tool' ? tool : think);
    out.push({ start: t, end: t + len, kind, name: kind === 'tool' ? ['bash', 'read_file', 'search'][i % 3] : undefined });
    t += len;
  }
  return out;
}

const at = (ph: Phase[], t: number) => ph.find((p) => t >= p.start && t < p.end) ?? ph[ph.length - 1];

/**
 * Events for one period of a phase schedule: the transition event when a phase
 * starts in this period, then token chunks while generating.
 */
function phaseEvents(ph: Phase[], tS: number, periodS: number, rng: Rng, rate: number, chunk: number): AgentEvent[] {
  const out: AgentEvent[] = [];
  if (at(ph, tS).kind === 'gen') out.push(...chunks(rng, tS, periodS, rate, chunk));
  ph.forEach((p, i) => {
    if (p.start < tS || p.start >= tS + periodS) return;
    const time = p.start * 1000;
    const prev = ph[i - 1];
    if (prev?.kind === 'tool') out.push({ type: 'tool-end', name: prev.name, time });
    if (p.kind === 'think') out.push({ type: 'start', time });
    if (p.kind === 'tool' || p.kind === 'hang') out.push({ type: 'tool-start', name: p.name, time });
    if (p.kind === 'idle') out.push({ type: 'finish', time });
  });
  return out;
}

// E01: short tool loops.
const SHORT = [0, 1].map((a) => loop(2100 + a, 180, [6, 14], [2, 8], [0.5, 2]));

// E02: coding agent with 5-60 s tool runs; a1's tool hangs from 120 s.
const CODER = [0, 1].map((a) => {
  const ph = loop(2200 + a, 600, [4, 15], [5, 60], [1, 4]);
  if (a === 1) {
    const i = ph.findIndex((p) => p.kind === 'tool' && p.start >= 120);
    ph.splice(i, ph.length - i, { start: ph[i].start, end: 600, kind: 'hang', name: 'bash' });
  }
  return ph;
});
const HANG_START = CODER[1][CODER[1].length - 1].start;

// E04: provider that batches ~1.5 s of output per delivery; cumulative totals,
// reset at each new run.
const BATCH = [0, 1].map((a) => loop(2400 + a, 240, [10, 30], [2, 8], [1, 3]));
const totals = [0, 0];

// E05: rate API (updateAgent) reporting `waiting` during tool calls.
const RATE_TOOLS = [0, 1].map((a) => loop(2500 + a, 300, [5, 15], [10, 90], [1, 3]));

export const EVENTS: Scenario[] = [
  {
    name: 'E01-chunked-events-runaway',
    seed: 2101, agents: 2, durationS: 180, periodMs: 50,
    // 4-token chunks at ~40 t/s between short tool calls. a1 runs away to
    // 160 t/s at 60-140 s without stopping for tools.
    labels: [{ agent: 1, kind: 'spike', start: 60, end: 140 }],
    step: (t, a, rng) => {
      if (a === 1 && t >= 60 && t < 140) return chunks(rng, t, 0.05, 160, 4);
      return phaseEvents(SHORT[a], t, 0.05, rng, 40, 4);
    },
  },
  {
    name: 'E02-tool-heavy-coder-hang',
    seed: 2102, agents: 2, durationS: 600, periodMs: 100,
    // Tool calls up to a minute are normal (status waiting). a1's bash call
    // never returns: a stall once it has waited 5 minutes.
    labels: [{ agent: 1, kind: 'stall', start: HANG_START + 300, end: 600 }],
    step: (t, a, rng) => phaseEvents(CODER[a], t, 0.1, rng, 35, 6),
  },
  {
    name: 'E03-stream-dies-mid-generation',
    seed: 2103, agents: 1, durationS: 120, periodMs: 100,
    // Streams at 50 t/s; at 50 s the connection dies mid-answer: no more
    // events, status still active (no finish). A stall from 50 s.
    labels: [{ kind: 'stall', start: 50, end: 120 }],
    step: (t, _a, rng) => {
      if (t === 0) return [{ type: 'start', time: 0 }];
      return t < 50 ? chunks(rng, t, 0.1, 50, 3) : null;
    },
  },
  {
    name: 'E04-batched-cumulative-totals',
    seed: 2104, agents: 2, durationS: 240, periodMs: 100,
    // Totals delivered every 1.5 s (bursty transport), counter reset per run,
    // finish between runs. Healthy: nothing to report.
    labels: [],
    step: (t, a, rng) => {
      if (t === 0) totals[a] = 0;
      const p = at(BATCH[a], t);
      const out: AgentEvent[] = [];
      for (const q of BATCH[a]) {
        if (q.start < t || q.start >= t + 0.1) continue;
        if (q.kind === 'think') {
          totals[a] = 0;
          out.push({ type: 'start', time: q.start * 1000 });
        }
        if (q.kind === 'tool') out.push({ type: 'finish', time: q.start * 1000 });
      }
      if (p.kind === 'gen') {
        totals[a] += noisy(rng, 30, 4) * 0.1;
        if (Math.round(t * 10) % 15 === 0) out.push({ type: 'tokens', total: Math.round(totals[a]), time: t * 1000 });
      }
      return out;
    },
  },
  {
    name: 'E05-rate-api-waiting-status',
    seed: 2105, agents: 2, durationS: 300, periodMs: 200,
    // updateAgent with tokensRate, reporting `waiting` during 10-90 s tool
    // calls and `thinking` briefly before output. Healthy.
    labels: [],
    step: (t, a, rng): AgentSample => {
      const p = at(RATE_TOOLS[a], t);
      if (p.kind === 'gen') return { tokensRate: noisy(rng, 35, 5), status: 'active' };
      return { tokensRate: 0, status: p.kind === 'tool' ? 'waiting' : 'thinking' };
    },
  },
  {
    name: 'E06-no-first-token',
    seed: 2106, agents: 1, durationS: 150, periodMs: 100,
    // Normal requests (TTFT ~1 s), then at 60 s a request whose first token
    // never comes: stuck in thinking, a stall from 60 s (reported at 30 s).
    labels: [{ kind: 'stall', start: 60, end: 150 }],
    step: (t, _a, rng) => {
      const runStart = Math.floor(t / 15) * 15;
      if (t >= 60) return t === 60 ? [{ type: 'start', time: 60_000 }] : null;
      if (t === runStart) return [{ type: 'start', time: t * 1000 }];
      if (t - runStart >= 1 && t - runStart < 10) return chunks(rng, t, 0.1, 40, 5);
      if (Math.abs(t - runStart - 10) < 1e-9) return [{ type: 'finish', time: t * 1000 }];
      return null;
    },
  },
];

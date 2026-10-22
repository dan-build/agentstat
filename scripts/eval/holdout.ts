// scripts/eval/holdout.ts
//
// HOLDOUT scenarios for the anomaly detectors, written by a reviewer who had
// not seen the detectors' tuning and kept apart from scenarios.ts and
// adversarial.ts. Each one models a situation that shows up in real agent
// telemetry (coding agents, orchestrators, queue workers, chat assistants)
// and is labelled with what an on-call engineer would want to be told.
//
// Conventions (see harness.ts): a label marks where an alert of that kind is
// CORRECT; `optional` = allowed but not required; anything else is an FP.
// Schedules are precomputed from their own seeded RNGs so they don't depend
// on the order in which the harness consumes its RNG. Per-agent state (EMA,
// arrival cursors) resets at t = 0, so a scenario can be replayed.

import { mulberry32, type Rng } from '../../src/simulator';
import type { AgentSample, AgentStatus } from '../../src/types';
import { gauss, type Label, type Scenario } from './harness';

const noisy = (rng: Rng, mean: number, sd: number) => Math.max(0, mean + gauss(rng) * sd);
const logn = (rng: Rng, median: number, sigma: number) => median * Math.exp(gauss(rng) * sigma);
const act = (tokensRate: number, status: AgentStatus = 'active'): AgentSample => ({ tokensRate, status });
const uni = (r: Rng, lo: number, hi: number) => lo + r() * (hi - lo);

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
 * Per-chunk rate as a streaming client computes it: tokens received in the
 * last sample period / period. Chunks of 4 tokens arrive as a Poisson process,
 * so a steady 40 t/s at 20 Hz reads 0, 80, 160, 240 … per sample.
 */
const chunkRate = (rng: Rng, rate: number, periodS: number, chunk = 4) =>
  (poisson(rng, (rate / chunk) * periodS) * chunk) / periodS;

interface Span {
  start: number;
  end: number;
  kind: string;
  rate?: number;
}
const find = (spans: Span[], t: number) => spans.find((s) => t >= s.start && t < s.end) ?? spans[spans.length - 1];

/** Alternating work/pause spans from a seeded RNG. */
function alternating(seed: number, total: number, work: [number, number], pause: [number, number], pauseKind = 'pause') {
  const r = mulberry32(seed);
  const spans: Span[] = [];
  let t = 0;
  let paused = false;
  while (t < total) {
    const len = paused ? uni(r, ...pause) : uni(r, ...work);
    spans.push({ start: t, end: t + len, kind: paused ? pauseKind : 'work' });
    t += len;
    paused = !paused;
  }
  return spans;
}

// ── H03: long tool phases, then a hung tool at 220 s ─────────────────────
const HUNG_AT = 220;
function toolSchedule(seed: number): Span[] {
  const r = mulberry32(seed);
  const spans: Span[] = [];
  let t = 0;
  for (;;) {
    const work = uni(r, 8, 20);
    const tool = uni(r, 15, 40);
    if (t + work + tool > HUNG_AT - 8) break;
    spans.push({ start: t, end: t + work, kind: 'work' });
    spans.push({ start: t + work, end: t + work + tool, kind: 'tool' });
    t += work + tool;
  }
  spans.push({ start: t, end: HUNG_AT, kind: 'work' });
  spans.push({ start: HUNG_AT, end: 1e9, kind: 'hung' });
  return spans;
}
const TOOLS = [toolSchedule(3031), toolSchedule(3032)];
const toolLabels: Label[] = TOOLS.flatMap((spans, agent) => [
  // A normal tool phase is quiet; past 30 s an alert is defensible.
  ...spans
    .filter((s) => s.kind === 'tool' && s.end - s.start > 30)
    .map((s): Label => ({ agent, kind: 'stall', start: s.start + 30, end: s.end, optional: true })),
  { agent, kind: 'stall', start: HUNG_AT, end: 300 },
]);

// ── H05: rate-limit (429) backoff gaps, then a 429 storm ──────────────────
function rateLimitGaps(seed: number): Span[] {
  const r = mulberry32(seed);
  const gaps: Span[] = [];
  let t = uni(r, 8, 15);
  while (t < 95) {
    const len = uni(r, 2, 6);
    gaps.push({ start: t, end: t + len, kind: 'gap' });
    t += len + uni(r, 15, 25);
  }
  // Storm: exponential backoff capped at 8 s, ~1.2 s of output between.
  t = 100;
  for (const len of [2, 4, 8, 8, 8, 8, 8, 8]) {
    gaps.push({ start: t, end: t + len, kind: 'gap' });
    t += len + 1.2;
  }
  return gaps;
}
const GAPS = [rateLimitGaps(5051), rateLimitGaps(5052)];
const inGap = (agent: number, t: number) => GAPS[agent].some((g) => t >= g.start && t < g.end);

// ── H06: reconnect replays the last 3 s of chunks in 0.5 s ────────────────
const BLIPS = [0, 1].map((a) => {
  const r = mulberry32(6060 + a);
  const out: { start: number; end: number }[] = [];
  for (let t = 20 + a * 7; t < 140; t += uni(r, 22, 30)) out.push({ start: t, end: t + uni(r, 1, 2) });
  return out;
});

// ── H08: task churn (complete / cancel → next task immediately) ──────────
function tasks(seed: number, total: number): Span[] {
  const r = mulberry32(seed);
  const spans: Span[] = [];
  let t = 0;
  while (t < total) {
    const ttft = uni(r, 0.5, 3);
    const rate = uni(r, 28, 48);
    const cancelled = r() < 0.25;
    const len = cancelled ? uni(r, 1, 3) : uni(r, 4, 25);
    spans.push({ start: t, end: t + ttft, kind: 'ttft' });
    spans.push({ start: t + ttft, end: t + ttft + len, kind: 'stream', rate });
    spans.push({ start: t + ttft + len, end: t + ttft + len + 0.5, kind: 'complete' });
    t += ttft + len + 0.5;
  }
  return spans;
}
const TASKS = [tasks(8081, 250), tasks(8082, 250), tasks(8083, 250)];

// ── H09 / H10 / H13: background work patterns ────────────────────────────
const LOOP_THINK = [alternating(9091, 300, [10, 20], [3, 8]), alternating(9092, 300, [10, 20], [3, 8])];
const FLEET_THINK = Array.from({ length: 20 }, (_, i) => alternating(1300 + i, 240, [6, 15], [2, 8]));

// ── H14: non-uniform arrival times (jitter, GC pauses, background tab) ───
const ARRIVALS = [0, 1, 2].map((a) => {
  const r = mulberry32(1414 + a);
  const ts: number[] = [];
  let t = 0;
  while (t < 181) {
    ts.push(t);
    const throttled = t >= 40 && t < 70; // background tab: timers clamp to ~1 Hz
    t += throttled ? 1 + (r() - 0.5) * 0.06 : Math.min(2.5, Math.max(0.02, 0.15 * Math.exp(gauss(r) * 0.8)));
  }
  return ts;
});
const cursor = [0, 0, 0];

// ── H15: reconnect after a pause, buffered samples delivered at once ─────
const DISCONNECTS = [
  { start: 60, end: 72, buffered: 120 },
  { start: 140, end: 165, buffered: 250 },
];
const calls = new Map<string, number>();

// ── H17: orchestrator waiting on workers ─────────────────────────────────
const ORCH: Span[] = [
  { start: 0, end: 5, kind: 'plan' },
  { start: 5, end: 55, kind: 'wait' },
  { start: 55, end: 63, kind: 'synth' },
  { start: 63, end: 68, kind: 'plan' },
  { start: 68, end: 133, kind: 'wait' },
  { start: 133, end: 141, kind: 'synth' },
  { start: 141, end: 146, kind: 'plan' },
  { start: 146, end: 186, kind: 'wait' },
  { start: 186, end: 194, kind: 'synth' },
  { start: 194, end: 199, kind: 'plan' },
  { start: 199, end: 1e9, kind: 'hung' }, // workers finish by 240; it never resumes
];
const WORKER_JOBS = [1, 2, 3, 4, 5].map((w) => {
  const r = mulberry32(1700 + w);
  return ORCH.filter((s) => s.kind === 'wait' || s.kind === 'hung').map((s) => {
    const end = Math.min(s.end, 240) - uni(r, 2, 6);
    const start = s.start + uni(r, 0.5, 3);
    return { start, end: start + uni(r, 0.6, 1) * (end - start) };
  });
});

// ── H18: chat assistant that only reports tokensRate ─────────────────────
const CHAT = [0, 1, 2].map((a) => alternating(1800 + a, 300, [3, 15], [4, 90], 'user'));

// ── H02: client-side moving average (EMA, tau 3 s) ───────────────────────
const ema = [0, 0];

export const HOLDOUT: Scenario[] = [
  {
    name: 'H01-chunked-streaming',
    seed: 1001, agents: 2, durationS: 180, periodMs: 50,
    // Rate computed per 50 ms sample from 4-token chunks: 0/80/160/240 t/s for
    // a steady 40 t/s, with 3-10 s thinking pauses. a1 runs away 4x (160 t/s)
    // at 60-140 s — a real runaway the on-call wants.
    labels: [{ agent: 1, kind: 'spike', start: 60, end: 140 }],
    step: (t, a, rng) => {
      const p = find(LOOP_THINK[a], t);
      if (p.kind === 'pause' && !(a === 1 && t >= 60 && t < 140)) return act(0, 'thinking');
      return act(chunkRate(rng, a === 1 && t >= 60 && t < 140 ? 160 : 40, 0.05));
    },
  },
  {
    name: 'H02-client-ema',
    seed: 1002, agents: 2, durationS: 180,
    // The client reports a 3 s EMA (smooth, lagged). a0: real 5x runaway at
    // 60-120 s. a1: real stall (0 t/s) at 60-95 s; the EMA takes ~10 s to decay.
    labels: [
      { agent: 0, kind: 'spike', start: 60, end: 120 },
      { agent: 1, kind: 'stall', start: 60, end: 97 },
    ],
    step: (t, a, rng) => {
      if (t === 0) ema[a] = a === 0 ? 25 : 30;
      const run = t >= 60 && t < (a === 0 ? 120 : 95);
      const raw = a === 0 ? (run ? noisy(rng, 125, 10) : noisy(rng, 25, 3)) : run ? 0 : noisy(rng, 30, 3);
      ema[a] += (1 - Math.exp(-0.1 / 3)) * (raw - ema[a]);
      return act(ema[a]);
    },
  },
  {
    name: 'H03-long-tool-phases',
    seed: 1003, agents: 2, durationS: 300, periodMs: 200,
    // Coding agent: 8-20 s of output, then a 15-40 s tool run (tests, build)
    // with 0 tokens. a0 reports `active` during tools, a1 `thinking`. Normal
    // tool runs should be quiet for 30 s (optional after); a tool that hangs
    // at 220 s and never returns is a required stall.
    labels: toolLabels,
    step: (t, a, rng) => {
      const p = find(TOOLS[a], t);
      if (p.kind === 'work') return act(noisy(rng, 35, 5));
      return act(0, a === 0 ? 'active' : 'thinking');
    },
  },
  {
    name: 'H04-context-compaction',
    seed: 1004, agents: 3, durationS: 240,
    // Every ~60 s the agent compacts its context: 12-25 s silent in `thinking`
    // (a2: 8-9 s silent in `active`), then decodes ~1.3x faster on the short
    // context, easing back as it grows. Routine — no alerts wanted.
    labels: [],
    step: (t, a, rng) => {
      const period = 60 + a * 7;
      const phase = (t + a * 13) % period;
      const silent = a === 2 ? 8 + (Math.floor((t + a * 13) / period) % 2) : 12 + ((Math.floor((t + a * 13) / period) * 7) % 14);
      if (t > 20 && phase < silent) return act(0, a === 2 ? 'active' : 'thinking');
      const boost = t > 20 ? 1 + 0.3 * Math.max(0, 1 - (phase - silent) / 40) : 1;
      return act(noisy(rng, 30 * boost, 3));
    },
  },
  {
    name: 'H05-rate-limit-429',
    seed: 1005, agents: 2, durationS: 200, periodMs: 250,
    // 429 backoffs of 2-6 s every ~20 s (a0 sends nothing, a1 reports 0 while
    // `active`) — routine. 100-160 s: a 429 storm, backoff 2-4-8-8-… s with
    // ~1 s of output between: throughput down ~85%. Alert allowed, not required.
    labels: [{ kind: 'stall', start: 100, end: 163, optional: true }],
    step: (t, a, rng) => {
      if (inGap(a, t)) return a === 0 ? null : act(0);
      return act(noisy(rng, 30, 4));
    },
  },
  {
    name: 'H06-reconnect-replay',
    seed: 1006, agents: 2, durationS: 150,
    // SSE blips of 1-2 s every ~25 s; on resume the server replays the last
    // 3 s of chunks within 0.5 s, so the client counts them twice (~7x for
    // 0.5 s). A telemetry artifact: a burst alert is defensible, nothing else.
    labels: BLIPS.flatMap((bs, agent) =>
      bs.map((b): Label => ({ agent, kind: 'spike', start: b.end, end: b.end + 1, optional: true }))
    ),
    step: (t, a, rng) => {
      for (const b of BLIPS[a]) {
        if (t >= b.start && t < b.end) return null;
        if (t >= b.end && t < b.end + 0.5) return act(noisy(rng, 30, 3) + 6 * 30);
      }
      return act(noisy(rng, 30, 3));
    },
  },
  {
    name: 'H07-model-swap',
    seed: 1007, agents: 2, durationS: 240,
    // Fallback mid-run at 90 s. a0: fast model 120 t/s -> slow 35 t/s (not a
    // stall). a1: slow 30 t/s -> fast 90 t/s (3x): a spike is allowed, and
    // must not fire again for the rest of the run.
    labels: [{ agent: 1, kind: 'spike', start: 90, end: 215, optional: true }],
    step: (t, a, rng) => {
      if (a === 0) return act(t < 90 ? noisy(rng, 120, 12) : noisy(rng, 35, 4));
      return act(t < 90 ? noisy(rng, 30, 3) : noisy(rng, 90, 9));
    },
  },
  {
    name: 'H08-task-churn',
    seed: 1008, agents: 3, durationS: 240,
    // Queue workers: 0.5-3 s TTFT (active, 0 t/s), stream 4-25 s at a per-task
    // decode speed of 28-48 t/s, 25% cancelled after 1-3 s; `complete` for
    // 0.5 s and straight into the next task. a0 reports at 2 Hz. Healthy.
    labels: [],
    step: (t, a, rng) => {
      if (a === 0 && Math.round(t * 10) % 5 !== 0) return null;
      const p = find(TASKS[a], t);
      if (p.kind === 'complete') return act(0, 'complete');
      if (p.kind === 'ttft') return act(0);
      return act(noisy(rng, p.rate!, p.rate! * 0.1));
    },
  },
  {
    name: 'H09-repetition-loop',
    seed: 1009, agents: 2, durationS: 300,
    // Normal: ~25 t/s with 3-8 s thinking pauses. At 100-260 s the model
    // degenerates into repeating itself until max_tokens: flat output, no
    // pauses. a0 at 72 t/s (~2x its usual peak) — required for the whole
    // loop. a1 at 34 t/s (~1x its peak) — invisible to a rate detector, optional.
    labels: [
      { agent: 0, kind: 'spike', start: 100, end: 260 },
      { agent: 1, kind: 'spike', start: 100, end: 260, optional: true },
    ],
    step: (t, a, rng) => {
      if (t >= 100 && t < 260) return act(noisy(rng, a === 0 ? 72 : 34, a === 0 ? 0.5 : 0.3));
      return find(LOOP_THINK[a], t).kind === 'pause' ? act(0, 'thinking') : act(noisy(rng, 25, 5));
    },
  },
  {
    name: 'H10-tool-call-spam',
    seed: 1010, agents: 2, durationS: 180,
    // a0: every 30 s, 6 s of rapid tool calls (active <-> thinking every
    // 0.3 s) — normal fan-out reads. a1: at 40-130 s a tool-call loop, active
    // <-> thinking every 0.25 s for 90 s with tiny outputs: burning budget,
    // the on-call wants to know.
    labels: [{ agent: 1, kind: 'thrash', start: 40, end: 130 }],
    step: (t, a, rng) => {
      const spam = a === 0 ? t % 30 >= 20 && t % 30 < 26 : t >= 40 && t < 130;
      if (spam) {
        const flip = Math.floor(t / (a === 0 ? 0.3 : 0.25)) % 2 === 0;
        return flip ? act(noisy(rng, 20, 4)) : act(0, 'thinking');
      }
      return act(noisy(rng, 35, 4));
    },
  },
  {
    name: 'H11-very-low-rate',
    seed: 1011, agents: 3, durationS: 240, periodMs: 1000,
    // 1 Hz structured-output agents. a0: steady 0.3 t/s (one label token every
    // ~3 s) — working. a1: 0.8 t/s, then nothing at 120-170 s — a real stall.
    // a2: averages 1 t/s as a 4 t/s sample every 4th second.
    labels: [{ agent: 1, kind: 'stall', start: 120, end: 170 }],
    step: (t, a, rng) => {
      if (a === 0) return act(noisy(rng, 0.3, 0.08));
      if (a === 1) return act(t >= 120 && t < 170 ? 0 : noisy(rng, 0.8, 0.15));
      return act(Math.round(t) % 4 === 0 ? 4 : 0);
    },
  },
  {
    name: 'H12-very-high-rate',
    seed: 1012, agents: 4, durationS: 180, periodMs: 50,
    // 2-5k t/s (fast inference hardware). a0: 3000 lognormal. a1: 4500 with a
    // 1 s dip to 1500 every 10 s (prefill contention). a2: 2000 -> 6000 at
    // 80-140 s (runaway, required). a3: 3000 -> 40 t/s at 90-130 s (1.3% of
    // normal: stalled, required).
    labels: [
      { agent: 2, kind: 'spike', start: 80, end: 140 },
      { agent: 3, kind: 'stall', start: 90, end: 130 },
    ],
    step: (t, a, rng) => {
      if (a === 0) return act(logn(rng, 3000, 0.2));
      if (a === 1) return act(logn(rng, t % 10 < 1 ? 1500 : 4500, 0.15));
      if (a === 2) return act(logn(rng, t >= 80 && t < 140 ? 6000 : 2000, 0.15));
      return act(t >= 90 && t < 130 ? noisy(rng, 40, 8) : logn(rng, 3000, 0.2));
    },
  },
  {
    name: 'H13-fleet-20-slow-degrade',
    seed: 1013, agents: 20, durationS: 240, periodMs: 200,
    // 20 agents at 15-72 t/s, every third one with thinking pauses. Agent 7
    // (36 t/s) degrades smoothly over 2 minutes (60-180 s) to ~1 t/s and stays
    // there while `active`: crawling at 3% of normal — page once it's there.
    labels: [{ agent: 7, kind: 'stall', start: 170, end: 240 }],
    step: (t, a, rng) => {
      const base = 15 + 3 * a;
      if (a === 7) {
        if (t < 60) return act(noisy(rng, base, base * 0.12));
        const f = t < 180 ? Math.exp((Math.log(1 / base) * (t - 60)) / 120) : 1 / base;
        return act(noisy(rng, base * f, base * f * 0.12));
      }
      if (a % 3 === 0 && find(FLEET_THINK[a], t).kind === 'pause') return act(0, 'thinking');
      return act(noisy(rng, base, base * 0.12));
    },
  },
  {
    name: 'H14-clock-jitter',
    seed: 1014, agents: 3, durationS: 180, periodMs: 10,
    // Samples arrive at irregular times (lognormal gaps, median 150 ms, some
    // 1-2.5 s event-loop stalls) and at ~1 Hz while the tab is in the
    // background (40-70 s). a0 healthy; a1 runaway 4x at 60-100 s (starts while
    // throttled); a2 stall (0 t/s, active) at 120-150 s.
    labels: [
      { agent: 1, kind: 'spike', start: 60, end: 100 },
      { agent: 2, kind: 'stall', start: 120, end: 150 },
    ],
    step: (t, a, rng) => {
      if (t === 0) cursor[a] = 0;
      const ts = ARRIVALS[a];
      if (cursor[a] >= ts.length || ts[cursor[a]] >= t + 0.01) return null;
      while (cursor[a] < ts.length && ts[cursor[a]] < t + 0.01) cursor[a]++;
      if (a === 1 && t >= 60 && t < 100) return act(noisy(rng, 120, 12));
      if (a === 2 && t >= 120 && t < 150) return act(0);
      return act(noisy(rng, 30, 3));
    },
  },
  {
    name: 'H15-reconnect-catch-up',
    seed: 1015, agents: 2, durationS: 200, batch: 300,
    // The dashboard's websocket drops for 12 s and 25 s; on reconnect the
    // buffered samples are delivered in one batch (all stamped at arrival).
    // a0: 120 / 250 normal samples at once. a1: the client folds the backlog
    // into one rate sample (30 t/s x 12 s / 0.1 s = 3600 t/s). The gap may
    // read as a stall (indistinguishable from a dropped stream); the a1
    // artifact may read as a burst; nothing else should fire.
    labels: [
      { kind: 'stall', start: 60, end: 75, optional: true },
      { kind: 'stall', start: 140, end: 168, optional: true },
      { agent: 1, kind: 'spike', start: 72, end: 75, optional: true },
      { agent: 1, kind: 'spike', start: 165, end: 168, optional: true },
    ],
    step: (t, a, rng) => {
      const key = `${a}:${Math.round(t * 1000)}`;
      const n = (calls.get(key) ?? 0) + 1;
      calls.set(key, n);
      if (t === 0 && n === 1) for (const k of [...calls.keys()]) if (k !== key) calls.delete(k);
      const d = DISCONNECTS.find((x) => t >= x.start && t < x.end);
      if (d) return null;
      const back = DISCONNECTS.find((x) => Math.abs(t - x.end) < 1e-9);
      if (back && a === 0) return n <= back.buffered + 1 ? act(noisy(rng, 30, 3)) : null;
      if (n > 1) return null;
      if (back) return act((30 * (back.end - back.start)) / 0.1);
      return act(noisy(rng, 30, 3));
    },
  },
  {
    name: 'H16-hallucinating-status',
    seed: 1016, agents: 2, durationS: 220,
    // The caller's grounding check sets `hallucinating` at 60-150 s. a0 keeps
    // streaming normally. a1 stops producing at 70 s, and at 150 s the caller
    // resets status to `active` though it's still wedged (until 200 s): that
    // is a required stall. Anything during the flagged period is optional.
    labels: [
      ...(['stall', 'spike', 'thrash'] as const).map((kind): Label => ({ kind, start: 60, end: 153, optional: true })),
      { agent: 1, kind: 'stall', start: 150, end: 200 },
    ],
    step: (t, a, rng) => {
      const flagged = t >= 60 && t < 150;
      if (a === 1 && t >= 70 && t < 200) return act(0, flagged ? 'hallucinating' : 'active');
      return act(noisy(rng, 30, 3), flagged ? 'hallucinating' : 'active');
    },
  },
  {
    name: 'H17-orchestrator-wait',
    seed: 1017, agents: 6, durationS: 300,
    // a0 orchestrates a1-a5: plans (5 s), waits in `thinking` with 0 tokens
    // while workers run (50, 65, 40 s), synthesises (8 s). Waiting on workers
    // is its job — no alerts. The 4th wait never ends: workers are all done by
    // 240 s and it never resumes (required from 239 s). Workers stream jobs and
    // sit `complete` between them.
    labels: [{ agent: 0, kind: 'stall', start: 239, end: 300 }],
    step: (t, a, rng) => {
      if (a === 0) {
        const p = find(ORCH, t);
        return p.kind === 'wait' || p.kind === 'hung' ? act(0, 'thinking') : act(noisy(rng, 40, 5));
      }
      const job = WORKER_JOBS[a - 1].find((j) => t >= j.start && t < j.end);
      return job ? act(noisy(rng, 45, 6)) : act(0, 'complete');
    },
  },
  {
    name: 'H18-rate-only-chat',
    seed: 1018, agents: 3, durationS: 300, periodMs: 200,
    // A chat assistant integrated with tokensRate only (status never sent, so
    // it stays at its initial `active`): 3-15 s replies, then 4-90 s waiting
    // for the user at 0 t/s. Nobody wants a page because a user is typing.
    labels: [],
    step: (t, a, rng) => ({ tokensRate: find(CHAT[a], t).kind === 'user' ? 0 : noisy(rng, 45, 6) }),
  },
];

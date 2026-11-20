// scripts/eval/holdout3.ts
//
// Third holdout set, written blind to the detector code. About half the
// scenarios concern start-up behaviour (slow first seconds, reasoning silence,
// agents joining late, runaways and stalls that begin early); the rest cover
// steady-state work, true positives and transport nuisances.
//
// Labels are from an on-call engineer's point of view and follow the same
// judgement calls as holdout2:
// - Tool calls and subagent waits of up to ~4 minutes are normal. A wait is only
//   a required stall after 5 minutes of total silence on a call that never returns.
// - A reasoning model thinking up to 60 s before output is normal for that
//   agent; an alert during a >30 s think is tolerated (optional), not required.
// - Fast active/thinking/waiting cycling is how tool-heavy agents work. Thrash
//   is required only when a problem state (`stuck`, `hallucinating`) flaps.
// - A normal first burst after a slow start is not a spike.
//
// Every schedule is precomputed at module load from its own seeded RNG.

import { gauss, type Label, type Scenario } from './harness';
import { mulberry32, type Rng } from '../../src/simulator';
import type { AgentEvent, AgentSample, AgentStatus } from '../../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TEvent = AgentEvent & { time: number };

const uni = (r: Rng, a: number, b: number): number => a + (b - a) * r();
const int = (r: Rng, a: number, b: number): number => Math.floor(uni(r, a, b + 1));
const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const sec = (ms: number): number => +(ms / 1000).toFixed(2);

/** Builds one agent's event timeline with a moving cursor (ms from scenario start). */
class TL {
  t = 0;
  readonly ev: TEvent[] = [];
  constructor(readonly r: Rng) {}
  emit(e: AgentEvent): this {
    this.ev.push({ ...e, time: this.t } as TEvent);
    return this;
  }
  gap(ms: number): this {
    this.t += Math.max(0, ms);
    return this;
  }
  until(ms: number): this {
    this.t = Math.max(this.t, ms);
    return this;
  }
  start(): this {
    return this.emit({ type: 'start' });
  }
  finish(): this {
    return this.emit({ type: 'finish' });
  }
  error(): this {
    return this.emit({ type: 'error' });
  }
  toolStart(name: string): this {
    return this.emit({ type: 'tool-start', name });
  }
  toolEnd(name: string, error = false): this {
    return this.emit(error ? { type: 'tool-end', name, error: true } : { type: 'tool-end', name });
  }
  tool(name: string, ms: number, error = false): this {
    return this.toolStart(name).gap(ms).toolEnd(name, error);
  }
  tokens(n: number): this {
    return this.emit({ type: 'tokens', count: n });
  }
  /** Stream `n` tokens at roughly `rate` tok/s in chunks with jittery gaps. */
  stream(
    n: number,
    rate: number,
    o: { cmin?: number; cmax?: number; jitter?: number; hiccup?: number } = {}
  ): this {
    const { cmin = 1, cmax = 20, jitter = 0.6, hiccup = 0.02 } = o;
    let left = Math.max(1, Math.round(n));
    while (left > 0) {
      const c = Math.min(left, int(this.r, cmin, cmax));
      this.tokens(c);
      left -= c;
      if (left > 0) {
        const base = (c / rate) * 1000 * Math.exp(jitter * gauss(this.r) - (jitter * jitter) / 2);
        this.gap(base + (this.r() < hiccup ? uni(this.r, 300, 1200) : 0));
      }
    }
    return this;
  }
}

/** Events whose time lies in [ms, ms + period). */
function lookup(ev: TEvent[], ms: number, period: number): AgentEvent[] {
  let lo = 0;
  let hi = ev.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (ev[m].time < ms) lo = m + 1;
    else hi = m;
  }
  const out: AgentEvent[] = [];
  for (let i = lo; i < ev.length && ev[i].time < ms + period; i++) out.push(ev[i]);
  return out;
}

const eventStep =
  (tls: TL[], period = 100) =>
  (tS: number, a: number): AgentEvent[] =>
    lookup(tls[a].ev, Math.round(tS * 1000), period);

/** Tool-using coding agent; returns right after a `start` once the cursor passes `untilMs`. */
function codingAgent(tl: TL, untilMs: number, o: { longTools?: boolean; rate?: [number, number] } = {}): TL {
  const r = tl.r;
  const [rlo, rhi] = o.rate ?? [45, 80];
  tl.start();
  while (tl.t < untilMs) {
    tl.gap(uni(r, 400, 2500));
    tl.stream(int(r, 30, 400), uni(r, rlo, rhi));
    const x = r();
    if (x < 0.45) tl.tool(pick(r, ['read_file', 'grep', 'list_dir']), uni(r, 150, 1500));
    else if (x < 0.7) tl.tool('edit_file', uni(r, 300, 2000), r() < 0.05);
    else if (x < 0.9)
      tl.tool('run_tests', o.longTools ? uni(r, 20_000, 180_000) : uni(r, 5_000, 40_000), r() < 0.4);
    else tl.tool('build', o.longTools ? uni(r, 60_000, 150_000) : uni(r, 8_000, 30_000), r() < 0.15);
    tl.gap(uni(r, 5, 60)).start();
    if (r() < 0.08) {
      tl.gap(uni(r, 400, 2000)).stream(int(r, 80, 300), uni(r, rlo, rhi)).finish();
      tl.gap(uni(r, 2_000, 15_000)).start();
    }
  }
  return tl;
}

/** Chat completion endpoint: request, TTFT, stream, finish, idle. */
function chatAgent(tl: TL, untilMs: number, idle: [number, number] = [3_000, 25_000]): TL {
  const r = tl.r;
  while (tl.t < untilMs) {
    tl.start();
    tl.gap(r() < 0.1 ? uni(r, 3_000, 8_000) : uni(r, 300, 3_000));
    tl.stream(int(r, 80, 700), uni(r, 40, 90));
    tl.finish();
    tl.gap(uni(r, idle[0], idle[1]));
  }
  return tl;
}

/** Tight tool loop: short model turn, short tool call, repeat. */
function fastToolLoop(tl: TL, untilMs: number): TL {
  const r = tl.r;
  while (tl.t < untilMs) {
    tl.start().gap(uni(r, 150, 500)).stream(int(r, 10, 80), uni(r, 60, 100));
    tl.tool(pick(r, ['read_file', 'grep', 'bash', 'edit_file']), uni(r, 100, 600), r() < 0.05).gap(uni(r, 5, 30));
  }
  return tl;
}

/** Sample-API timeline: one entry per period (null = nothing sent). */
class OldTL {
  readonly s: (AgentSample | null)[] = [];
  errors = 0;
  progress = 0;
  constructor(
    readonly r: Rng,
    readonly period = 100,
    readonly noise = 0.12
  ) {}
  get t(): number {
    return this.s.length * this.period;
  }
  /** One phase whose rate is `fn(f)`, f running 0..1 across the phase. */
  shape(ms: number, status: AgentStatus, fn: (f: number) => number): this {
    const n = Math.max(1, Math.round(ms / this.period));
    for (let i = 0; i < n; i++) {
      const level = fn(i / n);
      const rate = level > 0 ? Math.max(0, level * (1 + this.noise * gauss(this.r))) : 0;
      if (status === 'active') {
        this.progress += 0.03;
        if (this.progress > 100) this.progress = 0;
      }
      this.s.push({
        tokensRate: +rate.toFixed(1),
        progress: +this.progress.toFixed(1),
        status,
        errorCount: this.errors,
      });
    }
    return this;
  }
  phase(ms: number, status: AgentStatus, level: number): this {
    return this.shape(ms, status, () => level);
  }
}

/** Bursty planner: output bursts alternating with short thinking. Returns after an `active` phase. */
function planner(o: OldTL, untilMs: number, rate: [number, number] = [35, 75]): OldTL {
  const r = o.r;
  o.phase(uni(r, 4_000, 12_000), 'active', uni(r, rate[0], rate[1]));
  while (o.t < untilMs) {
    o.phase(uni(r, 2_000, 8_000), 'thinking', 0);
    o.phase(uni(r, 5_000, 20_000), 'active', uni(r, rate[0], rate[1]));
  }
  return o;
}

/** Agent that reports tool phases as `waiting` (mostly short, sometimes up to ~3 min). */
function toolAgent(o: OldTL, untilMs: number): OldTL {
  const r = o.r;
  o.phase(uni(r, 3_000, 10_000), 'active', uni(r, 30, 70));
  while (o.t < untilMs) {
    o.phase(uni(r, 1_000, 5_000), 'thinking', 0);
    const x = r();
    if (x < 0.15) o.phase(uni(r, 60_000, 170_000), 'waiting', 0);
    else if (x < 0.75) o.phase(uni(r, 3_000, 20_000), 'waiting', 0);
    o.phase(uni(r, 1_000, 3_000), 'thinking', 0);
    o.phase(uni(r, 5_000, 30_000), 'active', uni(r, 30, 70));
  }
  return o;
}

const oldStep =
  (tls: OldTL[]) =>
  (tS: number, a: number): AgentSample | null =>
    tls[a].s[Math.round((tS * 1000) / tls[a].period)] ?? null;

// ---------------------------------------------------------------------------
// Start-up scenarios
// ---------------------------------------------------------------------------

// S01 — Sample API. A research agent spends its first ~28 s reading the task
// (status `thinking`, 1-4 tok/s reasoning trickle), then produces its first
// real burst at 80 tok/s and settles into planner bursts. The first burst is
// the agent's normal output, not a spike. Healthy.
const S01: Scenario = (() => {
  const DUR = 180;
  const o = new OldTL(mulberry32(3101));
  o.shape(28_000, 'thinking', () => uni(o.r, 1, 4));
  o.phase(12_000, 'active', 80);
  planner(o, DUR * 1000 + 1000, [50, 85]);
  return { name: 'S01-slow-start-then-first-burst', seed: 31, durationS: DUR, labels: [], step: oldStep([o]) };
})();

// S02 — Event API. A reasoning model's very first request thinks silently for
// 40 s (this model routinely thinks 10-60 s), then streams at ~110 tok/s with
// tool calls. The silence past 30 s is a gray zone: an alert is tolerated, not
// required. The big first burst afterwards is normal.
const S02: Scenario = (() => {
  const DUR = 240;
  const tl = new TL(mulberry32(3201));
  const r = tl.r;
  tl.start().gap(40_000);
  const labels: Label[] = [{ kind: 'stall', start: 30, end: sec(tl.t), optional: true }];
  tl.stream(900, 110).tool('python', uni(r, 2_000, 8_000)).gap(20);
  while (tl.t < DUR * 1000) {
    tl.start().gap(uni(r, 4_000, 25_000)).stream(int(r, 200, 1200), uni(r, 80, 140));
    if (r() < 0.5) tl.tool(pick(r, ['python', 'search']), uni(r, 1_000, 15_000)).gap(20);
    else tl.finish().gap(uni(r, 3_000, 15_000));
  }
  return { name: 'S02-reasoning-first-request-silent-40s', seed: 32, durationS: DUR, labels, step: eventStep([tl]) };
})();

// S03 — Event API. Two chat agents that begin streaming immediately at t=0
// (no warm-up), at 60-80 tok/s with idle gaps. Starting at full speed is normal.
const S03: Scenario = (() => {
  const DUR = 180;
  const tls = [0, 1].map((i) => {
    const tl = new TL(mulberry32(3301 + i));
    tl.start().stream(int(tl.r, 300, 600), uni(tl.r, 60, 80)).finish().gap(uni(tl.r, 3_000, 12_000));
    return chatAgent(tl, DUR * 1000);
  });
  return { name: 'S03-starts-at-full-speed', seed: 33, agents: 2, durationS: DUR, labels: [], step: eventStep(tls) };
})();

// S04 — Event API. Three agents; agent 0 has run since the start, agent 1
// appears at 90 s and agent 2 at 150 s (first event is a start followed
// directly by a burst). Late joiners are not anomalies in themselves.
const S04: Scenario = (() => {
  const DUR = 300;
  const a0 = codingAgent(new TL(mulberry32(3401)), DUR * 1000);
  const a1 = new TL(mulberry32(3402)).until(90_000);
  codingAgent(a1, DUR * 1000);
  const a2 = new TL(mulberry32(3403)).until(150_000);
  a2.start().gap(600).stream(400, 70);
  codingAgent(a2, DUR * 1000);
  return { name: 'S04-agents-join-midway', seed: 34, agents: 3, durationS: DUR, labels: [], step: eventStep([a0, a1, a2]) };
})();

// S05 — Sample API. Agent 1 is a runaway from its first seconds: after 4 s of
// 2 tok/s thinking it emits 300 tok/s without a break for ~50 s (agent 0 on
// the same fleet runs 35-75 tok/s). A generation loop right at start-up still
// needs paging. Required spike from 10 s.
const S05: Scenario = (() => {
  const DUR = 120;
  const a0 = planner(new OldTL(mulberry32(3501)), DUR * 1000 + 1000);
  const a1 = new OldTL(mulberry32(3502));
  a1.phase(4_000, 'thinking', 2);
  a1.phase(50_000, 'active', 300);
  a1.phase(DUR * 1000 + 1000 - a1.t, 'complete', 0);
  const labels: Label[] = [{ agent: 1, kind: 'spike', start: 10, end: 54 }];
  return { name: 'S05-runaway-from-the-start', seed: 35, agents: 2, durationS: DUR, labels, step: oldStep([a0, a1]) };
})();

// S06 — Event API. A coding agent works normally for ~20 s of its run, then a
// streaming response goes silent mid-generation (status `active`, no tool
// open, dropped connection) for 70 s before the client errors and retries.
// Early in the run, but still a real stall.
const S06: Scenario = (() => {
  const DUR = 240;
  const tl = codingAgent(new TL(mulberry32(3601)), 18_000);
  tl.gap(800).stream(120, 60);
  const s0 = tl.t;
  tl.gap(70_000);
  const s1 = tl.t;
  tl.error().gap(500);
  codingAgent(tl, DUR * 1000);
  const labels: Label[] = [{ kind: 'stall', start: sec(s0), end: sec(s1) }];
  return { name: 'S06-early-stall-mid-generation', seed: 36, durationS: DUR, labels, step: eventStep([tl]) };
})();

// S07 — Sample API. Four agents of different speeds (30, 60, 90, 120 tok/s)
// each start with 10-25 s of low-rate thinking (1-4 tok/s) at staggered
// moments, then burst at their own speed. Healthy fleet warm-up.
const S07: Scenario = (() => {
  const DUR = 200;
  const speeds = [30, 60, 90, 120];
  const tls = speeds.map((sp, i) => {
    const o = new OldTL(mulberry32(3701 + i));
    o.phase(i * 4_000, 'complete', 0);
    o.shape(uni(o.r, 10_000, 25_000), 'thinking', () => uni(o.r, 1, 4));
    o.phase(uni(o.r, 8_000, 15_000), 'active', sp);
    return planner(o, DUR * 1000 + 1000, [sp * 0.7, sp * 1.1]);
  });
  return { name: 'S07-staggered-warmup-four-speeds', seed: 37, agents: 4, durationS: DUR, labels: [], step: oldStep(tls) };
})();

// S08 — Sample API. Agent boots and sits `thinking` at ~0 tok/s for 150 s: a
// non-reasoning agent that normally thinks 1-5 s between bursts, stuck on
// start-up. With no history yet, a think of up to 60 s could be normal (the
// set's judgement call), so 30-60 s is optional; past 60 s it's required. It
// then recovers and runs normally.
const S08: Scenario = (() => {
  const DUR = 300;
  const o = new OldTL(mulberry32(3801));
  o.phase(150_000, 'thinking', 0);
  o.phase(8_000, 'active', 60);
  planner(o, DUR * 1000 + 1000);
  const labels: Label[] = [
    { kind: 'stall', start: 30, end: 60, optional: true },
    { kind: 'stall', start: 60, end: 150 },
  ];
  return { name: 'S08-stuck-thinking-at-boot', seed: 38, durationS: DUR, labels, step: oldStep([o]) };
})();

// S09 — Sample API. Agent flaps `hallucinating`/`active` every 0.2-0.5 s for
// ~15 s starting 10 s into its life (grounding check failing on a bad first
// retrieval), with output continuing at 40 tok/s. Required thrash.
const S09: Scenario = (() => {
  const DUR = 150;
  const o = new OldTL(mulberry32(3901));
  o.phase(10_000, 'active', 45);
  const t0 = o.t;
  while (o.t < t0 + 15_000) o.phase(uni(o.r, 200, 500), 'hallucinating', 40).phase(uni(o.r, 200, 500), 'active', 40);
  const t1 = o.t;
  planner(o, DUR * 1000 + 1000);
  const labels: Label[] = [{ kind: 'thrash', start: sec(t0), end: sec(t1) }];
  return { name: 'S09-early-hallucination-flapping', seed: 39, durationS: DUR, labels, step: oldStep([o]) };
})();

// S10 — Event API. A fleet of three coding agents spun up together: each has
// a 5-20 s silence after `start` (cold model load), then runs normally. Slow
// cold starts are not stalls. Healthy.
const S10: Scenario = (() => {
  const DUR = 200;
  const tls = [0, 1, 2].map((i) => {
    const tl = new TL(mulberry32(4001 + i));
    tl.until(i * 1_500).start().gap(uni(tl.r, 5_000, 20_000)).stream(150, 60);
    tl.tool('read_file', 800).gap(20);
    return codingAgent(tl, DUR * 1000);
  });
  return { name: 'S10-cold-start-silence-fleet', seed: 40, agents: 3, durationS: DUR, labels: [], step: eventStep(tls) };
})();

// S11 — Event API. A short tool call, then one long summary of 3000 tokens at
// 70 tok/s (about 43 s of continuous streaming) early in the run. Long but not
// fast; healthy.
const S11: Scenario = (() => {
  const DUR = 200;
  const tl = new TL(mulberry32(4101));
  tl.start().stream(200, 70).tool('fetch_doc', 3_000).gap(20).start().gap(900).stream(3000, 70);
  tl.finish().gap(5_000);
  chatAgent(tl, DUR * 1000);
  return { name: 'S11-long-steady-first-answer', seed: 41, durationS: DUR, labels: [], step: eventStep([tl]) };
})();

// ---------------------------------------------------------------------------
// Steady state and normal variety
// ---------------------------------------------------------------------------

// T01 — Sample API. Two planner agents alternating output (35-75 tok/s) and
// thinking (2-8 s) for 6 min. Healthy.
const T01: Scenario = (() => {
  const DUR = 360;
  const tls = [0, 1].map((i) => planner(new OldTL(mulberry32(4201 + i)), DUR * 1000 + 1000));
  return { name: 'T01-bursty-planners', seed: 42, agents: 2, durationS: DUR, labels: [], step: oldStep(tls) };
})();

// T02 — Sample API at 5 Hz. Steady streamers whose rate swells slowly between
// 40 and 90 tok/s over a ~90 s period; no pauses. Slow swells are normal.
const T02: Scenario = (() => {
  const DUR = 360;
  const tls = [0, 1].map((i) => {
    const o = new OldTL(mulberry32(4301 + i), 200, 0.08);
    const phase = i * 1.7;
    const total = DUR * 1000 + 1000;
    o.shape(total, 'active', (f) => 65 + 25 * Math.sin(phase + ((f * total) / 90_000) * 2 * Math.PI));
    return o;
  });
  return { name: 'T02-slow-swell-streamers-5hz', seed: 43, agents: 2, durationS: DUR, periodMs: 200, labels: [], step: oldStep(tls) };
})();

// T03 — Event API. Coding agent with long test/build waits (20 s-3 min) for
// 10 min. Long tool waits are the job. Healthy.
const T03: Scenario = (() => {
  const DUR = 600;
  const tl = codingAgent(new TL(mulberry32(4401)), DUR * 1000, { longTools: true });
  return { name: 'T03-long-tool-waits', seed: 44, durationS: DUR, labels: [], step: eventStep([tl]) };
})();

// T04 — Sample API. A deploy agent waits (`waiting`, rate 0) 220 s for a
// rollout to finish between active phases. Under the 4-minute normal limit.
const T04: Scenario = (() => {
  const DUR = 420;
  const o = new OldTL(mulberry32(4501));
  o.phase(8_000, 'active', 50).phase(3_000, 'thinking', 0).phase(220_000, 'waiting', 0);
  o.phase(2_000, 'thinking', 0).phase(10_000, 'active', 55);
  toolAgent(o, DUR * 1000 + 1000);
  return { name: 'T04-220s-deploy-wait', seed: 45, durationS: DUR, labels: [], step: oldStep([o]) };
})();

// T05 — Event API. Two agents in tight tool loops (status churn every ~1.5 s,
// 5% tool errors that are retried). Normal behaviour, not thrash.
const T05: Scenario = (() => {
  const DUR = 200;
  const tls = [0, 1].map((i) => fastToolLoop(new TL(mulberry32(4601 + i)), DUR * 1000));
  return { name: 'T05-tool-loop-churn-healthy', seed: 46, agents: 2, durationS: DUR, labels: [], step: eventStep(tls) };
})();

// ---------------------------------------------------------------------------
// True positives
// ---------------------------------------------------------------------------

// P01 — Sample API. A normal bursty agent (thinking gaps of 2-8 s) freezes
// with status `active` but 0 tok/s for 45 s, then resumes. Required stall
// across the silent stretch.
const P01: Scenario = (() => {
  const DUR = 300;
  const o = planner(new OldTL(mulberry32(4701)), 100_000);
  const s0 = o.t;
  o.phase(45_000, 'active', 0);
  const s1 = o.t;
  planner(o, DUR * 1000 + 1000);
  const labels: Label[] = [{ kind: 'stall', start: sec(s0), end: sec(s1) }];
  return { name: 'P01-active-but-silent', seed: 47, durationS: DUR, labels, step: oldStep([o]) };
})();

// P02 — Event API. Coding agent (45-80 tok/s) enters a repetition loop that
// streams 220 tok/s for 60 s, but the loop emits a ~1 s pause every ~12 s (the
// provider re-chunks). Sustained far above normal: one required spike from
// start to end of the loop, dips included.
const P02: Scenario = (() => {
  const DUR = 300;
  const tl = codingAgent(new TL(mulberry32(4801)), 100_000);
  tl.gap(700).stream(80, 60);
  const l0 = tl.t;
  while (tl.t < l0 + 60_000) {
    tl.stream(uni(tl.r, 10, 14) * 220, 220, { cmin: 8, cmax: 20, jitter: 0.3, hiccup: 0 });
    tl.gap(uni(tl.r, 900, 1500));
  }
  const l1 = tl.t;
  tl.finish().gap(4_000);
  codingAgent(tl, DUR * 1000);
  const labels: Label[] = [{ kind: 'spike', start: sec(l0), end: sec(l1) }];
  return { name: 'P02-pulsing-runaway-with-dips', seed: 48, durationS: DUR, labels, step: eventStep([tl]) };
})();

// P03 — Sample API. Agent at ~50 tok/s ramps linearly to 250 tok/s over 20 s,
// holds 40 s, then drops back. The rate passes 3x normal at ~10 s into the
// ramp; required spike from there until the hold ends.
const P03: Scenario = (() => {
  const DUR = 240;
  const o = planner(new OldTL(mulberry32(4901)), 90_000, [45, 55]);
  o.phase(2_000, 'active', 50);
  const r0 = o.t;
  o.shape(20_000, 'active', (f) => 50 + 200 * f);
  o.phase(40_000, 'active', 250);
  const r1 = o.t;
  planner(o, DUR * 1000 + 1000, [45, 55]);
  const labels: Label[] = [{ kind: 'spike', start: sec(r0) + 10, end: sec(r1) }];
  return { name: 'P03-ramping-runaway', seed: 49, durationS: DUR, labels, step: oldStep([o]) };
})();

// P04 — Sample API. Three agents at 30-70 tok/s; agent 2 runs at 5x its
// normal (~300 tok/s) for 30 s. Required spike on agent 2 only.
const P04: Scenario = (() => {
  const DUR = 240;
  const a0 = planner(new OldTL(mulberry32(5001)), DUR * 1000 + 1000);
  const a1 = planner(new OldTL(mulberry32(5002)), DUR * 1000 + 1000);
  const a2 = planner(new OldTL(mulberry32(5003)), 110_000, [50, 70]);
  a2.phase(1_000, 'active', 60);
  const f0 = a2.t;
  a2.phase(30_000, 'active', 300);
  const f1 = a2.t;
  planner(a2, DUR * 1000 + 1000, [50, 70]);
  const labels: Label[] = [{ agent: 2, kind: 'spike', start: sec(f0), end: sec(f1) }];
  return { name: 'P04-one-agent-of-three-runs-away', seed: 50, agents: 3, durationS: DUR, labels, step: oldStep([a0, a1, a2]) };
})();

// P05 — Sample API. A tool-using agent flaps `stuck`/`thinking` every 0.2-0.5 s
// for ~18 s (a health probe toggling), little output. Required thrash; a stall
// alert is tolerated because the agent produces almost nothing while flapping.
const P05: Scenario = (() => {
  const DUR = 240;
  const o = toolAgent(new OldTL(mulberry32(5101)), 80_000);
  const t0 = o.t;
  while (o.t < t0 + 18_000) {
    o.errors++;
    o.phase(uni(o.r, 200, 500), 'stuck', 0).phase(uni(o.r, 200, 500), 'thinking', 1);
  }
  const t1 = o.t;
  toolAgent(o, DUR * 1000 + 1000);
  const labels: Label[] = [
    { kind: 'thrash', start: sec(t0), end: sec(t1) },
    { kind: 'stall', start: sec(t0), end: sec(t1), optional: true },
  ];
  return { name: 'P05-stuck-thinking-flap', seed: 51, durationS: DUR, labels, step: oldStep([o]) };
})();

// P06 — Sample API at 5 Hz. A steady 60 tok/s streamer goes silent (still
// `active`, rate 0) for 50 s and then resumes. Required stall.
const P06: Scenario = (() => {
  const DUR = 240;
  const o = new OldTL(mulberry32(5201), 200, 0.08);
  o.phase(90_000, 'active', 60);
  const s0 = o.t;
  o.phase(50_000, 'active', 0);
  const s1 = o.t;
  o.phase(DUR * 1000 + 1000 - o.t, 'active', 60);
  const labels: Label[] = [{ kind: 'stall', start: sec(s0), end: sec(s1) }];
  return { name: 'P06-5hz-stream-goes-silent', seed: 52, durationS: DUR, periodMs: 200, labels, step: oldStep([o]) };
})();

// ---------------------------------------------------------------------------
// Nuisances
// ---------------------------------------------------------------------------

// N01 — Sample API with transport batching: a buffering proxy delivers three
// consecutive 100 ms samples at once every 300 ms. Healthy planner agent.
const N01: Scenario = (() => {
  const DUR = 240;
  const o = planner(new OldTL(mulberry32(5301)), DUR * 1000 + 1000);
  let call = 0;
  const step = (): AgentSample | null => o.s[call++] ?? null;
  return { name: 'N01-batched-transport', seed: 53, durationS: DUR, periodMs: 300, batch: 3, labels: [], step };
})();

// N02 — Sample API with dropped samples: ~25% of samples never arrive, plus
// occasional 2-3 s gaps of lost telemetry in the middle of an active burst.
// Healthy planner; short drop-outs are a transport issue, not a stall.
const N02: Scenario = (() => {
  const DUR = 300;
  const o = planner(new OldTL(mulberry32(5401)), DUR * 1000 + 1000);
  const r = mulberry32(5402);
  let outUntil = -1;
  for (let i = 0; i < o.s.length; i++) {
    if (i > outUntil && r() < 0.003) outUntil = i + int(r, 20, 30);
    if (i <= outUntil || r() < 0.25) o.s[i] = null;
  }
  return { name: 'N02-dropped-samples', seed: 54, durationS: DUR, labels: [], step: oldStep([o]) };
})();

// N03 — Sample API where the integration reports rate in chunks: tokens
// arrive in 0.5 s pulses at 200 tok/s every 2.5 s (average ~40 tok/s) and the
// rate is 0 in between, status staying `active`. Healthy.
const N03: Scenario = (() => {
  const DUR = 240;
  const o = new OldTL(mulberry32(5501));
  while (o.t < DUR * 1000 + 1000) o.phase(2_000, 'active', 0).phase(500, 'active', 200);
  return { name: 'N03-chunked-rate-reporting', seed: 55, durationS: DUR, labels: [], step: oldStep([o]) };
})();

// N04 — Sample API at 5 Hz: two planners on slow telemetry. Healthy.
const N04: Scenario = (() => {
  const DUR = 240;
  const tls = [0, 1].map((i) => planner(new OldTL(mulberry32(5601 + i), 200), DUR * 1000 + 1000));
  return { name: 'N04-5hz-planners', seed: 56, agents: 2, durationS: DUR, periodMs: 200, labels: [], step: oldStep(tls) };
})();

// N05 — Event API. A chat agent whose provider delivers tokens in batches of
// 60-200 every 1-2 s while mid-answer, with one real 100 s silent request
// (`start` with no first token) in the middle. The batching is normal; the
// silent request is a required stall.
const N05: Scenario = (() => {
  const DUR = 300;
  const tl = new TL(mulberry32(5701));
  const r = tl.r;
  const answer = (): void => {
    tl.start().gap(uni(r, 500, 2000));
    for (let b = int(r, 6, 20); b > 0; b--) {
      tl.tokens(int(r, 60, 200));
      if (b > 1) tl.gap(uni(r, 1000, 2000));
    }
    tl.finish().gap(uni(r, 2_000, 8_000));
  };
  while (tl.t < 90_000) answer();
  tl.start();
  const s0 = tl.t;
  tl.gap(100_000);
  const s1 = tl.t;
  tl.error().gap(500);
  while (tl.t < DUR * 1000) answer();
  const labels: Label[] = [{ kind: 'stall', start: sec(s0), end: sec(s1) }];
  return { name: 'N05-batched-provider-plus-silent-request', seed: 57, durationS: DUR, labels, step: eventStep([tl]) };
})();

export const HOLDOUT3: Scenario[] = [
  S01, S02, S03, S04, S05, S06, S07, S08, S09, S10, S11,
  T01, T02, T03, T04, T05,
  P01, P02, P03, P04, P05, P06,
  N01, N02, N03, N04, N05,
];

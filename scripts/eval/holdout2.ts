// scripts/eval/holdout2.ts
//
// Second holdout set, written independently of the detector code. Each
// scenario models a real integration an on-call engineer would watch, and the
// labels say what that engineer would actually want to be paged about.
//
// Most scenarios use the event API (`push`): per-chunk token events, `start`,
// tool calls, `error`, `finish`. A few use the sample API (`updateAgent`) with
// status `waiting` for tool phases.
//
// Every schedule is precomputed at module load from its own seeded RNG
// (mulberry32), so it never depends on the harness RNG and replays exactly.
//
// Judgement calls used throughout (kept consistent across scenarios):
// - Tool calls and subagent waits of up to ~4 minutes are normal (test suites,
//   builds, research workers). A wait only becomes a required stall after
//   5 minutes of total silence on a plain tool call that never returns.
// - A reasoning model thinking up to 60 s before output is normal for that
//   agent; an alert during a >30 s think is tolerated (optional), not required.
// - Fast active/thinking/waiting cycling is how tool-heavy agents work. Thrash
//   is required only when a problem state (`stuck`, `hallucinating`) flaps.

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
  total = 0;
  readonly ev: TEvent[] = [];
  constructor(
    readonly r: Rng,
    readonly useTotal = false
  ) {}
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
    if (this.useTotal) {
      this.total += n;
      return this.emit({ type: 'tokens', total: this.total });
    }
    return this.emit({ type: 'tokens', count: n });
  }
  /**
   * Stream `n` tokens at roughly `rate` tok/s: chunks of cmin–cmax tokens,
   * log-normal jitter on the gaps, and occasional sub-second hiccups.
   */
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
  /** Merge events from parallel sub-streams (all at or after the cursor's past). */
  mergeIn(evs: TEvent[]): this {
    const all = [...this.ev, ...evs].map((e, i) => ({ e, i }));
    all.sort((a, b) => a.e.time - b.e.time || a.i - b.i);
    this.ev.length = 0;
    for (const x of all) this.ev.push(x.e);
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

/**
 * A tool-using coding agent (model call → stream → tool → model call …).
 * Runs until the cursor passes `untilMs`, always returning right after a
 * `start` (a model request in flight), so callers can script what comes next.
 */
function codingAgent(tl: TL, untilMs: number, o: { longTools?: boolean; rate?: [number, number] } = {}): TL {
  const r = tl.r;
  const [rlo, rhi] = o.rate ?? [45, 80];
  tl.start();
  while (tl.t < untilMs) {
    tl.gap(uni(r, 400, 2500));
    tl.stream(int(r, 30, 400), uni(r, rlo, rhi));
    const x = r();
    if (x < 0.45) {
      const k = int(r, 1, 3);
      if (k === 1) tl.tool(pick(r, ['read_file', 'grep', 'list_dir']), uni(r, 150, 1500));
      else {
        // Parallel calls: start all, they return in whatever order they finish.
        const names = ['read_file', 'grep', 'list_dir'].slice(0, k);
        const ends: { name: string; at: number }[] = [];
        for (const name of names) {
          tl.toolStart(name);
          ends.push({ name, at: tl.t + uni(r, 150, 2500) });
          tl.gap(uni(r, 5, 40));
        }
        ends.sort((a, b) => a.at - b.at);
        for (const e of ends) tl.until(e.at).toolEnd(e.name);
      }
    } else if (x < 0.7) tl.tool('edit_file', uni(r, 300, 2000), r() < 0.05);
    else if (x < 0.9)
      tl.tool('run_tests', o.longTools ? uni(r, 20_000, 180_000) : uni(r, 5_000, 40_000), r() < 0.4);
    else tl.tool('build', o.longTools ? uni(r, 60_000, 150_000) : uni(r, 8_000, 30_000), r() < 0.15);
    tl.gap(uni(r, 5, 60)).start();
    if (r() < 0.08) {
      // Task done: summary, finish, short idle, next task.
      tl.gap(uni(r, 400, 2000)).stream(int(r, 80, 300), uni(r, rlo, rhi)).finish();
      tl.gap(uni(r, 2_000, 15_000)).start();
    }
  }
  return tl;
}

/** Finish an in-flight model request: TTFT, a closing message, finish. */
function wrapUp(tl: TL): TL {
  return tl.gap(uni(tl.r, 400, 2000)).stream(int(tl.r, 50, 250), uni(tl.r, 45, 80)).finish();
}

/** A chat completion endpoint: request → TTFT → stream → finish → idle. */
function chatAgent(
  tl: TL,
  untilMs: number,
  idle: [number, number] = [3_000, 25_000],
  onRun?: (tl: TL) => void
): TL {
  const r = tl.r;
  while (tl.t < untilMs) {
    onRun?.(tl);
    tl.start();
    tl.gap(r() < 0.1 ? uni(r, 3_000, 8_000) : uni(r, 300, 3_000));
    tl.stream(int(r, 80, 700), uni(r, 40, 90));
    tl.finish();
    tl.gap(uni(r, idle[0], idle[1]));
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
    readonly period = 100
  ) {}
  get t(): number {
    return this.s.length * this.period;
  }
  phase(ms: number, status: AgentStatus, level: number): this {
    const n = Math.max(1, Math.round(ms / this.period));
    for (let i = 0; i < n; i++) {
      // Rate as the integration would send it: averaged over ~1 s, mild noise.
      const rate = level > 0 ? Math.max(0, level * (1 + 0.12 * gauss(this.r))) : 0;
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
  drop(ms: number): this {
    const n = Math.round(ms / this.period);
    for (let i = 0; i < n; i++) this.s.push(null);
    return this;
  }
}

/**
 * A normal sample-API agent: active bursts, short thinking, tool phases
 * reported as `waiting` (mostly short, sometimes up to ~3 min).
 * Always returns at the end of an `active` phase.
 */
function oldNormal(o: OldTL, untilMs: number, forceLongWaitAt?: number): OldTL {
  const r = o.r;
  let forced = forceLongWaitAt === undefined;
  o.phase(uni(r, 3_000, 10_000), 'active', uni(r, 30, 70));
  while (o.t < untilMs) {
    o.phase(uni(r, 1_000, 5_000), 'thinking', 0);
    const x = r();
    if (!forced && o.t >= (forceLongWaitAt ?? 0)) {
      forced = true;
      o.phase(170_000, 'waiting', 0);
    } else if (x < 0.15) o.phase(uni(r, 60_000, 170_000), 'waiting', 0);
    else if (x < 0.75) o.phase(uni(r, 3_000, 20_000), 'waiting', 0);
    o.phase(uni(r, 1_000, 3_000), 'thinking', 0);
    o.phase(uni(r, 5_000, 30_000), 'active', uni(r, 30, 70));
  }
  return o;
}

const oldStep =
  (tls: OldTL[], period = 100) =>
  (tS: number, a: number): AgentSample | null =>
    tls[a].s[Math.round((tS * 1000) / period)] ?? null;

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

// N01 — Two Vercel-AI-SDK-style chat endpoints. Per-chunk token events of
// 1–20 tokens with jittery gaps and occasional hiccups, TTFT 0.3–8 s, idle
// (`complete`) 3–25 s between requests. Healthy: nothing to page about.
const N01: Scenario = (() => {
  const DUR = 240;
  const tls = [0, 1].map((i) => chatAgent(new TL(mulberry32(1101 + i)), DUR * 1000));
  return { name: 'N01-chat-stream-bursty-chunks', seed: 11, agents: 2, durationS: DUR, labels: [], step: eventStep(tls) };
})();

// N02 — A provider/proxy that buffers and delivers tokens in big batches
// (40–160 tokens) every 1–2 s, with short tool waits between turns. The
// derived short-window rate is lumpy by construction; it is still normal.
const N02: Scenario = (() => {
  const DUR = 240;
  const tl = new TL(mulberry32(1201));
  const r = tl.r;
  while (tl.t < DUR * 1000) {
    tl.start().gap(uni(r, 500, 2500));
    const batches = int(r, 8, 40);
    for (let b = 0; b < batches; b++) {
      const g = uni(r, 1000, 2000);
      tl.tokens(Math.round((g / 1000) * uni(r, 45, 80)));
      if (b < batches - 1) tl.gap(g);
    }
    if (r() < 0.6) tl.tool(pick(r, ['search', 'fetch_url']), uni(r, 2_000, 15_000)).gap(30);
    else tl.finish().gap(uni(r, 2_000, 10_000));
  }
  return { name: 'N02-batched-provider-delivery', seed: 12, durationS: DUR, labels: [], step: eventStep([tl]) };
})();

// N03 — Integration that forwards the provider's cumulative usage counter as
// `total`. Each new response restarts the counter (smaller total = new
// count); some chunks re-send an unchanged total. Includes a long 1.5–2.5k
// token answer so the pre-reset total is large. Healthy.
const N03: Scenario = (() => {
  const DUR = 300;
  const tl = new TL(mulberry32(1301), true);
  const r = tl.r;
  let run = 0;
  while (tl.t < DUR * 1000) {
    tl.total = 0;
    tl.start().gap(uni(r, 300, 2500));
    const n = run === 3 ? int(r, 1500, 2500) : int(r, 60, 600);
    const rate = uni(r, 40, 85);
    let left = n;
    while (left > 0) {
      const c = Math.min(left, int(r, 1, 20));
      tl.tokens(c);
      left -= c;
      if (r() < 0.05) tl.gap(uni(r, 5, 30)).tokens(0);
      if (left > 0) tl.gap((c / rate) * 1000 * Math.exp(0.6 * gauss(r) - 0.18));
    }
    tl.finish().gap(uni(r, 2_000, 20_000));
    run++;
  }
  return { name: 'N03-cumulative-total-with-resets', seed: 13, durationS: DUR, labels: [], step: eventStep([tl]) };
})();

// N04 — Tool-heavy coding agent over 15 min: quick (sometimes parallel)
// reads/greps, edits, test runs of 20 s–3 min and builds of 1–2.5 min, all
// reported as open tool calls (`waiting`); test failures come back as tool
// errors. Long waits here are normal work.
const N04: Scenario = (() => {
  const DUR = 900;
  const tl = codingAgent(new TL(mulberry32(1401)), DUR * 1000, { longTools: true });
  return { name: 'N04-coding-agent-long-tool-calls', seed: 14, durationS: DUR, labels: [], step: eventStep([tl]) };
})();

// N05 — Same kind of coding agent; after ~2 min a `run_tests` call never
// returns (hung test runner) and the agent sits in `waiting` for ~23 min.
// Normal tool calls here run up to 3 min, so nothing before 5 min of wait is
// alertable; after that, total silence on one tool call is something on-call
// wants to hear about, and the window is long enough to be required.
const N05: Scenario = (() => {
  const DUR = 1500;
  const tl = codingAgent(new TL(mulberry32(1501)), 120_000, { longTools: true });
  tl.gap(900).stream(60, 60).toolStart('run_tests');
  const hang = tl.t;
  const labels: Label[] = [{ kind: 'stall', start: sec(hang) + 300, end: DUR }];
  return { name: 'N05-hung-tool-call', seed: 15, durationS: DUR, labels, step: eventStep([tl]) };
})();

// N06 — Orchestrator (agent 0) plans, then waits on three subagents via an
// open `await_subagents` call while they do tool-heavy work for 1–3 min,
// then synthesizes. Subagents are idle (`complete`) between jobs. Waits of
// up to ~4 min are the design; healthy throughout.
function orchestration(seed: number, durMs: number, foreverAfterMs?: number) {
  const tls = [0, 1, 2, 3].map((i) => new TL(mulberry32(seed + i)));
  const [orch, ...subs] = tls;
  const r = orch.r;
  for (const s of subs) s.finish();
  let foreverStart: number | null = null;
  while (orch.t < durMs) {
    orch.start().gap(uni(r, 600, 2000)).stream(int(r, 150, 500), uni(r, 50, 70));
    orch.toolStart('await_subagents');
    const ws = orch.t;
    let maxEnd = ws;
    for (const s of subs) {
      s.until(ws + uni(s.r, 200, 2000));
      codingAgent(s, s.t + uni(s.r, 60_000, 180_000));
      wrapUp(s);
      maxEnd = Math.max(maxEnd, s.t);
    }
    if (foreverAfterMs !== undefined && ws >= foreverAfterMs) {
      foreverStart = ws;
      break;
    }
    orch.until(maxEnd + uni(r, 300, 1500)).toolEnd('await_subagents');
    orch.gap(30).start();
    wrapUp(orch).gap(uni(r, 5_000, 30_000));
  }
  return { tls, foreverStart };
}

const N06: Scenario = (() => {
  const DUR = 900;
  const { tls } = orchestration(1601, DUR * 1000);
  return { name: 'N06-orchestrator-waits-on-subagents', seed: 16, agents: 4, durationS: DUR, labels: [], step: eventStep(tls) };
})();

// N07 — Orchestrator completes one round, then its second wait never ends
// (lost completion callback): all subagents finish within ~3 min and go idle
// while agent 0 stays `waiting` for ~20 min. Gray zone: orchestrators can
// legitimately wait a long time and the telemetry doesn't link the workers to
// the orchestrator, so an alert after 5 min of waiting is allowed, not required.
const N07: Scenario = (() => {
  const DUR = 1500;
  const { tls, foreverStart } = orchestration(1701, DUR * 1000, 150_000);
  const ws = foreverStart ?? 0;
  const labels: Label[] = [{ agent: 0, kind: 'stall', start: sec(ws) + 300, end: DUR, optional: true }];
  return { name: 'N07-orchestrator-wait-never-ends', seed: 17, agents: 4, durationS: DUR, labels, step: eventStep(tls) };
})();

// N08 — Three agents; agent 1's stream goes silent mid-generation (status
// `active`, no tool open — a dropped SSE connection) for 75 s until the
// client times out, emits `error` and retries. That is a real stall.
const N08: Scenario = (() => {
  const DUR = 300;
  const a0 = chatAgent(new TL(mulberry32(1801)), DUR * 1000);
  const a2 = codingAgent(new TL(mulberry32(1803)), DUR * 1000);
  const a1 = codingAgent(new TL(mulberry32(1802)), 125_000);
  a1.gap(800).stream(120, 60);
  const s0 = a1.t;
  a1.gap(75_000);
  const s1 = a1.t;
  a1.error();
  codingAgent(a1, DUR * 1000);
  const labels: Label[] = [{ agent: 1, kind: 'stall', start: sec(s0), end: sec(s1) }];
  return { name: 'N08-stream-silent-mid-generation', seed: 18, agents: 3, durationS: DUR, labels, step: eventStep([a0, a1, a2]) };
})();

// N09 — Non-reasoning chat model (TTFT normally 0.3–8 s). One request gets
// `start` and then no first token for 120 s before the client gives up
// (`error`) and retries. Required stall over the silent request.
const N09: Scenario = (() => {
  const DUR = 360;
  const tl = chatAgent(new TL(mulberry32(1901)), 150_000);
  tl.start();
  const s0 = tl.t;
  tl.gap(120_000);
  const s1 = tl.t;
  tl.error().gap(500);
  chatAgent(tl, DUR * 1000);
  const labels: Label[] = [{ kind: 'stall', start: sec(s0), end: sec(s1) }];
  return { name: 'N09-no-first-token-after-start', seed: 19, durationS: DUR, labels, step: eventStep([tl]) };
})();

// N10 — Reasoning model: every request thinks 5–60 s (status `thinking`, no
// tokens) before streaming fast (80–150 tok/s), with tool calls between.
// Thinks past 30 s are a gray zone (optional). Then one request thinks for
// 5 min with nothing (stuck upstream) before erroring — required from 30 s.
const N10: Scenario = (() => {
  const tl = new TL(mulberry32(2001));
  const r = tl.r;
  const labels: Label[] = [];
  while (tl.t < 280_000) {
    tl.start();
    const think = r() < 0.3 ? uni(r, 30_000, 60_000) : uni(r, 5_000, 30_000);
    if (think > 30_000) labels.push({ kind: 'stall', start: sec(tl.t + 30_000), end: sec(tl.t + think), optional: true });
    tl.gap(think).stream(int(r, 200, 1500), uni(r, 80, 150));
    if (r() < 0.5) tl.tool(pick(r, ['python', 'search']), uni(r, 1_000, 20_000)).gap(20);
    else tl.finish().gap(uni(r, 3_000, 20_000));
  }
  tl.start();
  const hs = tl.t;
  tl.gap(300_000).error().gap(300).start().gap(12_000).stream(600, 110).finish();
  labels.push({ kind: 'stall', start: sec(hs) + 30, end: sec(hs) + 300 });
  const DUR = Math.ceil(sec(tl.t)) + 30;
  return { name: 'N10-reasoning-model-long-thinks', seed: 20, durationS: DUR, labels, step: eventStep([tl]) };
})();

// N11 — Coding agent (bursts at 45–80 tok/s between tool calls) falls into a
// degenerate repetition loop: one uninterrupted stream of ~9k tokens at
// ~200 tok/s (repetitive text decodes faster under speculative decoding)
// until max_tokens ends it ~45 s later. Required spike.
const N11: Scenario = (() => {
  const DUR = 300;
  const tl = codingAgent(new TL(mulberry32(2101)), 150_000);
  tl.gap(800).stream(100, 65);
  const l0 = tl.t;
  tl.stream(9000, 200, { cmin: 8, cmax: 20, jitter: 0.3, hiccup: 0 });
  const l1 = tl.t;
  tl.finish().gap(4000);
  codingAgent(tl, DUR * 1000);
  const labels: Label[] = [{ kind: 'spike', start: sec(l0), end: sec(l1) }];
  return { name: 'N11-repetition-loop-runaway', seed: 21, durationS: DUR, labels, step: eventStep([tl]) };
})();

// N12 — Three coding agents; agent 2 hits a retry bug that fires five
// concurrent completions under the same agent id, all streaming for ~30 s
// (aggregate ~5× its normal rate). Required spike on agent 2 only.
const N12: Scenario = (() => {
  const DUR = 320;
  const a0 = codingAgent(new TL(mulberry32(2201)), DUR * 1000);
  const a1 = codingAgent(new TL(mulberry32(2202)), DUR * 1000);
  const a2 = codingAgent(new TL(mulberry32(2203)), 160_000);
  a2.gap(600).stream(40, 60);
  const f0 = a2.t;
  let f1 = f0;
  const subs: TEvent[] = [];
  for (let k = 0; k < 5; k++) {
    const s = new TL(mulberry32(2210 + k));
    s.until(f0 + uni(s.r, 0, 1500)).start().gap(uni(s.r, 300, 900));
    const rate = uni(s.r, 50, 70);
    s.stream(rate * 30, rate);
    f1 = Math.max(f1, s.t);
    subs.push(...s.ev);
  }
  a2.mergeIn(subs).until(f1).finish().gap(3000);
  codingAgent(a2, DUR * 1000);
  const labels: Label[] = [{ agent: 2, kind: 'spike', start: sec(f0), end: sec(f1) }];
  return { name: 'N12-concurrent-retry-fanout', seed: 22, agents: 3, durationS: DUR, labels, step: eventStep([a0, a1, a2]) };
})();

// N13 — Summarizer agent (35–50 tok/s with fetch_doc tool pauses) hits a
// recursion bug: from ~120 s another nested call starts every 15 s under the
// same id, so the rate keeps climbing 1×→6× over 100 s. Required spike.
const N13: Scenario = (() => {
  const DUR = 360;
  const tl = new TL(mulberry32(2301));
  const r = tl.r;
  while (tl.t < 120_000) {
    tl.start().gap(uni(r, 500, 1500)).stream(int(r, 200, 600), uni(r, 35, 50));
    tl.tool('fetch_doc', uni(r, 1_000, 6_000)).gap(20);
  }
  tl.start().gap(700);
  const c0 = tl.t;
  const c1 = c0 + 100_000;
  const subs: TEvent[] = [];
  for (let k = 0; k < 6; k++) {
    const s = new TL(mulberry32(2310 + k));
    s.until(c0 + k * 15_000);
    if (k > 0) s.start().gap(uni(s.r, 400, 900));
    const rate = uni(s.r, 35, 50);
    s.stream(((c1 - s.t) / 1000) * rate, rate);
    subs.push(...s.ev);
  }
  tl.mergeIn(subs);
  tl.until(Math.max(...subs.map((e) => e.time))).finish();
  const end = tl.t;
  tl.gap(5000);
  while (tl.t < DUR * 1000) {
    tl.start().gap(uni(r, 500, 1500)).stream(int(r, 200, 600), uni(r, 35, 50));
    tl.tool('fetch_doc', uni(r, 1_000, 6_000)).gap(20);
  }
  const labels: Label[] = [{ kind: 'spike', start: sec(c0), end: sec(end) }];
  return { name: 'N13-climbing-nested-calls', seed: 23, durationS: DUR, labels, step: eventStep([tl]) };
})();

// N14 — Two agents in tight tool loops: a short model turn (TTFT 0.15–0.5 s,
// 10–80 tokens), a 0.1–0.6 s tool call, repeat — four status changes every
// ~1.5 s (thinking→active→waiting→thinking). 5% of tool calls error and are
// simply retried. This is what healthy agents look like: no thrash.
function fastToolLoop(tl: TL, untilMs: number, errP: number): TL {
  const r = tl.r;
  while (tl.t < untilMs) {
    tl.start().gap(uni(r, 150, 500)).stream(int(r, 10, 80), uni(r, 60, 100));
    const name = pick(r, ['read_file', 'grep', 'bash', 'edit_file']);
    tl.tool(name, uni(r, 100, 600), r() < errP).gap(uni(r, 5, 30));
    if (r() < 0.03) tl.start().gap(400).stream(int(r, 40, 150), 70).finish().gap(uni(r, 1_000, 4_000));
  }
  return tl;
}

const N14: Scenario = (() => {
  const DUR = 240;
  const tls = [0, 1].map((i) => fastToolLoop(new TL(mulberry32(2401 + i)), DUR * 1000, 0.05));
  return { name: 'N14-fast-tool-loop-healthy', seed: 24, agents: 2, durationS: DUR, labels: [], step: eventStep(tls) };
})();

// N15 — Sample API. Agent 0 hits a 429 retry loop and its integration
// reports `stuck` on every failure and `active` on every retry, flapping
// every 0.2–0.5 s for ~20 s. Agent 1's grounding guard toggles
// `hallucinating`/`active` the same way for ~15 s. Both are required thrash.
// Agent 0's flap is mostly `stuck` with little output, so a stall alert there
// is tolerated. Normal phases use `waiting` for tool calls.
const N15: Scenario = (() => {
  const DUR = 260;
  const a0 = oldNormal(new OldTL(mulberry32(2501)), 100_000);
  const t0 = a0.t;
  while (a0.t < t0 + 20_000) {
    a0.errors++;
    a0.phase(uni(a0.r, 200, 500), 'stuck', 0).phase(uni(a0.r, 200, 500), 'active', 25);
  }
  const t1 = a0.t;
  oldNormal(a0, DUR * 1000 + 1000);
  const b = oldNormal(new OldTL(mulberry32(2502)), 180_000);
  const u0 = b.t;
  while (b.t < u0 + 15_000) b.phase(uni(b.r, 200, 500), 'hallucinating', 40).phase(uni(b.r, 200, 500), 'active', 40);
  const u1 = b.t;
  oldNormal(b, DUR * 1000 + 1000);
  const labels: Label[] = [
    { agent: 0, kind: 'thrash', start: sec(t0), end: sec(t1) },
    { agent: 0, kind: 'stall', start: sec(t0), end: sec(t1), optional: true },
    { agent: 1, kind: 'thrash', start: sec(u0), end: sec(u1) },
  ];
  return { name: 'N15-sample-api-problem-state-flapping', seed: 25, agents: 2, durationS: DUR, labels, step: oldStep([a0, b]) };
})();

// N16 — Event API. A coding agent gets into a tool-error storm: every
// ~0.4 s it emits a tiny turn, calls `bash`, and the call fails (tool-end
// error) — 25 s of waiting↔thinking↔active cycling with errors piling up,
// then it gives up and explains. No problem status is ever reported, so
// whether this is "thrash" is a judgement call: optional.
const N16: Scenario = (() => {
  const DUR = 240;
  const tl = codingAgent(new TL(mulberry32(2601)), 90_000);
  const r = tl.r;
  const s0 = tl.t;
  while (tl.t < s0 + 25_000) {
    tl.gap(uni(r, 100, 200)).stream(int(r, 15, 30), 90);
    tl.tool('bash', uni(r, 80, 200), true).gap(10).start();
  }
  const s1 = tl.t;
  wrapUp(tl).gap(5000);
  codingAgent(tl, DUR * 1000);
  const labels: Label[] = [{ kind: 'thrash', start: sec(s0), end: sec(s1), optional: true }];
  return { name: 'N16-tool-error-storm', seed: 26, durationS: DUR, labels, step: eventStep([tl]) };
})();

// N17 — Sample API with `waiting` tool phases (3 s–170 s, rate 0). Agent 0
// includes a 170 s tool wait: normal. Agent 1's telemetry stops entirely
// for 40 s while its last status was `active` (worker process froze), then
// resumes: required stall.
const N17: Scenario = (() => {
  const DUR = 600;
  const a0 = oldNormal(new OldTL(mulberry32(2701)), DUR * 1000 + 1000, 200_000);
  const a1 = oldNormal(new OldTL(mulberry32(2702)), 300_000);
  a1.phase(3000, 'active', 50);
  const d0 = a1.t;
  a1.drop(40_000);
  const d1 = a1.t;
  oldNormal(a1, DUR * 1000 + 1000);
  const labels: Label[] = [{ agent: 1, kind: 'stall', start: sec(d0), end: sec(d1) }];
  return { name: 'N17-sample-api-waiting-and-dropout', seed: 27, agents: 2, durationS: DUR, labels, step: oldStep([a0, a1]) };
})();

// N18 — Six classifier/extractor workers doing many tiny runs back to back:
// start → 0.2–0.8 s TTFT → 20–150 tokens → finish → 0.1–2 s idle. Status
// cycles thinking→active→complete constantly; all healthy.
const N18: Scenario = (() => {
  const DUR = 180;
  const tls = [0, 1, 2, 3, 4, 5].map((i) => {
    const tl = new TL(mulberry32(2801 + i));
    const r = tl.r;
    while (tl.t < DUR * 1000) {
      tl.start().gap(uni(r, 200, 800)).stream(int(r, 20, 150), uni(r, 60, 100)).finish();
      tl.gap(uni(r, 100, 2000));
    }
    return tl;
  });
  return { name: 'N18-many-short-runs', seed: 28, agents: 6, durationS: DUR, labels: [], step: eventStep(tls) };
})();

// N19 — Two low-traffic chat assistants over 20 min: idle (`complete`) for
// 1–6 min between requests, starting idle. A request after a long idle is a
// normal burst, and long idles are not stalls.
const N19: Scenario = (() => {
  const DUR = 1200;
  const tls = [0, 1].map((i) => {
    const tl = new TL(mulberry32(2901 + i));
    tl.finish().gap(uni(tl.r, 30_000, 200_000));
    return chatAgent(tl, DUR * 1000, [60_000, 360_000]);
  });
  return { name: 'N19-long-idle-between-requests', seed: 29, agents: 2, durationS: DUR, labels: [], step: eventStep(tls) };
})();

// N20 — Agent hitting provider rate limits. At ~100 s a request fails (error)
// and is retried with exponential backoff 1, 2, 4, 8, 16 s before it
// succeeds — ~35 s with no tokens, status `thinking`, errors piling up. An
// alert late in that window is tolerated (optional). At ~200 s a short
// 1, 2, 4 s backoff sequence is routine and must not alert.
function backoff(tl: TL, steps: number[]): { s0: number; s1: number } {
  const r = tl.r;
  tl.start();
  const s0 = tl.t;
  for (const b of steps) tl.gap(uni(r, 200, 400)).error().gap(b * 1000 * uni(r, 0.8, 1.2)).start();
  const s1 = tl.t;
  tl.gap(uni(r, 500, 1500)).stream(int(r, 100, 400), uni(r, 45, 80)).finish().gap(uni(r, 2_000, 6_000));
  return { s0, s1 };
}

const N20: Scenario = (() => {
  const DUR = 300;
  const tl = chatAgent(new TL(mulberry32(3001)), 100_000);
  const { s0, s1 } = backoff(tl, [1, 2, 4, 8, 16]);
  chatAgent(tl, 200_000);
  backoff(tl, [1, 2, 4]);
  chatAgent(tl, DUR * 1000);
  const labels: Label[] = [{ kind: 'stall', start: sec(s0) + 20, end: sec(s1), optional: true }];
  return { name: 'N20-rate-limit-backoff', seed: 30, durationS: DUR, labels, step: eventStep([tl]) };
})();

export const HOLDOUT2: Scenario[] = [
  N01, N02, N03, N04, N05, N06, N07, N08, N09, N10,
  N11, N12, N13, N14, N15, N16, N17, N18, N19, N20,
];

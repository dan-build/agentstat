// src/core/store.ts
//
// Framework-free state for one chart: the roster, per-agent buffers, ingest
// validation, the demo simulator, health and anomaly ticks, live-value easing
// and pause. The renderer reads it directly every frame; React subscribes to
// its row snapshot through useSyncExternalStore.

import { TimeSeriesBuffer } from '../timeseries';
import { StatusLog } from '../statuslog';
import {
  detectAnomalies,
  type Anomaly,
  type AnomalyConfig,
  type AnomalyKind,
  type AnomalySeverity,
} from '../anomaly';
import { calculateHealth } from '../health';
import { simStep, type Rng, type SimState } from '../simulator';
import {
  AGENT_STATUSES,
  type Agent,
  type AgentEvent,
  type AgentSample,
  type AgentStatus,
  type AgentStreamStats,
  type HealthMetrics,
} from '../types';
import {
  DEFAULT_VIEW_MS,
  EPISODE_GRACE_MS,
  HEALTH_WINDOW_MS,
  LATENCY_HISTORY,
  DETECTOR_HISTORY_MS,
  clamp,
  lerp,
  warnOnce,
} from './constants';
import {
  createSeries,
  makeRecord,
  sameBand,
  toAgent,
  type AgentRecord,
  type LiveValues,
} from './record';

/** What the DOM overlays (legend, panel, summary) render. */
export type RowSnapshot = {
  id: string;
  name: string;
  /** Explicit agent color; palette colors are resolved at render time. */
  color?: string;
  visible: boolean;
  status: AgentStatus;
  rate: number;
  score: number | null;
};

/** Emitted by a health tick, in order, for the component to act on. */
export type StoreEvent =
  | { kind: 'anomaly'; id: string; name: string; anomaly: Anomaly }
  | { kind: 'resolved'; id: string; name: string; anomaly: Anomaly }
  | { kind: 'health'; id: string; health: HealthMetrics };

export interface StoreOptions {
  windowSeconds?: number;
  maxHistoryPoints: number;
}

// Active time the slow reference rate needs before the detectors may use it.
const REFERENCE_WARMUP_MS = 10_000;

// Event ingest: the rate is tokens over a trailing window of about three
// typical gaps between token events (so batched delivery reads as a steady
// rate), between these bounds; sampled at most every SAMPLE_MS.
const RATE_WINDOW_MS = [1_000, 4_000] as const;
const SAMPLE_MS = 100;
// Statuses in which quiet output is expected; leaving one starts a stretch of
// work, in which quiet output can be a stall.
const RESTING = new Set<AgentStatus>(['waiting', 'complete']);
// Once an agent's events stop, health ticks sample its rate (zero) at most
// this often.
const STREAM_TICK_MS = 250;

/** Per-agent state for agents fed with `push` events. */
type Stream = {
  /** Token events in the rate window, as flat [t, count, t, count, …]. */
  win: number[];
  total: number;
  /** Last cumulative `total` reported, to turn totals into deltas. */
  lastTotal?: number;
  /** Latest time applied (events are clamped to be monotonic). */
  t: number;
  /** When the last event arrived (store clock), whatever its `time`. */
  arrived: number;
  lastSample: number;
  /** Time of the last `start`/`tool-end` still waiting for its first token. */
  ttftFrom: number | null;
  ttft: number | null;
  /** Previous token event of the current streaming stretch (null across pauses). */
  lastTok: number | null;
  /** Estimated start of the current streaming stretch (the rate window can't reach earlier). */
  from: number;
  /** Token events in the current stretch. */
  n: number;
  itl: number | null;
  tools: string[];
};

type Episode = {
  since: number;
  baseline?: number;
  severity: AnomalySeverity;
  lastSeen: number;
  last: Anomaly;
  name: string;
};

const sameRows = (a: RowSnapshot[], b: RowSnapshot[]) =>
  a.length === b.length &&
  a.every(
    (p, i) =>
      p.id === b[i].id &&
      p.name === b[i].name &&
      p.color === b[i].color &&
      p.visible === b[i].visible &&
      p.status === b[i].status &&
      p.score === b[i].score &&
      Math.abs(p.rate - b[i].rate) < 0.05
  );

export class AgentStore {
  /** Roster in display order. */
  list: AgentRecord[] = [];
  readonly byId = new Map<string, AgentRecord>();
  readonly progress = new Map<string, TimeSeriesBuffer>();
  readonly tokens = new Map<string, TimeSeriesBuffer>();
  readonly status = new Map<string, StatusLog>();
  readonly live = new Map<string, LiveValues>();
  readonly anomalies = new Map<string, Anomaly[]>();
  /** Sticky token-axis ceiling, recomputed at most 4×/s by the view. */
  readonly axis = { bucket: -1, value: 0 };
  /** Set by any write that changes what's drawn; cleared by the renderer. */
  dirty = true;
  /** Wall time the view was frozen at, or null while live. */
  pausedAt: number | null = null;
  options: StoreOptions;

  private _props = new Map<string, Agent>();
  // Agents added by a stream source (not in the agents prop), in arrival order.
  private _auto = new Set<string>();
  // Prop agents that received source events (reset when the source changes).
  private _sourced = new Set<string>();
  private _latency = new Map<string, number[]>();
  private _health = new Map<string, HealthMetrics>();
  private _episodes = new Map<string, Map<AnomalyKind, Episode>>();
  // Agents whose anomalous status was set by the consumer; the simulator
  // must not auto-recover them.
  private _locked = new Set<string>();
  private _sim = new Map<string, SimState>();
  private _simTouched = new Set<string>();
  private _rows: RowSnapshot[] = [];
  // `resolved` events for episodes ended outside a tick (agent removed),
  // delivered at the start of the next tick.
  private _pendingEvents: StoreEvent[] = [];
  // Per-agent slow reference of the normal active rate (detector context).
  private _refRate = new Map<string, number>();
  // Active time (ms) behind each reference, so a start-up ramp can't set it.
  private _refActiveMs = new Map<string, number>();
  // Agents whose caller has reported a status at least once.
  private _statusReported = new Set<string>();
  // When each agent's current status began, and when its current stretch of
  // work (since it last left `waiting`/`complete`) began.
  private _statusSince = new Map<string, number>();
  private _workSince = new Map<string, number>();
  private _streams = new Map<string, Stream>();
  // History the detectors need for the current config.
  private _detectorHistoryMs = DETECTOR_HISTORY_MS;
  // Rate at/below which output counts as none (the detectors' current config).
  private _idleRate = 0.5;
  private _lastTick = 0;
  private _listeners = new Set<() => void>();

  constructor(agents: Agent[], options: StoreOptions, now: number) {
    this.options = options;
    this.syncRoster(agents, now);
    this._rows = this._buildRows();
  }

  // ── Roster ─────────────────────────────────────────────────────────────

  /**
   * Reconcile with the `agents` prop. Static fields that changed since the
   * last prop are applied; runtime values stay with ingest, and a legend
   * toggle isn't clobbered by a re-render passing the same `visible` again.
   */
  syncRoster(incoming: Agent[], now: number): void {
    const prevProps = this._props;
    const nextProps = new Map<string, Agent>();
    const next: AgentRecord[] = [];
    for (const a of Array.isArray(incoming) ? incoming : []) {
      if (!a || typeof a.id !== 'string') continue;
      if (nextProps.has(a.id)) {
        warnOnce(`dup:${a.id}`, `Duplicate agent id "${a.id}" ignored.`);
        continue;
      }
      nextProps.set(a.id, a);
      // A stream-added agent that now appears in the prop: the prop owns it
      // (and its data still came from the source).
      if (this._auto.delete(a.id)) this._sourced.add(a.id);
      let rec = this.byId.get(a.id);
      if (!rec) {
        rec = this._create(a, now);
      } else {
        const prev = prevProps.get(a.id);
        if (!prev || prev.name !== a.name) rec.name = a.name ?? a.id;
        if (!prev || prev.color !== a.color) rec.color = a.color;
        if (!prev || !sameBand(prev.config?.expectedTokensPerSec, a.config?.expectedTokensPerSec)) {
          rec.config = a.config;
        }
        if (prev && (prev.visible ?? true) !== (a.visible ?? true)) rec.visible = a.visible ?? true;
      }
      next.push(rec);
    }
    for (const id of this._auto) next.push(this.byId.get(id) as AgentRecord);
    for (const id of Array.from(this.byId.keys())) {
      if (!nextProps.has(id) && !this._auto.has(id)) this._drop(id);
    }
    this._props = nextProps;
    this.list = next;
    this.dirty = true;
  }

  private _create(a: Agent, now: number): AgentRecord {
    const rec = makeRecord(a);
    this.byId.set(a.id, rec);
    const series = createSeries(rec, this.options.maxHistoryPoints, now);
    this.progress.set(a.id, series.progress);
    this.tokens.set(a.id, series.tokens);
    this.status.set(a.id, series.status);
    this._statusSince.set(a.id, now);
    this._workSince.set(a.id, now);
    return rec;
  }

  // ── Stream sources ─────────────────────────────────────────────────────

  /**
   * Before a source's event at time `t`: add the agent if it's unknown
   * (idle, after the prop agents), or move the start of an agent that has
   * no data yet back to `t`, so replayed history isn't squashed into the
   * moment the chart mounted.
   */
  ensure(id: string, t: number, now: number): void {
    t = Math.min(t, now);
    const rec = this.byId.get(id);
    if (!rec) {
      this._create({ id, name: id, current: { tokensRate: 0, progress: 0, status: 'complete' } }, t);
      this._auto.add(id);
      this.list = [...this.list, this.byId.get(id) as AgentRecord];
      this.dirty = true;
      return;
    }
    if (
      t < (this._statusSince.get(id) ?? t) &&
      this.tokens.get(id)?.length === 1 &&
      !this._statusReported.has(id) &&
      !this._streams.has(id)
    ) {
      this._recreate(id, toAgent(rec), t);
    }
    if (!this._auto.has(id)) this._sourced.add(id);
  }

  /** Start an agent over from `a` at `t` (all derived state goes). */
  private _recreate(id: string, a: Agent, t: number): void {
    const visible = this.byId.get(id)?.visible ?? true;
    this._drop(id);
    const rec = this._create(a, t);
    rec.visible = visible;
    this.list = this.list.map((r) => (r.id === id ? rec : r));
    this.dirty = true;
  }

  /**
   * A new source: its history will be replayed from the start, so what the
   * previous one fed goes — its agents, and the data of prop agents it fed.
   */
  resetSource(now: number): void {
    this.removeAuto();
    for (const id of this._sourced) {
      const a = this._props.get(id);
      if (a && this.byId.has(id)) this._recreate(id, a, now);
    }
    this._sourced.clear();
  }

  /** Name, color or band for a source-added agent (the agents prop wins). */
  describe(id: string, d: { name?: string; color?: string; config?: Agent['config'] }, now: number): void {
    this.ensure(id, now, now);
    const rec = this.byId.get(id);
    if (!rec || this._props.has(id)) return;
    if (typeof d.name === 'string') rec.name = d.name;
    if (d.color !== undefined) rec.color = d.color;
    if (d.config !== undefined) rec.config = d.config;
    this.invalidate(true);
  }

  /** Remove source-added agents (all of them without `id`). */
  removeAuto(id?: string): void {
    const ids = id === undefined ? [...this._auto] : this._auto.has(id) ? [id] : [];
    for (const x of ids) {
      this._auto.delete(x);
      this._drop(x);
    }
    if (ids.length) {
      this.list = this.list.filter((r) => this.byId.has(r.id));
      this.dirty = true;
    }
  }

  /** Queue `resolved` for every open episode of an agent (removal, detection off). */
  private _closeEpisodes(id: string): StoreEvent[] {
    const eps = this._episodes.get(id);
    this._episodes.delete(id);
    if (!eps) return [];
    return [...eps.values()].map((ep) => ({ kind: 'resolved', id, name: ep.name, anomaly: ep.last }));
  }

  private _drop(id: string): void {
    this._pendingEvents.push(...this._closeEpisodes(id));
    this.byId.delete(id);
    this.progress.delete(id);
    this.tokens.delete(id);
    this.status.delete(id);
    this._latency.delete(id);
    this.live.delete(id);
    this._health.delete(id);
    this.anomalies.delete(id);
    this._locked.delete(id);
    this._refRate.delete(id);
    this._refActiveMs.delete(id);
    this._statusReported.delete(id);
    this._statusSince.delete(id);
    this._workSince.delete(id);
    this._sourced.delete(id);
    this._streams.delete(id);
    this._sim.delete(id);
  }

  toggleVisible(id: string): void {
    const rec = this.byId.get(id);
    if (!rec) return;
    rec.visible = !rec.visible;
    this.invalidate(true);
  }

  showAll(): void {
    for (const rec of this.list) rec.visible = true;
    this.invalidate(true);
  }

  // ── Ingest ─────────────────────────────────────────────────────────────

  /**
   * Samples are kept for 1.5× the visible window, and never less than the
   * history the detectors need — a display option must not change what the
   * anomaly detectors can see.
   */
  retentionMs(): number {
    const winS = this.options.windowSeconds;
    const view = (winS !== undefined && winS > 0 ? winS * 1000 : DEFAULT_VIEW_MS) * 1.5;
    return Math.max(view, this._detectorHistoryMs);
  }

  /**
   * Record a status change at `t` (no-op if unchanged). `output`: the agent
   * is producing output as of this change.
   */
  private _setStatus(rec: AgentRecord, status: AgentStatus, t: number, output = false): void {
    this._statusReported.add(rec.id);
    const prev = rec.current.status;
    if (status === prev) return;
    rec.current.status = status;
    this._statusSince.set(rec.id, t);
    // A new stretch of work: after resting, or when thinking ends in output
    // (quiet thinking is judged by its own limit, not counted against
    // `active`). Flipping thinking → active without output doesn't reset it.
    if ((RESTING.has(prev) || (prev === 'thinking' && output)) && !RESTING.has(status)) {
      this._workSince.set(rec.id, t);
    }
    this.status.get(rec.id)?.record(t, status);
    if (this.pausedAt === null) this.dirty = true;
  }

  private _pushSample(rec: AgentRecord, now: number): void {
    const pBuf = this.progress.get(rec.id);
    const tBuf = this.tokens.get(rec.id);
    if (!pBuf || !tBuf) return;
    // Rate and progress are sampled together so both series stay aligned.
    pBuf.push(now, rec.current.progress);
    tBuf.push(now, rec.current.tokensRate);
    // While paused, retention is measured from the pause so the frozen view
    // keeps its history.
    const anchor = this.pausedAt ?? now;
    const retain = this.retentionMs();
    pBuf.evictOlderThan(anchor, retain);
    tBuf.evictOlderThan(anchor, retain);
    this.status.get(rec.id)?.evictOlderThan(anchor - retain);
    if (this.pausedAt === null) this.dirty = true;
  }

  /** Validate and apply a partial sample. Bad fields are dropped with a warning. */
  ingest(id: string, sample: AgentSample, now: number): void {
    const rec = this.byId.get(id);
    if (!rec) {
      warnOnce(`unknown:${id}`, `updateAgent("${id}") ignored: no agent with that id is in the agents prop.`);
      return;
    }
    if (!sample || typeof sample !== 'object') return;
    const num = (field: keyof AgentSample, lo: number, hi: number): number | undefined => {
      const v = sample[field];
      if (v === undefined) return undefined;
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        warnOnce(`${id}:${field}`, `updateAgent("${id}"): ignored non-finite ${field} (${String(v)}).`);
        return undefined;
      }
      return clamp(v, lo, hi);
    };
    const tokensRate = num('tokensRate', 0, Infinity);
    const progress = num('progress', 0, 100);
    const latencyMs = num('latencyMs', 0, Infinity);
    const confidenceScore = num('confidenceScore', 0, 1);
    const errorCount = num('errorCount', 0, Infinity);
    let status = sample.status;
    if (status !== undefined && !AGENT_STATUSES.includes(status)) {
      warnOnce(`${id}:status:${String(status)}`, `updateAgent("${id}"): unknown status "${String(status)}" ignored.`);
      status = undefined;
    }

    if (status === 'stuck' || status === 'hallucinating') this._locked.add(id);
    else if (status !== undefined) this._locked.delete(id);

    const cur = rec.current;
    if (tokensRate !== undefined) cur.tokensRate = tokensRate;
    if (progress !== undefined) cur.progress = progress;
    if (confidenceScore !== undefined) cur.confidenceScore = confidenceScore;
    if (errorCount !== undefined) cur.errorCount = errorCount;
    if (latencyMs !== undefined) {
      cur.latencyMs = latencyMs;
      const log = this._latency.get(id) ?? [];
      log.push(latencyMs);
      if (log.length > LATENCY_HISTORY) log.splice(0, log.length - LATENCY_HISTORY);
      this._latency.set(id, log);
    }
    // Output only if this sample reports a real rate (not noise, not stale).
    if (status !== undefined) this._setStatus(rec, status, now, tokensRate !== undefined && tokensRate > this._idleRate);
    if (tokensRate !== undefined || progress !== undefined) this._pushSample(rec, now);
  }

  /**
   * Apply a stream event: derive rate, TTFT, inter-token latency and status.
   * Malformed events are dropped with a warning.
   */
  push(id: string, e: AgentEvent, now: number): void {
    const rec = this.byId.get(id);
    if (!rec) {
      warnOnce(`unknown:${id}`, `push("${id}") ignored: no agent with that id is in the agents prop.`);
      return;
    }
    const bad = (what: string) => warnOnce(`${id}:ev:${what}`, `push("${id}"): ignored ${what}.`);
    if (!e || typeof e !== 'object') return bad('a non-object event');
    let s = this._streams.get(id);
    if (!s) {
      s = { win: [], total: 0, t: -Infinity, arrived: now, lastSample: -Infinity, ttftFrom: null, ttft: null, lastTok: null, from: -Infinity, n: 0, itl: null, tools: [] };
      this._streams.set(id, s);
    }
    // Never in the future, and never before anything already recorded for
    // the agent (events, samples, status changes).
    const floor = Math.max(s.t, this._statusSince.get(id) ?? -Infinity, this.tokens.get(id)?.lastT ?? -Infinity);
    const t = Math.min(now, Math.max(floor, typeof e.time === 'number' && Number.isFinite(e.time) ? e.time : now));
    s.t = t;
    s.arrived = now;
    const cur = rec.current;
    const error = () => {
      cur.errorCount = (cur.errorCount ?? 0) + 1;
    };
    // A status set with updateAgent ('stuck', 'hallucinating') holds until
    // updateAgent changes it.
    const setStatus = (st: AgentStatus, output = false) => {
      if (!this._locked.has(id)) this._setStatus(rec, st, t, output);
    };
    // Before a hand-off clears the window: sample a held-back first chunk.
    if (e.type === 'start' || e.type === 'tool-start' || e.type === 'finish') {
      if (s.win.length && s.lastSample < s.win[s.win.length - 2]) this._sampleStream(rec, s, t, false);
    }
    switch (e.type) {
      case 'start':
        s.tools = [];
        s.ttftFrom = t;
        s.lastTok = null;
        s.win = [];
        setStatus('thinking');
        break;
      case 'tokens': {
        const { count, total } = e;
        let n: number;
        if (typeof total === 'number' && Number.isFinite(total) && total >= 0) {
          // The first total only sets the starting point (the agent may have
          // been running before the chart); a smaller one starts a new count.
          n = s.lastTotal === undefined ? 0 : total >= s.lastTotal ? total - s.lastTotal : total;
          s.lastTotal = total;
        } else if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
          n = count;
        } else {
          return bad('a tokens event without a finite count or total');
        }
        if (n === 0) break;
        // A gap longer than any rate window is a pause, not streaming.
        if (s.lastTok !== null && t - s.lastTok > RATE_WINDOW_MS[1]) s.lastTok = null;
        // A new stretch: its first chunk was produced over about one
        // inter-token gap (or since the request, if no gap is known yet), not
        // over the whole rate window.
        if (s.lastTok === null) {
          const span = s.itl ?? (s.ttftFrom !== null ? t - s.ttftFrom : RATE_WINDOW_MS[0]);
          s.from = t - clamp(span, SAMPLE_MS, RATE_WINDOW_MS[1]);
          s.n = 0;
        } else if (++s.n === 1 && s.itl === null) {
          // The second chunk shows the real gap: re-anchor the stretch on it.
          s.from = s.lastTok - clamp(t - s.lastTok, SAMPLE_MS, RATE_WINDOW_MS[1]);
        }
        s.win.push(t, n);
        s.total += n;
        if (s.ttftFrom !== null) {
          s.ttft = t - s.ttftFrom;
          s.ttftFrom = null;
          // TTFT is the latency of the model call: it feeds latencyTrend.
          this.ingest(id, { latencyMs: s.ttft }, now);
        }
        if (s.lastTok !== null) {
          const gap = t - s.lastTok;
          s.itl = s.itl === null ? gap : s.itl + (gap - s.itl) * 0.2;
        }
        s.lastTok = t;
        // Output while a tool call is open (streamed tool input) doesn't end the wait.
        setStatus(s.tools.length ? 'waiting' : 'active', true);
        // A lone first chunk with no known gap can't be read as a rate yet:
        // the next chunk shows the gap, or a health tick samples it as a
        // whole response (tokens over the time since the request).
        if (s.itl === null && s.n === 0) return;
        break;
      }
      case 'tool-start':
        s.tools.push(typeof e.name === 'string' ? e.name : '');
        // The model handed off: its output has stopped.
        s.lastTok = null;
        s.win = [];
        setStatus('waiting');
        break;
      case 'tool-end': {
        if (e.error) error();
        // Nothing open: a duplicate or stray end changes nothing.
        if (!s.tools.length) break;
        let i = s.tools.lastIndexOf(typeof e.name === 'string' ? e.name : '');
        if (i < 0) i = s.tools.length - 1;
        s.tools.splice(i, 1);
        if (!s.tools.length) {
          s.ttftFrom = t;
          s.lastTok = null;
          setStatus('thinking');
        }
        break;
      }
      case 'error':
        error();
        break;
      case 'finish':
        s.tools = [];
        s.win = [];
        s.ttftFrom = null;
        s.lastTok = null;
        setStatus('complete');
        break;
      default:
        return bad(`unknown event type "${String((e as { type?: unknown }).type)}"`);
    }
    this._sampleStream(rec, s, t, e.type === 'tokens');
  }

  /**
   * Push the event-derived rate as a sample at `t`. Token events are sampled
   * at most every SAMPLE_MS (the window keeps every token); status changes
   * and forced samples always are.
   */
  private _sampleStream(rec: AgentRecord, s: Stream, t: number, throttle: boolean): void {
    if (throttle && t - s.lastSample < SAMPLE_MS) return;
    const W = this._window(s, t);
    let i = 0;
    while (i < s.win.length && s.win[i] <= t - W) i += 2;
    if (i) s.win.splice(0, i);
    let sum = 0;
    for (let j = 1; j < s.win.length; j += 2) sum += s.win[j];
    rec.current.tokensRate = (sum * 1000) / W;
    s.lastSample = t;
    this._pushSample(rec, t);
  }

  /** Rate window at `t`: ~3 inter-token gaps, never reaching before the stretch. */
  private _window(s: Stream, t: number): number {
    const base = s.itl === null ? RATE_WINDOW_MS[1] : clamp(3 * s.itl, RATE_WINDOW_MS[0], RATE_WINDOW_MS[1]);
    return Math.max(SAMPLE_MS, Math.min(base, t - s.from));
  }

  /**
   * Health-tick sampling of an event-fed agent: once its events stop, its
   * rate falls to zero when the last tokens leave the window. That sample is
   * placed at that moment, but only taken once no event has arrived for the
   * window plus a tick, so batched delivery keeps its event times.
   */
  private _tickStream(rec: AgentRecord, s: Stream, now: number): void {
    if (s.win.length) {
      const last = s.win[s.win.length - 2];
      if (s.lastSample < last) {
        // Tokens not sampled yet (a held-back first chunk): sample them now.
        if (now - s.arrived >= STREAM_TICK_MS) this._sampleStream(rec, s, s.t, false);
        return;
      }
      const W = this._window(s, last);
      if (now - s.arrived < W + STREAM_TICK_MS) return;
      s.t = Math.min(now, Math.max(s.t, last + W));
      this._sampleStream(rec, s, s.t, false);
    } else if (now - s.lastSample >= STREAM_TICK_MS) {
      s.t = Math.max(s.t, now);
      this._sampleStream(rec, s, now, false);
    }
  }

  // ── Demo simulator ─────────────────────────────────────────────────────

  simTick(rng: Rng, now: number): void {
    if (this.pausedAt !== null) return;
    for (const rec of this.list) {
      const prev = this._sim.get(rec.id) ?? {
        anomalyTicks: 0,
        confidence: rec.current.confidenceScore ?? 0.9,
      };
      const step = simStep(toAgent(rec), prev, this._locked.has(rec.id), rng);
      this._sim.set(rec.id, step.state);
      rec.current.tokensRate = step.tokensRate;
      rec.current.progress = step.progress;
      rec.current.confidenceScore = step.confidenceScore;
      this._simTouched.add(rec.id);
      this._setStatus(rec, step.status, now, step.tokensRate > this._idleRate);
      this._pushSample(rec, now);
    }
  }

  /** Don't leave demo-only signals on agents once the simulator stops. */
  simStop(): void {
    for (const id of this._simTouched) {
      const rec = this.byId.get(id);
      if (rec) delete rec.current.confidenceScore;
    }
    this._simTouched.clear();
    this._sim.clear();
  }

  // ── Health and anomalies ───────────────────────────────────────────────

  /**
   * Run detection and health for every agent (hidden ones too: hiding a line
   * must not stop monitoring it). Emits, in order and per agent, anomalies
   * that just opened or escalated and health values that changed. Each
   * agent's state is updated before its events are emitted.
   */
  healthTick(now: number, detectOn: boolean, cfg: AnomalyConfig, emit: (e: StoreEvent) => void): void {
    for (const ev of this._pendingEvents.splice(0)) emit(ev);
    this._idleRate = cfg.stallRateThreshold;
    // Keep enough history for the slowest detector rule in this config.
    this._detectorHistoryMs = Math.max(
      DETECTOR_HISTORY_MS,
      2 * cfg.thinkingStallMs + 15_000,
      2 * cfg.stallDurationMs + 15_000,
      cfg.spikeBaselineMs + 10_000
    );
    const dt = this._lastTick ? Math.max(0, now - this._lastTick) : 0;
    this._lastTick = now;
    for (const rec of this.list) {
      // Event-fed agents: no event is information too (the rate decays).
      const st = this._streams.get(rec.id);
      if (st) this._tickStream(rec, st, now);
      const tBuf = this.tokens.get(rec.id);
      let found: Anomaly[] = [];
      if (detectOn && tBuf) {
        const tokens = tBuf.since(now - this.retentionMs());
        const changes =
          this.status.get(rec.id)?.transitionsInRange(now - cfg.thrashWindowMs, now) ?? [];
        const eps = this._episodes.get(rec.id) ?? new Map<AnomalyKind, Episode>();
        // Open episodes are passed in so detectors keep the baseline they
        // opened against and apply hysteresis.
        const open = new Map([...eps].map(([k, ep]) => [k, { since: ep.since, baseline: ep.baseline }]));
        // Slow reference of the agent's active rate (time constant ~5 min),
        // updated from this tick's active output.
        let sum = 0;
        let n = 0;
        for (const s of tBuf.since(now - (dt || 500))) {
          if (s.v > cfg.stallRateThreshold) {
            sum += s.v;
            n++;
          }
        }
        if (n) {
          const activeMs = (this._refActiveMs.get(rec.id) ?? 0) + (dt || 500);
          this._refActiveMs.set(rec.id, activeMs);
          const prev = this._refRate.get(rec.id) ?? 0;
          // A plain mean of the active output during warm-up (so the first
          // tick, often a ramp, can't anchor it), then the slow average.
          const a =
            activeMs <= REFERENCE_WARMUP_MS ? (dt || 500) / activeMs : 1 - Math.exp(-(dt || 500) / 300_000);
          this._refRate.set(rec.id, prev + (sum / n - prev) * a);
        }
        found = detectAnomalies(tokens, changes, rec.current.status, now, cfg, open, {
          // Only once it reflects real activity, not a start-up ramp.
          referenceRate: (this._refActiveMs.get(rec.id) ?? 0) >= REFERENCE_WARMUP_MS ? this._refRate.get(rec.id) : undefined,
          statusReported: this._statusReported.has(rec.id),
          statusSince: this._statusSince.get(rec.id),
          workSince: this._workSince.get(rec.id),
          waitingOn: st?.tools[st.tools.length - 1] || undefined,
        });
        const prev = this.anomalies.get(rec.id) ?? [];
        if (found.length || prev.length) this.dirty = true;
        this.anomalies.set(rec.id, found);

        // Report once when an episode opens (and on escalation), not on every
        // tick, and once when it ends.
        for (const a of found) {
          const open = eps.get(a.kind);
          const escalated = open?.severity === 'warning' && a.severity === 'critical';
          if (!open || escalated) emit({ kind: 'anomaly', id: rec.id, name: rec.name, anomaly: a });
          eps.set(a.kind, {
            since: open?.since ?? now,
            baseline: open?.baseline ?? a.baseline,
            severity: open && !escalated ? open.severity : a.severity,
            lastSeen: now,
            last: a,
            name: rec.name,
          });
        }
        for (const [kind, ep] of Array.from(eps)) {
          if (now - ep.lastSeen >= EPISODE_GRACE_MS) {
            eps.delete(kind);
            emit({ kind: 'resolved', id: rec.id, name: rec.name, anomaly: ep.last });
          }
        }
        this._episodes.set(rec.id, eps);
      } else if (this.anomalies.has(rec.id) || this._episodes.has(rec.id)) {
        // Detection switched off: open episodes end now.
        for (const ev of this._closeEpisodes(rec.id)) emit(ev);
        this.anomalies.delete(rec.id);
        this.dirty = true;
      }

      const rates = tBuf ? tBuf.valuesSince(now - HEALTH_WINDOW_MS) : [];
      const health = calculateHealth(toAgent(rec), rates, detectOn ? found : undefined, this._latency.get(rec.id));
      const cached = this._health.get(rec.id);
      // Ease the headline score so it doesn't flicker; a large drop (e.g. an
      // anomaly penalty) surfaces immediately.
      let score = health.score;
      if (cached && health.score >= cached.score - 15) {
        score = Math.round(cached.score * 0.6 + health.score * 0.4);
      }
      const smoothed = { ...health, score };
      const changed =
        !cached ||
        Math.abs(cached.score - smoothed.score) >= 1 ||
        cached.hallucinationRisk !== smoothed.hallucinationRisk ||
        cached.latencyTrend !== smoothed.latencyTrend;
      this._health.set(rec.id, smoothed);
      if (changed) emit({ kind: 'health', id: rec.id, health: smoothed });
    }
  }

  // ── Live values ────────────────────────────────────────────────────────

  /**
   * Ease live values toward their targets (all agents, so getLiveMetrics is
   * always current). Frozen while paused; snapped when `snap` (reduced
   * motion). Returns whether a visible agent is still easing.
   */
  stepLive(delta: number, snap: boolean): boolean {
    const EPS = 0.05;
    let animating = false;
    const paused = this.pausedAt !== null;
    for (const rec of this.list) {
      let lv = this.live.get(rec.id);
      if (!lv) {
        lv = { tokensRate: rec.current.tokensRate, progress: rec.current.progress, status: rec.current.status };
        this.live.set(rec.id, lv);
      }
      lv.status = rec.current.status;
      if (paused) continue;
      const dp = rec.current.progress - lv.progress;
      const dt = rec.current.tokensRate - lv.tokensRate;
      if (snap || (Math.abs(dp) <= EPS && Math.abs(dt) <= EPS)) {
        lv.progress = rec.current.progress;
        lv.tokensRate = rec.current.tokensRate;
        continue;
      }
      lv.progress = lerp(lv.progress, rec.current.progress, 1 - Math.pow(0.78, delta));
      lv.tokensRate = lerp(lv.tokensRate, rec.current.tokensRate, 1 - Math.pow(0.88, delta));
      if (rec.visible) animating = true;
    }
    return animating;
  }

  // ── Invalidation ───────────────────────────────────────────────────────

  /** Request a redraw; `rescaleAxis` also recomputes the token axis. */
  invalidate(rescaleAxis = false): void {
    if (rescaleAxis) this.axis.bucket = -1;
    this.dirty = true;
  }

  /** Whether a redraw was requested since the last call; clears the request. */
  takeDirty(): boolean {
    const d = this.dirty;
    this.dirty = false;
    return d;
  }

  setOptions(options: StoreOptions): void {
    this.options = options;
  }

  // ── Pause ──────────────────────────────────────────────────────────────

  setPaused(paused: boolean, now: number): void {
    this.pausedAt = paused ? now : null;
    this.dirty = true;
  }

  // ── Reads ──────────────────────────────────────────────────────────────

  getHealth(id: string): HealthMetrics | undefined {
    const h = this._health.get(id);
    return h ? { ...h } : undefined;
  }

  getAnomalies(id: string): Anomaly[] {
    return (this.anomalies.get(id) ?? []).map((a) => ({ ...a }));
  }

  getStats(id: string, now: number): AgentStreamStats | undefined {
    const rec = this.byId.get(id);
    if (!rec) return undefined;
    const s = this._streams.get(id);
    return {
      totalTokens: s?.total ?? 0,
      ttftMs: s?.ttft ?? null,
      interTokenMs: s?.itl ?? null,
      tool: s?.tools.length ? s.tools[s.tools.length - 1] : null,
      statusMs: Math.max(0, now - (this._statusSince.get(id) ?? now)),
    };
  }

  getLiveMetrics(id: string): LiveValues | undefined {
    const lv = this.live.get(id);
    const rec = this.byId.get(id);
    if (!lv || !rec) return undefined;
    // Status is discrete and never eased: report it as of now.
    return { tokensRate: lv.tokensRate, progress: lv.progress, status: rec.current.status };
  }

  // ── Row snapshot (useSyncExternalStore) ────────────────────────────────

  private _buildRows(): RowSnapshot[] {
    return this.list.map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      visible: r.visible,
      status: r.current.status,
      // The latest real sample, not the eased tip: frames can be throttled
      // (background tabs), and a readout must not lag behind the data.
      rate: r.current.tokensRate,
      score: this._health.get(r.id)?.score ?? null,
    }));
  }

  /** Recompute rows; notify subscribers only if something visible changed. */
  publish(): void {
    const next = this._buildRows();
    if (sameRows(this._rows, next)) return;
    this._rows = next;
    for (const l of this._listeners) l();
  }

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  };

  getRows = (): RowSnapshot[] => this._rows;
}

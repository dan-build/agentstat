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
  type AgentSample,
  type AgentStatus,
  type HealthMetrics,
} from '../types';
import {
  DEFAULT_VIEW_MS,
  EPISODE_GRACE_MS,
  HEALTH_WINDOW_MS,
  LATENCY_HISTORY,
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
  | { kind: 'health'; id: string; health: HealthMetrics };

export interface StoreOptions {
  windowSeconds?: number;
  maxHistoryPoints: number;
}

type Episode = { severity: AnomalySeverity; lastSeen: number };

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
  private _latency = new Map<string, number[]>();
  private _health = new Map<string, HealthMetrics>();
  private _episodes = new Map<string, Map<AnomalyKind, Episode>>();
  // Agents whose anomalous status was set by the consumer; the simulator
  // must not auto-recover them.
  private _locked = new Set<string>();
  private _sim = new Map<string, SimState>();
  private _simTouched = new Set<string>();
  private _rows: RowSnapshot[] = [];
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
      let rec = this.byId.get(a.id);
      if (!rec) {
        rec = makeRecord(a);
        this.byId.set(a.id, rec);
        const series = createSeries(rec, this.options.maxHistoryPoints, now);
        this.progress.set(a.id, series.progress);
        this.tokens.set(a.id, series.tokens);
        this.status.set(a.id, series.status);
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
    for (const id of Array.from(this.byId.keys())) {
      if (!nextProps.has(id)) this._drop(id);
    }
    this._props = nextProps;
    this.list = next;
    this.dirty = true;
  }

  private _drop(id: string): void {
    this.byId.delete(id);
    this.progress.delete(id);
    this.tokens.delete(id);
    this.status.delete(id);
    this._latency.delete(id);
    this.live.delete(id);
    this._health.delete(id);
    this.anomalies.delete(id);
    this._episodes.delete(id);
    this._locked.delete(id);
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

  /** Samples are kept for 1.5× the visible window. */
  retentionMs(): number {
    const winS = this.options.windowSeconds;
    return (winS !== undefined && winS > 0 ? winS * 1000 : DEFAULT_VIEW_MS) * 1.5;
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
    if (status !== undefined) {
      cur.status = status;
      this.status.get(id)?.record(now, status);
      if (this.pausedAt === null) this.dirty = true;
    }
    if (tokensRate !== undefined || progress !== undefined) this._pushSample(rec, now);
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
      if (step.status !== rec.current.status) {
        rec.current.status = step.status;
        this.status.get(rec.id)?.record(now, step.status);
      }
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
    for (const rec of this.list) {
      const tBuf = this.tokens.get(rec.id);
      let found: Anomaly[] = [];
      if (detectOn && tBuf) {
        const tokens = tBuf.since(now - this.retentionMs());
        const changes =
          this.status.get(rec.id)?.transitionsInRange(now - cfg.thrashWindowMs, now) ?? [];
        found = detectAnomalies(tokens, changes, rec.current.status, now, cfg);
        const prev = this.anomalies.get(rec.id) ?? [];
        if (found.length || prev.length) this.dirty = true;
        this.anomalies.set(rec.id, found);

        // Once per episode (and on escalation), not once per tick.
        const eps = this._episodes.get(rec.id) ?? new Map<AnomalyKind, Episode>();
        for (const a of found) {
          const open = eps.get(a.kind);
          const escalated = open?.severity === 'warning' && a.severity === 'critical';
          if (!open || escalated) emit({ kind: 'anomaly', id: rec.id, name: rec.name, anomaly: a });
          eps.set(a.kind, { severity: a.severity, lastSeen: now });
        }
        for (const [kind, ep] of Array.from(eps)) {
          if (now - ep.lastSeen > EPISODE_GRACE_MS) eps.delete(kind);
        }
        this._episodes.set(rec.id, eps);
      } else if (this.anomalies.has(rec.id)) {
        this.anomalies.delete(rec.id);
        this._episodes.delete(rec.id);
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

// scripts/eval/harness.ts
//
// Deterministic replay of a labelled scenario through the real AgentStore +
// detectors, and scoring of the emitted anomaly events against ground truth.

import { AgentStore } from '../../src/core/store';
import { DEFAULT_ANOMALY_CONFIG, type AnomalyConfig, type AnomalyKind } from '../../src/anomaly';
import { HEALTH_TICK_MS } from '../../src/core/constants';
import { mulberry32, type Rng } from '../../src/simulator';
import type { Agent, AgentSample } from '../../src/types';

/** Alerts up to this long after a label's end still count for it. */
export const TOLERANCE_MS = 3_000;
/** Time origin, so timestamps look like a page that has been open a while. */
const T0 = 10_000;

export interface Label {
  /** Agent index; omitted = every agent in the scenario. */
  agent?: number;
  kind: AnomalyKind;
  /** Seconds from scenario start. */
  start: number;
  end: number;
  /** "Allowed but not required": matching alerts are neither TP nor FP, absence is not a miss. */
  optional?: boolean;
}

export interface Scenario {
  name: string;
  seed: number;
  agents?: number;
  durationS: number;
  /** Sample period (ms). Default 100 (10 Hz). */
  periodMs?: number;
  cfg?: Partial<AnomalyConfig>;
  labels: Label[];
  /** Called every period per agent; return null to send nothing (dropped stream). */
  step: (tS: number, agent: number, rng: Rng) => AgentSample | null;
}

export interface Alert {
  agent: number;
  kind: AnomalyKind;
  severity: string;
  /** Seconds from scenario start (tick time). */
  t: number;
  /** Seconds the detector anchored the anomaly at. */
  anchor: number;
  message: string;
  /** Index into labels, or -1 when it matched none. */
  label: number;
}

export interface LabelResult extends Label {
  agentIdx: number;
  hit: boolean;
  latencyS: number | null;
  alerts: number;
}

export interface ScenarioResult {
  name: string;
  agents: number;
  durationS: number;
  alerts: Alert[];
  tp: number;
  fp: number;
  misses: number;
  allowed: number;
  latencies: number[];
  medianLatencyS: number | null;
  /** Max alerts matched to one label (1 = clean, 2 = one escalation, >2 = repeats). */
  maxPerEpisode: number;
  labels: LabelResult[];
  fpByKind: Record<string, number>;
}

export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function runScenario(sc: Scenario): ScenarioResult {
  const n = sc.agents ?? 1;
  const period = sc.periodMs ?? 100;
  const cfg: AnomalyConfig = { ...DEFAULT_ANOMALY_CONFIG, ...sc.cfg };
  const rng = mulberry32(sc.seed);
  const agents: Agent[] = Array.from({ length: n }, (_, i) => ({
    id: `a${i}`,
    name: `agent ${i}`,
    current: { tokensRate: 0, progress: 0, status: 'active' },
  }));
  const store = new AgentStore(agents, { maxHistoryPoints: 100_000 }, T0);
  const alerts: Alert[] = [];
  const endMs = sc.durationS * 1000;
  // Integer-ms clock; samples and ticks that coincide are applied ingest-first.
  for (let ms = 0; ms <= endMs; ms++) {
    const now = T0 + ms;
    if (ms % period === 0) {
      for (let i = 0; i < n; i++) {
        const s = sc.step(ms / 1000, i, rng);
        if (s) store.ingest(`a${i}`, s, now);
      }
    }
    if (ms % HEALTH_TICK_MS === 0 && ms > 0) {
      store.healthTick(now, true, cfg, (e) => {
        if (e.kind !== 'anomaly') return;
        alerts.push({
          agent: Number(e.id.slice(1)),
          kind: e.anomaly.kind,
          severity: e.anomaly.severity,
          t: ms / 1000,
          anchor: (e.anomaly.t - T0) / 1000,
          message: e.anomaly.message,
          label: -1,
        });
      });
    }
  }
  return score(sc, n, alerts);
}

function score(sc: Scenario, n: number, alerts: Alert[]): ScenarioResult {
  // Expand agent-less labels to one per agent.
  const labels: LabelResult[] = [];
  for (const l of sc.labels) {
    const idxs = l.agent === undefined ? Array.from({ length: n }, (_, i) => i) : [l.agent];
    for (const a of idxs) labels.push({ ...l, agentIdx: a, hit: false, latencyS: null, alerts: 0 });
  }
  const tol = TOLERANCE_MS / 1000;
  let fp = 0;
  let allowed = 0;
  const fpByKind: Record<string, number> = {};
  for (const al of alerts) {
    // Prefer a required label over an optional one when both cover the alert.
    let best = -1;
    labels.forEach((l, i) => {
      if (l.agentIdx !== al.agent || l.kind !== al.kind) return;
      if (al.t < l.start || al.t > l.end + tol) return;
      if (best === -1 || (labels[best].optional && !l.optional)) best = i;
    });
    al.label = best;
    if (best === -1) {
      fp++;
      fpByKind[al.kind] = (fpByKind[al.kind] ?? 0) + 1;
      continue;
    }
    const l = labels[best];
    l.alerts++;
    if (l.optional) {
      allowed++;
      continue;
    }
    if (!l.hit) {
      l.hit = true;
      l.latencyS = +(al.t - l.start).toFixed(2);
    }
  }
  const req = labels.filter((l) => !l.optional);
  const tp = req.filter((l) => l.hit).length;
  const latencies = req.flatMap((l) => (l.latencyS === null ? [] : [l.latencyS]));
  return {
    name: sc.name,
    agents: n,
    durationS: sc.durationS,
    alerts,
    tp,
    fp,
    misses: req.length - tp,
    allowed,
    latencies,
    medianLatencyS: median(latencies),
    maxPerEpisode: Math.max(0, ...req.map((l) => l.alerts)),
    labels,
    fpByKind,
  };
}

/** Standard normal via Box–Muller on the seeded RNG. */
export const gauss = (rng: Rng): number => {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
};

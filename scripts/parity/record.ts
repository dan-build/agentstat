// scripts/parity/record.ts
//
// Records every labelled eval scenario as a parity trace: each input the
// AgentStore received (samples, events, health ticks, with exact times) and
// everything it produced at each tick. The Rust core replays the inputs and
// must produce the same outputs, so both implementations stay identical.

import { AgentStore, type StoreEvent } from '../../src/core/store';
import { DEFAULT_ANOMALY_CONFIG, type AnomalyConfig } from '../../src/anomaly';
import { HEALTH_TICK_MS } from '../../src/core/constants';
import { mulberry32 } from '../../src/simulator';
import type { Agent } from '../../src/types';
import type { Scenario } from '../eval/harness';
import { SCENARIOS } from '../eval/scenarios';
import { ADVERSARIAL } from '../eval/adversarial';
import { HOLDOUT } from '../eval/holdout';
import { EVENTS } from '../eval/events';
import { HOLDOUT2 } from '../eval/holdout2';

const T0 = 10_000;

type Op =
  | { op: 'ingest'; now: number; id: string; sample: unknown }
  | { op: 'push'; now: number; id: string; event: unknown }
  | { op: 'tick'; now: number; out: unknown[]; agents: unknown[] };

// `event` names what happened; an anomaly's own `kind` is stall/spike/thrash.
const outEvent = (e: StoreEvent) =>
  e.kind === 'health'
    ? { event: 'health', id: e.id, ...e.health }
    : { event: e.kind, id: e.id, name: e.name, anomaly: e.anomaly };

export function record(sc: Scenario, set: string) {
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
  const ops: Op[] = [];
  const endMs = sc.durationS * 1000;
  for (let ms = 0; ms <= endMs; ms++) {
    const now = T0 + ms;
    if (ms % period === 0) {
      for (let i = 0; i < n; i++) {
        for (let b = 0; b < (sc.batch ?? 1); b++) {
          const s = sc.step(ms / 1000, i, rng);
          if (Array.isArray(s)) {
            for (const e of s) {
              const event = e.time === undefined ? e : { ...e, time: T0 + e.time };
              ops.push({ op: 'push', now, id: `a${i}`, event });
              store.push(`a${i}`, event, now);
            }
          } else if (s) {
            ops.push({ op: 'ingest', now, id: `a${i}`, sample: s });
            store.ingest(`a${i}`, s, now);
          }
        }
      }
    }
    if (ms % HEALTH_TICK_MS === 0 && ms > 0) {
      const out: unknown[] = [];
      store.healthTick(now, true, cfg, (e) => out.push(outEvent(e)));
      const snapshot = store.list.map((r) => ({
        id: r.id,
        status: r.current.status,
        rate: r.current.tokensRate,
        errors: r.current.errorCount ?? 0,
        stats: store.getStats(r.id, now),
      }));
      ops.push({ op: 'tick', now, out, agents: snapshot });
    }
  }
  return { name: sc.name, set, agents: n, t0: T0, cfg, ops };
}

export function recordAll() {
  return [
    ...SCENARIOS.map((sc) => record(sc, 'original')),
    ...ADVERSARIAL.map((sc) => record(sc, 'adversarial')),
    ...HOLDOUT.map((sc) => record(sc, 'holdout')),
    ...EVENTS.map((sc) => record(sc, 'events')),
    ...HOLDOUT2.map((sc) => record(sc, 'holdout2')),
  ];
}

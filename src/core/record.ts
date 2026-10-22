// src/core/record.ts — the store's per-agent record and its buffers.

import { TimeSeriesBuffer } from '../timeseries';
import { StatusLog } from '../statuslog';
import { AGENT_STATUSES, type Agent, type AgentStatus } from '../types';
import { DEFAULT_CAP, clamp } from './constants';

/** Mutable per-agent state owned by the store. */
export type AgentRecord = {
  id: string;
  name: string;
  color?: string;
  config?: Agent['config'];
  visible: boolean;
  current: Agent['current'];
};

/** Values drawn at the live tip, eased toward the latest sample. */
export type LiveValues = { tokensRate: number; progress: number; status: AgentStatus };

/** Normalize an `Agent` prop into a record. */
export const makeRecord = (a: Agent): AgentRecord => {
  const num = (v: unknown, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : 0;
  const status = AGENT_STATUSES.includes(a.current?.status) ? a.current.status : 'active';
  return {
    id: a.id,
    name: a.name ?? a.id,
    color: a.color,
    config: a.config,
    visible: a.visible ?? true,
    current: {
      ...a.current,
      tokensRate: num(a.current?.tokensRate, 0, Infinity),
      progress: num(a.current?.progress, 0, 100),
      status,
    },
  };
};

/**
 * Buffers for one agent, holding one real sample: the state the consumer
 * declared. No backfilled history — a telemetry chart must not draw data
 * that never happened.
 */
export const createSeries = (rec: AgentRecord, maxHistoryPoints: number, now: number, progressKnown: boolean) => {
  const cap = Math.max(2, Math.floor(maxHistoryPoints) || DEFAULT_CAP);
  const progress = new TimeSeriesBuffer(cap);
  const tokens = new TimeSeriesBuffer(cap);
  // Unknown progress has no samples (not 0%) until the agent reports it.
  if (progressKnown) progress.push(now, rec.current.progress);
  tokens.push(now, rec.current.tokensRate);
  const status = new StatusLog();
  status.record(now, rec.current.status);
  return { progress, tokens, status };
};

/** Public `Agent` view of a record (shares `current`). */
export const toAgent = (r: AgentRecord): Agent => ({
  id: r.id,
  name: r.name,
  color: r.color,
  config: r.config,
  visible: r.visible,
  current: r.current,
});

export const sameBand = (a?: [number, number], b?: [number, number]) =>
  a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1]);

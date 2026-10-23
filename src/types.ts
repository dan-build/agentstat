// src/types.ts
//
// Public data types. Kept in a leaf module so the helpers (status log, anomaly
// detection, health scoring) can import them without importing the component.

/**
 * - `active`: producing output.
 * - `thinking`: working without output (reasoning, reading a tool result).
 * - `waiting`: blocked on something outside the model — a tool call,
 *   subagents, a person. Quiet output is expected; only a very long wait
 *   (`AnomalyConfig.waitingStallMs`) counts as a stall.
 * - `stuck`, `hallucinating`: problems you detected yourself.
 * - `complete`: done (or idle between jobs).
 */
export type AgentStatus = 'active' | 'stuck' | 'thinking' | 'waiting' | 'complete' | 'hallucinating';

export const AGENT_STATUSES: readonly AgentStatus[] = [
  'active',
  'stuck',
  'thinking',
  'waiting',
  'complete',
  'hallucinating',
];

/**
 * Which series the chart plots on the primary visual.
 * - 'auto' (default): progress once every visible agent reports it, else the
 *   token rate — an agent that never reports progress has none to show.
 * - 'progress': the 0–100% progress curve.
 * - 'tokens': the token-rate curve on a data-driven auto-scaled axis.
 * - 'both': progress on the left axis, token rate on the right (dual-axis).
 *
 * With 'progress' or 'both', an agent that hasn't reported progress has no
 * line (its progress is unknown, not 0%).
 */
export type ChartMetric = 'auto' | 'progress' | 'tokens' | 'both';

export type AgentDataPoint = {
  /** Sample time in the `performance.now()` clock domain. */
  time: number;
  tokensRate: number;
  progress: number;
  status: AgentStatus;
  latencyMs?: number;
  confidenceScore?: number;
  errorCount?: number;
};

export type HealthMetrics = {
  /** Composite 0–100 over the components that have data. */
  score: number;
  /**
   * How close the recent average token rate sits to the agent's expected band
   * (`config.expectedTokensPerSec`). 100 = inside the band; falls off with the
   * distance outside it, relative to the band's upper edge.
   */
  tokenEfficiency: number;
  /** Steadiness of the token rate relative to its own level. 100 = steady. */
  stability: number;
  /**
   * Caller-supplied signal only — AgentStat cannot detect hallucinations from
   * telemetry. `1 − confidenceScore` as a percentage when you pass a
   * confidence, 100 while you report status `'hallucinating'`, otherwise null.
   */
  hallucinationRisk: number | null;
  /**
   * Direction of `latencyMs` across recent updates. null until at least four
   * latency samples have been reported.
   */
  latencyTrend: 'improving' | 'stable' | 'degrading' | null;
};

/**
 * A partial telemetry update. Omitted fields keep their previous value, so you
 * can report only what changed (e.g. just the rate, or just the status).
 */
export type AgentSample = {
  tokensRate?: number;
  /** 0–100. */
  progress?: number;
  status?: AgentStatus;
  /** Latency of the last model/tool call, in ms. Enables `latencyTrend`. */
  latencyMs?: number;
  /** Your own 0–1 quality/grounding signal. Enables `hallucinationRisk`. */
  confidenceScore?: number;
  errorCount?: number;
};

export type Agent = {
  id: string;
  name: string;
  /**
   * Any CSS color (`#hex`, `rgb()`, `hsl()`, named, or `var(--token)`).
   * Omit to use the next color of the theme's built-in palette, which is
   * tuned for contrast on both light and dark backgrounds.
   */
  color?: string;
  /** @deprecated Not read. AgentStat keeps its own buffers; omit it. */
  data?: AgentDataPoint[];
  current: {
    tokensRate: number;
    progress: number;
    status: AgentStatus;
    latencyMs?: number;
    confidenceScore?: number;
    errorCount?: number;
  };
  config?: {
    expectedTokensPerSec?: [number, number];
    /** @deprecated Not read. */
    maxHallucinationThreshold?: number;
  };
  /** Initial visibility (default true). Legend clicks toggle it at runtime. */
  visible?: boolean;
};

/**
 * A raw stream event, for `ref.current.push(id, event)`. AgentStat derives the
 * token rate, time to first token, inter-token latency and status from these,
 * so you forward what your stream emits instead of computing rates yourself.
 *
 * `time` is optional, in the `performance.now()` clock (default: now). A time
 * in the future is treated as now; one earlier than anything already recorded
 * for the agent, as that time.
 *
 * Statuses derived from events don't replace a `stuck` or `hallucinating`
 * status set with `updateAgent`; that holds until `updateAgent` changes it.
 */
export type AgentEvent =
  /** A model request was sent. Status → `thinking`; starts the TTFT clock. */
  | { type: 'start'; time?: number }
  /**
   * Output arrived. Pass `count` (tokens in this chunk) or `total` (running
   * count for the agent: the first total only sets the starting point, and a
   * smaller total than before starts a new count). Status → `active`.
   */
  | {
      type: 'tokens';
      count?: number;
      total?: number;
      /**
       * When this output began, if it arrives as one block after the fact
       * (e.g. a call reported when it ended): plotted at its average rate
       * over [since, time], and its time from `start` is the TTFT.
       */
      since?: number;
      time?: number;
    }
  /** A tool call began (nest freely). Status → `waiting` while any is open. */
  | { type: 'tool-start'; name?: string; time?: number }
  /**
   * A tool call returned. Closes the most recent open call with this `name`
   * (or the most recent one). Status → `thinking` once none are open.
   * `error: true` also counts an error.
   */
  | { type: 'tool-end'; name?: string; error?: boolean; time?: number }
  /** Something failed. Increments `errorCount`. */
  | { type: 'error'; time?: number }
  /** The run finished. Status → `complete`; open tool calls are closed. */
  | { type: 'finish'; time?: number };

/** What AgentStat derived from an agent's events (see `AgentEvent`). */
export type AgentStreamStats = {
  /** Tokens counted from `tokens` events since the agent was added. */
  totalTokens: number;
  /** Time from the last `start` (or `tool-end`) to the first token after it. */
  ttftMs: number | null;
  /** Typical gap between token events while streaming (moving average). */
  interTokenMs: number | null;
  /** Name of the innermost open tool call ('' if unnamed), or null. */
  tool: string | null;
  /** How long the agent has been in its current status, in ms. */
  statusMs: number;
};

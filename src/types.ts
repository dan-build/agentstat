// src/types.ts
//
// Public data types. Kept in a leaf module so the helpers (status log, anomaly
// detection, health scoring) can import them without importing the component.

export type AgentStatus = 'active' | 'stuck' | 'thinking' | 'complete' | 'hallucinating';

export const AGENT_STATUSES: readonly AgentStatus[] = [
  'active',
  'stuck',
  'thinking',
  'complete',
  'hallucinating',
];

/**
 * Which series the chart plots on the primary visual.
 * - 'progress' (default): the 0–100% progress curve.
 * - 'tokens': the token-rate curve on a data-driven auto-scaled axis.
 * - 'both': progress on the left axis, token rate on the right (dual-axis).
 */
export type ChartMetric = 'progress' | 'tokens' | 'both';

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

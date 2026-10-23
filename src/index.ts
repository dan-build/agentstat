export { default as AgentStat, createAgent, demoAgents } from './AgentStat';

export { detectAnomalies, DEFAULT_ANOMALY_CONFIG } from './anomaly';

export { createAgentStream, useAgentStream } from './stream';
export { useAgentTelemetry, AgentStatusBadge, AnomalyBanner, AgentRoster, AgentTimeline } from './telemetry';
export type { AgentTelemetry, TelemetryOptions } from './telemetry';
export type { AgentSource, AgentStream, AgentStreamMessage } from './stream';

export type { AgentStatProps, AgentStatRef } from './AgentStat';

export type {
  Agent,
  AgentDataPoint,
  AgentEvent,
  AgentStreamStats,
  AgentSample,
  AgentStatus,
  HealthMetrics,
  ChartMetric,
} from './types';

export type { Anomaly, AnomalyKind, AnomalySeverity, AnomalyConfig } from './anomaly';

export { default as AgentStat, createAgent, demoAgents } from './AgentStat';

export {
  detectAnomalies,
  DEFAULT_ANOMALY_CONFIG,
} from './anomaly';

export type {
  Agent,
  AgentDataPoint,
  AgentStatus,
  AgentStatProps,
  AgentStatRef,
  HealthMetrics,
  ChartMetric,
} from './AgentStat';

export type {
  Anomaly,
  AnomalyKind,
  AnomalySeverity,
  AnomalyConfig,
} from './anomaly';

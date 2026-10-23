// src/telemetry.tsx — agent telemetry without the chart: a headless hook
// (`useAgentTelemetry`) running the same store, event handling and anomaly
// detection, and small components built on it.

import React, { useEffect, useState } from 'react';
import { AgentStore } from './core/store';
import { HEALTH_TICK_MS } from './core/constants';
import { DEFAULT_ANOMALY_CONFIG, type Anomaly, type AnomalyConfig } from './anomaly';
import type { AgentSource } from './stream';
import type { AgentStatus } from './types';
import { useSourceSubscription } from './ui/useSource';
import { useMediaQuery } from './ui/hooks';
import { StatusIcon } from './ui/StatusIcon';
import { formatInt, formatRate, formatStatus } from './format';
import { tokensFor, FONT_SANS, FONT_MONO, type ThemeMode } from './theme';

/** One agent's live telemetry. */
export type AgentTelemetry = {
  id: string;
  name: string;
  status: AgentStatus;
  /** How long it has had this status (ms). */
  statusMs: number;
  /** Innermost open tool call ('' if unnamed), or null. */
  tool: string | null;
  tokensRate: number;
  totalTokens: number;
  ttftMs: number | null;
  /** 0–100, or null before the first health tick. */
  health: number | null;
  /** Anomalies active now (empty with detection off). */
  anomalies: Anomaly[];
  /** Status history, oldest first: each status and how long ago it began and ended (ms; end 0 = now). */
  history: { status: AgentStatus; fromMs: number; toMs: number }[];
};

export interface TelemetryOptions {
  /** Detect stalls, spikes and thrash. Default true. */
  anomalyDetection?: boolean;
  anomalyConfig?: Partial<AnomalyConfig>;
  /** Status history kept for `history` (seconds). Default 300. */
  historySeconds?: number;
}

/**
 * Live telemetry for every agent of `source`, updated every half second —
 * what the chart shows, without the chart, for building your own UI (or the
 * components below).
 *
 * ```tsx
 * const agents = useAgentTelemetry(stream);
 * return <AgentRoster agents={agents} />;
 * ```
 */
export function useAgentTelemetry(source: AgentSource | undefined, options: TelemetryOptions = {}): AgentTelemetry[] {
  const historyMs = (options.historySeconds ?? 300) * 1000;
  const [store] = useState(() => new AgentStore([], { windowSeconds: historyMs / 1500, maxHistoryPoints: 10_000 }, 0));
  const [agents, setAgents] = useState<AgentTelemetry[]>([]);
  useSourceSubscription(store, source);

  const detect = options.anomalyDetection ?? true;
  const cfgKey = JSON.stringify(options.anomalyConfig ?? {});
  useEffect(() => {
    const cfg: AnomalyConfig = { ...DEFAULT_ANOMALY_CONFIG, ...(JSON.parse(cfgKey) as Partial<AnomalyConfig>) };
    const tick = () => {
      const now = performance.now();
      store.healthTick(now, detect, cfg, () => {});
      if (typeof document !== 'undefined' && document.hidden) return;
      setAgents(
        store.list.map((r) => {
          const stats = store.getStats(r.id, now);
          const changes = store.status.get(r.id)?.transitionsInRange(now - historyMs, now) ?? [];
          return {
            id: r.id,
            name: r.name,
            status: r.current.status,
            statusMs: stats?.statusMs ?? 0,
            tool: stats?.tool ?? null,
            tokensRate: r.current.tokensRate,
            totalTokens: stats?.totalTokens ?? 0,
            ttftMs: stats?.ttftMs ?? null,
            health: store.getHealth(r.id)?.score ?? null,
            anomalies: store.getAnomalies(r.id),
            history: changes.map((c, i) => ({
              status: c.status,
              fromMs: Math.min(historyMs, now - c.t),
              toMs: i + 1 < changes.length ? now - changes[i + 1].t : 0,
            })),
          };
        })
      );
    };
    tick();
    const interval = setInterval(tick, HEALTH_TICK_MS);
    return () => clearInterval(interval);
  }, [store, detect, cfgKey, historyMs]);

  return agents;
}

// ── Components ───────────────────────────────────────────────────────────

const CSS = `
.agentstat-c{font-family:var(--as-font);color:var(--as-text);font-size:13px;line-height:1.4}
.agentstat-c *{box-sizing:border-box}
.agentstat-badge{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%;padding:2px 10px;border-radius:999px;background:var(--as-surface);box-shadow:var(--as-shadow);border:1px solid transparent;color:var(--as-text-secondary);white-space:nowrap}
.agentstat-badge[data-tone="warning"]{color:var(--as-warning)}
.agentstat-badge[data-tone="critical"]{color:var(--as-critical)}
.agentstat-badge svg{flex-shrink:0}
.agentstat-badge-tool{overflow:hidden;text-overflow:ellipsis;min-width:0;color:var(--as-text)}
.agentstat-n{font-variant-numeric:tabular-nums}
.agentstat-banner{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:10px;background:var(--as-surface);box-shadow:var(--as-shadow);border:1px solid transparent}
.agentstat-banner-row{display:flex;align-items:baseline;gap:8px;min-width:0}
.agentstat-banner-row[data-tone="warning"] .agentstat-mark{color:var(--as-warning)}
.agentstat-banner-row[data-tone="critical"] .agentstat-mark{color:var(--as-critical)}
.agentstat-banner-name{font-weight:500;flex-shrink:0}
.agentstat-banner-msg{color:var(--as-text-secondary);min-width:0;overflow-wrap:anywhere}
.agentstat-roster{width:100%;border-collapse:collapse}
.agentstat-roster th{font-size:11px;font-weight:500;letter-spacing:0.05em;text-transform:uppercase;color:var(--as-text-tertiary);text-align:left;padding:4px 8px}
.agentstat-roster td{padding:6px 8px;border-top:1px solid var(--as-selected);vertical-align:middle}
.agentstat-roster .agentstat-n{text-align:right}
.agentstat-roster td:first-child{max-width:20ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agentstat-timeline{display:flex;height:10px;border-radius:999px;overflow:hidden;background:var(--as-selected)}
.agentstat-timeline span{height:100%;min-width:1px}
.agentstat-timeline [data-s="active"]{background:oklch(0.66 0.14 155)}
.agentstat-timeline [data-s="thinking"]{background:oklch(0.64 0.12 255)}
.agentstat-timeline [data-s="waiting"]{background:var(--as-text-tertiary)}
.agentstat-timeline [data-s="complete"]{background:transparent}
.agentstat-timeline [data-s="stuck"]{background:var(--as-warning)}
.agentstat-timeline [data-s="hallucinating"]{background:var(--as-critical)}
.agentstat-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
`;

type Themed = {
  /** Default 'system' (follows the OS setting). */
  theme?: 'light' | 'dark' | 'system';
  className?: string;
  style?: React.CSSProperties;
};

/** Root element props: the chart's theme tokens as CSS variables. */
function useRoot({ theme = 'system', className, style }: Themed, cls: string) {
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)', theme === 'system');
  const mode: ThemeMode = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
  const t = tokensFor(mode);
  const vars = {
    '--as-surface': t.surface,
    '--as-text': t.text,
    '--as-text-secondary': t.textSecondary,
    '--as-text-tertiary': t.textTertiary,
    '--as-selected': t.selected,
    '--as-warning': t.warning,
    '--as-critical': t.critical,
    '--as-shadow': t.shadow,
    '--as-font': FONT_SANS,
    '--as-font-mono': FONT_MONO,
  } as React.CSSProperties;
  return {
    className: `agentstat-c ${cls}${className ? ` ${className}` : ''}`,
    'data-theme': mode,
    style: { ...vars, ...style },
  };
}

/** "12s", "4m 05s", "1h 02m". */
const formatSpan = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

const toneOf = (a: AgentTelemetry): 'warning' | 'critical' | undefined =>
  a.anomalies.some((x) => x.severity === 'critical') || a.status === 'hallucinating'
    ? 'critical'
    : a.anomalies.length || a.status === 'stuck'
      ? 'warning'
      : undefined;

/** An agent's status in words and icon: "Waiting · bash · 12s". */
export function AgentStatusBadge({ agent, ...themed }: { agent: AgentTelemetry } & Themed) {
  const root = useRoot(themed, 'agentstat-badge');
  return (
    <span {...root} data-tone={toneOf(agent)}>
      <style>{CSS}</style>
      <StatusIcon status={agent.status} />
      <span>{formatStatus(agent.status)}</span>
      {agent.tool !== null && (
        <>
          <span aria-hidden="true">·</span>
          <span className="agentstat-badge-tool" title={agent.tool || 'tool'}>
            <bdi>{agent.tool || 'tool'}</bdi>
          </span>
        </>
      )}
      <span aria-hidden="true">·</span>
      <span className="agentstat-n">{formatSpan(agent.statusMs)}</span>
    </span>
  );
}

/**
 * Anomalies active now, one line each ("Coder: stalled 12s while active");
 * nothing when there are none. Critical ones are announced assertively.
 */
export function AnomalyBanner({ agents, ...themed }: { agents: AgentTelemetry[] } & Themed) {
  const root = useRoot(themed, 'agentstat-banner');
  const rows = agents.flatMap((a) => a.anomalies.map((x) => ({ a, x })));
  if (!rows.length) return null;
  const critical = rows.some((r) => r.x.severity === 'critical');
  return (
    <div {...root} role={critical ? 'alert' : 'status'}>
      <style>{CSS}</style>
      {rows.map(({ a, x }) => (
        <div key={`${a.id}:${x.kind}`} className="agentstat-banner-row" data-tone={x.severity}>
          {/* Severity by shape as well as color: ▲ warning, ◆ critical. */}
          <span className="agentstat-mark" aria-hidden="true">
            {x.severity === 'critical' ? '◆' : '▲'}
          </span>
          <span className="agentstat-banner-name">
            <bdi>{a.name}</bdi>
          </span>
          <span className="agentstat-banner-msg">
            <span className="agentstat-sr">{x.severity}: </span>
            {x.message}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Every agent in a table: status, rate, tokens and health. */
export function AgentRoster({ agents, ...themed }: { agents: AgentTelemetry[] } & Themed) {
  const root = useRoot(themed, 'agentstat-roster-wrap');
  return (
    <div {...root}>
      <style>{CSS}</style>
      <table className="agentstat-roster">
        <caption className="agentstat-sr">Agents</caption>
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col">Status</th>
            <th scope="col" className="agentstat-n">
              Rate
            </th>
            <th scope="col" className="agentstat-n">
              Tokens
            </th>
            <th scope="col" className="agentstat-n">
              Health
            </th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.id}>
              <td title={a.name}>
                <bdi>{a.name}</bdi>
              </td>
              <td>
                <AgentStatusBadge agent={a} theme={root['data-theme']} />
              </td>
              <td className="agentstat-n">{formatRate(a.tokensRate)}</td>
              <td className="agentstat-n">{formatInt(a.totalTokens)}</td>
              <td className="agentstat-n">{a.health === null ? '–' : formatInt(a.health)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * An agent's status over the last `history` (from `useAgentTelemetry`): one
 * bar, a segment per status. The statuses are also listed for screen
 * readers, and named on hover.
 */
export function AgentTimeline({ agent, ...themed }: { agent: AgentTelemetry } & Themed) {
  const root = useRoot(themed, 'agentstat-timeline-wrap');
  const span = agent.history.length ? agent.history[0].fromMs : 0;
  return (
    <div {...root}>
      <style>{CSS}</style>
      <div className="agentstat-timeline" aria-hidden="true">
        {agent.history.map((h, i) => (
          <span
            key={i}
            data-s={h.status}
            title={`${formatStatus(h.status)} · ${formatSpan(h.fromMs - h.toMs)}`}
            style={{ flexGrow: span ? (h.fromMs - h.toMs) / span : 1 }}
          />
        ))}
      </div>
      <ol className="agentstat-sr">
        {agent.history.map((h, i) => (
          <li key={i}>
            {formatStatus(h.status)} for {formatSpan(h.fromMs - h.toMs)}
          </li>
        ))}
      </ol>
    </div>
  );
}

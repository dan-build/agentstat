// src/telemetry.tsx — agent telemetry without the chart: a headless hook
// (`useAgentTelemetry`) running the same store, event handling and anomaly
// detection, and small components built on it.

import React, { useEffect, useRef, useState } from 'react';
import { AgentStore } from './core/store';
import { HEALTH_TICK_MS } from './core/constants';
import { DEFAULT_ANOMALY_CONFIG, type Anomaly, type AnomalyConfig } from './anomaly';
import type { AgentSource } from './stream';
import type { Agent, AgentStatus, HealthMetrics } from './types';
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
  /**
   * Status history within `historySeconds`, oldest first: each status and
   * how long ago it began and ended (ms; end 0 = now).
   */
  history: { status: AgentStatus; fromMs: number; toMs: number }[];
};

export interface TelemetryOptions {
  /** Agents known up front (as the chart's `agents` prop); the source adds more. */
  agents?: Agent[];
  /** Detect stalls, spikes and thrash. Default true. */
  anomalyDetection?: boolean;
  anomalyConfig?: Partial<AnomalyConfig>;
  /** Status history kept for `history` (seconds). Default 300. */
  historySeconds?: number;
  /** An anomaly started (or escalated) — once, not on every tick. */
  onAnomaly?: (agentId: string, anomaly: Anomaly) => void;
  /** An anomaly that was reported has ended. */
  onAnomalyEnd?: (agentId: string, anomaly: Anomaly) => void;
  onHealthChange?: (agentId: string, health: HealthMetrics) => void;
}

const NO_AGENTS: Agent[] = [];

/**
 * Live telemetry for every agent of `source` (and `options.agents`), updated
 * every half second — what the chart shows, without the chart, for building
 * your own UI or the components below.
 *
 * ```tsx
 * const agents = useAgentTelemetry(stream);
 * return <AgentRoster agents={agents} />;
 * ```
 */
export function useAgentTelemetry(source: AgentSource | undefined, options: TelemetryOptions = {}): AgentTelemetry[] {
  const historyMs = (options.historySeconds ?? 300) * 1000;
  // The store keeps samples for 1.5× its window: a window of 2/3 of the
  // history keeps exactly the history.
  const [store] = useState(() => new AgentStore([], { windowSeconds: historyMs / 1500, maxHistoryPoints: 10_000 }, 0));
  const [agents, setAgents] = useState<AgentTelemetry[]>([]);
  // Latest options for the ticking effect, without restarting it.
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  useEffect(() => {
    store.setOptions({ windowSeconds: historyMs / 1500, maxHistoryPoints: 10_000 });
  }, [store, historyMs]);
  const roster = options.agents ?? NO_AGENTS;
  useEffect(() => {
    store.syncRoster(roster, performance.now());
  }, [store, roster]);
  useSourceSubscription(store, source);

  useEffect(() => {
    const tick = () => {
      const now = performance.now();
      const o = latest.current;
      const cfg: AnomalyConfig = { ...DEFAULT_ANOMALY_CONFIG, ...o.anomalyConfig };
      store.healthTick(now, o.anomalyDetection ?? true, cfg, (ev) => {
        if (ev.kind === 'anomaly') o.onAnomaly?.(ev.id, { ...ev.anomaly });
        else if (ev.kind === 'resolved') o.onAnomalyEnd?.(ev.id, { ...ev.anomaly });
        else o.onHealthChange?.(ev.id, { ...ev.health });
      });
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
            history: changes
              .map((c, i) => ({
                status: c.status,
                fromMs: Math.min(historyMs, now - c.t),
                toMs: i + 1 < changes.length ? now - changes[i + 1].t : 0,
              }))
              // A status replaced at the same instant (e.g. created idle, then
              // started) never held.
              .filter((h) => h.fromMs > h.toMs),
          };
        })
      );
    };
    tick();
    const interval = setInterval(tick, HEALTH_TICK_MS);
    return () => clearInterval(interval);
  }, [store, historyMs]);

  return agents;
}

// ── Components ───────────────────────────────────────────────────────────

const CSS = `
.agentstat-c{font-family:var(--as-font);color:var(--as-text);font-size:13px;line-height:1.4}
.agentstat-c *{box-sizing:border-box}
.agentstat-badge{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%;min-height:24px;padding:0 10px;border-radius:999px;background:var(--as-surface);box-shadow:var(--as-shadow);border:1px solid transparent;font:500 12px/1 var(--as-font);color:var(--as-text-secondary);white-space:nowrap}
.agentstat-badge[data-tone="warning"]{color:var(--as-warning)}
.agentstat-badge[data-tone="critical"]{color:var(--as-critical)}
.agentstat-badge svg{flex-shrink:0}
.agentstat-badge-tool{overflow:hidden;text-overflow:ellipsis;min-width:4ch;max-width:16ch;color:var(--as-text)}
.agentstat-n{font-variant-numeric:tabular-nums}
.agentstat-banner{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:12px;background:var(--as-surface);box-shadow:var(--as-shadow);border:1px solid transparent}
.agentstat-banner-row{display:flex;align-items:baseline;gap:8px;min-width:0}
.agentstat-banner-row[data-tone="warning"] .agentstat-mark{color:var(--as-warning)}
.agentstat-banner-row[data-tone="critical"] .agentstat-mark{color:var(--as-critical)}
.agentstat-banner-name{font-weight:500;flex-shrink:1;min-width:0;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agentstat-banner-msg{color:var(--as-text-secondary);flex:1;min-width:0;overflow-wrap:break-word}
.agentstat-roster-wrap{overflow-x:auto}
.agentstat-roster{width:100%;min-width:520px;border-collapse:collapse;table-layout:fixed}
.agentstat-roster th{font-size:11px;font-weight:500;letter-spacing:0.05em;text-transform:uppercase;color:var(--as-text-tertiary);text-align:left;padding:4px 8px}
.agentstat-roster td,.agentstat-roster tbody th{padding:6px 8px;border-top:1px solid var(--as-selected);vertical-align:middle}
.agentstat-roster tbody th{font:inherit;font-weight:500;letter-spacing:normal;text-transform:none;color:var(--as-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agentstat-roster .agentstat-n{text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agentstat-roster-wrap:focus-visible{outline:2px solid var(--as-text-tertiary);outline-offset:2px;border-radius:4px}
.agentstat-timeline{display:flex;gap:2px;height:10px;border-radius:999px;overflow:hidden;background:var(--as-selected)}
.agentstat-timeline[data-dense]{gap:0}
.agentstat-timeline span{height:100%;min-width:0}
.agentstat-timeline .agentstat-gap{background:transparent}
.agentstat-timeline [data-s="active"]{background:var(--as-active)}
.agentstat-timeline [data-s="thinking"]{background:var(--as-thinking)}
.agentstat-timeline [data-s="waiting"]{background:repeating-linear-gradient(135deg,var(--as-text-tertiary) 0 3px,transparent 3px 5px)}
.agentstat-timeline [data-s="complete"]{background:color-mix(in srgb,var(--as-text-tertiary) 30%,transparent)}
.agentstat-timeline [data-s="stuck"]{background:var(--as-warning)}
.agentstat-timeline [data-s="hallucinating"]{background:repeating-linear-gradient(135deg,var(--as-critical) 0 3px,transparent 3px 5px)}
.agentstat-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
`;

/** Props every component takes. */
export type TelemetryComponentProps = {
  /** Default 'system' (follows the OS setting). */
  theme?: 'light' | 'dark' | 'system';
  className?: string;
  style?: React.CSSProperties;
};

/** Root element props: the chart's theme tokens as CSS variables. */
function useRoot({ theme = 'system', className, style }: TelemetryComponentProps, cls: string) {
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)', theme === 'system');
  const mode: ThemeMode = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
  const t = tokensFor(mode);
  const dark = mode === 'dark';
  const vars = {
    '--as-bg': t.bg,
    '--as-surface': t.surface,
    '--as-text': t.text,
    '--as-text-secondary': t.textSecondary,
    '--as-text-tertiary': t.textTertiary,
    '--as-selected': t.selected,
    '--as-warning': t.warning,
    '--as-critical': t.critical,
    '--as-shadow': t.shadow,
    // Timeline statuses: ≥ 3:1 against the track in either theme.
    '--as-active': dark ? 'oklch(0.70 0.14 155)' : 'oklch(0.50 0.13 155)',
    '--as-thinking': dark ? 'oklch(0.70 0.12 255)' : 'oklch(0.50 0.14 255)',
    '--as-font': FONT_SANS,
    '--as-font-mono': FONT_MONO,
  } as React.CSSProperties;
  return {
    className: `agentstat-c ${cls}${className ? ` ${className}` : ''}`,
    'data-theme': mode,
    style: { ...vars, ...style },
  };
}

let compactNf: Intl.NumberFormat | undefined;
/** 1,234 · 123K · 98.8B: fits a narrow column. */
const formatCompact = (v: number) =>
  Math.abs(v) < 100_000
    ? formatInt(v)
    : (compactNf ??= new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })).format(v);

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

function BadgeBody({ agent }: { agent: AgentTelemetry }) {
  return (
    <>
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
    </>
  );
}

/** An agent's status in words and icon: "Waiting · bash · 12s". */
export function AgentStatusBadge({ agent, ...themed }: { agent: AgentTelemetry } & TelemetryComponentProps) {
  const root = useRoot(themed, 'agentstat-badge');
  return (
    <span {...root} data-tone={toneOf(agent)}>
      <style>{CSS}</style>
      <BadgeBody agent={agent} />
    </span>
  );
}

type Seen = { severity: string; name: string; kind: string };

/**
 * What to announce about `agents`' anomalies, for two always-present live
 * regions (`polite` → role="status", `assertive` → role="alert"): each
 * anomaly once — when it starts, escalates (critical goes to `assertive`)
 * or resolves — not every time its numbers tick.
 */
export function useAnomalyAnnouncer(agents: AgentTelemetry[]): { polite: string; assertive: string } {
  const rows = agents.flatMap((a) => a.anomalies.map((x) => ({ a, x })));
  // Announcements, kept apart from the visible list (whose text ticks), in
  // live regions that are always there. Worked out when the set of anomalies
  // (or a severity) changes — during render, against the previous set.
  const key = rows.map(({ a, x }) => `${a.id}:${x.kind}:${x.severity}`).join('|');
  const [said, setSaid] = useState({ key: '', seen: new Map<string, Seen>(), polite: '', assertive: '' });
  if (said.key !== key) {
    const seen = new Map<string, Seen>();
    const lines: string[] = [];
    let urgent = false;
    for (const { a, x } of rows) {
      const k = `${a.id}:${x.kind}`;
      seen.set(k, { severity: x.severity, name: a.name, kind: x.kind });
      const before = said.seen.get(k);
      if (!before || before.severity !== x.severity) {
        lines.push(`${a.name}: ${x.message}.`);
        urgent ||= x.severity === 'critical';
      }
    }
    for (const [k, v] of said.seen) if (!seen.has(k)) lines.push(`${v.name}: ${v.kind} resolved.`);
    // The other region empties, so nothing stale is left to find — and a
    // repeat of earlier text is still a change, so it's read again.
    const text = lines.join(' ');
    setSaid({
      key,
      seen,
      polite: !lines.length ? said.polite : urgent ? '' : text,
      assertive: !lines.length ? said.assertive : urgent ? text : '',
    });
  }
  return { polite: said.polite, assertive: said.assertive };
}

/**
 * Anomalies active now, one line each ("Coder: stalled 12s while active").
 * Screen readers hear each once — when it starts, escalates or resolves —
 * not every time its numbers change.
 */
export function AnomalyBanner({ agents, ...themed }: { agents: AgentTelemetry[] } & TelemetryComponentProps) {
  const root = useRoot(themed, 'agentstat-banner');
  const rows = agents.flatMap((a) => a.anomalies.map((x) => ({ a, x })));
  const { polite, assertive } = useAnomalyAnnouncer(agents);
  return (
    <>
      <span className="agentstat-sr" role="status" style={SR}>
        {polite}
      </span>
      <span className="agentstat-sr" role="alert" style={SR}>
        {assertive}
      </span>
      {rows.length > 0 && (
        <div {...root}>
          <style>{CSS}</style>
          {rows.map(({ a, x }) => (
            <div key={`${a.id}:${x.kind}`} className="agentstat-banner-row" data-tone={x.severity}>
              {/* Severity by shape as well as color: ▲ warning, ◆ critical. */}
              <span className="agentstat-mark" aria-hidden="true">
                {x.severity === 'critical' ? '◆' : '▲'}
              </span>
              <span className="agentstat-banner-name" title={a.name}>
                <bdi>{a.name}</bdi>
              </span>
              <span className="agentstat-banner-msg">
                <span className="agentstat-sr">{x.severity}: </span>
                {x.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// Inline, so the live regions stay hidden before the stylesheet is there.
const SR: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0,0,0,0)',
  whiteSpace: 'nowrap',
  border: 0,
};

/** Every agent in a table: status, rate, tokens and health. */
export function AgentRoster({
  agents,
  caption = 'Agents',
  ...themed
}: {
  agents: AgentTelemetry[];
  /** The table's accessible name (read by screen readers). Default "Agents". */
  caption?: string;
} & TelemetryComponentProps) {
  const root = useRoot(themed, 'agentstat-roster-wrap');
  return (
    // Scrolls sideways when narrow: focusable, so the keyboard can scroll it.
    <div {...root} role="region" aria-label={caption} tabIndex={0}>
      <style>{CSS}</style>
      <table className="agentstat-roster">
        <caption className="agentstat-sr">{caption}</caption>
        <colgroup>
          <col style={{ width: '28%' }} />
          <col style={{ width: '36%' }} />
          <col style={{ width: '12%' }} />
          <col style={{ width: '12%' }} />
          <col style={{ width: '12%' }} />
        </colgroup>
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
              <th scope="row" title={a.name}>
                <bdi>{a.name}</bdi>
              </th>
              <td>
                {/* One stylesheet and theme for the table, not one per badge. */}
                <span className="agentstat-badge" data-tone={toneOf(a)}>
                  <BadgeBody agent={a} />
                </span>
              </td>
              <td className="agentstat-n" title={formatRate(a.tokensRate)}>
                {formatRate(a.tokensRate)}
              </td>
              <td className="agentstat-n" title={formatInt(a.totalTokens)}>
                {formatCompact(a.totalTokens)}
              </td>
              <td className="agentstat-n">{a.health === null ? '–' : formatInt(a.health)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Which status a merged stretch shows: the one that matters most.
const RANK: Record<AgentStatus, number> = {
  complete: 0,
  thinking: 1,
  active: 2,
  waiting: 3,
  stuck: 4,
  hallucinating: 5,
};

type Seg = { status: AgentStatus; fromMs: number; toMs: number };

/**
 * Merge runs of segments shorter than `minMs` (status flapping) into stretches
 * at least that long, each showing its most important status, so a busy
 * history still fits its bar and the latest status stays visible.
 */
function bucket(segs: Seg[], minMs: number): Seg[] {
  const out: Seg[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    // A short segment joins a bucket that is still short; a long one never
    // joins (one brief status mustn't recolor a long stretch).
    if (last && last.fromMs - last.toMs < minMs && s.fromMs - s.toMs < minMs) {
      last.toMs = s.toMs;
      if (RANK[s.status] > RANK[last.status]) last.status = s.status;
    } else out.push({ ...s });
  }
  return out;
}

/**
 * An agent's status history laid out on a `windowSeconds` window: `before`
 * is the share of the window before its history starts, and `bars` the
 * segments to draw (each with its `share` of the window), with flapping
 * merged into buckets showing their most important status. `shown` is the
 * unmerged history within the window (e.g. for a text list).
 */
export function timelineBars(agent: AgentTelemetry, windowSeconds = 300) {
  const windowMs = Math.max(1, windowSeconds * 1000);
  const shown = agent.history
    .map((h) => ({ ...h, fromMs: Math.min(h.fromMs, windowMs) }))
    .filter((h) => h.fromMs > h.toMs);
  const bars = bucket(shown, windowMs / 200).map((h) => ({ ...h, share: (h.fromMs - h.toMs) / windowMs }));
  return { before: (windowMs - (shown[0]?.fromMs ?? 0)) / windowMs, bars, shown };
}

/**
 * An agent's status over the last `windowSeconds` (default 300; at most the
 * hook's `historySeconds`): one bar, a segment per status, sized to time, so
 * stacked timelines line up. Statuses differ by fill pattern as well as
 * color, are named on hover, and are listed for screen readers.
 */
export function AgentTimeline({
  agent,
  windowSeconds = 300,
  ...themed
}: { agent: AgentTelemetry; windowSeconds?: number } & TelemetryComponentProps) {
  const root = useRoot(themed, 'agentstat-timeline-wrap');
  const { before, bars, shown } = timelineBars(agent, windowSeconds);
  return (
    <div {...root}>
      <style>{CSS}</style>
      <div className="agentstat-timeline" aria-hidden="true" data-dense={bars.length > 40 ? '' : undefined}>
        {before > 0 && <span className="agentstat-gap" style={{ flexGrow: before }} />}
        {bars.map((h, i) => (
          <span
            key={i}
            data-s={h.status}
            title={`${formatStatus(h.status)} · ${formatSpan(h.fromMs - h.toMs)}`}
            style={{ flexGrow: h.share }}
          />
        ))}
      </div>
      <ol className="agentstat-sr" aria-label={`${agent.name} status history`}>
        {shown.map((h, i) => (
          <li key={i}>
            {formatStatus(h.status)} for {formatSpan(h.fromMs - h.toMs)}
          </li>
        ))}
      </ol>
    </div>
  );
}

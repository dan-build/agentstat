// src/ui/Panel.tsx — per-agent rate, health and status over the chart.

import React from 'react';
import { MAX_PANEL_ROWS } from '../core/constants';
import type { RowSnapshot } from '../core/store';
import { formatInt, formatRate, formatStatus } from '../format';
import type { AgentStatus } from '../types';
import { StatusIcon } from './StatusIcon';

const statusTone = (s: AgentStatus): 'warning' | 'critical' | undefined =>
  s === 'stuck' ? 'warning' : s === 'hallucinating' ? 'critical' : undefined;

export function Panel({
  rows,
  colorFor,
}: {
  /** Visible rows only. */
  rows: RowSnapshot[];
  colorFor: (r: RowSnapshot) => string;
}) {
  const shown = rows.slice(0, MAX_PANEL_ROWS);
  if (shown.length === 0) return null;
  return (
    // Decorative duplicate of the screen-reader summary, so hidden from AT.
    <div className="agentstat-panel agentstat-surface" aria-hidden="true">
      <span />
      <span className="agentstat-head">Agent</span>
      <span className="agentstat-head" style={{ textAlign: 'right' }}>Rate</span>
      <span className="agentstat-head" style={{ textAlign: 'right' }}>Health</span>
      <span className="agentstat-head">Status</span>
      {shown.map((r) => (
        <React.Fragment key={r.id}>
          <span className="agentstat-swatch" style={{ '--c': colorFor(r) } as React.CSSProperties} />
          <span className="agentstat-name agentstat-secondary" title={r.name}>
            <bdi>{r.name}</bdi>
          </span>
          <span className="agentstat-num">{formatRate(r.rate)}</span>
          <span className="agentstat-num">{r.score === null ? '–' : formatInt(r.score)}</span>
          <span className="agentstat-status" data-tone={statusTone(r.status)}>
            <StatusIcon status={r.status} />
            {formatStatus(r.status)}
          </span>
        </React.Fragment>
      ))}
      {rows.length > shown.length && <span className="agentstat-more">+{rows.length - shown.length} more</span>}
    </div>
  );
}

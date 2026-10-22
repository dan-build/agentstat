// src/ui/Tooltip.tsx — details of the inspected sample. Positioned by the
// render loop (via `innerRef`) so it follows the point as the chart scrolls.

import React from 'react';
import { formatAgo, formatPercent, formatRate, formatStatus } from '../format';
import type { AgentDataPoint } from '../types';

export type HoverInfo = {
  agentId: string;
  /** Age of the sample when it was selected, in ms. */
  ageMs: number;
  name: string;
  color: string;
  point: AgentDataPoint;
  /** False while the agent hasn't reported progress (shown as unknown). */
  progressKnown: boolean;
  x: number;
  y: number;
};

export function Tooltip({ hover, innerRef }: { hover: HoverInfo; innerRef: React.Ref<HTMLDivElement> }) {
  return (
    <div
      ref={innerRef}
      className="agentstat-tooltip agentstat-surface"
      data-place={hover.y < 72 ? 'below' : 'above'}
      style={{ left: hover.x, top: hover.y }}
      aria-hidden="true"
    >
      <div className="agentstat-tooltip-head">
        <span className="agentstat-swatch" style={{ '--c': hover.color } as React.CSSProperties} />
        <bdi>{hover.name}</bdi>
        <span className="agentstat-tooltip-age">{formatAgo(hover.ageMs)}</span>
      </div>
      <div className="agentstat-tooltip-body">
        {formatRate(hover.point.tokensRate)} · {hover.progressKnown ? formatPercent(hover.point.progress) : '–'} ·{' '}
        {formatStatus(hover.point.status)}
      </div>
    </div>
  );
}

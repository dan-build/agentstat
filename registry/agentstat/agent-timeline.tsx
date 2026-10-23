'use client';

import { timelineBars, type AgentStatus, type AgentTelemetry } from '@dan-build/agentstat';
import { cn } from '@/lib/utils';

// Told apart by pattern as well as color: solid (active, thinking), diagonal
// hatch (waiting, hallucinating), vertical stripes (stuck), faint (complete).
// Patterns use currentColor, so they follow a locally scoped dark theme.
const HATCH = 'bg-[repeating-linear-gradient(135deg,currentColor_0_3px,transparent_3px_5px)]';
const FILL: Record<AgentStatus, string> = {
  active: 'bg-emerald-700 dark:bg-emerald-400',
  thinking: 'bg-blue-700 dark:bg-blue-400',
  waiting: `text-muted-foreground ${HATCH}`,
  complete: 'bg-muted-foreground/50',
  stuck:
    'text-amber-700 dark:text-amber-400 bg-[repeating-linear-gradient(90deg,currentColor_0_3px,transparent_3px_5px)]',
  hallucinating: `text-destructive ${HATCH}`,
};

const LABEL: Record<AgentStatus, string> = {
  active: 'Active',
  thinking: 'Thinking',
  waiting: 'Waiting',
  complete: 'Complete',
  stuck: 'Stuck',
  hallucinating: 'Hallucinating',
};

const span = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

/**
 * An agent's status over the last `windowSeconds` (at most the hook's
 * `historySeconds`): one bar, a segment per status, sized to time.
 */
export function AgentTimeline({
  agent,
  windowSeconds = 300,
  className,
}: {
  agent: AgentTelemetry;
  windowSeconds?: number;
  className?: string;
}) {
  const { before, bars, shown } = timelineBars(agent, windowSeconds);
  return (
    <div className={className}>
      <div
        aria-hidden="true"
        className={cn('flex h-2.5 overflow-hidden rounded-full bg-muted', bars.length <= 40 && 'gap-0.5')}
      >
        {before > 0 && <span style={{ flexGrow: before }} />}
        {bars.map((bar, i) => (
          <span
            key={i}
            className={cn('h-full min-w-0', FILL[bar.status])}
            style={{ flexGrow: bar.share }}
            title={`${LABEL[bar.status]} · ${span(bar.fromMs - bar.toMs)}`}
          />
        ))}
      </div>
      <ol className="sr-only" aria-label={`${agent.name} status history`}>
        {shown.map((h, i) => (
          <li key={i}>
            {LABEL[h.status]} for {span(h.fromMs - h.toMs)}
          </li>
        ))}
      </ol>
    </div>
  );
}

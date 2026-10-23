'use client';

import { Activity, Brain, CircleCheck, CirclePause, Hourglass, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { AgentStatus, AgentTelemetry } from '@dan-build/agentstat';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

// One icon and word per status: status never relies on color alone.
export const AGENT_STATUS: Record<AgentStatus, { label: string; icon: LucideIcon }> = {
  active: { label: 'Active', icon: Activity },
  thinking: { label: 'Thinking', icon: Brain },
  waiting: { label: 'Waiting', icon: Hourglass },
  complete: { label: 'Complete', icon: CircleCheck },
  stuck: { label: 'Stuck', icon: CirclePause },
  hallucinating: { label: 'Hallucinating', icon: TriangleAlert },
};

/** "12s", "4m 05s", "1h 02m". */
export function formatDuration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Warning or critical, from the agent's anomalies and status. */
export function agentTone(agent: AgentTelemetry): 'warning' | 'critical' | undefined {
  if (agent.anomalies.some((a) => a.severity === 'critical') || agent.status === 'hallucinating') return 'critical';
  if (agent.anomalies.length || agent.status === 'stuck') return 'warning';
  return undefined;
}

/** An agent's status in words and icon: "Waiting · bash · 12s". */
export function AgentStatusBadge({ agent, className }: { agent: AgentTelemetry; className?: string }) {
  const { label, icon: Icon } = AGENT_STATUS[agent.status];
  const tone = agentTone(agent);
  return (
    <Badge
      variant="outline"
      className={cn(
        'max-w-full gap-1.5 font-medium whitespace-nowrap',
        tone === 'critical' && 'text-destructive',
        tone === 'warning' && 'text-amber-700 dark:text-amber-400',
        !tone && 'text-muted-foreground',
        className
      )}
    >
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      <span>{label}</span>
      {/* Severity in words too, not only color. */}
      {tone && <span className="sr-only">({tone})</span>}
      {agent.tool !== null && (
        <>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 max-w-[16ch] truncate text-foreground" title={agent.tool || 'tool'}>
            <bdi>{agent.tool || 'tool'}</bdi>
          </span>
        </>
      )}
      <span aria-hidden="true">·</span>
      <span className="tabular-nums">{formatDuration(agent.statusMs)}</span>
    </Badge>
  );
}

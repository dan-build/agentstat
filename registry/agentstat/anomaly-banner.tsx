'use client';

import { OctagonAlert, TriangleAlert } from 'lucide-react';
import { useAnomalyAnnouncer, type AgentTelemetry } from '@dan-build/agentstat';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

/**
 * Anomalies active now, one line each ("Coder: stalled 12s while active").
 * Screen readers hear each once — when it starts, escalates or resolves —
 * not every time its numbers tick.
 */
export function AnomalyBanner({ agents, className }: { agents: AgentTelemetry[]; className?: string }) {
  const { polite, assertive } = useAnomalyAnnouncer(agents);
  const rows = agents.flatMap((agent) => agent.anomalies.map((anomaly) => ({ agent, anomaly })));
  const critical = rows.some((r) => r.anomaly.severity === 'critical');
  const Icon = critical ? OctagonAlert : TriangleAlert;
  return (
    <>
      <span className="sr-only" role="status">
        {polite}
      </span>
      <span className="sr-only" role="alert">
        {assertive}
      </span>
      {rows.length > 0 && (
        <Alert variant={critical ? 'destructive' : 'default'} className={className}>
          <Icon aria-hidden="true" />
          <AlertTitle>{critical ? 'Agents need attention' : 'Unusual agent activity'}</AlertTitle>
          <AlertDescription>
            <ul className="grid gap-1">
              {rows.map(({ agent, anomaly }) => (
                <li key={`${agent.id}:${anomaly.kind}`} className="flex min-w-0 items-baseline gap-2">
                  {/* Severity by shape as well as color: ▲ warning, ◆ critical. */}
                  <span
                    aria-hidden="true"
                    className={cn(
                      anomaly.severity === 'critical' ? 'text-destructive' : 'text-amber-700 dark:text-amber-400'
                    )}
                  >
                    {anomaly.severity === 'critical' ? '◆' : '▲'}
                  </span>
                  <span className="max-w-[40%] shrink truncate font-medium text-foreground" title={agent.name}>
                    <bdi>{agent.name}</bdi>
                  </span>
                  <span className="min-w-0 flex-1 break-words">
                    <span className="sr-only">{anomaly.severity}: </span>
                    {anomaly.message}
                  </span>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}

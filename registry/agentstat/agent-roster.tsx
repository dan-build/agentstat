'use client';

import type { AgentTelemetry } from '@dan-build/agentstat';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AgentStatusBadge } from '@/components/agent-status-badge';

const rate = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const usd = (v: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: v < 0.01 ? 4 : v < 1_000 ? 2 : 0 }).format(v);

const PER_CALL = 'Reports each call when it ends: see its tokens';

/** Every agent in a table: status, rate, tokens, health and (when reported) cost. */
export function AgentRoster({
  agents,
  caption = 'Agents',
  className,
}: {
  agents: AgentTelemetry[];
  /** The table's accessible name. */
  caption?: string;
  className?: string;
}) {
  // A cost column only when some agent reports cost.
  const cost = agents.some((a) => a.costUsd > 0);
  return (
    <Table className={className}>
      <TableCaption className="sr-only">{caption}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Agent</TableHead>
          <TableHead>Status</TableHead>
          {/* Narrow screens keep agent, status and tokens. */}
          <TableHead className="hidden text-right sm:table-cell">Rate</TableHead>
          <TableHead className="text-right">Tokens</TableHead>
          <TableHead className="hidden text-right sm:table-cell">Health</TableHead>
          {cost && <TableHead className="text-right">Cost</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {agents.map((agent) => (
          <TableRow key={agent.id}>
            <TableHead scope="row" className="max-w-[20ch] truncate font-medium text-foreground" title={agent.name}>
              <bdi>{agent.name}</bdi>
            </TableHead>
            <TableCell>
              <AgentStatusBadge agent={agent} />
            </TableCell>
            {/* Agents that report per call (e.g. Claude Code) have no instantaneous rate. */}
            <TableCell className="hidden text-right tabular-nums sm:table-cell" title={agent.perCall ? PER_CALL : undefined}>
              {agent.perCall ? '–' : <>{rate.format(agent.tokensRate)}&nbsp;t/s</>}
            </TableCell>
            <TableCell className="text-right tabular-nums" title={whole.format(agent.totalTokens)}>
              {agent.totalTokens < 100_000 ? whole.format(agent.totalTokens) : compact.format(agent.totalTokens)}
            </TableCell>
            <TableCell className="hidden text-right tabular-nums sm:table-cell" title={agent.perCall ? PER_CALL : undefined}>
              {agent.health === null || agent.perCall ? '–' : agent.health}
            </TableCell>
            {cost && (
              <TableCell className="text-right tabular-nums">{agent.costUsd > 0 ? usd(agent.costUsd) : '–'}</TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

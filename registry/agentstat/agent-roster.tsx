'use client';

import type { AgentTelemetry } from '@dan-build/agentstat';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AgentStatusBadge } from '@/components/agent-status-badge';

const rate = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

/** Every agent in a table: status, rate, tokens and health. */
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
  return (
    <Table className={className}>
      <TableCaption className="sr-only">{caption}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Agent</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Rate</TableHead>
          <TableHead className="text-right">Tokens</TableHead>
          <TableHead className="text-right">Health</TableHead>
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
            <TableCell className="text-right tabular-nums">{rate.format(agent.tokensRate)}&nbsp;t/s</TableCell>
            <TableCell className="text-right tabular-nums" title={whole.format(agent.totalTokens)}>
              {agent.totalTokens < 100_000 ? whole.format(agent.totalTokens) : compact.format(agent.totalTokens)}
            </TableCell>
            <TableCell className="text-right tabular-nums">{agent.health === null ? '–' : agent.health}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

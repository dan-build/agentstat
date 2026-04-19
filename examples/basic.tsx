// examples/basic.tsx
//
// Three ways to get AgentStat on screen, easiest first. Pick the one that
// matches how ready your real data is.
'use client';

import { useMemo } from 'react';
import { AgentStat, createAgent, demoAgents, type Agent } from 'agentstat';

// 1 — Instant demo. Ready-made agents + built-in simulation.
//     Use this to verify the install works, or as a placeholder while
//     your real telemetry is still being wired up.
export function InstantDemo() {
  return <AgentStat agents={demoAgents} simulateData height={400} />;
}

// 2 — One real agent, minimal boilerplate. `createAgent` fills in the
//     `data`, `current`, and `visible` defaults so you only name the
//     agent and pick a color.
export function SingleAgent() {
  const agents = useMemo<Agent[]>(
    () => [createAgent('chat-agent', 'Chat Assistant', '#1d4ed8')],
    []
  );
  return <AgentStat agents={agents} height={400} />;
}

// 3 — Full control. Construct the Agent object yourself when you need
//     custom `config.expectedTokensPerSec` ranges, non-default initial
//     values, or anything else createAgent doesn't expose.
export function FullControl() {
  const agents = useMemo<Agent[]>(
    () => [
      {
        id: 'chat-agent',
        name: 'Chat Assistant',
        color: '#1d4ed8',
        data: [],
        current: { tokensRate: 0, progress: 0, status: 'active' },
        visible: true,
        config: { expectedTokensPerSec: [5, 25] },
      },
    ],
    []
  );
  return <AgentStat agents={agents} height={400} />;
}

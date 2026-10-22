// examples/vercel-ai-sdk.tsx
//
// Monitor a Vercel AI SDK (v5+) chat with AgentStat.
//
//   npm i ai @ai-sdk/react
//
// Forwards the chat's lifecycle, streamed text and tool calls as AgentStat
// events; AgentStat derives the token rate, time to first token and status
// (thinking → active → waiting on a tool → … → complete). Token counts are
// estimated from streamed characters (~4 per token for English — replace
// with real counts if your server sends them as message metadata).
//
// This file isn't type-checked in the AgentStat repo because `ai` isn't one
// of its dependencies.
'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useChat } from '@ai-sdk/react';
import { AgentStat, createAgent, type AgentStatRef } from '@dan-build/agentstat';

const AGENT_ID = 'chat';
const CHARS_PER_TOKEN = 4;

type Part = { type: string; text?: string; toolCallId?: string; toolName?: string; state?: string };

export default function MonitoredChat() {
  const statRef = useRef<AgentStatRef>(null);
  const agents = useMemo(() => [createAgent(AGENT_ID, 'Assistant')], []);
  const { messages, status, sendMessage } = useChat();

  // Lifecycle: request sent → start; done → finish.
  useEffect(() => {
    const push = statRef.current?.push;
    if (status === 'submitted') push?.(AGENT_ID, { type: 'start' });
    if (status === 'error') push?.(AGENT_ID, { type: 'error' });
    if (status === 'ready' || status === 'error') push?.(AGENT_ID, { type: 'finish' });
  }, [status]);

  // Output and tool calls of the latest assistant message, as deltas.
  const seen = useRef({ id: '', chars: 0, tools: new Map<string, string>() });
  const last = messages[messages.length - 1];
  useEffect(() => {
    const ref = statRef.current;
    if (!ref || last?.role !== 'assistant') return;
    if (seen.current.id !== last.id) seen.current = { id: last.id, chars: 0, tools: new Map() };
    let chars = 0;
    for (const p of last.parts as Part[]) {
      if (p.type === 'text' || p.type === 'reasoning') chars += p.text?.length ?? 0;
      if (!p.toolCallId || (!p.type.startsWith('tool-') && p.type !== 'dynamic-tool')) continue;
      const name = p.toolName ?? p.type.slice('tool-'.length);
      const prev = seen.current.tools.get(p.toolCallId);
      if (prev === p.state) continue;
      seen.current.tools.set(p.toolCallId, p.state ?? '');
      if (p.state === 'input-available') ref.push(AGENT_ID, { type: 'tool-start', name });
      if (p.state === 'output-available' || p.state === 'output-error') {
        ref.push(AGENT_ID, { type: 'tool-end', name, error: p.state === 'output-error' });
      }
    }
    const delta = chars - seen.current.chars;
    if (delta > 0) {
      seen.current.chars = chars;
      ref.push(AGENT_ID, { type: 'tokens', count: delta / CHARS_PER_TOKEN });
    }
  }, [last]);

  return (
    <div>
      <AgentStat ref={statRef} agents={agents} metric="tokens" anomalyDetection height={320} />
      <button type="button" onClick={() => sendMessage({ text: 'Write a haiku about telemetry.' })}>
        Send
      </button>
    </div>
  );
}

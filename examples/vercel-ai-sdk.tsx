// examples/vercel-ai-sdk.tsx
//
// Monitor a Vercel AI SDK (v5+) chat with AgentStat.
//
//   npm i ai @ai-sdk/react
//
// Forwards the chat's lifecycle, streamed text and tool calls as AgentStat
// events; AgentStat derives the token rate, time to first token and status
// (thinking → active → waiting on a tool → … → complete); a failed request
// or tool call counts an error. Token counts are estimated from streamed characters (~4 per token for English — replace
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

// AI SDK v5/v6 UI message parts, as far as this example reads them.
// Tool states in which the call has started but not finished.
const OPEN = new Set(['input-available', 'approval-requested', 'approval-responded']);
type Part = { type: string; text?: string; toolCallId?: string; toolName?: string; state?: string };

export default function MonitoredChat() {
  const statRef = useRef<AgentStatRef>(null);
  const agents = useMemo(() => [createAgent(AGENT_ID, 'Assistant')], []);
  const { messages, status, sendMessage } = useChat();

  // One effect, in stream order: output and tool calls of the latest
  // assistant message (as deltas, text before each tool event that follows
  // it), then the lifecycle — so `finish` is never sent before the last tokens.
  const seen = useRef({ id: '', chars: 0, tools: new Map<string, string>(), status: '' });
  const last = messages[messages.length - 1];
  useEffect(() => {
    const ref = statRef.current;
    if (!ref) return;
    const s = seen.current;
    if (status === 'submitted' && s.status !== 'submitted') ref.push(AGENT_ID, { type: 'start' });
    if (last?.role === 'assistant') {
      if (s.id !== last.id) Object.assign(s, { id: last.id, chars: 0, tools: new Map() });
      let chars = 0;
      const flush = () => {
        if (chars > s.chars) ref.push(AGENT_ID, { type: 'tokens', count: (chars - s.chars) / CHARS_PER_TOKEN });
        s.chars = Math.max(s.chars, chars);
      };
      for (const p of last.parts as Part[]) {
        if (p.type === 'text' || p.type === 'reasoning') chars += p.text?.length ?? 0;
        if (!p.toolCallId || (!p.type.startsWith('tool-') && p.type !== 'dynamic-tool')) continue;
        const name = p.toolName ?? p.type.slice('tool-'.length);
        const state = p.state ?? '';
        const prev = s.tools.get(p.toolCallId);
        if (prev === state) continue;
        s.tools.set(p.toolCallId, state);
        flush();
        const done = state === 'output-available' || state === 'output-error' || state === 'output-denied';
        // A call can go from streaming its input to done between two renders.
        if (!OPEN.has(prev ?? '') && (OPEN.has(state) || done)) {
          ref.push(AGENT_ID, { type: 'tool-start', name });
        }
        if (done) ref.push(AGENT_ID, { type: 'tool-end', name, error: state !== 'output-available' });
      }
      flush();
    }
    if (status !== s.status) {
      if (status === 'error') ref.push(AGENT_ID, { type: 'error' });
      if (status === 'ready' || status === 'error') ref.push(AGENT_ID, { type: 'finish' });
    }
    s.status = status;
  }, [last, status]);

  return (
    <div>
      <AgentStat ref={statRef} agents={agents} metric="tokens" anomalyDetection height={320} />
      <button type="button" onClick={() => sendMessage({ text: 'Write a haiku about telemetry.' })}>
        Send
      </button>
    </div>
  );
}

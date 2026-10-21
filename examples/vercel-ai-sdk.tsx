// examples/vercel-ai-sdk.tsx
//
// Monitor a Vercel AI SDK (v5+) chat with AgentStat.
//
//   npm i ai @ai-sdk/react
//
// The token rate is measured from the streamed text over a sliding 1 s window
// (~4 characters per token for English — replace with real counts if your
// server sends them as message metadata). It keeps reporting on a timer while
// a response is in flight, so a stream that goes quiet shows up as a falling
// rate and, with `anomalyDetection`, as a stall.
//
// This file isn't type-checked in the AgentStat repo because `ai` isn't one
// of its dependencies.
'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useChat } from '@ai-sdk/react';
import { AgentStat, createAgent, type AgentStatRef, type AgentStatus } from '@dan-build/agentstat';

const AGENT_ID = 'chat';
const RATE_WINDOW_MS = 1000;
const CHARS_PER_TOKEN = 4;

// useChat status → AgentStat status.
const STATUS: Record<string, AgentStatus> = {
  submitted: 'thinking', // request sent, waiting for the first token
  streaming: 'active',
  ready: 'complete',
  error: 'stuck', // closest "needs attention" state
};

export default function MonitoredChat() {
  const statRef = useRef<AgentStatRef>(null);
  const agents = useMemo(() => [createAgent(AGENT_ID, 'Assistant')], []);
  const { messages, status, sendMessage } = useChat();

  // Approximate tokens streamed so far in the latest assistant message.
  const last = messages[messages.length - 1];
  const streamedChars =
    last?.role === 'assistant'
      ? last.parts.reduce((n, p) => n + (p.type === 'text' ? p.text.length : 0), 0)
      : 0;
  const tokensRef = useRef(0);
  tokensRef.current = streamedChars / CHARS_PER_TOKEN;

  // Report status changes as they happen.
  useEffect(() => {
    statRef.current?.updateAgent(AGENT_ID, {
      status: STATUS[status] ?? 'active',
      ...(status === 'ready' || status === 'error' ? { tokensRate: 0 } : {}),
    });
  }, [status]);

  // While a response is in flight, sample the rate every 250 ms.
  useEffect(() => {
    if (status !== 'submitted' && status !== 'streaming') return;
    const samples: { t: number; tokens: number }[] = [];
    const id = setInterval(() => {
      const t = performance.now();
      samples.push({ t, tokens: tokensRef.current });
      while (samples.length > 1 && t - samples[0].t > RATE_WINDOW_MS) samples.shift();
      const first = samples[0];
      const dt = (t - first.t) / 1000;
      const rate = dt > 0 ? (tokensRef.current - first.tokens) / dt : 0;
      statRef.current?.updateAgent(AGENT_ID, { tokensRate: Math.max(0, rate) });
    }, 250);
    return () => clearInterval(id);
  }, [status]);

  return (
    <div>
      <AgentStat ref={statRef} agents={agents} metric="tokens" anomalyDetection height={320} />
      <button type="button" onClick={() => sendMessage({ text: 'Write a haiku about telemetry.' })}>
        Send
      </button>
    </div>
  );
}

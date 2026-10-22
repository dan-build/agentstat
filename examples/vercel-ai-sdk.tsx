// examples/vercel-ai-sdk.tsx
//
// Monitor a Vercel AI SDK (v5–v7) chat with AgentStat.
//
//   npm i ai @ai-sdk/react
//
// `createChatTracker` turns useChat's messages and status into AgentStat
// events — streamed text, tool calls, request start and finish — and
// AgentStat derives the token rate, time to first token and status
// (thinking → active → waiting on a tool → … → complete). Token counts are
// estimated from characters (~4 per token for English); pass `countTokens`
// for exact ones.
//
// This file isn't type-checked in the AgentStat repo because `ai` isn't one
// of its dependencies.
'use client';

import { useEffect, useMemo } from 'react';
import { useChat } from '@ai-sdk/react';
import { AgentStat, useAgentStream } from '@dan-build/agentstat';
import { createChatTracker } from '@dan-build/agentstat/ai-sdk';

export default function MonitoredChat() {
  const stream = useAgentStream();
  const track = useMemo(() => createChatTracker(stream, 'chat'), [stream]);
  const { messages, status, sendMessage } = useChat();
  useEffect(() => track(messages, status), [track, messages, status]);

  return (
    <div>
      <AgentStat source={stream} metric="tokens" anomalyDetection height={320} />
      <button type="button" onClick={() => sendMessage({ text: 'Write a haiku about telemetry.' })}>
        Send
      </button>
    </div>
  );
}

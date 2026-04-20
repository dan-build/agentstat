// examples/vercel-ai-sdk.tsx
//
// Wire AgentStat to the Vercel AI SDK's useCompletion hook. Token rate is
// approximated from streamed-character count (~4 chars/token for English).
// Swap to your own measurement if you have better signal (e.g. the server
// sending real token counts in an SSE channel).
'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useCompletion } from 'ai/react';
import { AgentStat, type Agent, type AgentStatRef } from '@dan-build/agentstat';

export default function MonitoredChat() {
  const agentStatRef = useRef<AgentStatRef>(null);
  const startTimeRef = useRef<number>(0);

  const agents = useMemo<Agent[]>(
    () => [
      {
        id: 'chat-agent',
        name: 'Chat Assistant',
        color: '#111111',
        data: [],
        current: { tokensRate: 0, progress: 0, status: 'active' },
        visible: true,
        config: { expectedTokensPerSec: [5, 25] },
      },
    ],
    []
  );

  const { completion, isLoading } = useCompletion({
    api: '/api/chat',
    onResponse: () => {
      startTimeRef.current = performance.now();
      agentStatRef.current?.updateAgent('chat-agent', 0, 1, 'thinking');
    },
    onFinish: () => {
      agentStatRef.current?.updateAgent('chat-agent', 0, 100, 'complete');
    },
  });

  useEffect(() => {
    if (!isLoading || !completion) return;
    const elapsed = (performance.now() - startTimeRef.current) / 1000;
    const approxTokens = completion.length / 4;
    const tokensPerSec = elapsed > 0 ? approxTokens / elapsed : 0;
    const progress = Math.min(99, approxTokens * 2);
    agentStatRef.current?.updateAgent(
      'chat-agent',
      tokensPerSec,
      progress,
      'active'
    );
  }, [completion, isLoading]);

  return (
    <AgentStat
      ref={agentStatRef}
      agents={agents}
      simulateData={false}
      height={400}
    />
  );
}

// src/stream.ts — the event stream for React: the core plus a hook.

import { useState } from 'react';
import { createAgentStream, type AgentStream } from './stream-core';

export * from './stream-core';

/** `createAgentStream()` for a component: the same stream for its lifetime. */
export function useAgentStream(): AgentStream {
  const [stream] = useState(createAgentStream);
  return stream;
}

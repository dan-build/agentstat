// src/ag-ui.ts — `@dan-build/agentstat/ag-ui`
//
// AG-UI protocol events → AgentStat events. No dependency on @ag-ui/*:
// events are read structurally. Framework-free and server-safe.

import type { AgentEvent } from './types';
import type { AdapterOptions, EventSink } from './ai-sdk';

export type { AdapterOptions, EventSink };

/** An AG-UI event (only the fields AgentStat reads). */
export type AgUiEvent = {
  type: string;
  delta?: string;
  toolCallId?: string;
  toolCallName?: string;
  /** Set on events of a subagent's run. */
  subagentRunId?: string;
  /** On RUN_ERROR; `'abort'` when the run was stopped. */
  code?: string;
};

const estimate = (text: string) => text.length / 4;

/**
 * Returns a function to call with every AG-UI event of one agent's runs; it
 * pushes the matching AgentStat events for `agentId`.
 *
 * A tool call counts as running from `TOOL_CALL_END` (its arguments are
 * complete) to `TOOL_CALL_RESULT`; the arguments themselves are model output.
 * A tool your frontend runs has no result event in the same run: the run's
 * end closes it. Subagent events (`subagentRunId`) belong to their own agents
 * and are left out (a subagent's error is counted). A child agent's own
 * stream (its runs carry `parentRunId`) gets its own tap. Pass events as AG-UI
 * clients deliver them (`agent.subscribe`), which expands chunk events (`TEXT_MESSAGE_CHUNK`, `TOOL_CALL_CHUNK`);
 * raw chunk streams lose tool calls.
 *
 * ```ts
 * const tap = createAgUiTap(stream, 'researcher');
 * agent.subscribe({ onEvent: ({ event }) => tap(event) });
 * ```
 */
export function createAgUiTap(sink: EventSink, agentId: string, options: AdapterOptions = {}): (event: AgUiEvent) => void {
  const count = options.countTokens ?? estimate;
  const names = new Map<string, string>();
  const push = (e: AgentEvent) => sink.push(agentId, e);
  return (e) => {
    if (!e || typeof e.type !== 'string') return;
    if (e.type === 'SUBAGENT_ERROR') return push({ type: 'error' });
    if (e.subagentRunId) return;
    switch (e.type) {
      case 'RUN_STARTED':
        names.clear();
        push({ type: 'start' });
        break;
      case 'TEXT_MESSAGE_CONTENT':
      case 'TEXT_MESSAGE_CHUNK':
      case 'REASONING_MESSAGE_CONTENT':
      case 'REASONING_MESSAGE_CHUNK':
      case 'THINKING_TEXT_MESSAGE_CONTENT':
      case 'TOOL_CALL_ARGS':
      case 'TOOL_CALL_CHUNK':
        if (typeof e.delta === 'string' && e.delta) push({ type: 'tokens', count: count(e.delta) });
        break;
      case 'TOOL_CALL_START':
        if (e.toolCallId) names.set(e.toolCallId, e.toolCallName ?? '');
        break;
      case 'TOOL_CALL_END':
        push({ type: 'tool-start', name: names.get(e.toolCallId ?? '') ?? '' });
        break;
      case 'TOOL_CALL_RESULT':
        push({ type: 'tool-end', name: names.get(e.toolCallId ?? '') ?? '' });
        break;
      case 'RUN_ERROR':
        // Stopping a run isn't a failure.
        if (e.code !== 'abort') push({ type: 'error' });
        push({ type: 'finish' });
        break;
      case 'RUN_FINISHED':
        push({ type: 'finish' });
        break;
    }
  };
}

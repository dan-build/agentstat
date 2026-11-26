// src/openai-agents.ts — `@dan-build/agentstat/openai-agents`
//
// OpenAI Agents SDK for JavaScript (`run(agent, input, { stream: true })`
// events) → AgentStat events. No dependency on @openai/agents: events are
// read structurally. Framework-free and server-safe.
//
// Mapping:
//   raw_model_stream_event: response_started → a model request;
//     output_text_delta → output as it streams
//   run_item_stream_event: tool_called → tool-start (by call id);
//     tool_output → tool-end; tool_approval_requested → the agent needs you
//   agent_updated_stream_event (a handoff) → the next agent: the one handing
//     off finishes; each agent after the first gets `<agentId>/<name>`
//   the stream's end → finish (via `trackOpenAiAgentsRun`)

import type { AgentEvent } from './types';
import type { AdapterOptions, EventSink } from './ai-sdk';

export type { AdapterOptions, EventSink };

/** A run stream event (only the fields AgentStat reads). */
export type OpenAiAgentsEvent = {
  type: string;
  /** raw_model_stream_event */
  data?: { type?: string; delta?: string };
  /** run_item_stream_event */
  name?: string;
  item?: { rawItem?: { callId?: string; name?: string }; agent?: { name?: string } };
  /** agent_updated_stream_event */
  agent?: { name?: string };
};

export interface OpenAiAgentsOptions extends AdapterOptions {
  /** The run's agent id (default `"openai-agent"`); agents handed off to get `<agentId>/<name>`. */
  agentId?: string;
}

const estimate = (text: string) => text.length / 4;

/**
 * Returns a function to call with every event of a streamed run; it pushes
 * the matching AgentStat events. Push `{ type: 'finish' }` for the current
 * agent when the run ends with `tap.end()`, or use `trackOpenAiAgentsRun`,
 * which does.
 *
 * ```ts
 * const tap = createOpenAiAgentsTap(stream, { agentId: 'triage' });
 * for await (const e of await run(agent, input, { stream: true })) tap(e);
 * ```
 */
export function createOpenAiAgentsTap(
  sink: EventSink,
  options: OpenAiAgentsOptions = {}
): ((event: OpenAiAgentsEvent) => void) & { current(): string; end(): void } {
  const root = options.agentId ?? 'openai-agent';
  const count = options.countTokens ?? estimate;
  let first: string | null = null;
  let current = root;
  const tools = new Map<string, string>();
  // Hosted tools (web search, file search) report no output: closed when
  // the model responds again.
  const hosted: string[] = [];
  // A tool waiting for approval: the run stops there, and the agent still
  // needs the person after it ends.
  let awaiting: string | null = null;
  const push = (e: AgentEvent) => sink.push(current, e);
  const askApproval = (name: string) =>
    sink.attention?.(current, {
      reason: 'needs-you',
      message: name ? `needs your approval for ${name.slice(0, 64)}` : 'needs your approval',
    });
  const closeHosted = () => {
    for (const name of hosted.splice(0)) push({ type: 'tool-end', name });
  };
  const idFor = (name: string) => (first === null || name === first ? root : `${root}/${name}`);

  const tap = (e: OpenAiAgentsEvent) => {
    if (!e || typeof e.type !== 'string') return;
    if (e.type === 'agent_updated_stream_event') {
      const name = e.agent?.name ?? '';
      if (first === null) {
        first = name;
        return;
      }
      const next = idFor(name);
      if (next === current) return;
      // A handoff: the agent handing off is done; the next one takes over.
      push({ type: 'finish' });
      current = next;
      if (next !== root) sink.describe?.(next, { name: `${root} · ${name}` });
      return;
    }
    if (e.type === 'raw_model_stream_event') {
      const d = e.data;
      if (d?.type === 'response_started') {
        closeHosted();
        awaiting = null;
        push({ type: 'start' });
      }
      else if (d?.type === 'output_text_delta' && typeof d.delta === 'string' && d.delta) {
        push({ type: 'tokens', count: count(d.delta) });
      }
      return;
    }
    if (e.type !== 'run_item_stream_event') return;
    const raw = e.item?.rawItem;
    switch (e.name) {
      case 'tool_called': {
        const name = raw?.name ?? '';
        if (raw?.callId) tools.set(raw.callId, name);
        else hosted.push(name);
        push({ type: 'tool-start', name });
        break;
      }
      case 'tool_output': {
        const callId = raw?.callId ?? '';
        push({ type: 'tool-end', name: tools.get(callId) ?? raw?.name ?? '' });
        tools.delete(callId);
        break;
      }
      case 'tool_approval_requested': {
        awaiting = raw?.name ?? '';
        askApproval(awaiting);
        break;
      }
    }
  };
  // The run's end: the agent finishes (still needing the person if a tool
  // awaits approval).
  const end = () => {
    hosted.length = 0;
    push({ type: 'finish' });
    if (awaiting !== null) askApproval(awaiting);
  };
  return Object.assign(tap, { current: () => current, end });
}

/**
 * Feed a whole streamed run to AgentStat, passing its events through:
 * iterate this instead of the run. Its end finishes the current agent; a run
 * that throws is reported as an error and a finish, then rethrown.
 *
 * ```ts
 * const result = await run(agent, input, { stream: true });
 * for await (const e of trackOpenAiAgentsRun(stream, result, { agentId: 'triage' })) { … }
 * ```
 */
export async function* trackOpenAiAgentsRun<E extends OpenAiAgentsEvent>(
  sink: EventSink,
  events: AsyncIterable<E>,
  options: OpenAiAgentsOptions = {}
): AsyncGenerator<E, void, undefined> {
  const tap = createOpenAiAgentsTap(sink, options);
  let threw = false;
  try {
    for await (const e of events) {
      tap(e);
      yield e;
    }
  } catch (err) {
    threw = true;
    sink.push(tap.current(), { type: 'error' });
    sink.push(tap.current(), { type: 'finish' });
    throw err;
  } finally {
    if (!threw) tap.end();
  }
}

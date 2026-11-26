// src/claude-agent-sdk.ts — `@dan-build/agentstat/claude-agent-sdk`
//
// Anthropic's Claude Agent SDK (`query()` messages) → AgentStat events. No
// dependency on @anthropic-ai/claude-agent-sdk: messages are read
// structurally. Framework-free and server-safe.
//
// Mapping:
//   system/init → start (a new run)
//   stream_event (with `includePartialMessages`) → a model request
//     (`message_start`) and its output as it streams (text, thinking and
//     tool-input deltas); without partial messages, each completed assistant
//     block's text instead
//   assistant tool_use block → tool-start; the user message's tool_result
//     with the same id → tool-end (`is_error` → an error)
//   the `Agent` tool (or `Task` in older versions) → a subagent with its own
//     id, `<agentId>/<tool_use_id>`, named after its type; messages with that
//     `parent_tool_use_id` are its own; its tool_result ends it
//   result → finish (an error first if `is_error`), and its
//     `total_cost_usd` as cost

import type { AgentEvent } from './types';
import type { AdapterOptions, EventSink } from './ai-sdk';

export type { AdapterOptions, EventSink };

/** A content block of an assistant or user message (only what AgentStat reads). */
type Block = {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: { subagent_type?: string; description?: string };
  tool_use_id?: string;
  is_error?: boolean;
};

/** A message from `query()` (only the fields AgentStat reads). */
export type ClaudeAgentMessage = {
  type: string;
  subtype?: string;
  parent_tool_use_id?: string | null;
  message?: { content?: string | Block[] };
  /** stream_event: a raw Anthropic stream event. */
  event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string; partial_json?: string } };
  /** assistant: set when the request failed. */
  error?: unknown;
  is_error?: boolean;
  total_cost_usd?: number;
  /** system/task_notification. */
  tool_use_id?: string;
  status?: string;
};

export interface ClaudeAgentOptions extends AdapterOptions {
  /** The run's agent id (default `"claude-agent"`); subagents get `<agentId>/<id>`. */
  agentId?: string;
}

const estimate = (text: string) => text.length / 4;
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

/**
 * Returns a function to call with every message `query()` yields; it pushes
 * the matching AgentStat events. Messages pass through unchanged, so you can
 * keep using them; or use `trackClaudeAgent`, which wraps the iteration.
 *
 * ```ts
 * const tap = createClaudeAgentTap(stream, { agentId: 'fixer' });
 * for await (const m of query({ prompt, options })) { tap(m); … }
 * ```
 */
export function createClaudeAgentTap(
  sink: EventSink,
  options: ClaudeAgentOptions = {}
): ((message: ClaudeAgentMessage) => void) & { end(error?: boolean): void } {
  const root = options.agentId ?? 'claude-agent';
  const count = options.countTokens ?? estimate;
  // Tool name by tool_use id, and the subagents (by their Agent call's id).
  const tools = new Map<string, string>();
  const subagents = new Set<string>();
  // Subagents started and not yet finished.
  const live = new Set<string>();
  // Agents whose output arrives as stream events (not counted twice).
  const streamed = new Set<string>();
  // Cost already reported for this run (the result's total is cumulative).
  let costSeen = 0;
  const idOf = (parent: string | null | undefined) => (parent && subagents.has(parent) ? `${root}/${parent}` : root);
  const push = (id: string, e: AgentEvent) => sink.push(id, e);
  const output = (id: string, text: string | undefined) => {
    if (typeof text === 'string' && text) push(id, { type: 'tokens', count: count(text) });
  };
  const finishChild = (callId: string, error: boolean) => {
    if (!live.delete(callId)) return;
    const child = `${root}/${callId}`;
    if (error) push(child, { type: 'error' });
    push(child, { type: 'finish' });
  };
  // The run is over: subagents still open end with it, then the run.
  const end = (error = false) => {
    for (const callId of Array.from(live)) finishChild(callId, false);
    if (error) push(root, { type: 'error' });
    push(root, { type: 'finish' });
  };

  const tap = (m: ClaudeAgentMessage) => {
    if (!m || typeof m.type !== 'string') return;
    const id = idOf(m.parent_tool_use_id);
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          tools.clear();
          subagents.clear();
          live.clear();
          streamed.clear();
          costSeen = 0;
          push(root, { type: 'start' });
        } else if (m.subtype === 'task_notification' && m.tool_use_id && subagents.has(m.tool_use_id)) {
          // A subagent that ended without its tool result (stopped, failed,
          // or one that ran in the background).
          finishChild(m.tool_use_id, m.status === 'failed');
        }
        break;
      case 'stream_event': {
        streamed.add(id);
        const ev = m.event;
        if (ev?.type === 'message_start') push(id, { type: 'start' });
        else if (ev?.type === 'content_block_delta') output(id, ev.delta?.text ?? ev.delta?.thinking ?? ev.delta?.partial_json);
        break;
      }
      case 'assistant': {
        if (m.error) push(id, { type: 'error' });
        const blocks = Array.isArray(m.message?.content) ? m.message.content : [];
        for (const b of blocks) {
          if (!b || typeof b.type !== 'string') continue;
          if ((b.type === 'text' || b.type === 'thinking') && !streamed.has(id)) output(id, b.text ?? b.thinking);
          if (b.type !== 'tool_use' || !b.id) continue;
          const name = b.name ?? '';
          tools.set(b.id, name);
          push(id, { type: 'tool-start', name });
          if (SUBAGENT_TOOLS.has(name)) {
            subagents.add(b.id);
            live.add(b.id);
            const child = `${root}/${b.id}`;
            sink.describe?.(child, { name: `${root} · ${b.input?.subagent_type ?? 'subagent'}` });
            push(child, { type: 'start' });
          }
        }
        break;
      }
      case 'user': {
        const blocks = Array.isArray(m.message?.content) ? m.message.content : [];
        for (const b of blocks) {
          if (b?.type !== 'tool_result' || !b.tool_use_id) continue;
          const name = tools.get(b.tool_use_id) ?? '';
          push(id, { type: 'tool-end', name, error: b.is_error === true });
          if (subagents.has(b.tool_use_id)) finishChild(b.tool_use_id, b.is_error === true);
          tools.delete(b.tool_use_id);
        }
        break;
      }
      case 'result': {
        end(m.is_error === true);
        const total = m.total_cost_usd;
        if (typeof total === 'number' && Number.isFinite(total) && total > costSeen) {
          push(root, { type: 'cost', usd: total - costSeen });
          costSeen = total;
        }
        break;
      }
    }
  };
  return Object.assign(tap, { end });
}

/**
 * Pass every message of a `query()` through, reporting it: iterate this
 * instead of the query. A query that throws is reported as an error and a
 * finish, then the error is rethrown.
 *
 * ```ts
 * for await (const m of trackClaudeAgent(stream, query({ prompt, options }), { agentId: 'fixer' })) { … }
 * ```
 */
export async function* trackClaudeAgent<M extends ClaudeAgentMessage>(
  sink: EventSink,
  messages: AsyncIterable<M>,
  options: ClaudeAgentOptions = {}
): AsyncGenerator<M, void, undefined> {
  const tap = createClaudeAgentTap(sink, options);
  let finished = false;
  let threw = false;
  try {
    for await (const m of messages) {
      tap(m);
      if (m && m.type === 'result') finished = true;
      else if (m && m.type === 'system' && m.subtype === 'init') finished = false;
      yield m;
    }
  } catch (err) {
    threw = true;
    // After its result, the run was already reported.
    if (!finished) tap.end(true);
    throw err;
  } finally {
    // Ended without a result: the stream stopped, or the loop broke out early.
    if (!finished && !threw) tap.end();
  }
}

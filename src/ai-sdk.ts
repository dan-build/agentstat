// src/ai-sdk.ts — `@dan-build/agentstat/ai-sdk`
//
// Vercel AI SDK (v5/v6) → AgentStat events. No dependency on `ai`: parts are
// read structurally, so this works with `streamText().fullStream`, UI message
// stream chunks and `useChat` messages alike. Framework-free and server-safe.

import type { AgentEvent } from './types';

/** Where events go: an `AgentStream` (or anything with its `push`). */
export interface EventSink {
  push(agentId: string, event: AgentEvent): void;
}

export interface AdapterOptions {
  /**
   * Tokens in a piece of streamed text. Default: characters ÷ 4, a fair
   * estimate for English; pass your tokenizer for exact counts.
   */
  countTokens?: (text: string) => number;
}

const estimate = (text: string) => text.length / 4;

/**
 * A part of `streamText(…).fullStream` or a UI message stream chunk (only the
 * fields AgentStat reads).
 */
export type AiSdkPart = {
  type: string;
  text?: string;
  delta?: string;
  toolName?: string;
  toolCallId?: string;
};

/**
 * Returns a function to call with every stream part; it pushes the matching
 * AgentStat events for `agentId`.
 *
 * ```ts
 * const tap = createAiSdkTap(stream, 'writer');
 * for await (const part of streamText({ … }).fullStream) tap(part);
 * ```
 */
export function createAiSdkTap(sink: EventSink, agentId: string, options: AdapterOptions = {}): (part: AiSdkPart) => void {
  const count = options.countTokens ?? estimate;
  const names = new Map<string, string>();
  const push = (e: AgentEvent) => sink.push(agentId, e);
  return (p) => {
    if (!p || typeof p.type !== 'string') return;
    switch (p.type) {
      case 'start-step':
        push({ type: 'start' });
        break;
      case 'text-delta':
      case 'reasoning-delta':
      case 'tool-input-delta': {
        // Model output: answer, reasoning, or the arguments of a tool call.
        const text = p.text ?? p.delta;
        if (typeof text === 'string' && text) push({ type: 'tokens', count: count(text) });
        break;
      }
      case 'tool-call':
      case 'tool-input-available': {
        const name = p.toolName ?? '';
        if (p.toolCallId) names.set(p.toolCallId, name);
        push({ type: 'tool-start', name });
        break;
      }
      case 'tool-result':
      case 'tool-error':
      case 'tool-output-available':
      case 'tool-output-error':
      case 'tool-output-denied':
        push({
          type: 'tool-end',
          name: p.toolName ?? names.get(p.toolCallId ?? '') ?? '',
          error: p.type === 'tool-error' || p.type === 'tool-output-error',
        });
        break;
      case 'error':
        push({ type: 'error' });
        break;
      case 'finish':
      case 'abort':
        names.clear();
        push({ type: 'finish' });
        break;
    }
  };
}

/**
 * Feed a whole stream (e.g. `result.fullStream`) to `agentId`. Resolves when it
 * ends; a stream that throws is reported as an error and a finish, then the
 * error is rethrown.
 */
export async function tapAiSdkStream(
  sink: EventSink,
  agentId: string,
  parts: AsyncIterable<AiSdkPart>,
  options?: AdapterOptions
): Promise<void> {
  const tap = createAiSdkTap(sink, agentId, options);
  try {
    for await (const p of parts) tap(p);
  } catch (err) {
    sink.push(agentId, { type: 'error' });
    sink.push(agentId, { type: 'finish' });
    throw err;
  }
}

/** A `useChat` message (only the fields AgentStat reads). */
export type ChatMessage = {
  id: string;
  role: string;
  parts: { type: string; text?: string; toolCallId?: string; toolName?: string; state?: string }[];
};

// Tool part states in which the call has started but not finished.
const OPEN = new Set(['input-available', 'approval-requested', 'approval-responded']);
const DONE = new Set(['output-available', 'output-error', 'output-denied']);

/**
 * For `useChat`: returns a function to call with `messages` and `status`
 * whenever they change (e.g. in a `useEffect`). It works out what is new
 * since the last call — streamed text, tool calls, the request lifecycle —
 * and pushes it, in stream order, for `agentId`.
 *
 * ```tsx
 * const track = useMemo(() => createChatTracker(stream, 'chat'), [stream]);
 * const { messages, status } = useChat();
 * useEffect(() => track(messages, status), [track, messages, status]);
 * ```
 */
export function createChatTracker(
  sink: EventSink,
  agentId: string,
  options: AdapterOptions = {}
): (messages: readonly ChatMessage[], status: string) => void {
  const count = options.countTokens ?? estimate;
  const push = (e: AgentEvent) => sink.push(agentId, e);
  let id = '';
  let chars = 0;
  let tools = new Map<string, string>();
  let last = '';
  return (messages, status) => {
    if (status === 'submitted' && last !== 'submitted') push({ type: 'start' });
    const m = messages[messages.length - 1];
    if (m?.role === 'assistant' && Array.isArray(m.parts)) {
      if (m.id !== id) {
        id = m.id;
        chars = 0;
        tools = new Map();
      }
      let seen = 0;
      // Text is reported up to each tool event, so output before a tool call
      // isn't counted after it.
      const flush = () => {
        if (seen > chars) {
          let text = '';
          let at = 0;
          for (const p of m.parts) {
            if (p.type !== 'text' && p.type !== 'reasoning') continue;
            const t = p.text ?? '';
            text += t.slice(Math.max(0, chars - at), Math.max(0, seen - at));
            at += t.length;
          }
          push({ type: 'tokens', count: count(text) });
          chars = seen;
        }
      };
      for (const p of m.parts) {
        if (p.type === 'text' || p.type === 'reasoning') seen += p.text?.length ?? 0;
        if (!p.toolCallId || (!p.type.startsWith('tool-') && p.type !== 'dynamic-tool')) continue;
        const state = p.state ?? '';
        const prev = tools.get(p.toolCallId);
        if (prev === state) continue;
        tools.set(p.toolCallId, state);
        flush();
        const name = p.toolName ?? p.type.slice('tool-'.length);
        const done = DONE.has(state);
        // A call can go from streaming its input to done between two calls.
        if (!OPEN.has(prev ?? '') && (OPEN.has(state) || done)) push({ type: 'tool-start', name });
        if (done) push({ type: 'tool-end', name, error: state === 'output-error' });
      }
      flush();
    }
    if (status !== last) {
      if (status === 'error') push({ type: 'error' });
      if ((status === 'ready' || status === 'error') && last) push({ type: 'finish' });
    }
    last = status;
  };
}

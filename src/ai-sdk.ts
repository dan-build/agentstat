// src/ai-sdk.ts — `@dan-build/agentstat/ai-sdk`
//
// Vercel AI SDK (v5–v7) → AgentStat events. No dependency on `ai`: parts are
// read structurally, so this works with `streamText().fullStream`, UI message
// stream chunks and `useChat` messages alike. Framework-free and server-safe.

import type { AgentEvent } from './types';

export type { AgentEvent };

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
  /** Tool-call arguments in UI message stream chunks. */
  inputTextDelta?: string;
  toolName?: string;
  toolCallId?: string;
  /** A partial result of a tool that streams its output (still running). */
  preliminary?: boolean;
};

/**
 * Returns a function to call with every stream part; it pushes the matching
 * AgentStat events for `agentId`. If a stream can end without a `finish` part
 * (an `error` part ends a failed stream), push `{ type: 'finish' }` yourself
 * when it ends — or use `tapAiSdkStream`, which does.
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
  // Between a request's start and its finish.
  let running = false;
  return (p) => {
    if (!p || typeof p.type !== 'string' || p.preliminary === true) return;
    switch (p.type) {
      // The request starts at `start`; `start-step` only comes with the
      // model's first chunk (and later steps continue the same request), so
      // it starts one only for streams that don't send `start`.
      case 'start':
      case 'start-step':
        if (p.type === 'start' || !running) push({ type: 'start' });
        running = true;
        break;
      case 'text-delta':
      case 'reasoning-delta':
      case 'tool-input-delta': {
        // Model output: answer, reasoning, or the arguments of a tool call.
        const text = p.text ?? p.delta ?? p.inputTextDelta;
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
        // Usually the end of a failed stream: the next one starts afresh.
        running = false;
        push({ type: 'error' });
        break;
      case 'finish':
      case 'abort':
        names.clear();
        running = false;
        push({ type: 'finish' });
        break;
    }
  };
}

/**
 * Feed a whole stream (e.g. `result.fullStream`) to `agentId`. Resolves when it
 * ends, finishing the run if the stream didn't (a failed stream ends with an
 * `error` part and no `finish`); a stream that throws is reported as an error
 * and a finish, then the error is rethrown.
 */
export async function tapAiSdkStream(
  sink: EventSink,
  agentId: string,
  parts: AsyncIterable<AiSdkPart>,
  options?: AdapterOptions
): Promise<void> {
  const tap = createAiSdkTap(sink, agentId, options);
  let ended = true;
  try {
    for await (const p of parts) {
      tap(p);
      if (p && typeof p.type === 'string') ended = p.type === 'finish' || p.type === 'abort';
    }
  } catch (err) {
    sink.push(agentId, { type: 'error' });
    sink.push(agentId, { type: 'finish' });
    throw err;
  }
  if (!ended) sink.push(agentId, { type: 'finish' });
}

export interface ChatTrackerOptions extends AdapterOptions {
  /** Tools your frontend runs: the agent waits on them after a request ends. */
  clientTools?: string[];
}

/** A `useChat` message (only the fields AgentStat reads). */
export type ChatMessage = {
  id: string;
  role: string;
  parts: { type: string; text?: string; toolCallId?: string; toolName?: string; state?: string; preliminary?: boolean }[];
};

// Tool part states in which the call has started but not finished.
const OPEN = new Set(['input-available', 'approval-requested', 'approval-responded']);
const DONE = new Set(['output-available', 'output-error', 'output-denied']);

/**
 * For `useChat`: returns a function to call with `messages` and `status`
 * whenever they change (e.g. in a `useEffect`). It works out what is new
 * since the last call — streamed text, tool calls, the request lifecycle —
 * and pushes it, in stream order, for `agentId`. Messages that were already
 * there on the first call, or that change while no request is running
 * (restored history, `setMessages`), aren't reported as output. A tool call
 * awaiting approval, or one of `clientTools` (tools your frontend runs),
 * keeps the agent `waiting` after the request ends, until it's answered; any
 * other open call ends with the request (e.g. the user pressed Stop).
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
  options: ChatTrackerOptions = {}
): (messages: readonly ChatMessage[], status: string) => void {
  const count = options.countTokens ?? estimate;
  const push = (e: AgentEvent) => sink.push(agentId, e);
  const busy = (st: string) => st === 'submitted' || st === 'streaming';
  let id = '';
  let chars = 0;
  let tools = new Map<string, string>();
  // Tool name of each call.
  const toolNames = new Map<string, string>();
  const client = new Set(options.clientTools ?? []);
  let last: string | null = null;
  return (messages, status) => {
    const m = messages[messages.length - 1];
    const assistant = m?.role === 'assistant' && Array.isArray(m.parts) ? m : undefined;
    const textOf = (x: ChatMessage) =>
      x.parts.reduce((n, p) => n + (p.type === 'text' || p.type === 'reasoning' ? p.text?.length ?? 0 : 0), 0);
    const stateOf = (p: ChatMessage['parts'][number]) =>
      // A preliminary result: the tool is still running.
      p.state === 'output-available' && p.preliminary === true ? 'input-available' : p.state ?? '';
    const isTool = (p: ChatMessage['parts'][number]) =>
      !!p.toolCallId && (p.type.startsWith('tool-') || p.type === 'dynamic-tool');
    const nameOf = (p: ChatMessage['parts'][number]) => p.toolName ?? p.type.slice('tool-'.length);
    // What the agent still waits on once a request has ended: an approval,
    // or a tool the frontend runs.
    const pending = () =>
      [...tools].some(
        ([callId, st]) => st === 'approval-requested' || (OPEN.has(st) && client.has(toolNames.get(callId) ?? ''))
      );
    // First call, or no request running: take the messages as they are
    // (restored history, setMessages), except that a tool the agent was left
    // waiting on (a frontend tool, an approval) can resolve.
    if (last === null || (!busy(status) && !busy(last))) {
      const waited = last !== null && pending();
      const before = tools;
      if (last === null && busy(status)) push({ type: 'start' });
      id = assistant?.id ?? '';
      chars = assistant ? textOf(assistant) : 0;
      tools = new Map();
      for (const p of assistant?.parts ?? []) {
        if (!isTool(p)) continue;
        const state = stateOf(p);
        tools.set(p.toolCallId as string, state);
        toolNames.set(p.toolCallId as string, nameOf(p));
        const was = before.get(p.toolCallId as string) ?? '';
        // An answered approval or a finished frontend tool closes the call.
        if (waited && OPEN.has(was) && (DONE.has(state) || (was === 'approval-requested' && state !== was))) {
          push({ type: 'tool-end', name: nameOf(p), error: state === 'output-error' });
        }
      }
      if (waited && !pending()) push({ type: 'finish' });
      last = status;
      return;
    }
    if (status === 'submitted' && last !== 'submitted') push({ type: 'start' });
    if (assistant) {
      if (assistant.id !== id) {
        id = assistant.id;
        chars = 0;
        tools = new Map();
      }
      // A step was regenerated (parts removed): continue from what's there.
      const total = textOf(assistant);
      if (total < chars) chars = total;
      let seen = 0;
      // Text is reported up to each tool event, so output before a tool call
      // isn't counted after it.
      const flush = () => {
        if (seen <= chars) return;
        let text = '';
        let at = 0;
        for (const p of assistant.parts) {
          if (p.type !== 'text' && p.type !== 'reasoning') continue;
          const t = p.text ?? '';
          text += t.slice(Math.max(0, chars - at), Math.max(0, seen - at));
          at += t.length;
        }
        push({ type: 'tokens', count: count(text) });
        chars = seen;
      };
      const present = new Set<string>();
      for (const p of assistant.parts) {
        if (p.type === 'text' || p.type === 'reasoning') seen += p.text?.length ?? 0;
        if (!isTool(p)) continue;
        const callId = p.toolCallId as string;
        present.add(callId);
        const state = stateOf(p);
        const prev = tools.get(callId);
        if (prev === state) continue;
        tools.set(callId, state);
        toolNames.set(callId, nameOf(p));
        flush();
        const name = nameOf(p);
        const done = DONE.has(state);
        // A call can go from streaming its input to done between two calls.
        if (!OPEN.has(prev ?? '') && (OPEN.has(state) || done)) push({ type: 'tool-start', name });
        if (done) push({ type: 'tool-end', name, error: state === 'output-error' });
      }
      flush();
      for (const callId of Array.from(tools.keys())) if (!present.has(callId)) tools.delete(callId);
    }
    if (status !== last) {
      if (status === 'error') push({ type: 'error' });
      // An approval or a frontend tool still pending: the agent waits on it.
      if (status === 'error' || (status === 'ready' && !pending())) push({ type: 'finish' });
    }
    last = status;
  };
}

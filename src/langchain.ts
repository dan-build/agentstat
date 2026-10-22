// src/langchain.ts — `@dan-build/agentstat/langchain`
//
// LangChain.js / LangGraph.js → AgentStat events, from callbacks or from
// `streamEvents` (v2). No dependency on @langchain/*: everything is read
// structurally. Framework-free and server-safe.

import type { AgentEvent } from './types';
import type { AdapterOptions, EventSink } from './ai-sdk';

export type { AdapterOptions, EventSink };

/** What is known about a run when its agent is chosen. */
export type LangChainRun = {
  /** The runnable's name (model, tool or chain). */
  name?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
};

/** A fixed agent id, or one chosen per run (e.g. `bySubgraph('graph')`). */
export type AgentIdFor = string | ((run: LangChainRun) => string);

export interface LangChainOptions extends AdapterOptions {
  agentId: AgentIdFor;
}

const estimate = (text: string) => text.length / 4;

/**
 * Route LangGraph runs inside a subgraph (e.g. each agent of a supervisor or
 * swarm) to the subgraph's node name; everything else to `fallback`.
 */
export const bySubgraph =
  (fallback: string) =>
  (run: LangChainRun): string => {
    const ns = run.metadata?.langgraph_checkpoint_ns;
    const parts = typeof ns === 'string' ? ns.split('|') : [];
    return parts.length > 1 ? parts[0].split(':')[0] || fallback : fallback;
  };

/** Text in a message chunk or generation: content, reasoning, tool-call arguments. */
function textOf(x: unknown): string {
  if (typeof x === 'string') return x;
  if (!x || typeof x !== 'object') return '';
  const o = x as Record<string, unknown>;
  let out = '';
  const content = o.content;
  if (typeof content === 'string') out += content;
  else if (Array.isArray(content)) {
    for (const b of content) {
      if (typeof b === 'string') out += b;
      else if (b && typeof b === 'object') {
        const r = b as Record<string, unknown>;
        for (const k of ['text', 'thinking', 'reasoning']) if (typeof r[k] === 'string') out += r[k];
      }
    }
  } else if (typeof o.text === 'string') out += o.text;
  if (Array.isArray(o.tool_call_chunks)) {
    for (const c of o.tool_call_chunks)
      if (c && typeof (c as { args?: unknown }).args === 'string') out += (c as { args: string }).args;
  }
  return out;
}

/** Output tokens a finished model run reported, if any. */
function outputTokens(output: unknown): number | undefined {
  const o = output as {
    llmOutput?: { tokenUsage?: { completionTokens?: number } };
    generations?: {
      message?: { usage_metadata?: { output_tokens?: number } };
    }[][];
    usage_metadata?: { output_tokens?: number };
  } | null;
  const n =
    o?.usage_metadata?.output_tokens ??
    o?.generations?.[0]?.[0]?.message?.usage_metadata?.output_tokens ??
    o?.llmOutput?.tokenUsage?.completionTokens;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Text of a finished model run (for runs that didn't stream). */
function outputText(output: unknown): string {
  const o = output as {
    generations?: { text?: string; message?: unknown }[][];
  } | null;
  const g = o?.generations?.[0]?.[0];
  if (g) return typeof g.text === 'string' && g.text ? g.text : textOf(g.message);
  return textOf(output);
}

/**
 * Shared state machine: model runs → start / tokens / finish, tool runs →
 * waiting, the top-level run's end → finish.
 */
function createMapper(sink: EventSink, options: LangChainOptions) {
  const count = options.countTokens ?? estimate;
  const pick = options.agentId;
  // Agent of each open run, and whether a model run has streamed.
  const agents = new Map<string, string>();
  const streamed = new Set<string>();
  const toolNames = new Map<string, string>();
  // Agents with a run in progress (not finished), and the outermost run.
  const busy = new Set<string>();
  let root: string | undefined;
  const push = (runId: string, e: AgentEvent) => {
    const id = agents.get(runId);
    if (id === undefined) return;
    if (e.type === 'finish') busy.delete(id);
    else busy.add(id);
    sink.push(id, e);
  };
  const open = (runId: string, run: LangChainRun) => {
    const id = typeof pick === 'function' ? pick(run) : pick;
    if (typeof id === 'string' && id) agents.set(runId, id);
  };
  const close = (runId: string) => {
    agents.delete(runId);
    streamed.delete(runId);
    toolNames.delete(runId);
  };
  return {
    /** A run started with no parent: its end ends everything under it. */
    rootStart(runId: string) {
      if (root === undefined) root = runId;
    },
    rootEnd(runId: string) {
      if (runId !== root) return;
      root = undefined;
      // E.g. a tool returned and the run ended without another model call.
      for (const id of busy) sink.push(id, { type: 'finish' });
      busy.clear();
    },
    modelStart(runId: string, run: LangChainRun) {
      open(runId, run);
      push(runId, { type: 'start' });
    },
    token(runId: string, text: string) {
      if (!text) return;
      streamed.add(runId);
      push(runId, { type: 'tokens', count: count(text) });
    },
    modelEnd(runId: string, output: unknown) {
      // A model that didn't stream: its whole output arrives now.
      if (!streamed.has(runId)) {
        const n = outputTokens(output) ?? count(outputText(output));
        if (n > 0) push(runId, { type: 'tokens', count: n });
      }
      // The call is done; what follows (a tool, the next call) reports itself.
      push(runId, { type: 'finish' });
      close(runId);
    },
    modelError(runId: string) {
      push(runId, { type: 'error' });
      push(runId, { type: 'finish' });
      close(runId);
    },
    toolStart(runId: string, run: LangChainRun) {
      open(runId, run);
      toolNames.set(runId, run.name ?? '');
      push(runId, { type: 'tool-start', name: run.name ?? '' });
    },
    toolEnd(runId: string, error: boolean) {
      push(runId, {
        type: 'tool-end',
        name: toolNames.get(runId) ?? '',
        error,
      });
      close(runId);
    },
  };
}

const nameOf = (serialized: unknown, runName?: string): string | undefined => {
  if (runName) return runName;
  const s = serialized as { name?: unknown; id?: unknown } | null;
  if (typeof s?.name === 'string') return s.name;
  return Array.isArray(s?.id) && typeof s.id[s.id.length - 1] === 'string' ? s.id[s.id.length - 1] : undefined;
};

type Meta = Record<string, unknown>;

/** The callback methods AgentStat implements (LangChain's handler signatures). */
export interface LangChainCallbackHandler {
  name: string;
  handleChainStart(
    chain: unknown,
    inputs: unknown,
    runId: string,
    runType?: string,
    tags?: string[],
    metadata?: Meta,
    runName?: string,
    parentRunId?: string
  ): void;
  handleChainEnd(outputs: unknown, runId: string): void;
  handleChainError(err: unknown, runId: string): void;
  handleChatModelStart(
    llm: unknown,
    messages: unknown,
    runId: string,
    parentRunId?: string,
    extraParams?: unknown,
    tags?: string[],
    metadata?: Meta,
    runName?: string
  ): void;
  handleLLMStart(
    llm: unknown,
    prompts: unknown,
    runId: string,
    parentRunId?: string,
    extraParams?: unknown,
    tags?: string[],
    metadata?: Meta,
    runName?: string
  ): void;
  handleLLMNewToken(
    token: string,
    idx: unknown,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    fields?: { chunk?: { message?: unknown } }
  ): void;
  handleLLMEnd(output: unknown, runId: string): void;
  handleLLMError(err: unknown, runId: string): void;
  handleToolStart(
    tool: unknown,
    input: unknown,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Meta,
    runName?: string
  ): void;
  handleToolEnd(output: unknown, runId: string): void;
  handleToolError(err: unknown, runId: string): void;
}

/**
 * A callback handler to pass in `callbacks` (of a model, tool, agent or graph
 * invocation). Model calls show as start → output → complete, tool calls as
 * `waiting`.
 *
 * ```ts
 * const callbacks = [createLangChainCallbacks(stream, { agentId: 'researcher' })];
 * await agent.invoke(input, { callbacks });
 * // LangGraph supervisor: one chart agent per sub-agent
 * await graph.invoke(input, { callbacks: [createLangChainCallbacks(stream, { agentId: bySubgraph('supervisor') })] });
 * ```
 */
export function createLangChainCallbacks(sink: EventSink, options: LangChainOptions): LangChainCallbackHandler {
  const m = createMapper(sink, options);
  const run = (
    serialized: unknown,
    metadata?: Record<string, unknown>,
    tags?: string[],
    runName?: string
  ): LangChainRun => ({
    name: nameOf(serialized, runName),
    metadata,
    tags,
  });
  return {
    name: 'agentstat',
    handleChainStart(
      _chain: unknown,
      _inputs: unknown,
      runId: string,
      _runType?: string,
      _tags?: string[],
      _metadata?: unknown,
      _runName?: string,
      parentRunId?: string
    ) {
      if (!parentRunId) m.rootStart(runId);
    },
    handleChainEnd(_outputs: unknown, runId: string) {
      m.rootEnd(runId);
    },
    handleChainError(_err: unknown, runId: string) {
      m.rootEnd(runId);
    },
    handleChatModelStart(
      llm: unknown,
      _messages: unknown,
      runId: string,
      _parentRunId?: string,
      _extra?: unknown,
      tags?: string[],
      metadata?: Record<string, unknown>,
      runName?: string
    ) {
      m.modelStart(runId, run(llm, metadata, tags, runName));
    },
    handleLLMStart(
      llm: unknown,
      _prompts: unknown,
      runId: string,
      _parentRunId?: string,
      _extra?: unknown,
      tags?: string[],
      metadata?: Record<string, unknown>,
      runName?: string
    ) {
      m.modelStart(runId, run(llm, metadata, tags, runName));
    },
    handleLLMNewToken(
      token: string,
      _idx: unknown,
      runId: string,
      _p?: string,
      _t?: string[],
      fields?: { chunk?: { message?: unknown } }
    ) {
      m.token(runId, token || textOf(fields?.chunk?.message));
    },
    handleLLMEnd(output: unknown, runId: string) {
      m.modelEnd(runId, output);
    },
    handleLLMError(_err: unknown, runId: string) {
      m.modelError(runId);
    },
    handleToolStart(
      tool: unknown,
      _input: unknown,
      runId: string,
      _parentRunId?: string,
      tags?: string[],
      metadata?: Record<string, unknown>,
      runName?: string
    ) {
      m.toolStart(runId, run(tool, metadata, tags, runName));
    },
    handleToolEnd(_output: unknown, runId: string) {
      m.toolEnd(runId, false);
    },
    handleToolError(_err: unknown, runId: string) {
      m.toolEnd(runId, true);
    },
  };
}

/** An event of `runnable.streamEvents(input, { version: 'v2' })`. */
export type LangChainStreamEvent = {
  event: string;
  run_id: string;
  name?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  data?: { chunk?: unknown; output?: unknown };
};

/**
 * Returns a function to call with every `streamEvents` (v2) event.
 *
 * ```ts
 * const tap = createLangChainTap(stream, { agentId: bySubgraph('graph') });
 * for await (const e of graph.streamEvents(input, { version: 'v2' })) tap(e);
 * ```
 */
export function createLangChainTap(sink: EventSink, options: LangChainOptions): (event: LangChainStreamEvent) => void {
  const m = createMapper(sink, options);
  return (e) => {
    if (!e || typeof e.event !== 'string' || typeof e.run_id !== 'string') return;
    const run: LangChainRun = {
      name: e.name,
      metadata: e.metadata,
      tags: e.tags,
    };
    // The first event is the start of the runnable streamEvents was called on.
    if (e.event.endsWith('_start')) m.rootStart(e.run_id);
    switch (e.event) {
      case 'on_chat_model_start':
      case 'on_llm_start':
        m.modelStart(e.run_id, run);
        break;
      case 'on_chat_model_stream':
      case 'on_llm_stream':
        m.token(e.run_id, textOf(e.data?.chunk));
        break;
      case 'on_chat_model_end':
      case 'on_llm_end':
        m.modelEnd(e.run_id, e.data?.output);
        break;
      case 'on_chat_model_error':
      case 'on_llm_error':
        m.modelError(e.run_id);
        break;
      case 'on_tool_start':
        m.toolStart(e.run_id, run);
        break;
      case 'on_tool_end':
      case 'on_tool_error':
        m.toolEnd(e.run_id, e.event === 'on_tool_error');
        break;
    }
    if (e.event.endsWith('_end') || e.event.endsWith('_error')) m.rootEnd(e.run_id);
  };
}

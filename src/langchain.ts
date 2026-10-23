// src/langchain.ts — `@dan-build/agentstat/langchain`
//
// LangChain.js / LangGraph.js → AgentStat events, from callbacks or from
// `streamEvents` (v2). No dependency on @langchain/*: everything is read
// structurally. Framework-free and server-safe.

import type { AdapterOptions, EventSink } from './ai-sdk';
import { createRunMapper, type ModelOutput } from './core/runs';

export type { AdapterOptions, EventSink };

/** What is known about a run when its agent is chosen. */
export type LangChainRun = {
  /** The runnable's name (model, tool or chain). */
  name?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
};

/** A fixed agent id, or one chosen per run (e.g. `bySubgraph('graph')`). */
export type AgentIdFor = string | ((run: LangChainRun) => string | undefined);

export interface LangChainOptions extends AdapterOptions {
  agentId: AgentIdFor;
}

const estimate = (text: string) => text.length / 4;

/**
 * Route each run to the agent it belongs to in a multi-agent setup: the
 * agent's name for `createAgent` agents (`lc_agent_name`), else the
 * subgraph's node name for runs inside a LangGraph subgraph (each agent of a
 * supervisor or swarm), else `fallback`. An agent called from inside a tool
 * is routed by its name only if it has one.
 */
export const bySubgraph =
  (fallback: string) =>
  (run: LangChainRun): string => {
    const name = run.metadata?.lc_agent_name;
    if (typeof name === 'string' && name) return name;
    const ns = run.metadata?.langgraph_checkpoint_ns;
    const parts = typeof ns === 'string' ? ns.split('|') : [];
    return (parts.length > 1 && parts[0].split(':')[0]) || fallback;
  };

const str = (v: unknown) => (typeof v === 'string' ? v : '');

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
        out += str(r.text) + str(r.thinking) + str(r.reasoning) + str((r.reasoningText as { text?: unknown })?.text);
      }
    }
  } else out += str(o.text);
  // Reasoning of OpenAI-compatible servers (DeepSeek, Qwen, vLLM).
  out += str((o.additional_kwargs as { reasoning_content?: unknown })?.reasoning_content);
  if (Array.isArray(o.tool_call_chunks)) for (const c of o.tool_call_chunks) out += str(c?.args);
  return out;
}

type Output = {
  usage_metadata?: { output_tokens?: number };
  tool_calls?: unknown[];
  llmOutput?: { tokenUsage?: { completionTokens?: number } };
  generations?: { text?: string; message?: Output }[][];
} | null;

/** Output tokens a finished model run reported, if any. */
function outputTokens(output: unknown): number | undefined {
  const o = output as Output;
  const n =
    o?.usage_metadata?.output_tokens ??
    o?.generations?.[0]?.[0]?.message?.usage_metadata?.output_tokens ??
    o?.llmOutput?.tokenUsage?.completionTokens;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Text of a finished model run (for runs that didn't stream). */
function outputText(output: unknown): string {
  const g = (output as Output)?.generations?.[0]?.[0];
  if (g) return str(g.text) || textOf(g.message);
  return textOf(output);
}

/** Whether a finished model run asked for tools (its agent goes on to run them). */
const callsTools = (output: unknown): boolean => {
  const o = output as Output;
  return !!(o?.tool_calls?.length || o?.generations?.[0]?.[0]?.message?.tool_calls?.length);
};

/** Stopped by the caller (AbortSignal), not failed. */
const aborted = (err: unknown) => {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'ModelAbortError';
};

/** Normalize a model run's output for the run mapper. */
const modelOutput = (output: unknown): ModelOutput => ({
  tokens: outputTokens(output),
  text: outputText(output),
  callsTools: callsTools(output),
});

const createMapper = (sink: EventSink, options: LangChainOptions, implicitRoot: boolean, report?: (err: unknown) => void) =>
  createRunMapper(sink, { pick: options.agentId, count: options.countTokens ?? estimate, implicitRoot, report });

const nameOf = (serialized: unknown, runName?: string): string | undefined => {
  if (runName) return runName;
  const s = serialized as { name?: unknown; id?: unknown } | null;
  if (typeof s?.name === 'string') return s.name;
  return Array.isArray(s?.id) && typeof s.id[s.id.length - 1] === 'string' ? s.id[s.id.length - 1] : undefined;
};

type Meta = Record<string, unknown>;

/**
 * The callback methods AgentStat implements, with the argument order LangChain
 * calls them with.
 */
export interface LangChainCallbackHandler {
  name: string;
  awaitHandlers: boolean;
  handleChainStart(
    chain: unknown,
    inputs: unknown,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Meta,
    runType?: string,
    runName?: string
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
    fields?: { chunk?: unknown }
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
 * A callback handler to pass in `callbacks` of an invocation (agent, graph,
 * model or tool); child runs inherit it. Attach it once per invocation.
 * Model calls show as start → output, tool calls as `waiting`; an agent is
 * complete once it has nothing running, and the end of the invocation
 * finishes (or, on error, fails) every agent it used.
 *
 * ```ts
 * const callbacks = [createLangChainCallbacks(stream, { agentId: 'researcher' })];
 * await agent.invoke(input, { callbacks });
 * // LangGraph supervisor or swarm: one chart agent per sub-agent
 * await graph.invoke(input, { callbacks: [createLangChainCallbacks(stream, { agentId: bySubgraph('supervisor') })] });
 * ```
 */
export function createLangChainCallbacks(sink: EventSink, options: LangChainOptions): LangChainCallbackHandler {
  const m = createMapper(sink, options, false);
  const run = (serialized: unknown, metadata?: Meta, tags?: string[], runName?: string): LangChainRun => ({
    name: nameOf(serialized, runName),
    metadata,
    tags,
  });
  return {
    name: 'agentstat',
    // Run in order with the invocation, so event times are when things
    // happened (and nothing is still queued when a serverless handler returns).
    awaitHandlers: true,
    handleChainStart(_chain, _inputs, runId, parentRunId) {
      m.chainStart(runId, parentRunId);
    },
    handleChainEnd(_outputs, runId) {
      m.chainEnd(runId, false);
    },
    handleChainError(err, runId) {
      m.chainEnd(runId, !aborted(err));
    },
    handleChatModelStart(llm, _messages, runId, parentRunId, _extra, tags, metadata, runName) {
      m.modelStart(runId, parentRunId, run(llm, metadata, tags, runName));
    },
    handleLLMStart(llm, _prompts, runId, parentRunId, _extra, tags, metadata, runName) {
      m.modelStart(runId, parentRunId, run(llm, metadata, tags, runName));
    },
    handleLLMNewToken(token, _idx, runId, _parentRunId, _tags, fields) {
      m.token(runId, token || textOf((fields?.chunk as { message?: unknown } | undefined)?.message));
    },
    handleLLMEnd(output, runId) {
      m.modelEnd(runId, modelOutput(output));
    },
    handleLLMError(err, runId) {
      m.modelEnd(runId, undefined, !aborted(err));
    },
    handleToolStart(tool, _input, runId, parentRunId, tags, metadata, runName) {
      m.toolStart(runId, parentRunId, run(tool, metadata, tags, runName));
    },
    handleToolEnd(_output, runId) {
      m.toolEnd(runId, false);
    },
    handleToolError(err, runId) {
      m.toolEnd(runId, !aborted(err));
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

/** A tap for one `streamEvents` call; `end()` closes what it left open. */
export interface LangChainTap {
  (event: LangChainStreamEvent): void;
  /** The stream stopped (or threw: `error` true) — end its runs. */
  end(error?: boolean): void;
}

/**
 * Returns a function to call with every event of one `streamEvents` (v2)
 * call. streamEvents has no error events: when the stream throws or you stop
 * reading it, call `tap.end(true)` — or use `tapLangChainStream`, which does.
 */
export function createLangChainTap(sink: EventSink, options: LangChainOptions): LangChainTap {
  // Your loop calls the tap: a failing sink is reported, not thrown into it.
  const m = createMapper(sink, options, true, (err) => console.error('[agentstat]', err));
  const tap = ((e: LangChainStreamEvent) => {
    if (!e || typeof e.event !== 'string' || typeof e.run_id !== 'string') return;
    const run: LangChainRun = { name: e.name, metadata: e.metadata, tags: e.tags };
    switch (e.event) {
      case 'on_chat_model_start':
      case 'on_llm_start':
        m.modelStart(e.run_id, undefined, run);
        break;
      case 'on_chat_model_stream':
      case 'on_llm_stream':
        m.token(e.run_id, textOf(e.data?.chunk));
        break;
      case 'on_chat_model_end':
      case 'on_llm_end':
        m.modelEnd(e.run_id, modelOutput(e.data?.output));
        break;
      case 'on_tool_start':
        m.toolStart(e.run_id, undefined, run);
        break;
      case 'on_tool_end':
      case 'on_tool_error':
        m.toolEnd(e.run_id, e.event === 'on_tool_error');
        break;
      default:
        if (e.event.endsWith('_start')) m.chainStart(e.run_id);
        else if (e.event.endsWith('_end')) m.chainEnd(e.run_id, false);
    }
  }) as LangChainTap;
  tap.end = (error = false) => m.endAll(error);
  return tap;
}

/**
 * Feed a whole `streamEvents` (v2) stream to the chart. Resolves when it ends;
 * a stream that throws ends its runs with an error, then the error is
 * rethrown.
 *
 * ```ts
 * await tapLangChainStream(stream, graph.streamEvents(input, { version: 'v2' }), { agentId: bySubgraph('graph') });
 * ```
 */
export async function tapLangChainStream(
  sink: EventSink,
  events: AsyncIterable<LangChainStreamEvent>,
  options: LangChainOptions
): Promise<void> {
  const tap = createLangChainTap(sink, options);
  try {
    for await (const e of events) tap(e);
  } catch (err) {
    tap.end(!aborted(err));
    throw err;
  }
  tap.end(false);
}

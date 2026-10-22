// LangChain.js / LangGraph.js adapter: callbacks and streamEvents (v2).
// Callbacks are called in the order LangChain's CallbackManager dispatches
// them (handleChainStart: chain, inputs, runId, parentRunId, tags, metadata,
// runType, runName), which differs from the handler typings.
import { describe, it, expect, vi } from 'vitest';
import { bySubgraph, createLangChainCallbacks, createLangChainTap, tapLangChainStream } from '../src/langchain';
import type { AgentEvent } from '../src/types';

const sink = () => {
  const got: [string, AgentEvent][] = [];
  return {
    got,
    push: (id: string, e: AgentEvent) => got.push([id, e]),
    seq: () => got.map(([id, e]) => `${id}:${e.type}${e.type === 'tool-start' ? `:${e.name}` : ''}`),
  };
};
const llm = { id: ['langchain', 'chat_models', 'openai', 'ChatOpenAI'] };
const withCalls = { generations: [[{ text: '', message: { tool_calls: [{ name: 'Search' }] } }]] };

describe('createLangChainCallbacks', () => {
  it('maps a ReAct loop as one busy stretch per step', () => {
    const s = sink();
    const cb = createLangChainCallbacks(s, { agentId: 'a', countTokens: (t) => t.length });
    cb.handleChainStart({}, {}, 'root', undefined, [], {}, undefined, 'LangGraph');
    cb.handleChainStart({}, {}, 'node', 'root', [], {}, undefined, 'agent');
    cb.handleChatModelStart(llm, [], 'm1', 'node');
    cb.handleLLMNewToken('', {}, 'm1', 'node', [], { chunk: { message: { content: '', tool_call_chunks: [{ args: '{"q":1}' }] } } });
    cb.handleLLMEnd(withCalls, 'm1'); // asked for a tool: no finish in between
    cb.handleChainEnd({}, 'node');
    cb.handleToolStart({ id: ['tools', 'Search'] }, '{}', 't1', 'root');
    cb.handleToolEnd('result', 't1');
    cb.handleChatModelStart(llm, [], 'm2', 'root');
    cb.handleLLMNewToken('Done.', {}, 'm2');
    cb.handleLLMEnd({}, 'm2');
    cb.handleChainEnd({}, 'root');
    expect(s.seq()).toEqual([
      'a:start', 'a:tokens', 'a:tool-start:Search', 'a:tool-end', 'a:finish',
      'a:start', 'a:tokens', 'a:finish',
    ]);
    expect(s.got[1][1]).toEqual({ type: 'tokens', count: 7 });
  });

  it('runs in order with the invocation (awaitHandlers)', () => {
    expect(createLangChainCallbacks(sink(), { agentId: 'a' }).awaitHandlers).toBe(true);
  });

  it('reports a non-streaming model call from its usage, else its text', () => {
    const s = sink();
    const cb = createLangChainCallbacks(s, { agentId: 'a' });
    cb.handleChatModelStart(llm, [], 'm1');
    cb.handleLLMEnd({ generations: [[{ text: 'x', message: { usage_metadata: { output_tokens: 42 } } }]] }, 'm1');
    cb.handleLLMStart(llm, [], 'm2');
    cb.handleLLMEnd({ generations: [[{ text: 'abcdefgh' }]] }, 'm2');
    expect(s.got.map(([, e]) => e)).toEqual([
      { type: 'start' }, { type: 'tokens', count: 42 }, { type: 'finish' },
      { type: 'start' }, { type: 'tokens', count: 2 }, { type: 'finish' },
    ]);
  });

  it('finishes an agent a returnDirect tool left, when the invocation ends', () => {
    const s = sink();
    const cb = createLangChainCallbacks(s, { agentId: 'a' });
    cb.handleChainStart({}, {}, 'root', undefined, [], {}, undefined, 'LangGraph');
    cb.handleChatModelStart(llm, [], 'm1', 'root');
    cb.handleLLMEnd(withCalls, 'm1');
    cb.handleChainEnd({}, 'root'); // the tool never reported (or returned directly)
    expect(s.seq()).toEqual(['a:start', 'a:finish']);
  });

  it('fails the agents of an invocation that errors', () => {
    const s = sink();
    const cb = createLangChainCallbacks(s, { agentId: 'a' });
    cb.handleChainStart({}, {}, 'root', undefined, [], {}, undefined, 'LangGraph');
    cb.handleToolStart({ name: 'lookup' }, '', 't1', 'root');
    cb.handleChainError(new Error('GraphRecursionError'), 'root'); // the tool never ended
    expect(s.seq()).toEqual(['a:tool-start:lookup', 'a:error', 'a:finish']);
  });

  it('counts a model error and ends the call', () => {
    const s = sink();
    const cb = createLangChainCallbacks(s, { agentId: 'a' });
    cb.handleChatModelStart(llm, [], 'm1');
    cb.handleLLMError(new Error('429'), 'm1');
    expect(s.seq()).toEqual(['a:start', 'a:error', 'a:finish']);
  });

  it('a supervisor is complete while its sub-agent works', () => {
    const s = sink();
    const cb = createLangChainCallbacks(s, { agentId: bySubgraph('supervisor') });
    const meta = (ns: string) => ({ langgraph_checkpoint_ns: ns });
    cb.handleChainStart({}, {}, 'root', undefined, [], {}, undefined, 'LangGraph');
    cb.handleChatModelStart(llm, [], 'm0', 'root', {}, [], meta('supervisor:1|agent:2'));
    cb.handleLLMEnd(withCalls, 'm0');
    cb.handleToolStart({}, '', 'h', 'root', [], meta('supervisor:1|tools:3'), 'transfer_to_researcher');
    cb.handleToolEnd('', 'h');
    cb.handleChatModelStart(llm, [], 'm1', 'root', {}, [], meta('researcher:4|agent:5'));
    cb.handleLLMNewToken('hi', {}, 'm1');
    expect(s.seq()).toEqual([
      'supervisor:start', 'supervisor:tool-start:transfer_to_researcher', 'supervisor:tool-end', 'supervisor:finish',
      'researcher:start', 'researcher:tokens',
    ]);
  });

  it('keeps concurrent runs of one agent in one stretch', () => {
    const s = sink();
    const cb = createLangChainCallbacks(s, { agentId: 'a' });
    cb.handleChatModelStart(llm, [], 'm1');
    cb.handleChatModelStart(llm, [], 'm2'); // batch / parallel branch
    cb.handleLLMNewToken('x', {}, 'm1');
    cb.handleLLMEnd({}, 'm1');
    cb.handleLLMNewToken('y', {}, 'm2');
    cb.handleLLMEnd({}, 'm2');
    expect(s.seq()).toEqual(['a:start', 'a:tokens', 'a:tokens', 'a:finish']);
  });

  it('keeps two concurrent invocations apart', () => {
    const s = sink();
    const cb = createLangChainCallbacks(s, { agentId: (r) => r.name });
    cb.handleChainStart({}, {}, 'r1', undefined);
    cb.handleChainStart({}, {}, 'r2', undefined);
    cb.handleToolStart({}, '', 't1', 'r1', [], {}, 'one');
    cb.handleChatModelStart(llm, [], 'm2', 'r2', {}, [], {}, 'two');
    cb.handleLLMNewToken('x', {}, 'm2');
    cb.handleChainEnd({}, 'r1'); // ends only r1's agent
    cb.handleChainEnd({}, 'r2');
    expect(s.seq()).toEqual(['one:tool-start:one', 'two:start', 'two:tokens', 'one:finish', 'two:finish']);
  });

  it('ignores a second start of the same run (handler attached twice)', () => {
    const s = sink();
    const cb = createLangChainCallbacks(s, { agentId: 'a' });
    cb.handleToolStart({ name: 't' }, '', 't1');
    cb.handleToolStart({ name: 't' }, '', 't1');
    cb.handleToolEnd('', 't1');
    cb.handleToolEnd('', 't1');
    expect(s.seq()).toEqual(['a:tool-start:t', 'a:tool-end', 'a:finish']);
  });

  it('counts reasoning from content blocks and reasoning_content', () => {
    const s = sink();
    const cb = createLangChainCallbacks(s, { agentId: 'a', countTokens: (t) => t.length });
    cb.handleChatModelStart(llm, [], 'm1');
    cb.handleLLMNewToken('', {}, 'm1', undefined, [], { chunk: { message: { content: [{ type: 'reasoning_content', reasoningText: { text: 'abc' } }] } } });
    cb.handleLLMNewToken('', {}, 'm1', undefined, [], { chunk: { message: { content: '', additional_kwargs: { reasoning_content: 'de' } } } });
    expect(s.got.slice(1).map(([, e]) => e)).toEqual([{ type: 'tokens', count: 3 }, { type: 'tokens', count: 2 }]);
  });

  it('routes by agent name first, then subgraph', () => {
    const route = bySubgraph('main');
    expect(route({ metadata: { lc_agent_name: 'critic', langgraph_checkpoint_ns: 'tools:1|agent:2' } })).toBe('critic');
    expect(route({ metadata: { langgraph_checkpoint_ns: 'researcher:1|agent:2' } })).toBe('researcher');
    expect(route({ metadata: { langgraph_checkpoint_ns: 'agent:1' } })).toBe('main');
    expect(route({})).toBe('main');
  });

  it('a throwing sink does not break the run', () => {
    vi.useFakeTimers();
    const cb = createLangChainCallbacks({ push: () => { throw new Error('sink'); } }, { agentId: 'a' });
    expect(() => cb.handleChatModelStart(llm, [], 'm1')).not.toThrow();
    expect(() => vi.runAllTimers()).toThrow('sink');
    vi.useRealTimers();
  });
});

describe('createLangChainTap (streamEvents v2)', () => {
  it('maps model streaming, tools and the root run', () => {
    const s = sink();
    const tap = createLangChainTap(s, { agentId: 'g', countTokens: () => 1 });
    for (const e of [
      { event: 'on_chain_start', run_id: 'root', name: 'LangGraph' },
      { event: 'on_chat_model_start', run_id: 'm1', name: 'ChatAnthropic' },
      { event: 'on_chat_model_stream', run_id: 'm1', data: { chunk: { content: [{ type: 'thinking', thinking: 'hm' }] } } },
      { event: 'on_chat_model_stream', run_id: 'm1', data: { chunk: { content: 'Hi' } } },
      { event: 'on_chat_model_end', run_id: 'm1', data: { output: { tool_calls: [{}] } } },
      { event: 'on_tool_start', run_id: 't1', name: 'get_weather' },
      { event: 'on_tool_error', run_id: 't1' },
      { event: 'on_chain_end', run_id: 'root' },
    ])
      tap(e);
    expect(s.seq()).toEqual(['g:start', 'g:tokens', 'g:tokens', 'g:tool-start:get_weather', 'g:tool-end', 'g:finish']);
  });

  it('tapLangChainStream ends runs with an error when the stream throws, and the next root works', async () => {
    const s = sink();
    async function* failing() {
      yield { event: 'on_chain_start', run_id: 'root' };
      yield { event: 'on_chat_model_start', run_id: 'm1' };
      throw new Error('model failed'); // streamEvents has no error events
    }
    await expect(tapLangChainStream(s, failing(), { agentId: 'g' })).rejects.toThrow('model failed');
    expect(s.seq()).toEqual(['g:start', 'g:error', 'g:finish']);
    const tap = createLangChainTap(s, { agentId: 'g' });
    tap({ event: 'on_chain_start', run_id: 'r1' });
    tap({ event: 'on_chat_model_start', run_id: 'm1' });
    tap.end(true);
    tap({ event: 'on_chain_start', run_id: 'r2' });
    tap({ event: 'on_tool_start', run_id: 't', name: 'x' });
    tap({ event: 'on_chain_end', run_id: 'r2' });
    expect(s.seq().slice(3)).toEqual(['g:start', 'g:error', 'g:finish', 'g:tool-start:x', 'g:finish']);
  });

  it('ignores events for runs it never saw start, and malformed events', () => {
    const s = sink();
    const tap = createLangChainTap(s, { agentId: 'g' });
    tap({ event: 'on_chat_model_stream', run_id: 'x', data: { chunk: { content: 'a' } } });
    tap({ event: 'on_tool_end', run_id: 'y' });
    tap(null as never);
    expect(s.got).toEqual([]);
  });
});

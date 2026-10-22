// LangChain.js / LangGraph.js adapter: callbacks and streamEvents (v2).
import { describe, it, expect } from 'vitest';
import { bySubgraph, createLangChainCallbacks, createLangChainTap } from '../src/langchain';
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

describe('createLangChainCallbacks', () => {
  it('maps a ReAct loop: model, tool, model, end', () => {
    const s = sink();
    const cb = createLangChainCallbacks(s, { agentId: 'a', countTokens: (t) => t.length });
    cb.handleChainStart({}, {}, 'root');
    cb.handleChatModelStart(llm, [], 'm1', 'root');
    cb.handleLLMNewToken('', {}, 'm1', 'root', [], { chunk: { message: { content: '', tool_call_chunks: [{ args: '{"q":1}' }] } } });
    cb.handleLLMEnd({ generations: [[{ text: '' }]] }, 'm1');
    cb.handleToolStart({ id: ['tools', 'Search'] }, '{}', 't1', 'root');
    cb.handleToolEnd('result', 't1');
    cb.handleChatModelStart(llm, [], 'm2', 'root');
    cb.handleLLMNewToken('Done.', {}, 'm2');
    cb.handleLLMEnd({}, 'm2');
    cb.handleChainEnd({}, 'root');
    expect(s.seq()).toEqual(['a:start', 'a:tokens', 'a:finish', 'a:tool-start:Search', 'a:tool-end', 'a:start', 'a:tokens', 'a:finish']);
    expect(s.got[1][1]).toEqual({ type: 'tokens', count: 7 });
  });

  it('reports a non-streaming model call from its usage, else its text', () => {
    const s = sink();
    const cb = createLangChainCallbacks(s, { agentId: 'a' });
    cb.handleChatModelStart(llm, [], 'm1');
    cb.handleLLMEnd({ generations: [[{ text: 'x', message: { usage_metadata: { output_tokens: 42 } } }]] }, 'm1');
    cb.handleLLMStart(llm, [], 'm2');
    cb.handleLLMEnd({ generations: [[{ text: 'abcdefgh' }]] }, 'm2');
    expect(s.got.map(([, e]) => e)).toEqual([
      { type: 'start' },
      { type: 'tokens', count: 42 },
      { type: 'finish' },
      { type: 'start' },
      { type: 'tokens', count: 2 },
      { type: 'finish' },
    ]);
  });

  it('finishes an agent left after a tool when the outer run ends', () => {
    const s = sink();
    const cb = createLangChainCallbacks(s, { agentId: 'a' });
    cb.handleChainStart({}, {}, 'root');
    cb.handleChainStart({}, {}, 'inner', undefined, [], {}, 'node', 'root'); // not a root
    cb.handleToolStart({ name: 'lookup' }, '', 't1', 'inner');
    cb.handleToolError(new Error('x'), 't1');
    cb.handleChainEnd({}, 'inner');
    expect(s.seq()).toEqual(['a:tool-start:lookup', 'a:tool-end']);
    cb.handleChainError(new Error('y'), 'root');
    expect(s.seq()).toEqual(['a:tool-start:lookup', 'a:tool-end', 'a:finish']);
    expect(s.got[1][1]).toMatchObject({ error: true });
  });

  it('counts a model error and ends the call', () => {
    const s = sink();
    const cb = createLangChainCallbacks(s, { agentId: 'a' });
    cb.handleChatModelStart(llm, [], 'm1');
    cb.handleLLMError(new Error('429'), 'm1');
    expect(s.seq()).toEqual(['a:start', 'a:error', 'a:finish']);
  });

  it('routes runs to agents, e.g. by LangGraph subgraph', () => {
    const s = sink();
    const cb = createLangChainCallbacks(s, { agentId: bySubgraph('supervisor') });
    const meta = (ns: string) => ({ langgraph_checkpoint_ns: ns });
    cb.handleChatModelStart(llm, [], 'm0', undefined, {}, [], meta('supervisor:1'));
    cb.handleChatModelStart(llm, [], 'm1', undefined, {}, [], meta('researcher:2|agent:3'));
    cb.handleLLMNewToken('hi', {}, 'm1');
    cb.handleToolStart({ name: 'web' }, '', 't1', undefined, [], meta('researcher:2|tools:4'));
    expect(s.seq()).toEqual(['supervisor:start', 'researcher:start', 'researcher:tokens', 'researcher:tool-start:web']);
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
      { event: 'on_chat_model_end', run_id: 'm1', data: { output: {} } },
      { event: 'on_tool_start', run_id: 't1', name: 'get_weather' },
      { event: 'on_tool_error', run_id: 't1' },
      { event: 'on_chain_end', run_id: 'root' },
    ])
      tap(e);
    expect(s.seq()).toEqual(['g:start', 'g:tokens', 'g:tokens', 'g:finish', 'g:tool-start:get_weather', 'g:tool-end', 'g:finish']);
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

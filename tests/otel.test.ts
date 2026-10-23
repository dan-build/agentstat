// OpenTelemetry GenAI span processor, with span objects shaped like the
// SDK's (spanContext(), parentSpanContext / parentSpanId, HrTime, status).
import { describe, it, expect, vi } from 'vitest';
import { createOtelProcessor, type OtelSpan } from '../src/otel';
import { AgentStore } from '../src/core/store';
import type { AgentEvent } from '../src/types';

const sink = () => {
  const got: [string, AgentEvent][] = [];
  return {
    got,
    push: (id: string, e: AgentEvent) => got.push([id, e]),
    seq: () => got.map(([id, e]) => `${id}:${e.type}${e.type === 'tool-start' ? `:${e.name}` : ''}`),
  };
};

/** HrTime for `ms` in this page's performance clock, stamped like the SDK (wall clock). */
const hr = (ms: number): [number, number] => {
  const epoch = Date.now() - performance.now() + ms;
  return [Math.floor(epoch / 1000), Math.round((epoch % 1000) * 1e6)];
};

let n = 0;
function span(attrs: Record<string, unknown>, parent?: OtelSpan, v1 = false): OtelSpan {
  const id = `s${++n}`;
  const s: OtelSpan = { name: String(attrs.name ?? id), attributes: attrs, spanContext: () => ({ spanId: id }), startTime: hr(1000 + n) };
  if (parent) {
    if (v1) s.parentSpanId = parent.spanContext().spanId;
    else s.parentSpanContext = { spanId: parent.spanContext().spanId };
  }
  return s;
}
const end = (p: ReturnType<typeof createOtelProcessor>, s: OtelSpan, attrs: Record<string, unknown> = {}, error = false) => {
  s.attributes = { ...s.attributes, ...attrs };
  s.endTime = hr(2000 + n);
  if (error) s.status = { code: 2 };
  p.onEnd(s);
};

describe('createOtelProcessor', () => {
  it('waits on tools the app runs without spans, until the next call', () => {
    const s = sink();
    const p = createOtelProcessor(s, { agentId: 'a' });
    const chat1 = span({ 'gen_ai.operation.name': 'chat' }); // its own root: no wrapper span
    p.onStart(chat1);
    end(p, chat1, { 'gen_ai.usage.output_tokens': 20, 'gen_ai.response.finish_reasons': ['tool_calls'] });
    expect(s.seq()).toEqual(['a:start', 'a:tokens', 'a:tool-start:tools']);
    const chat2 = span({ 'gen_ai.operation.name': 'chat' });
    p.onStart(chat2);
    end(p, chat2, { 'gen_ai.usage.output_tokens': 50, 'gen_ai.response.finish_reasons': ['stop'] });
    expect(s.seq().slice(3)).toEqual(['a:tool-end', 'a:start', 'a:tokens', 'a:finish']);
  });

  it('through the store: a call is plotted at its average rate since its first chunk, which is the TTFT', () => {
    const store = new AgentStore([], { maxHistoryPoints: 1000 }, 0);
    const now = performance.now();
    const p = createOtelProcessor({ push: (id, e) => { store.ensure(id, e.time ?? now, now); store.push(id, e, now); } }, { agentId: 'a' });
    const chat: OtelSpan = {
      name: 'chat', attributes: { 'gen_ai.operation.name': 'chat' }, spanContext: () => ({ spanId: 'c' }),
      startTime: hr(now - 12_000),
    };
    p.onStart(chat);
    chat.attributes = { ...chat.attributes, 'gen_ai.usage.output_tokens': 1_100, 'gen_ai.response.time_to_first_chunk': 1 };
    chat.endTime = hr(now);
    p.onEnd(chat);
    const stats = store.getStats('a', now)!;
    expect(stats.ttftMs).toBeCloseTo(1_000, -1);
    expect(Math.max(...store.tokens.get('a')!.values())).toBeCloseTo(100, 0); // 1100 tokens over 11 s
  });

  it('reads the output text when no usage is reported, and the span’s own agent name', () => {
    const s = sink();
    const p = createOtelProcessor(s, { countTokens: (t) => t.length });
    const tool = span({ 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'x', 'gen_ai.agent.name': 'ops' });
    p.onStart(tool);
    end(p, tool);
    const chat = span({ 'gen_ai.operation.name': 'chat' });
    p.onStart(chat);
    end(p, chat, { 'gen_ai.output.messages': JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: 'Hello' }] }]) });
    expect(s.seq()).toEqual(['ops:tool-start:x', 'ops:tool-end', 'ops:finish', 'agent:start', 'agent:tokens', 'agent:finish']);
    expect(s.got[4][1]).toMatchObject({ count: 5 });
  });

  it('reports a remote agent (CLIENT invoke_agent) as one live run; an outer agent span adds none', () => {
    const s = sink();
    const p = createOtelProcessor(s);
    const team = span({ 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'team' });
    p.onStart(team);
    const remote = { ...span({ 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'bedrock-agent' }, team), kind: 2 };
    p.onStart(remote);
    expect(s.seq()).toEqual(['bedrock-agent:start']); // live from its start
    end(p, remote);
    end(p, team);
    expect(s.seq()).toEqual(['bedrock-agent:start', 'bedrock-agent:finish']);
  });

  it('a call that asks for tools and is never followed up is done after 2 minutes', () => {
    vi.useFakeTimers();
    const s = sink();
    const p = createOtelProcessor(s, { agentId: 'a' });
    const chat = span({ 'gen_ai.operation.name': 'chat' });
    p.onStart(chat);
    end(p, chat, { 'gen_ai.response.finish_reasons': ['tool_calls'] });
    vi.advanceTimersByTime(119_000);
    expect(s.seq()).toEqual(['a:start', 'a:tool-start:tools']);
    vi.advanceTimersByTime(1_000);
    expect(s.seq()).toEqual(['a:start', 'a:tool-start:tools', 'a:tool-end', 'a:finish']);
    vi.useRealTimers();
  });

  it('through the store: a non-streamed call without TTFC has the whole call as its TTFT', () => {
    const store = new AgentStore([], { maxHistoryPoints: 1000 }, 0);
    const now = performance.now();
    const p = createOtelProcessor({ push: (id, e) => { store.ensure(id, e.time ?? now, now); store.push(id, e, now); } }, { agentId: 'a' });
    const chat: OtelSpan = { name: 'chat', attributes: { 'gen_ai.operation.name': 'chat' }, spanContext: () => ({ spanId: 'n' }), startTime: hr(now - 3_000) };
    p.onStart(chat);
    chat.attributes = { ...chat.attributes, 'gen_ai.usage.output_tokens': 300 };
    chat.endTime = hr(now);
    p.onEnd(chat);
    expect(store.getStats('a', now)!.ttftMs).toBeCloseTo(3_000, -1);
    expect(Math.max(...store.tokens.get('a')!.values())).toBeCloseTo(100, 0);
  });

  it('a throwing agentId function never reaches the instrumented app', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const p = createOtelProcessor(sink(), { agentId: () => { throw new Error('bad pick'); } });
    const chat = span({ 'gen_ai.operation.name': 'chat' });
    expect(() => p.onStart(chat)).not.toThrow();
    expect(() => end(p, chat)).not.toThrow();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('maps an agent with a model call, a tool and a final answer', () => {
    const s = sink();
    const p = createOtelProcessor(s);
    const agent = span({ 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'researcher' });
    p.onStart(agent);
    const chat1 = span({ 'gen_ai.operation.name': 'chat' }, agent);
    p.onStart(chat1);
    end(p, chat1, { 'gen_ai.usage.output_tokens': 40, 'gen_ai.response.finish_reasons': ['tool_calls'] });
    const tool = span({ 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search' }, agent);
    p.onStart(tool);
    end(p, tool);
    const chat2 = span({ 'gen_ai.operation.name': 'chat' }, agent);
    p.onStart(chat2);
    end(p, chat2, { 'gen_ai.usage.output_tokens': 120, 'gen_ai.response.finish_reasons': ['stop'] });
    end(p, agent);
    expect(s.seq()).toEqual([
      'researcher:start', 'researcher:tokens',
      'researcher:tool-start:tools', // waiting on the tools it asked for…
      'researcher:tool-start:search', 'researcher:tool-end', // …which turn out to be reported (no gap)
      'researcher:tool-end',
      'researcher:start', 'researcher:tokens', 'researcher:finish',
    ]);
    expect(s.got[1][1]).toMatchObject({ count: 40 });
  });

  it('times events from the span, in this clock', () => {
    const s = sink();
    const p = createOtelProcessor(s, { agentId: 'a' });
    const chat = span({ 'gen_ai.operation.name': 'chat' });
    p.onStart(chat);
    end(p, chat, { 'gen_ai.usage.output_tokens': 10 });
    const start = s.got[0][1].time!;
    const finish = s.got[2][1].time!;
    expect(Math.abs(start - (1000 + n))).toBeLessThan(1);
    expect(Math.abs(finish - (2000 + n))).toBeLessThan(1);
  });

  it('routes sub-agents by their agent spans (SDK 1.x parents too)', () => {
    const s = sink();
    const p = createOtelProcessor(s, { agentId: 'orchestrator' });
    const root = span({ 'gen_ai.operation.name': 'invoke_workflow' });
    p.onStart(root);
    const plan = span({ 'gen_ai.operation.name': 'chat' }, root);
    p.onStart(plan);
    end(p, plan, { 'gen_ai.response.finish_reasons': 'tool_calls' });
    const sub = span({ 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.id': 'coder' }, root, true);
    p.onStart(sub);
    const code = span({ 'gen_ai.operation.name': 'text_completion' }, sub, true);
    p.onStart(code);
    end(p, code, { 'gen_ai.usage.output_tokens': 5 });
    end(p, sub);
    end(p, root);
    expect(s.seq()).toEqual([
      'orchestrator:start', 'orchestrator:tool-start:tools',
      'orchestrator:tool-end', 'orchestrator:finish', // handed off: another agent's turn
      'coder:start', 'coder:tokens', 'coder:finish',
    ]);
  });

  it('counts errors: a failed model call, a failed tool, a failed root', () => {
    const s = sink();
    const p = createOtelProcessor(s, { agentId: 'a' });
    const root = span({ name: 'request' });
    p.onStart(root);
    const tool = span({ 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'db' }, root);
    p.onStart(tool);
    end(p, tool, {}, true);
    const chat = span({ 'gen_ai.operation.name': 'chat' }, root);
    p.onStart(chat);
    end(p, chat, {}, true);
    end(p, root, {}, true);
    expect(s.got.map(([, e]) => e.type + ('error' in e && e.error ? '!' : ''))).toEqual([
      'tool-start', 'tool-end!', 'start', 'error', 'finish',
    ]);
  });

  it('ignores spans that are not GenAI work, and a throwing sink', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const p = createOtelProcessor({ push: () => { throw new Error('sink'); } });
    const http = span({ 'http.method': 'GET' });
    p.onStart(http);
    const chat = span({ 'gen_ai.operation.name': 'chat' }, http);
    expect(() => p.onStart(chat)).not.toThrow();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('shutdown ends what is open', async () => {
    const s = sink();
    const p = createOtelProcessor(s, { agentId: 'a' });
    const chat = span({ 'gen_ai.operation.name': 'chat' });
    p.onStart(chat);
    await p.shutdown();
    expect(s.seq()).toEqual(['a:start', 'a:finish']);
  });
});

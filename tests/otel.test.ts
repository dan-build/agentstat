// OpenTelemetry GenAI span processor, with span objects shaped like the
// SDK's (spanContext(), parentSpanContext / parentSpanId, HrTime, status).
import { describe, it, expect, vi } from 'vitest';
import { createOtelProcessor, type OtelSpan } from '../src/otel';
import type { AgentEvent } from '../src/types';

const sink = () => {
  const got: [string, AgentEvent][] = [];
  return {
    got,
    push: (id: string, e: AgentEvent) => got.push([id, e]),
    seq: () => got.map(([id, e]) => `${id}:${e.type}${e.type === 'tool-start' ? `:${e.name}` : ''}`),
  };
};

/** HrTime for `ms` after this page's time origin. */
const hr = (ms: number): [number, number] => {
  const epoch = performance.timeOrigin + ms;
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
      'researcher:start', 'researcher:tokens', 'researcher:tool-start:search', 'researcher:tool-end',
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
      'orchestrator:start', 'orchestrator:finish', // handed over, then another agent started
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

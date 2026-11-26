// The Claude Agent SDK and OpenAI Agents SDK adapters, and the attention the
// AI SDK and AG-UI adapters now report. Messages follow the SDKs' own types
// (@anthropic-ai/claude-agent-sdk 0.3.332, @openai/agents 0.22.0, ai 7, @ag-ui/core 1.0).
import { describe, it, expect } from 'vitest';
import { createClaudeAgentTap, trackClaudeAgent, type ClaudeAgentMessage } from '../src/claude-agent-sdk';
import { createOpenAiAgentsTap, trackOpenAiAgentsRun, type OpenAiAgentsEvent } from '../src/openai-agents';
import { createAiSdkTap, createChatTracker } from '../src/ai-sdk';
import { createAgUiTap } from '../src/ag-ui';
import type { AgentEvent } from '../src/types';
import type { AgentAttention } from '../src/stream-core';

/** A sink recording "id:event" lines (tool names and cost included). */
function recorder() {
  const log: string[] = [];
  const names: Record<string, string> = {};
  const sink = {
    push(id: string, e: AgentEvent) {
      const detail =
        e.type === 'tool-start' || e.type === 'tool-end'
          ? `(${e.name}${e.type === 'tool-end' && e.error ? ',error' : ''})`
          : e.type === 'cost'
            ? `(${e.usd.toFixed(2)})`
            : e.type === 'tokens'
              ? `(${e.count})`
              : '';
      log.push(`${id}:${e.type}${detail}`);
    },
    attention(id: string, a: AgentAttention) {
      log.push(`${id}:attention(${a.reason},${a.message})`);
    },
    describe(id: string, info: { name?: string }) {
      names[id] = info.name ?? '';
    },
  };
  return { log, names, sink };
}

async function* from<T>(items: T[], fail?: Error): AsyncGenerator<T> {
  for (const i of items) yield i;
  if (fail) throw fail;
}

const init: ClaudeAgentMessage = { type: 'system', subtype: 'init' };
const assistant = (content: object[], parent: string | null = null): ClaudeAgentMessage => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { content: content as never },
});
const toolResult = (id: string, parent: string | null = null, isError = false): ClaudeAgentMessage => ({
  type: 'user',
  parent_tool_use_id: parent,
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] },
});

describe('Claude Agent SDK', () => {
  it('maps a run with a tool call and a subagent, and its cost', () => {
    const { log, names, sink } = recorder();
    const tap = createClaudeAgentTap(sink, { agentId: 'fixer' });
    tap(init);
    tap(assistant([{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }]));
    tap(toolResult('t1'));
    tap(assistant([{ type: 'tool_use', id: 'a1', name: 'Agent', input: { subagent_type: 'Explore', description: 'find' } }]));
    tap(assistant([{ type: 'tool_use', id: 't2', name: 'Grep', input: {} }], 'a1'));
    tap(toolResult('t2', 'a1', true));
    tap(toolResult('a1'));
    tap({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.1 });
    expect(log).toEqual([
      'fixer:start',
      'fixer:tokens(3)',
      'fixer:tool-start(Bash)',
      'fixer:tool-end(Bash)',
      'fixer:tool-start(Agent)',
      'fixer/a1:start',
      'fixer/a1:tool-start(Grep)',
      'fixer/a1:tool-end(Grep,error)',
      'fixer:tool-end(Agent)',
      'fixer/a1:finish',
      'fixer:finish',
      'fixer:cost(0.10)',
    ]);
    expect(names['fixer/a1']).toBe('fixer · Explore');
  });

  it('counts streamed output once, and only new cost from a cumulative total', () => {
    const { log, sink } = recorder();
    const tap = createClaudeAgentTap(sink);
    tap(init);
    tap({ type: 'stream_event', event: { type: 'message_start' } });
    tap({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'abcdefgh' } } });
    // The completed block arrives too: not counted again.
    tap(assistant([{ type: 'text', text: 'abcdefgh' }]));
    tap({ type: 'result', is_error: true, total_cost_usd: 0.25 });
    tap({ type: 'result', is_error: false, total_cost_usd: 0.4 });
    expect(log).toEqual([
      'claude-agent:start',
      'claude-agent:start',
      'claude-agent:tokens(2)',
      'claude-agent:error',
      'claude-agent:finish',
      'claude-agent:cost(0.25)',
      'claude-agent:finish',
      'claude-agent:cost(0.15)',
    ]);
  });

  it('passes messages through, finishing a run that stops early or throws', async () => {
    const { log, sink } = recorder();
    const seen: string[] = [];
    for await (const m of trackClaudeAgent(sink, from([init, assistant([{ type: 'text', text: 'hi' }])]), { agentId: 'x' })) {
      seen.push(m.type);
      break;
    }
    expect(seen).toEqual(['system']);
    expect(log).toEqual(['x:start', 'x:finish']);
    const failed = recorder();
    await expect(async () => {
      for await (const _ of trackClaudeAgent(failed.sink, from([init], new Error('boom')), { agentId: 'y' })) void _;
    }).rejects.toThrow('boom');
    expect(failed.log).toEqual(['y:start', 'y:error', 'y:finish']);
  });
});

const ev = (e: OpenAiAgentsEvent) => e;

describe('OpenAI Agents SDK', () => {
  it('maps model output, tools, approvals and a handoff', async () => {
    const { log, names, sink } = recorder();
    const events = [
      ev({ type: 'agent_updated_stream_event', agent: { name: 'Triage' } }),
      ev({ type: 'raw_model_stream_event', data: { type: 'response_started' } }),
      ev({ type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: 'abcd' } }),
      ev({ type: 'run_item_stream_event', name: 'tool_called', item: { rawItem: { callId: 'c1', name: 'lookup' } } }),
      ev({ type: 'run_item_stream_event', name: 'tool_output', item: { rawItem: { callId: 'c1' } } }),
      ev({ type: 'run_item_stream_event', name: 'tool_approval_requested', item: { rawItem: { callId: 'c2', name: 'refund' } } }),
      ev({ type: 'agent_updated_stream_event', agent: { name: 'Billing' } }),
      ev({ type: 'raw_model_stream_event', data: { type: 'response_started' } }),
    ];
    for await (const _ of trackOpenAiAgentsRun(sink, from(events), { agentId: 'support' })) void _;
    expect(log).toEqual([
      'support:start',
      'support:tokens(1)',
      'support:tool-start(lookup)',
      'support:tool-end(lookup)',
      'support:attention(needs-you,needs your approval for refund)',
      'support:finish',
      'support/Billing:start',
      'support/Billing:finish',
    ]);
    expect(names['support/Billing']).toBe('support · Billing');
  });

  it('reports a run that throws on the agent that was running', async () => {
    const { log, sink } = recorder();
    const tap = createOpenAiAgentsTap(sink);
    tap(ev({ type: 'raw_model_stream_event', data: { type: 'response_started' } }));
    expect(tap.current()).toBe('openai-agent');
    await expect(async () => {
      for await (const _ of trackOpenAiAgentsRun(sink, from([], new Error('quota')))) void _;
    }).rejects.toThrow('quota');
    expect(log).toEqual(['openai-agent:start', 'openai-agent:error', 'openai-agent:finish']);
  });
});

describe('attention from the AI SDK and AG-UI adapters', () => {
  it('AI SDK: a tool waiting for approval needs you; bad tool input is an error', () => {
    const { log, sink } = recorder();
    const tap = createAiSdkTap(sink, 'w');
    tap({ type: 'tool-call', toolCallId: 'c', toolName: 'deploy' });
    tap({ type: 'tool-approval-request', toolCall: { toolCallId: 'c', toolName: 'deploy' } });
    tap({ type: 'tool-input-error', toolCallId: 'd', toolName: 'search' });
    expect(log).toEqual(['w:tool-start(deploy)', 'w:attention(needs-you,needs your approval for deploy)', 'w:error']);
  });

  it('useChat: a part awaiting approval needs you', () => {
    const { log, sink } = recorder();
    const track = createChatTracker(sink, 'chat');
    track([], 'ready');
    track([{ id: 'u', role: 'user', parts: [] }], 'submitted');
    track([{ id: 'm', role: 'assistant', parts: [{ type: 'tool-deploy', toolCallId: 'c', state: 'approval-requested' }] }], 'streaming');
    expect(log).toContain('chat:attention(needs-you,needs your approval for deploy)');
  });

  it('AG-UI: a run interrupted for input needs you', () => {
    const { log, sink } = recorder();
    const tap = createAgUiTap(sink, 'r');
    tap({ type: 'RUN_STARTED' });
    tap({ type: 'RUN_FINISHED', outcome: { type: 'interrupt' } });
    tap({ type: 'RUN_STARTED' });
    tap({ type: 'RUN_FINISHED', outcome: { type: 'success' } });
    expect(log).toEqual(['r:start', 'r:finish', 'r:attention(needs-you,is waiting for your input)', 'r:start', 'r:finish']);
  });
});

describe('runs that end while something is still open', () => {
  it('AI SDK: an approval still needs you after the run finishes', () => {
    const { log, sink } = recorder();
    const tap = createAiSdkTap(sink, 'w');
    tap({ type: 'start' });
    tap({ type: 'tool-call', toolCallId: 'c', toolName: 'deploy' });
    tap({ type: 'tool-approval-request', toolCall: { toolCallId: 'c', toolName: 'deploy' } });
    tap({ type: 'finish' });
    expect(log.slice(-2)).toEqual(['w:finish', 'w:attention(needs-you,needs your approval for deploy)']);
    // Answered in the next request: nothing more to ask.
    tap({ type: 'start' });
    tap({ type: 'tool-result', toolCallId: 'c', toolName: 'deploy' });
    tap({ type: 'finish' });
    expect(log.slice(-1)).toEqual(['w:finish']);
  });

  it('OpenAI Agents: an approval still needs you after the run ends; hosted tools close', async () => {
    const { log, sink } = recorder();
    const events = [
      ev({ type: 'raw_model_stream_event', data: { type: 'response_started' } }),
      ev({ type: 'run_item_stream_event', name: 'tool_called', item: { rawItem: { name: 'web_search' } } }),
      ev({ type: 'raw_model_stream_event', data: { type: 'response_started' } }),
      ev({ type: 'run_item_stream_event', name: 'tool_approval_requested', item: { rawItem: { callId: 'c', name: 'refund' } } }),
    ];
    for await (const _ of trackOpenAiAgentsRun(sink, from(events))) void _;
    expect(log).toEqual([
      'openai-agent:start',
      'openai-agent:tool-start(web_search)',
      'openai-agent:tool-end(web_search)',
      'openai-agent:start',
      'openai-agent:attention(needs-you,needs your approval for refund)',
      'openai-agent:finish',
      'openai-agent:attention(needs-you,needs your approval for refund)',
    ]);
  });

  it('Claude Agent SDK: subagents still open end with the run, errors are reported once', async () => {
    const { log, sink } = recorder();
    const tap = createClaudeAgentTap(sink, { agentId: 'f' });
    tap(init);
    tap(assistant([{ type: 'tool_use', id: 'a1', name: 'Agent', input: { subagent_type: 'Plan' } }]));
    tap({ type: 'result', subtype: 'error_max_turns', is_error: true, total_cost_usd: 0 });
    expect(log).toEqual(['f:start', 'f:tool-start(Agent)', 'f/a1:start', 'f/a1:finish', 'f:error', 'f:finish']);
    const after = recorder();
    await expect(async () => {
      for await (const _ of trackClaudeAgent(after.sink, from([init, { type: 'result', is_error: false } as ClaudeAgentMessage], new Error('late')), {
        agentId: 'g',
      }))
        void _;
    }).rejects.toThrow('late');
    expect(after.log).toEqual(['g:start', 'g:finish']);
  });
});

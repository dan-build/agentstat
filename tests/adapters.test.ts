// AI SDK and AG-UI adapters: protocol parts/events → AgentStat events.
import { describe, it, expect } from 'vitest';
import { createAiSdkTap, createChatTracker, tapAiSdkStream, type ChatMessage } from '../src/ai-sdk';
import { createAgUiTap } from '../src/ag-ui';
import type { AgentEvent } from '../src/types';

const sink = () => {
  const got: [string, AgentEvent][] = [];
  return { got, push: (id: string, e: AgentEvent) => got.push([id, e]), types: () => got.map(([, e]) => e.type) };
};

describe('createAiSdkTap', () => {
  it('maps a fullStream with a tool step', () => {
    const s = sink();
    const tap = createAiSdkTap(s, 'w');
    for (const p of [
      { type: 'start' },
      { type: 'start-step' },
      { type: 'text-delta', text: 'Looking it up' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'search' },
      { type: 'tool-result', toolCallId: 'c1' },
      { type: 'finish-step' },
      { type: 'start-step' },
      { type: 'reasoning-delta', text: 'hmm' },
      { type: 'text-delta', text: 'Found it.' },
      { type: 'finish' },
    ])
      tap(p);
    // One request: `start` opens it (TTFT from here); later steps continue it.
    expect(s.types()).toEqual(['start', 'tokens', 'tool-start', 'tool-end', 'tokens', 'tokens', 'finish']);
    expect(s.got[1][1]).toEqual({ type: 'tokens', count: 13 / 4 });
    expect(s.got[3][1]).toEqual({ type: 'tool-end', name: 'search', error: false });
    expect(s.got.every(([id]) => id === 'w')).toBe(true);
  });

  it('maps UI message stream chunks (delta, tool output states)', () => {
    const s = sink();
    const tap = createAiSdkTap(s, 'w', { countTokens: () => 1 });
    tap({ type: 'start-step' });
    tap({ type: 'text-delta', delta: 'hi' });
    tap({ type: 'tool-input-delta', inputTextDelta: '{"q":' });
    tap({ type: 'tool-input-available', toolCallId: 'c', toolName: 'fetch' });
    tap({ type: 'tool-output-error', toolCallId: 'c' });
    tap({ type: 'abort' });
    expect(s.got.map(([, e]) => e)).toEqual([
      { type: 'start' },
      { type: 'tokens', count: 1 },
      { type: 'tokens', count: 1 },
      { type: 'tool-start', name: 'fetch' },
      { type: 'tool-end', name: 'fetch', error: true },
      { type: 'finish' },
    ]);
  });

  it('starts at start-step for streams without a start part', () => {
    const s = sink();
    const tap = createAiSdkTap(s, 'w');
    tap({ type: 'start-step' });
    tap({ type: 'start-step' });
    tap({ type: 'finish' });
    tap({ type: 'start-step' });
    expect(s.types()).toEqual(['start', 'finish', 'start']);
  });

  it('keeps waiting through preliminary tool results', () => {
    const s = sink();
    const tap = createAiSdkTap(s, 'w');
    tap({ type: 'tool-call', toolCallId: 'c', toolName: 'crawl' });
    tap({ type: 'tool-result', toolCallId: 'c', preliminary: true });
    tap({ type: 'tool-result', toolCallId: 'c', preliminary: true });
    tap({ type: 'tool-result', toolCallId: 'c' });
    expect(s.types()).toEqual(['tool-start', 'tool-end']);
  });

  it('ignores unknown and malformed parts', () => {
    const s = sink();
    const tap = createAiSdkTap(s, 'w');
    tap({ type: 'source' });
    tap({ type: 'text-delta', text: '' });
    tap(null as never);
    expect(s.got).toEqual([]);
  });

  it('tapAiSdkStream reports a stream that throws, then rethrows', async () => {
    const s = sink();
    async function* parts() {
      yield { type: 'start-step' };
      throw new Error('network');
    }
    await expect(tapAiSdkStream(s, 'w', parts())).rejects.toThrow('network');
    expect(s.types()).toEqual(['start', 'error', 'finish']);
  });

  it('tapAiSdkStream finishes a stream that ends on an error part', async () => {
    const s = sink();
    async function* parts() {
      yield { type: 'start' };
      yield { type: 'tool-call', toolCallId: 'c', toolName: 't' };
      yield { type: 'error' };
    }
    await tapAiSdkStream(s, 'w', parts());
    expect(s.types()).toEqual(['start', 'tool-start', 'error', 'finish']);
  });
});

describe('createChatTracker', () => {
  const msg = (parts: ChatMessage['parts'], id = 'm1'): ChatMessage[] => [
    { id: 'u', role: 'user', parts: [{ type: 'text', text: 'q' }] },
    { id, role: 'assistant', parts },
  ];

  it('pushes lifecycle, text deltas and tool calls in stream order', () => {
    const s = sink();
    const track = createChatTracker(s, 'chat', { countTokens: (t) => t.length });
    track([], 'ready'); // initial state: nothing to report
    track(msg([]).slice(0, 1), 'submitted');
    track(msg([{ type: 'text', text: 'Let me ' }]), 'streaming');
    track(
      msg([
        { type: 'text', text: 'Let me check' },
        { type: 'tool-search', toolCallId: 'c1', state: 'input-available' },
      ]),
      'streaming'
    );
    track(
      msg([
        { type: 'text', text: 'Let me check' },
        { type: 'tool-search', toolCallId: 'c1', state: 'output-available' },
        { type: 'text', text: 'Done' },
      ]),
      'ready'
    );
    expect(s.got.map(([, e]) => e)).toEqual([
      { type: 'start' },
      { type: 'tokens', count: 7 },
      { type: 'tokens', count: 5 }, // 'check' before the tool call
      { type: 'tool-start', name: 'search' },
      { type: 'tool-end', name: 'search', error: false },
      { type: 'tokens', count: 4 },
      { type: 'finish' }, // after the last tokens
    ]);
  });

  it('opens and closes a tool call that finished between two updates', () => {
    const s = sink();
    const track = createChatTracker(s, 'chat');
    track([], 'submitted');
    s.got.length = 0;
    track(msg([{ type: 'dynamic-tool', toolName: 'run', toolCallId: 'c', state: 'input-streaming' }]), 'streaming');
    track(msg([{ type: 'dynamic-tool', toolName: 'run', toolCallId: 'c', state: 'output-error' }]), 'streaming');
    expect(s.got.map(([, e]) => e)).toEqual([
      { type: 'tool-start', name: 'run' },
      { type: 'tool-end', name: 'run', error: true },
    ]);
  });

  it('does not report history present on the first call or replaced while idle', () => {
    const s = sink();
    const track = createChatTracker(s, 'chat');
    const saved = msg([
      { type: 'text', text: 'x'.repeat(4000) },
      { type: 'tool-search', toolCallId: 'c', state: 'output-available' },
    ]);
    track(saved, 'ready');
    track(msg([{ type: 'text', text: 'other' }], 'm9'), 'ready'); // setMessages
    expect(s.got).toEqual([]);
    track(msg([{ type: 'text', text: 'other' }], 'm9'), 'submitted');
    expect(s.types()).toEqual(['start']);
  });

  it('keeps waiting on a frontend tool after the request ends, until its result', () => {
    const s = sink();
    const track = createChatTracker(s, 'chat');
    track([], 'ready');
    track(msg([]).slice(0, 1), 'submitted');
    const ask = (state: string) => msg([{ type: 'tool-askUser', toolCallId: 'c', state }]);
    track(ask('input-available'), 'streaming');
    track(ask('input-available'), 'ready'); // request over, tool pending
    expect(s.types()).toEqual(['start', 'tool-start']);
    track(ask('output-available'), 'ready'); // the person answered
    expect(s.types()).toEqual(['start', 'tool-start', 'tool-end', 'finish']);
  });

  it('treats a preliminary result as still running', () => {
    const s = sink();
    const track = createChatTracker(s, 'chat');
    track([], 'ready');
    track(msg([]).slice(0, 1), 'submitted');
    const part = (state: string, preliminary?: boolean) => msg([{ type: 'tool-crawl', toolCallId: 'c', state, preliminary }]);
    track(part('input-available'), 'streaming');
    track(part('output-available', true), 'streaming');
    track(part('output-available'), 'streaming');
    expect(s.types()).toEqual(['start', 'tool-start', 'tool-end']);
  });

  it('continues from regenerated text after a step is reset', () => {
    const s = sink();
    const track = createChatTracker(s, 'chat', { countTokens: (t) => t.length });
    track([], 'ready');
    track(msg([]).slice(0, 1), 'submitted');
    track(msg([{ type: 'text', text: 'abcdef' }]), 'streaming');
    track(msg([{ type: 'text', text: 'ab' }]), 'streaming'); // reset-step
    track(msg([{ type: 'text', text: 'abXYZ' }]), 'streaming');
    expect(s.got.map(([, e]) => e)).toEqual([
      { type: 'start' },
      { type: 'tokens', count: 6 },
      { type: 'tokens', count: 3 },
    ]);
  });

  it('counts an error and finishes; is idempotent for repeated calls', () => {
    const s = sink();
    const track = createChatTracker(s, 'chat');
    track([], 'ready');
    track([], 'submitted');
    track([], 'error');
    track([], 'error');
    expect(s.types()).toEqual(['start', 'error', 'finish']);
  });
});

describe('createAgUiTap', () => {
  it('maps a run with reasoning, a backend tool and a result', () => {
    const s = sink();
    const tap = createAgUiTap(s, 'r', { countTokens: () => 1 });
    for (const e of [
      { type: 'RUN_STARTED' },
      { type: 'REASONING_MESSAGE_CONTENT', delta: 'think' },
      { type: 'TEXT_MESSAGE_START' },
      { type: 'TEXT_MESSAGE_CONTENT', delta: 'Hi' },
      { type: 'TOOL_CALL_START', toolCallId: 't', toolCallName: 'lookup' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 't', delta: '{}' },
      { type: 'TOOL_CALL_END', toolCallId: 't' },
      { type: 'TOOL_CALL_RESULT', toolCallId: 't' },
      { type: 'STATE_SNAPSHOT' },
      { type: 'RUN_FINISHED' },
    ])
      tap(e);
    expect(s.got.map(([, e]) => e)).toEqual([
      { type: 'start' },
      { type: 'tokens', count: 1 },
      { type: 'tokens', count: 1 },
      { type: 'tokens', count: 1 },
      { type: 'tool-start', name: 'lookup' },
      { type: 'tool-end', name: 'lookup' },
      { type: 'finish' },
    ]);
  });

  it('leaves nested runs and subagent events to their own agents', () => {
    const s = sink();
    const tap = createAgUiTap(s, 'o', { countTokens: () => 1 });
    for (const e of [
      { type: 'RUN_STARTED' },
      { type: 'TOOL_CALL_START', toolCallId: 'd', toolCallName: 'delegate' },
      { type: 'TOOL_CALL_END', toolCallId: 'd' },
      { type: 'RUN_STARTED', parentRunId: 'o' },
      { type: 'TEXT_MESSAGE_CONTENT', delta: 'child' },
      { type: 'RUN_FINISHED' },
      { type: 'TEXT_MESSAGE_CONTENT', delta: 'sub', subagentRunId: 's1' },
      { type: 'SUBAGENT_ERROR' },
      { type: 'TOOL_CALL_RESULT', toolCallId: 'd' },
      { type: 'RUN_FINISHED' },
    ])
      tap(e);
    expect(s.got.map(([, e]) => e)).toEqual([
      { type: 'start' },
      { type: 'tool-start', name: 'delegate' },
      { type: 'error' },
      { type: 'tool-end', name: 'delegate' },
      { type: 'finish' },
    ]);
  });

  it('does not count a stopped run as an error', () => {
    const s = sink();
    const tap = createAgUiTap(s, 'r');
    tap({ type: 'RUN_STARTED' });
    tap({ type: 'RUN_ERROR', code: 'abort' });
    expect(s.types()).toEqual(['start', 'finish']);
  });

  it('reports a run error and ends the run', () => {
    const s = sink();
    const tap = createAgUiTap(s, 'r');
    tap({ type: 'RUN_STARTED' });
    tap({ type: 'RUN_ERROR' });
    expect(s.types()).toEqual(['start', 'error', 'finish']);
  });
});

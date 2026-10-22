// createAgentStream / useAgentStream and <AgentStat source>.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { StrictMode, createRef } from 'react';
import AgentStat, { createAgent, type AgentStatRef } from '../src/AgentStat';
import { createAgentStream, type AgentStreamMessage } from '../src/stream';

const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const legendNames = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('.agentstat-legend button[aria-pressed]')).map((b) => b.textContent?.trim());

describe('createAgentStream', () => {
  it('replays kept history to a late subscriber, descriptions first, with event times', () => {
    const s = createAgentStream();
    s.push('a', { type: 'start', time: 100 });
    s.push('a', { type: 'tokens', count: 3 });
    s.describe('a', { name: 'Alpha' });
    const got: AgentStreamMessage[] = [];
    s.subscribe((m) => got.push(m));
    expect(got.map((m) => m.type)).toEqual(['agent', 'event', 'event']);
    expect(got[1]).toMatchObject({ type: 'event', event: { type: 'start', time: 100 } });
    expect(got[2].type === 'event' && typeof got[2].event.time).toBe('number');
  });

  it('delivers only messages after `after`, then live ones', () => {
    const s = createAgentStream();
    s.push('a', { type: 'start' });
    s.push('a', { type: 'finish' });
    const got: number[] = [];
    const off = s.subscribe((m) => got.push(m.seq), 1);
    s.push('a', { type: 'start' });
    off();
    s.push('a', { type: 'finish' });
    expect(got).toEqual([2, 3]);
  });

  it('forgets a removed agent, so later subscribers do not re-add it', () => {
    const s = createAgentStream();
    s.push('a', { type: 'start' });
    s.describe('a', { name: 'A' });
    s.push('b', { type: 'start' });
    s.remove('a');
    const ids: string[] = [];
    s.subscribe((m) => m.type !== 'remove' && ids.push(m.id));
    expect(ids).toEqual(['b']);
  });

  it('drops history older than five minutes', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const s = createAgentStream();
    s.push('a', { type: 'start' });
    now = 301_000;
    s.push('a', { type: 'finish' });
    const got: string[] = [];
    s.subscribe((m) => m.type === 'event' && got.push(m.event.type));
    expect(got).toEqual(['finish']);
    vi.restoreAllMocks();
  });
});

describe('<AgentStat source>', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('adds agents from events pushed before and after mount, after the prop agents', async () => {
    const s = createAgentStream();
    s.push('w1', { type: 'tokens', count: 4 });
    s.describe('w1', { name: 'Worker 1' });
    const { container } = render(<AgentStat agents={[createAgent('lead', 'Lead')]} source={s} />);
    await tick(10);
    act(() => s.push('w2', { type: 'start' }));
    await tick(10);
    expect(legendNames(container)).toEqual(['Lead', 'Worker 1', 'w2']);
    act(() => s.remove('w2'));
    await tick(10);
    expect(legendNames(container)).toEqual(['Lead', 'Worker 1']);
  });

  it('applies history once under StrictMode', async () => {
    const s = createAgentStream();
    s.push('a', { type: 'tokens', count: 10 });
    const ref = createRef<AgentStatRef>();
    render(
      <StrictMode>
        <AgentStat ref={ref} source={s} />
      </StrictMode>
    );
    await tick(10);
    act(() => s.push('a', { type: 'tokens', count: 5 }));
    expect(ref.current!.getStats('a')!.totalTokens).toBe(15);
  });

  it('feeds events for a prop agent into it, keeping replayed times', async () => {
    const s = createAgentStream();
    const t0 = performance.now();
    s.push('lead', { type: 'start', time: t0 });
    s.push('lead', { type: 'tokens', count: 8, time: t0 + 500 });
    await tick(5_000); // the chart mounts later
    const ref = createRef<AgentStatRef>();
    render(<AgentStat ref={ref} agents={[createAgent('lead', 'Lead')]} source={s} />);
    await tick(10);
    const stats = ref.current!.getStats('lead')!;
    expect(stats.totalTokens).toBe(8);
    expect(stats.ttftMs).toBe(500); // not squashed into the mount time
  });

  it('removes the previous source’s agents when the source changes', async () => {
    const a = createAgentStream();
    const b = createAgentStream();
    a.push('x', { type: 'start' });
    b.push('y', { type: 'start' });
    const { container, rerender } = render(<AgentStat source={a} />);
    await tick(10);
    expect(legendNames(container)).toEqual(['x']);
    rerender(<AgentStat source={b} />);
    await tick(10);
    expect(legendNames(container)).toEqual(['y']);
  });

  it('keeps source agents when the agents prop changes', async () => {
    const s = createAgentStream();
    s.push('w', { type: 'start' });
    const { container, rerender } = render(<AgentStat agents={[createAgent('a', 'A')]} source={s} />);
    await tick(10);
    rerender(<AgentStat agents={[createAgent('b', 'B')]} source={s} />);
    await tick(10);
    expect(legendNames(container)).toEqual(['B', 'w']);
  });
});

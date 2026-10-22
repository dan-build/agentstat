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
  it('replays kept history to a late subscriber in order, with event times', () => {
    const s = createAgentStream();
    const t = performance.now();
    s.push('a', { type: 'start', time: t - 100 });
    s.push('a', { type: 'tokens', count: 3 });
    s.describe('a', { name: 'Alpha' });
    const got: AgentStreamMessage[] = [];
    s.subscribe((m) => got.push(m));
    expect(got.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(got[0]).toMatchObject({ type: 'event', event: { type: 'start', time: t - 100 } });
    expect(got[1].type === 'event' && typeof got[1].event.time).toBe('number');
  });

  it('caps future times at now and warns once about another clock', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = createAgentStream();
    s.push('clk', { type: 'start', time: Date.now() });
    s.push('clk', { type: 'finish', time: Date.now() });
    const times: number[] = [];
    s.subscribe((m) => m.type === 'event' && times.push(m.event.time as number));
    expect(Math.max(...times)).toBeLessThanOrEqual(performance.now());
    expect(warn).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('keeps delivering to other subscribers when one throws', () => {
    vi.useFakeTimers();
    const s = createAgentStream();
    const got: number[] = [];
    s.subscribe(() => {
      throw new Error('boom');
    });
    s.subscribe((m) => got.push(m.seq));
    expect(() => s.push('a', { type: 'start' })).not.toThrow();
    expect(got).toEqual([1]);
    expect(() => vi.runAllTimers()).toThrow('boom'); // reported, not swallowed
    vi.useRealTimers();
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

  it('drops history older than five minutes, past descriptions and while idle', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const s = createAgentStream();
    s.describe('a', { name: 'A' });
    s.push('a', { type: 'start' });
    s.remove('gone');
    now = 301_000;
    s.push('a', { type: 'finish' });
    const got: string[] = [];
    s.subscribe((m) => got.push(m.type === 'event' ? m.event.type : m.type));
    expect(got).toEqual(['agent', 'finish']); // the description outlives its message
    // A stream that went quiet: nothing old is replayed an hour later.
    now = 4_000_000;
    const late: string[] = [];
    s.subscribe((m) => late.push(m.type));
    expect(late).toEqual([]); // nothing kept for 'a' but its description: gone
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

  it('applies history once under StrictMode, with a description sent before mount', async () => {
    const s = createAgentStream();
    s.push('a', { type: 'tokens', count: 10 });
    s.describe('a', { name: 'A' });
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
    s.push('lead', { type: 'start' });
    await tick(500);
    s.push('lead', { type: 'tokens', count: 8 });
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

  it('does not double-count prop agents when the source changes back or is recreated', async () => {
    const a = createAgentStream();
    const b = createAgentStream();
    a.push('lead', { type: 'tokens', count: 8 });
    const ref = createRef<AgentStatRef>();
    const agents = [createAgent('lead', 'Lead')];
    const { rerender } = render(<AgentStat ref={ref} agents={agents} source={a} />);
    await tick(10);
    rerender(<AgentStat ref={ref} agents={agents} source={b} />);
    await tick(10);
    expect(ref.current!.getStats('lead')!.totalTokens).toBe(0);
    rerender(<AgentStat ref={ref} agents={agents} source={a} />);
    await tick(10);
    expect(ref.current!.getStats('lead')!.totalTokens).toBe(8);
    // An inline wrapper is a new source on every render: replayed, not added up.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 3; i++) {
      rerender(<AgentStat ref={ref} agents={agents} source={{ subscribe: a.subscribe }} />);
      await tick(10);
    }
    expect(ref.current!.getStats('lead')!.totalTokens).toBe(8);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('changed 3 times'));
    warn.mockRestore();
  });

  it('resets a stream agent the prop took over when the source changes', async () => {
    const a = createAgentStream();
    a.push('w', { type: 'tokens', count: 8 });
    const ref = createRef<AgentStatRef>();
    const { rerender } = render(<AgentStat ref={ref} source={a} />);
    await tick(10);
    const agents = [createAgent('w', 'W')]; // roster loads after mount
    rerender(<AgentStat ref={ref} agents={agents} source={a} />);
    await tick(10);
    rerender(<AgentStat ref={ref} agents={agents} source={createAgentStream()} />);
    await tick(10);
    expect(ref.current!.getStats('w')!.totalTokens).toBe(0);
    rerender(<AgentStat ref={ref} agents={agents} source={a} />);
    await tick(10);
    expect(ref.current!.getStats('w')!.totalTokens).toBe(8);
  });

  it('removes source agents when the source is taken away', async () => {
    const a = createAgentStream();
    a.push('x', { type: 'start' });
    const { container, rerender } = render(<AgentStat source={a} />);
    await tick(10);
    rerender(<AgentStat />);
    await tick(10);
    expect(legendNames(container)).toEqual([]);
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

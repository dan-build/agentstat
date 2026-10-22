// Progress is unknown until an agent reports it: 'auto' plots token rate
// until then, and an unknown progress is never drawn as 0%.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import { AgentStore } from '../src/core/store';
import { computeView, primaryBuffer } from '../src/core/view';
import AgentStat, { createAgent, type AgentStatRef } from '../src/AgentStat';
import { Tooltip } from '../src/ui/Tooltip';
import type { Agent, ChartMetric } from '../src/types';

const T0 = 10_000;
const view = (store: AgentStore, metric: ChartMetric) =>
  computeView(store, { metric, windowSeconds: undefined, tokenAxisMax: undefined }, T0 + 1_000, 800, 400);

describe('known progress', () => {
  it("createAgent's 0 is unknown; a starting value above 0 or any report is known", () => {
    const withStart: Agent = { ...createAgent('b', 'B'), current: { tokensRate: 0, progress: 40, status: 'active' } };
    const store = new AgentStore([createAgent('a', 'A'), withStart], { maxHistoryPoints: 1000 }, T0);
    expect(store.progressKnown.has('a')).toBe(false);
    expect(store.progressKnown.has('b')).toBe(true);
    store.ingest('a', { progress: 0 }, T0 + 100); // a reported 0% is known
    expect(store.progressKnown.has('a')).toBe(true);
  });

  it("'auto' plots progress only once every visible agent reports it", () => {
    const store = new AgentStore([createAgent('a', 'A'), createAgent('b', 'B')], { maxHistoryPoints: 1000 }, T0);
    store.ingest('a', { tokensRate: 20 }, T0 + 100);
    expect(view(store, 'auto').metric).toBe('tokens');
    store.ingest('b', { progress: 10 }, T0 + 200);
    expect(view(store, 'auto').metric).toBe('tokens'); // a mixed fleet keeps every line
    store.toggleVisible('a'); // hidden agents don't decide it
    expect(view(store, 'auto').metric).toBe('progress');
    store.ingest('a', { progress: 5 }, T0 + 300);
    store.toggleVisible('a');
    expect(view(store, 'auto').metric).toBe('progress');
    expect(view(store, 'both').metric).toBe('both');
  });

  it('records no progress before the first report (no flat 0% history)', () => {
    const store = new AgentStore([createAgent('a', 'A')], { maxHistoryPoints: 1000 }, T0);
    for (let i = 1; i <= 50; i++) store.ingest('a', { tokensRate: 20 }, T0 + i * 100);
    expect(store.progress.get('a')!.length).toBe(0);
    store.ingest('a', { progress: 40 }, T0 + 5_100);
    expect(store.progress.get('a')!.values()).toEqual([40]);
    expect(store.tokens.get('a')!.length).toBe(52);
  });

  it('draws no progress line for an agent whose progress is unknown', () => {
    const store = new AgentStore([createAgent('a', 'A'), createAgent('b', 'B')], { maxHistoryPoints: 1000 }, T0);
    store.ingest('b', { progress: 10 }, T0 + 200);
    const v = view(store, 'progress');
    expect(primaryBuffer(store, 'a', v)).toBeUndefined();
    expect(primaryBuffer(store, 'b', v)).toBeDefined();
    expect(primaryBuffer(store, 'a', view(store, 'tokens'))).toBeDefined();
  });

  it('shows unknown progress as – in the tooltip', () => {
    const point = { time: 0, tokensRate: 12, progress: 0, status: 'active' as const };
    const base = { agentId: 'a', ageMs: 0, name: 'A', color: '#000', point, x: 0, y: 0 };
    const { container, rerender } = render(<Tooltip hover={{ ...base, progressKnown: false }} innerRef={null} />);
    expect(container.textContent).toContain('· – ·');
    rerender(<Tooltip hover={{ ...base, progressKnown: true }} innerRef={null} />);
    expect(container.textContent).toContain('0%');
  });
});

describe('unknown progress in the component', () => {
  const tick = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400, toJSON: () => ({}),
    } as DOMRect);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keyboard inspection skips agents without a line', async () => {
    const ref = createRef<AgentStatRef>();
    const agents = [createAgent('a', 'A'), createAgent('b', 'B'), createAgent('c', 'C')];
    const { container } = render(<AgentStat ref={ref} agents={agents} metric="progress" />);
    for (let i = 0; i < 10; i++) {
      act(() => {
        ref.current!.updateAgent('a', { progress: i, tokensRate: 5 });
        ref.current!.updateAgent('b', { tokensRate: 5 }); // never reports progress
        ref.current!.updateAgent('c', { progress: i * 2, tokensRate: 5 });
      });
      await tick(100);
    }
    const canvas = container.querySelector('canvas')!;
    const names = () => container.querySelector('[role="tooltip"], .agentstat-tooltip')?.textContent ?? '';
    fireEvent.keyDown(canvas, { key: 'End' });
    await tick(50);
    expect(names()).toContain('A');
    fireEvent.keyDown(canvas, { key: 'ArrowDown' });
    await tick(50);
    expect(names()).toContain('C'); // B has no line: skipped, not stuck
    expect(ref.current!.getLiveMetrics('b')!.progressKnown).toBe(false);
    expect(ref.current!.getLiveMetrics('a')!.progressKnown).toBe(true);
  });
});

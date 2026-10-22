// Progress is unknown until an agent reports it: 'auto' plots token rate
// until then, and an unknown progress is never drawn as 0%.
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { AgentStore } from '../src/core/store';
import { computeView, primaryBuffer } from '../src/core/view';
import { createAgent } from '../src/AgentStat';
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

  it("'auto' plots token rate until a visible agent reports progress", () => {
    const store = new AgentStore([createAgent('a', 'A'), createAgent('b', 'B')], { maxHistoryPoints: 1000 }, T0);
    store.ingest('a', { tokensRate: 20 }, T0 + 100);
    expect(view(store, 'auto').metric).toBe('tokens');
    store.ingest('b', { progress: 10 }, T0 + 200);
    expect(view(store, 'auto').metric).toBe('progress');
    store.toggleVisible('b'); // hidden agents don't decide it
    expect(view(store, 'auto').metric).toBe('tokens');
    expect(view(store, 'both').metric).toBe('both');
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

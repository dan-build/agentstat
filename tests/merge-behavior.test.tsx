import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { createRef } from 'react';
import AgentStat, { type Agent, type AgentStatRef } from '../src/AgentStat';

const makeAgent = (id: string, tokensRate = 15): Agent => ({
  id,
  name: `Agent ${id}`,
  color: '#000000',
  data: [],
  visible: true,
  config: { expectedTokensPerSec: [10, 20] },
  current: { tokensRate, progress: 0, status: 'active' },
});

// Advance time past the 500ms health-sync interval inside AgentStat,
// flushing any pending React effects triggered by setInterval.
async function advancePastHealthSync() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600);
  });
}

describe('initialAgents merge behavior (FIX 4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves updateAgent state when the agents array reference changes but the id list does not', async () => {
    const ref = createRef<AgentStatRef>();
    const { rerender } = render(
      <AgentStat
        ref={ref}
        agents={[makeAgent('a'), makeAgent('b')]}
        simulateData={false}
      />
    );

    // Push agent 'a' far outside the expected token range via updateAgent.
    // This should tank its tokenEfficiency in the subsequent health sync.
    act(() => {
      ref.current?.updateAgent('a', 100, 50, 'active');
    });
    await advancePastHealthSync();

    const healthBefore = ref.current?.getHealth('a');
    expect(healthBefore).toBeDefined();
    expect(healthBefore!.tokenEfficiency).toBeLessThan(50);

    // Force a re-render with a FRESH array literal containing the same ids.
    // Pre-FIX-4, this would blow away agentsRef.current and the subsequent
    // health sync would read the initial tokensRate (15), producing efficiency=100.
    rerender(
      <AgentStat
        ref={ref}
        agents={[makeAgent('a'), makeAgent('b')]}
        simulateData={false}
      />
    );
    await advancePastHealthSync();

    const healthAfter = ref.current?.getHealth('a');
    expect(healthAfter).toBeDefined();
    expect(healthAfter!.tokenEfficiency).toBe(healthBefore!.tokenEfficiency);
  });

  it('prunes health cache state for removed agent ids', async () => {
    const ref = createRef<AgentStatRef>();
    const { rerender } = render(
      <AgentStat
        ref={ref}
        agents={[makeAgent('a'), makeAgent('b'), makeAgent('c')]}
        simulateData={false}
      />
    );

    // Update 'b' out-of-range so its health cache gets a non-default score,
    // giving us something observable to prune.
    act(() => {
      ref.current?.updateAgent('b', 100, 50, 'active');
    });
    await advancePastHealthSync();
    expect(ref.current?.getHealth('b')).toBeDefined();

    // Remove 'b' from the roster.
    rerender(
      <AgentStat
        ref={ref}
        agents={[makeAgent('a'), makeAgent('c')]}
        simulateData={false}
      />
    );
    await advancePastHealthSync();

    // The removed id should no longer have an entry in the health cache.
    expect(ref.current?.getHealth('b')).toBeUndefined();
  });

  it('mounts a newly added agent without disturbing existing agents', async () => {
    const ref = createRef<AgentStatRef>();
    const { rerender } = render(
      <AgentStat
        ref={ref}
        agents={[makeAgent('a')]}
        simulateData={false}
      />
    );

    act(() => {
      ref.current?.updateAgent('a', 100, 50, 'active');
    });
    await advancePastHealthSync();
    const healthA = ref.current?.getHealth('a');
    expect(healthA).toBeDefined();

    // Add a brand-new agent 'b'.
    rerender(
      <AgentStat
        ref={ref}
        agents={[makeAgent('a'), makeAgent('b')]}
        simulateData={false}
      />
    );
    await advancePastHealthSync();

    // 'a' state preserved.
    expect(ref.current?.getHealth('a')?.tokenEfficiency).toBe(healthA!.tokenEfficiency);
    // 'b' now present with its own fresh health entry.
    expect(ref.current?.getHealth('b')).toBeDefined();
  });
});

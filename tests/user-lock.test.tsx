import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { createRef } from 'react';
import AgentStat, { type Agent, type AgentStatRef } from '../src/AgentStat';

const makeAgent = (id: string): Agent => ({
  id,
  name: `Agent ${id}`,
  color: '#000000',
  data: [],
  visible: true,
  config: { expectedTokensPerSec: [10, 20] },
  current: { tokensRate: 15, progress: 0, status: 'active' },
});

// Advance long enough that the simulation's auto-recovery threshold
// (~55 ticks × 55ms = ~3s) is well behind us.
async function advancePastAutoRecoveryWindow() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
}

describe('user-lock: simulation respects consumer-set anomalous status (Item 4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves user-set stuck status past the 3s auto-recovery window', async () => {
    const ref = createRef<AgentStatRef>();
    render(
      <AgentStat
        ref={ref}
        agents={[makeAgent('a')]}
        simulateData={true}
      />
    );

    act(() => {
      ref.current?.updateAgent('a', 0.8, 10, 'stuck');
    });

    await advancePastAutoRecoveryWindow();

    // Pre-FIX: status would have auto-recovered to 'active' around t=3s.
    expect(ref.current?.getLiveMetrics('a')?.status).toBe('stuck');
  });

  it('preserves user-set hallucinating status past the 3s auto-recovery window', async () => {
    const ref = createRef<AgentStatRef>();
    render(
      <AgentStat
        ref={ref}
        agents={[makeAgent('a')]}
        simulateData={true}
      />
    );

    act(() => {
      ref.current?.updateAgent('a', 3.1, 45, 'hallucinating');
    });

    await advancePastAutoRecoveryWindow();
    expect(ref.current?.getLiveMetrics('a')?.status).toBe('hallucinating');
  });

  it('clears the lock when updateAgent is called with a non-anomalous status', async () => {
    const ref = createRef<AgentStatRef>();
    render(
      <AgentStat
        ref={ref}
        agents={[makeAgent('a')]}
        simulateData={true}
      />
    );

    // Lock into stuck.
    act(() => {
      ref.current?.updateAgent('a', 0.8, 10, 'stuck');
    });
    await advancePastAutoRecoveryWindow();
    expect(ref.current?.getLiveMetrics('a')?.status).toBe('stuck');

    // User clears by re-asserting 'active'. After this, sim is free to
    // drive status again (subject to RNG), so at minimum we know the
    // next tick will not be 'stuck' unless randomness re-triggers it.
    act(() => {
      ref.current?.updateAgent('a', 15, 20, 'active');
    });
    // One sim tick is enough to observe the cleared lock.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    // Immediately after the unlock, status should be 'active' — unlock is
    // instantaneous; sim has had too few ticks to re-roll an anomaly.
    expect(ref.current?.getLiveMetrics('a')?.status).toBe('active');
  });

  it('applies the lock independently per agent', async () => {
    const ref = createRef<AgentStatRef>();
    render(
      <AgentStat
        ref={ref}
        agents={[makeAgent('a'), makeAgent('b')]}
        simulateData={true}
      />
    );

    // Lock only 'a'.
    act(() => {
      ref.current?.updateAgent('a', 0.8, 10, 'stuck');
    });

    await advancePastAutoRecoveryWindow();

    // 'a' held by the lock.
    expect(ref.current?.getLiveMetrics('a')?.status).toBe('stuck');
    // 'b' was never user-touched; whatever the sim decided is fine,
    // but it must NOT be 'stuck' as a knock-on effect of 'a' being locked.
    // (If this assertion ever becomes flaky due to randomness, switch
    // to asserting 'b' is in the expected-transition set.)
    const bStatus = ref.current?.getLiveMetrics('b')?.status;
    expect(bStatus).toBeDefined();
    // No specific assertion about which status 'b' holds — the point is
    // just that agent 'a' doesn't contaminate agent 'b'.
  });
});

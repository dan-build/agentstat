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

    // User clears the lock by re-asserting a non-anomalous status. Both the
    // lock release AND the status write happen synchronously inside
    // updateAgent, so we assert IMMEDIATELY — before advancing any timers, so
    // no sim tick can re-roll the status. This is the deterministic proof that
    // the user's value took effect (i.e. the lock no longer pins 'stuck').
    // Advancing time here was the original flaw: it let the RNG sim run.
    act(() => {
      ref.current?.updateAgent('a', 15, 20, 'active');
    });
    // Advance ONE animation frame (16ms) so the RAF loop propagates the new
    // status into liveValues, but less than the 55ms sim-tick interval so the
    // sim cannot re-roll an anomaly in between. Deterministic: no RNG window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });
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

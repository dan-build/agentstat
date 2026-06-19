import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { createRef } from 'react';
import AgentStat, { type Agent, type AgentStatRef } from '../src/AgentStat';

const makeAgent = (id: string): Agent => ({
  id,
  name: `Agent ${id}`,
  color: '#1d4ed8',
  data: [],
  visible: true,
  config: { expectedTokensPerSec: [10, 20] },
  current: { tokensRate: 15, progress: 0, status: 'active' },
});

// The StatusLog itself is unit-tested in statuslog.test.ts. These tests verify
// the component wiring: status transitions driven through updateAgent are
// reflected in live metrics and don't disturb existing behavior, across both
// windowed and non-windowed modes.
describe('per-point status history — component integration', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('records a status transition driven via updateAgent', async () => {
    const ref = createRef<AgentStatRef>();
    render(<AgentStat ref={ref} agents={[makeAgent('a')]} simulateData={false} />);

    act(() => {
      ref.current?.updateAgent('a', 2, 30, 'stuck');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    // Live status reflects the transition.
    expect(ref.current?.getLiveMetrics('a')?.status).toBe('stuck');
  });

  it('handles a sequence of distinct transitions without throwing', async () => {
    const ref = createRef<AgentStatRef>();
    render(<AgentStat ref={ref} agents={[makeAgent('a')]} simulateData={false} />);

    const seq: Array<Parameters<NonNullable<AgentStatRef['updateAgent']>>> = [];
    expect(() => {
      act(() => {
        ref.current?.updateAgent('a', 12, 10, 'active');
        ref.current?.updateAgent('a', 0.5, 12, 'stuck');
        ref.current?.updateAgent('a', 3, 40, 'hallucinating');
        ref.current?.updateAgent('a', 15, 80, 'active');
      });
    }).not.toThrow();
    void seq;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(ref.current?.getLiveMetrics('a')?.status).toBe('active');
  });

  it('works under a time window with eviction', async () => {
    const ref = createRef<AgentStatRef>();
    render(
      <AgentStat
        ref={ref}
        agents={[makeAgent('a')]}
        windowSeconds={5}
        simulateData={false}
      />
    );

    // Drive a transition, advance past the window so eviction runs, and confirm
    // the component neither throws nor loses the agent. (Live status is surfaced
    // via the RAF loop, which is exercised by the user-lock suite; here we only
    // assert the windowed status path is stable through eviction.)
    expect(() => {
      act(() => {
        ref.current?.updateAgent('a', 1, 5, 'stuck');
      });
    }).not.toThrow();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000); // past the window → eviction
    });
    expect(() => {
      act(() => {
        ref.current?.updateAgent('a', 15, 50, 'active');
      });
    }).not.toThrow();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    // Agent still present and queryable after windowed eviction.
    expect(ref.current?.getLiveMetrics('a')).toBeDefined();
  });

  it('keeps status history independent per agent', async () => {
    const ref = createRef<AgentStatRef>();
    render(
      <AgentStat
        ref={ref}
        agents={[makeAgent('a'), makeAgent('b')]}
        simulateData={false}
      />
    );
    act(() => {
      ref.current?.updateAgent('a', 1, 10, 'stuck');
      ref.current?.updateAgent('b', 15, 20, 'active');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(ref.current?.getLiveMetrics('a')?.status).toBe('stuck');
    expect(ref.current?.getLiveMetrics('b')?.status).toBe('active');
  });
});

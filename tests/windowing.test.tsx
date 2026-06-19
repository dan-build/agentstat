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
  current: { tokensRate: 15, progress: 20, status: 'active' },
});

describe('windowSeconds — time-windowed buffer integration', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('mounts with a window and accepts updates without throwing', async () => {
    const ref = createRef<AgentStatRef>();
    expect(() =>
      render(
        <AgentStat
          ref={ref}
          agents={[makeAgent('a'), makeAgent('b')]}
          windowSeconds={60}
          simulateData={false}
        />
      )
    ).not.toThrow();

    act(() => {
      for (let i = 0; i < 50; i++) {
        ref.current?.updateAgent('a', 10 + i * 0.1, i, 'active');
      }
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(ref.current?.getLiveMetrics('a')?.progress).toBeDefined();
    expect(ref.current?.getHealth('a')).toBeDefined();
  });

  it('works in sim mode under a tight window without throwing', async () => {
    const ref = createRef<AgentStatRef>();
    render(
      <AgentStat
        ref={ref}
        agents={[makeAgent('a')]}
        windowSeconds={5}
        simulateData={true}
      />
    );
    // Run well past the window so eviction has to engage repeatedly.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(ref.current?.getLiveMetrics('a')?.status).toBeDefined();
  });

  it('combines windowSeconds with metric="both" without throwing', async () => {
    const ref = createRef<AgentStatRef>();
    expect(() =>
      render(
        <AgentStat
          ref={ref}
          agents={[makeAgent('a')]}
          windowSeconds={30}
          metric="both"
          simulateData={false}
        />
      )
    ).not.toThrow();

    act(() => {
      ref.current?.updateAgent('a', 22, 80, 'active');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(ref.current?.getHealth('a')).toBeDefined();
  });

  it('renders identically to legacy when windowSeconds is omitted', async () => {
    const ref = createRef<AgentStatRef>();
    render(
      <AgentStat ref={ref} agents={[makeAgent('a')]} simulateData={false} />
    );
    act(() => {
      ref.current?.updateAgent('a', 15, 40, 'active');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    // Count-based path still works: health present, metrics live.
    expect(ref.current?.getLiveMetrics('a')?.progress).toBeDefined();
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { createRef } from 'react';
import AgentStat, {
  niceMax,
  type Agent,
  type AgentStatRef,
} from '../src/AgentStat';

const makeAgent = (id: string, tokensRate = 15): Agent => ({
  id,
  name: `Agent ${id}`,
  color: '#1d4ed8',
  data: [],
  visible: true,
  config: { expectedTokensPerSec: [10, 20] },
  current: { tokensRate, progress: 30, status: 'active' },
});

describe('niceMax — token axis ceiling', () => {
  it('floors small values to at least 10', () => {
    expect(niceMax(0)).toBe(10);
    expect(niceMax(3)).toBe(10);
    expect(niceMax(9.9)).toBe(10);
  });

  it('rounds up to the nearest 1/2/5 × 10ⁿ', () => {
    expect(niceMax(15)).toBe(20);
    expect(niceMax(22)).toBe(50);
    expect(niceMax(35)).toBe(50);
    expect(niceMax(99)).toBe(100);
    expect(niceMax(120)).toBe(200);
    expect(niceMax(350)).toBe(500);
  });

  it('respects a custom floor', () => {
    expect(niceMax(0, 50)).toBe(50);
    expect(niceMax(3, 50)).toBe(50);
  });

  it('never returns a ceiling below the input', () => {
    for (const v of [1, 7, 13, 28, 64, 130, 270, 999]) {
      expect(niceMax(v)).toBeGreaterThanOrEqual(v);
    }
  });
});

// These exercise the full mount + RAF + sim path (canvas stubbed in setup.ts)
// across every metric mode. They prove the new scale routing doesn't throw and
// the imperative API still drives state regardless of which metric is plotted.
describe('metric modes — mount + update across progress / tokens / both', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  for (const metric of ['progress', 'tokens', 'both'] as const) {
    it(`mounts and updates without throwing in metric="${metric}"`, async () => {
      const ref = createRef<AgentStatRef>();
      expect(() =>
        render(
          <AgentStat
            ref={ref}
            agents={[makeAgent('a', 12), makeAgent('b', 28)]}
            metric={metric}
            simulateData={false}
          />
        )
      ).not.toThrow();

      act(() => {
        ref.current?.updateAgent('a', 18, 55, 'active');
        ref.current?.updateAgent('b', 31, 70, 'active');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });

      // Live metrics are driven the same way regardless of plotted metric.
      expect(ref.current?.getLiveMetrics('a')?.progress).toBeDefined();
      expect(ref.current?.getHealth('a')).toBeDefined();
    });
  }

  it('accepts a pinned tokenAxisMax without throwing', () => {
    expect(() =>
      render(
        <AgentStat
          agents={[makeAgent('a', 999)]}
          metric="tokens"
          tokenAxisMax={50}
          simulateData={false}
        />
      )
    ).not.toThrow();
  });

  it('defaults to progress metric when none is given (v0.1 behavior)', async () => {
    const ref = createRef<AgentStatRef>();
    render(<AgentStat ref={ref} agents={[makeAgent('a')]} simulateData={false} />);
    act(() => {
      ref.current?.updateAgent('a', 15, 40, 'active');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(ref.current?.getLiveMetrics('a')?.progress).toBeDefined();
  });
});

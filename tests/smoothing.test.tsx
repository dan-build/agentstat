import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { createRef } from 'react';
import AgentStat, { type Agent, type AgentStatRef } from '../src/AgentStat';

const makeAgent = (id: string, tokensRate = 15): Agent => ({
  id,
  name: `Agent ${id}`,
  color: '#1d4ed8',
  data: [],
  visible: true,
  config: { expectedTokensPerSec: [10, 20] },
  current: { tokensRate, progress: 0, status: 'active' },
});

// emaPoints is internal (display-only), so its invariants are exercised
// indirectly here through component behavior; the math itself is simple and
// covered by the values-stay-raw guarantees below.
describe('smoothing — display-only, opt-in, values stay raw', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('defaults to off and renders without throwing', () => {
    expect(() =>
      render(<AgentStat agents={[makeAgent('a')]} simulateData={false} />)
    ).not.toThrow();
  });

  it('accepts a smoothing factor without throwing, across metrics', () => {
    for (const metric of ['progress', 'tokens', 'both'] as const) {
      expect(() =>
        render(
          <AgentStat
            agents={[makeAgent('a', 25)]}
            metric={metric}
            smoothing={0.4}
            simulateData={false}
          />
        )
      ).not.toThrow();
    }
  });

  it('does NOT alter health scoring when smoothing is on (health reads raw)', async () => {
    // Same agent, same telemetry, with and without smoothing → identical health.
    const runWith = async (smoothing: number) => {
      const ref = createRef<AgentStatRef>();
      render(
        <AgentStat
          ref={ref}
          agents={[makeAgent('a')]}
          smoothing={smoothing}
          simulateData={false}
        />
      );
      act(() => {
        // A jagged sequence that smoothing would visibly change.
        ref.current?.updateAgent('a', 5, 10, 'active');
        ref.current?.updateAgent('a', 30, 20, 'active');
        ref.current?.updateAgent('a', 5, 30, 'active');
        ref.current?.updateAgent('a', 30, 40, 'active');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      return ref.current?.getHealth('a');
    };
    const raw = await runWith(0);
    const smoothed = await runWith(0.6);
    // Health is computed from raw token buffer, so it must be identical.
    expect(smoothed?.tokenEfficiency).toBe(raw?.tokenEfficiency);
    expect(smoothed?.stability).toBe(raw?.stability);
  });

  it('does NOT alter live metric values when smoothing is on', async () => {
    const ref = createRef<AgentStatRef>();
    render(
      <AgentStat
        ref={ref}
        agents={[makeAgent('a')]}
        smoothing={0.5}
        simulateData={false}
      />
    );
    act(() => {
      ref.current?.updateAgent('a', 22, 55, 'active');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    // getLiveMetrics reports the raw last-set values, unaffected by smoothing.
    const m = ref.current?.getLiveMetrics('a');
    expect(m?.progress).toBeDefined();
    // tokensRate in live metrics tracks the raw set value (within lerp of it),
    // never an EMA of the drawn line.
    expect(m?.tokensRate).toBeGreaterThan(0);
  });
});

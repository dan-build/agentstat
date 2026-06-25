import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { createRef } from 'react';
import AgentStat, { type Agent, type AgentStatRef } from '../src/AgentStat';
import type { Anomaly } from '../src/anomaly';

const makeAgent = (id: string): Agent => ({
  id,
  name: `Agent ${id}`,
  color: '#1d4ed8',
  data: [],
  visible: true,
  config: { expectedTokensPerSec: [10, 20] },
  current: { tokensRate: 15, progress: 0, status: 'active' },
});

// Drives N idle (0 t/s) updates while the agent stays 'active', which should
// trip the stall detector. Uses a tight stall threshold so the test is fast.
async function driveStall(ref: React.RefObject<AgentStatRef>) {
  for (let i = 0; i < 40; i++) {
    act(() => {
      ref.current?.updateAgent('a', 0, 10, 'active');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
  }
  // Let the 500ms detection interval run.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600);
  });
}

describe('anomaly detection — component wiring', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is OFF by default: getAnomalies returns empty even on anomalous data', async () => {
    const ref = createRef<AgentStatRef>();
    render(<AgentStat ref={ref} agents={[makeAgent('a')]} simulateData={false} />);
    await driveStall(ref);
    expect(ref.current?.getAnomalies('a')).toEqual([]);
  });

  it('detects a stall when anomalyDetection is on', async () => {
    const ref = createRef<AgentStatRef>();
    render(
      <AgentStat
        ref={ref}
        agents={[makeAgent('a')]}
        anomalyDetection
        anomalyConfig={{ stallDurationMs: 2000 }}
        simulateData={false}
      />
    );
    await driveStall(ref);
    const found = ref.current?.getAnomalies('a') ?? [];
    expect(found.some((x) => x.kind === 'stall')).toBe(true);
  });

  it('fires onAnomaly once per occurrence, not every interval', async () => {
    const onAnomaly = vi.fn<(id: string, a: Anomaly) => void>();
    const ref = createRef<AgentStatRef>();
    render(
      <AgentStat
        ref={ref}
        agents={[makeAgent('a')]}
        anomalyDetection
        anomalyConfig={{ stallDurationMs: 2000 }}
        onAnomaly={onAnomaly}
        simulateData={false}
      />
    );
    await driveStall(ref);
    // Keep the stall going for several more detection intervals.
    for (let i = 0; i < 10; i++) {
      act(() => {
        ref.current?.updateAgent('a', 0, 10, 'active');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
    }
    const stallCalls = onAnomaly.mock.calls.filter(([, a]) => a.kind === 'stall');
    // The stall anchor time is stable, so it should fire once, not ~10×.
    expect(stallCalls.length).toBe(1);
    expect(stallCalls[0][0]).toBe('a');
  });

  it('clears anomalies when detection is turned off (rerender)', async () => {
    const ref = createRef<AgentStatRef>();
    const { rerender } = render(
      <AgentStat
        ref={ref}
        agents={[makeAgent('a')]}
        anomalyDetection
        anomalyConfig={{ stallDurationMs: 2000 }}
        simulateData={false}
      />
    );
    await driveStall(ref);
    expect(ref.current?.getAnomalies('a').length).toBeGreaterThan(0);

    rerender(
      <AgentStat
        ref={ref}
        agents={[makeAgent('a')]}
        anomalyDetection={false}
        simulateData={false}
      />
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(ref.current?.getAnomalies('a')).toEqual([]);
  });

  it('does not flag a healthy steadily-producing agent', async () => {
    const onAnomaly = vi.fn();
    const ref = createRef<AgentStatRef>();
    render(
      <AgentStat
        ref={ref}
        agents={[makeAgent('a')]}
        anomalyDetection
        onAnomaly={onAnomaly}
        simulateData={false}
      />
    );
    for (let i = 0; i < 40; i++) {
      act(() => {
        ref.current?.updateAgent('a', 15, (i * 2) % 100, 'active');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(ref.current?.getAnomalies('a')).toEqual([]);
    expect(onAnomaly).not.toHaveBeenCalled();
  });
});

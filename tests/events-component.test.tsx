// The `push` / `getStats` ref API through the component.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { createRef } from 'react';
import AgentStat, { createAgent, type AgentStatRef } from '../src/AgentStat';

const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe('ref.push', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('derives status and stats from events and shows waiting in the panel', async () => {
    const ref = createRef<AgentStatRef>();
    const agents = [createAgent('c', 'Coder')];
    const { container } = render(<AgentStat ref={ref} agents={agents} panel="always" />);
    act(() => {
      ref.current!.push('c', { type: 'start' });
      ref.current!.push('c', { type: 'tokens', count: 12 });
      ref.current!.push('c', { type: 'tool-start', name: 'bash' });
    });
    expect(ref.current!.getStats('c')).toMatchObject({ totalTokens: 12, tool: 'bash' });
    expect(ref.current!.getStats('nope')).toBeUndefined();
    await tick(600);
    expect(ref.current!.getLiveMetrics('c')!.status).toBe('waiting');
    expect(container.querySelector('.agentstat-panel')!.textContent).toContain('Waiting');
  });
});

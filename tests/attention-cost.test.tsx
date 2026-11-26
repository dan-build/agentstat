// Attention (an agent needs you, finished, failed…) and cost, end to end:
// from a stream or the local service's SSE wire to the hook and components.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { createAgentStream, connectSse, createSseHandler } from '../src/sse';
import { useAgentTelemetry, AgentRoster, AgentStatusBadge, type AgentTelemetry, type TelemetryOptions } from '../src/telemetry';
import { formatCost } from '../src/format';

const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

function Probe({ source, onValue, ...opts }: { source?: Parameters<typeof useAgentTelemetry>[0]; onValue: (a: AgentTelemetry[]) => void } & TelemetryOptions) {
  onValue(useAgentTelemetry(source, opts));
  return null;
}

describe('attention', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('marks an agent as needing you until it does anything after asking', async () => {
    const s = createAgentStream();
    const onAttention = vi.fn();
    let agents: AgentTelemetry[] = [];
    render(<Probe source={s} onAttention={onAttention} onValue={(a) => (agents = a)} />);
    act(() => {
      s.push('a', { type: 'tool-start', name: 'Bash' });
      s.attention('a', { reason: 'needs-you', message: 'needs your permission for Bash', app: 'com.apple.Terminal' });
    });
    await tick(3_000);
    expect(agents[0].needsYou).toMatchObject({ message: 'needs your permission for Bash', app: 'com.apple.Terminal' });
    expect(agents[0].needsYou!.sinceMs).toBeGreaterThanOrEqual(2_500);
    expect(onAttention).toHaveBeenCalledTimes(1);
    expect(onAttention.mock.calls[0][0]).toBe('a');
    expect(onAttention.mock.calls[0][1]).toMatchObject({ reason: 'needs-you', message: 'needs your permission for Bash' });
    // A notice that isn't "needs you" fires, but marks nothing.
    act(() => s.attention('a', { reason: 'done', message: 'finished after 4m 12s' }));
    await tick(600);
    expect(onAttention).toHaveBeenCalledTimes(2);
    expect(agents[0].needsYou).not.toBeNull();
    // Answered: the tool runs on.
    act(() => s.push('a', { type: 'tool-end', name: 'Bash' }));
    await tick(600);
    expect(agents[0].needsYou).toBeNull();
    // The agent is still there: attention never removes it.
    expect(agents.map((x) => x.id)).toEqual(['a']);
  });

  it('does not call back for old attention replayed on connect', async () => {
    const s = createAgentStream();
    s.push('a', { type: 'start' });
    s.attention('a', { reason: 'failed', message: 'turn ended with an error', time: performance.now() - 60_000 });
    const onAttention = vi.fn();
    render(<Probe source={s} onAttention={onAttention} onValue={() => {}} />);
    await tick(600);
    expect(onAttention).not.toHaveBeenCalled();
  });

  it('shows "Needs you" in the badge, with the reason for screen readers', () => {
    const a: AgentTelemetry = {
      id: 'a', name: 'api', status: 'waiting', statusMs: 9_000, tool: 'Bash', tokensRate: 0, totalTokens: 10,
      ttftMs: null, health: null, perCall: true, anomalies: [], costUsd: 0,
      needsYou: { message: 'needs your permission for Bash', sinceMs: 9_000 }, history: [],
    };
    const { container } = render(<AgentStatusBadge agent={a} />);
    expect(container.textContent).toContain('Needs you');
    expect(container.textContent).toContain('needs your permission for Bash');
    expect(container.querySelector('[data-tone="warning"]')).not.toBeNull();
  });
});

describe('cost', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('adds up without changing status, and shows a cost column', async () => {
    const s = createAgentStream();
    let agents: AgentTelemetry[] = [];
    render(<Probe source={s} onValue={(x) => (agents = x)} />);
    act(() => {
      s.push('a', { type: 'start' });
      s.push('a', { type: 'tokens', count: 50 });
      s.push('a', { type: 'finish' });
      s.push('a', { type: 'cost', usd: 0.0125 });
      s.push('a', { type: 'cost', usd: 0.02 });
      s.push('a', { type: 'cost', usd: Number.NaN });
      s.push('b', { type: 'start' });
    });
    await tick(600);
    const a = agents.find((x) => x.id === 'a')!;
    expect(a.costUsd).toBeCloseTo(0.0325);
    expect(a.status).toBe('complete');
    const { container, rerender } = render(<AgentRoster agents={agents} />);
    expect([...container.querySelectorAll('thead th')].map((th) => th.textContent)).toContain('Cost');
    expect(container.textContent).toContain('$0.03');
    // Nobody reports cost: no column.
    rerender(<AgentRoster agents={agents.map((x) => ({ ...x, costUsd: 0 }))} />);
    expect([...container.querySelectorAll('thead th')].map((th) => th.textContent)).not.toContain('Cost');
  });

  it('never brings back an agent that is gone', async () => {
    const s = createAgentStream();
    let agents: AgentTelemetry[] = [];
    render(<Probe source={s} onValue={(x) => (agents = x)} />);
    act(() => {
      s.push('a', { type: 'start' });
      s.remove('a');
      s.push('a', { type: 'cost', usd: 0.5 });
      s.push('ghost', { type: 'cost', usd: 0.5 });
    });
    await tick(600);
    expect(agents).toEqual([]);
  });

  it('formats dollars for the size of the amount', () => {
    expect([formatCost(0.0042), formatCost(0.42), formatCost(12.3), formatCost(1204.4)]).toEqual(['$0.0042', '$0.42', '$12.30', '$1,204']);
  });
});

describe('attention over SSE', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('carries attention and cost from a handler to connectSse', async () => {
    const delivered: { onmessage: ((e: { data: string; lastEventId: string }) => void) | null }[] = [];
    vi.stubGlobal(
      'EventSource',
      class {
        onmessage: ((e: { data: string; lastEventId: string }) => void) | null = null;
        onerror = null;
        readyState = 1;
        constructor() {
          delivered.push(this);
        }
        close() {}
      }
    );
    const server = createAgentStream();
    server.push('a', { type: 'start' });
    server.attention('a', { reason: 'needs-you', message: 'has a question for you' });
    server.push('a', { type: 'cost', usd: 0.5 });
    const res = await createSseHandler(server)(new Request('http://x/'));
    const reader = res.body!.getReader();
    let text = '';
    for (let i = 0; i < 4; i++) text += new TextDecoder().decode((await reader.read()).value);
    const frames = text.split('\n\n').filter((b) => b.includes('data: '));
    const wire = frames.map((b) => JSON.parse(b.split('data: ')[1]));
    expect(wire[1].m).toMatchObject({ type: 'attention', reason: 'needs-you', message: 'has a question for you' });
    expect(wire[1].age).toBeGreaterThanOrEqual(0);

    const client = connectSse('http://x/');
    const got: string[] = [];
    client.subscribe((m) => got.push(m.type === 'attention' ? `attention:${m.reason}` : m.type === 'event' ? m.event.type : m.type));
    for (const b of frames) {
      const id = b.split('\n').find((l) => l.startsWith('id: '))!.slice(4);
      delivered[0].onmessage!({ data: b.split('data: ')[1], lastEventId: id });
    }
    expect(got).toEqual(['start', 'attention:needs-you', 'cost']);
    await reader.cancel().catch(() => {});
  });
});

// useAgentTelemetry and the components built on it, fed by a stream.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { createAgentStream } from '../src/stream';
import {
  useAgentTelemetry,
  AgentStatusBadge,
  AnomalyBanner,
  AgentRoster,
  AgentTimeline,
  type AgentTelemetry,
} from '../src/telemetry';

const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** Renders the hook and exposes its latest value. */
function Probe({ source, onValue, ...opts }: { source: ReturnType<typeof createAgentStream>; onValue: (a: AgentTelemetry[]) => void; anomalyDetection?: boolean }) {
  onValue(useAgentTelemetry(source, opts));
  return null;
}

describe('useAgentTelemetry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reports each agent of the stream: status, tool, time in status, tokens, history', async () => {
    const s = createAgentStream();
    let agents: AgentTelemetry[] = [];
    render(<Probe source={s} onValue={(a) => (agents = a)} />);
    act(() => {
      s.push('coder', { type: 'start' });
      s.push('coder', { type: 'tokens', count: 40 });
      s.push('coder', { type: 'tool-start', name: 'bash' });
    });
    await tick(12_000);
    const c = agents.find((a) => a.id === 'coder')!;
    expect(c).toMatchObject({ status: 'waiting', tool: 'bash', totalTokens: 40 });
    expect(c.statusMs).toBeGreaterThanOrEqual(11_500);
    expect(c.history.map((h) => h.status)).toEqual(['complete', 'thinking', 'active', 'waiting']);
    expect(c.history[c.history.length - 1].toMs).toBe(0);
    expect(c.health).not.toBeNull();
  });

  it('detects anomalies (a stream that dies while active)', async () => {
    const s = createAgentStream();
    let agents: AgentTelemetry[] = [];
    render(<Probe source={s} onValue={(a) => (agents = a)} />);
    act(() => {
      s.push('a', { type: 'start' });
      for (let i = 0; i < 10; i++) s.push('a', { type: 'tokens', count: 5 });
    });
    await tick(12_000);
    expect(agents[0].anomalies.map((x) => x.kind)).toContain('stall');
  });
});

const agent = (over: Partial<AgentTelemetry> = {}): AgentTelemetry => ({
  id: 'c',
  name: 'Coder',
  status: 'waiting',
  statusMs: 12_400,
  tool: 'bash',
  tokensRate: 12.5,
  totalTokens: 1_234,
  ttftMs: 800,
  health: 91,
  anomalies: [],
  history: [
    { status: 'active', fromMs: 60_000, toMs: 12_400 },
    { status: 'waiting', fromMs: 12_400, toMs: 0 },
  ],
  ...over,
});

/** Text as read out (a component's <style> isn't). */
const text = (el: Element) =>
  [...el.childNodes].filter((n) => n.nodeName !== 'STYLE').map((n) => n.textContent).join('');

describe('components', () => {
  it('AgentStatusBadge: status, tool and time in words, tone from anomalies', () => {
    const { container, rerender } = render(<AgentStatusBadge agent={agent()} theme="light" />);
    const badge = container.querySelector('.agentstat-badge')!;
    expect(text(badge)).toBe('Waiting·bash·12s');
    expect(badge.getAttribute('data-tone')).toBeNull();
    const stall = { kind: 'stall' as const, severity: 'critical' as const, t: 0, message: 'stalled 30s while active', value: 0 };
    rerender(<AgentStatusBadge agent={agent({ status: 'active', tool: null, statusMs: 95_000, anomalies: [stall] })} theme="dark" />);
    expect(text(container.querySelector('.agentstat-badge')!)).toBe('Active·1m 35s');
    expect(container.querySelector('.agentstat-badge')!.getAttribute('data-tone')).toBe('critical');
    expect(container.querySelector('.agentstat-badge')!.getAttribute('data-theme')).toBe('dark');
  });

  it('AnomalyBanner: nothing without anomalies; alert for critical, status for warnings', () => {
    const { container, rerender } = render(<AnomalyBanner agents={[agent()]} />);
    expect(container.innerHTML).toBe('');
    const warn = { kind: 'spike' as const, severity: 'warning' as const, t: 0, message: 'runaway output 90/s', value: 90 };
    rerender(<AnomalyBanner agents={[agent({ anomalies: [warn] })]} />);
    expect(container.querySelector('[role="status"]')!.textContent).toContain('Coder');
    expect(container.textContent).toContain('warning: runaway output 90/s');
    rerender(<AnomalyBanner agents={[agent({ anomalies: [{ ...warn, severity: 'critical' }] })]} />);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('AgentRoster: a row per agent with tabular numbers', () => {
    const { container } = render(<AgentRoster agents={[agent(), agent({ id: 'r', name: 'Researcher', health: null })]} />);
    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('1,234');
    expect(rows[1].lastElementChild!.textContent).toBe('–');
    expect(container.querySelector('caption')!.textContent).toBe('Agents');
  });

  it('AgentTimeline: a segment per status, sized by time, listed for screen readers', () => {
    const { container } = render(<AgentTimeline agent={agent()} />);
    const segs = container.querySelectorAll<HTMLElement>('.agentstat-timeline span');
    expect([...segs].map((s) => s.dataset.s)).toEqual(['active', 'waiting']);
    expect(Number(segs[0].style.flexGrow)).toBeCloseTo(47.6 / 60, 2);
    expect(container.querySelector('ol')!.textContent).toContain('Active for 47s');
  });
});

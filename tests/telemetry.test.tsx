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
  type TelemetryOptions,
} from '../src/telemetry';
import { createAgent } from '../src/AgentStat';

const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** Renders the hook and exposes its latest value. */
function Probe({ source, onValue, ...opts }: { source?: ReturnType<typeof createAgentStream>; onValue: (a: AgentTelemetry[]) => void } & TelemetryOptions) {
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
    // Created idle and started at the same instant: no zero-length 'complete'.
    expect(c.history.map((h) => h.status)).toEqual(['waiting']);
    expect(c.history[c.history.length - 1].toMs).toBe(0);
    expect(c.health).not.toBeNull();
  });

  it('calls back once per anomaly; honours Infinity in the config; takes static agents', async () => {
    const s = createAgentStream();
    const onAnomaly = vi.fn();
    let agents: AgentTelemetry[] = [];
    const { rerender } = render(
      <Probe source={s} agents={[createAgent('fixed', 'Fixed')]} onAnomaly={onAnomaly} onValue={(a) => (agents = a)} />
    );
    act(() => {
      s.push('a', { type: 'start' });
      for (let i = 0; i < 10; i++) s.push('a', { type: 'tokens', count: 5 });
    });
    await tick(25_000);
    expect(agents.map((a) => a.id)).toEqual(['fixed', 'a']);
    expect(onAnomaly.mock.calls.filter(([id]) => id === 'a').map(([, an]) => an.severity)).toEqual(['warning', 'critical']);
    rerender(
      <Probe source={s} agents={[createAgent('fixed', 'Fixed')]} anomalyConfig={{ stallDurationMs: Infinity }} onValue={(a) => (agents = a)} />
    );
    await tick(6_000);
    expect(agents[1].anomalies).toEqual([]); // the rule is off, not on
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
    expect(text(container.querySelector('.agentstat-badge')!)).toBe('Active(critical)·1m 35s');
    expect(container.querySelector('.agentstat-badge')!.getAttribute('data-tone')).toBe('critical');
    expect(container.querySelector('.agentstat-badge')!.getAttribute('data-theme')).toBe('dark');
  });

  it('AnomalyBanner: announces each anomaly once (start, escalation, end), not as its text ticks', () => {
    const { container, rerender } = render(<AnomalyBanner agents={[agent()]} />);
    const status = () => container.querySelector('[role="status"]')!.textContent;
    const alert = () => container.querySelector('[role="alert"]')!.textContent;
    expect(container.querySelector('.agentstat-banner')).toBeNull(); // live regions only
    expect(status()).toBe('');
    const stall = (s: number, severity: 'warning' | 'critical' = 'warning') => ({
      kind: 'stall' as const, severity, t: 0, message: `stalled ${s}s while active`, value: 0,
    });
    rerender(<AnomalyBanner agents={[agent({ anomalies: [stall(10)] })]} />);
    expect(status()).toBe('Coder: stalled 10s while active.');
    expect(container.querySelector('.agentstat-banner')!.textContent).toContain('warning: stalled 10s');
    rerender(<AnomalyBanner agents={[agent({ anomalies: [stall(11)] })]} />);
    expect(status()).toBe('Coder: stalled 10s while active.'); // ticking text isn't re-announced
    rerender(<AnomalyBanner agents={[agent({ anomalies: [stall(20, 'critical')] })]} />);
    expect(alert()).toBe('Coder: stalled 20s while active.');
    rerender(<AnomalyBanner agents={[agent()]} />);
    expect(status()).toBe('Coder: stall resolved.');
    expect(container.querySelector('[role="status"].agentstat-banner, .agentstat-banner[role]')).toBeNull();
  });

  it('AgentRoster: a row per agent with tabular numbers', () => {
    const { container } = render(<AgentRoster agents={[agent(), agent({ id: 'r', name: 'Researcher', health: null })]} />);
    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('1,234');
    expect(rows[1].lastElementChild!.textContent).toBe('–');
    expect(rows[0].querySelector('th[scope="row"]')!.textContent).toBe('Coder');
    expect(container.querySelector('caption')!.textContent).toBe('Agents');
    expect(container.querySelectorAll('style')).toHaveLength(1); // not one per badge
  });

  it('AgentTimeline: a flapping history fits the bar, worst status shown, latest kept', () => {
    const history: AgentTelemetry['history'] = [{ status: 'active', fromMs: 300_000, toMs: 150_000 }];
    for (let i = 0; i < 300; i++) {
      const from = 150_000 - i * 500;
      history.push({ status: i % 2 ? 'stuck' : 'active', fromMs: from, toMs: from - 500 });
    }
    history.push({ status: 'waiting', fromMs: 0 + 0, toMs: 0 }); // filtered (zero length)
    history[history.length - 1] = { status: 'waiting', fromMs: 1, toMs: 0 };
    const { container } = render(<AgentTimeline agent={agent({ history })} />);
    const segs = [...container.querySelectorAll<HTMLElement>('.agentstat-timeline span')];
    expect(segs.length).toBeLessThanOrEqual(202);
    expect(segs[0].dataset.s).toBe('active'); // the long stretch keeps its own status
    expect(segs.slice(1, -1).every((s) => s.dataset.s === 'stuck')).toBe(true);
    expect(container.querySelector('.agentstat-timeline')!.hasAttribute('data-dense')).toBe(true);
  });

  it('AgentRoster: big numbers compact, full value on hover; focusable scroll region', () => {
    const { container } = render(<AgentRoster agents={[agent({ totalTokens: 98_765_432_109 })]} />);
    const cell = container.querySelectorAll('tbody td')[2] as HTMLElement;
    expect(cell.textContent).toMatch(/^98\.8B$/);
    expect(cell.title).toBe('98,765,432,109');
    const wrap = container.querySelector('[role="region"]')!;
    expect(wrap.getAttribute('aria-label')).toBe('Agents');
    expect(wrap.getAttribute('tabindex')).toBe('0');
  });

  it('AnomalyBanner: a repeated identical alert is announced again; the other region empties', () => {
    const stall = { kind: 'stall' as const, severity: 'critical' as const, t: 0, message: 'stalled 20s while active', value: 0 };
    const { container, rerender } = render(<AnomalyBanner agents={[agent({ anomalies: [stall] })]} />);
    const alert = () => container.querySelector('[role="alert"]')!.textContent;
    const first = alert();
    rerender(<AnomalyBanner agents={[agent()]} />);
    expect(alert()).toBe(''); // resolved: nothing stale left in the alert
    rerender(<AnomalyBanner agents={[agent({ anomalies: [stall] })]} />);
    expect(alert()).toBe(first); // '' → text again: a change, so it's read again
  });

  it('AgentTimeline: segments sized to the window (empty before the agent existed), listed for screen readers', () => {
    const { container } = render(<AgentTimeline agent={agent()} windowSeconds={120} />);
    const segs = container.querySelectorAll<HTMLElement>('.agentstat-timeline span');
    expect([...segs].map((s) => s.dataset.s ?? 'gap')).toEqual(['gap', 'active', 'waiting']);
    expect(Number(segs[0].style.flexGrow)).toBeCloseTo(60 / 120, 2);
    expect(Number(segs[1].style.flexGrow)).toBeCloseTo(47.6 / 120, 2);
    expect(container.querySelector('ol')!.getAttribute('aria-label')).toBe('Coder status history');
    expect(container.querySelector('ol')!.textContent).toContain('Active for 47s');
  });
});

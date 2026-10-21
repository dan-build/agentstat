// Layout behavior under constrained sizes and many agents.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import AgentStat, { createAgent } from '../src/AgentStat';
import { formatRate } from '../src/format';

const sizeTo = (width: number, height: number) =>
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height,
    toJSON: () => ({}),
  } as DOMRect);

const roster = (n: number) => Array.from({ length: n }, (_, i) => createAgent(`a${i}`, `Agent ${i + 1}`));

describe('layout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps the legend to one row and moves the rest into a "+N" menu', async () => {
    sizeTo(600, 400);
    render(<AgentStat agents={roster(24)} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    const more = screen.getByRole('button', { name: /more agents/ });
    const shown = screen.getAllByRole('button', { pressed: true });
    expect(shown.length).toBeLessThan(24);
    expect(more.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('group', { name: 'More agents' });
    expect(menu.querySelectorAll('button[aria-pressed]').length + shown.length).toBe(24);

    // Escape closes the menu and returns focus to its trigger.
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'More agents' })).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it('offers "Show all agents" when some are hidden', async () => {
    sizeTo(600, 400);
    render(<AgentStat agents={roster(12).map((a, i) => ({ ...a, visible: i % 2 === 0 }))} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    fireEvent.click(screen.getByRole('button', { name: /more agents/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Show all agents' }));
    const unpressedAgents = screen
      .queryAllByRole('button', { pressed: false })
      .filter((b) => b.textContent !== 'Pause');
    expect(unpressedAgents).toHaveLength(0);
  });

  it('hides the panel automatically on small charts, unless asked to always show it', async () => {
    sizeTo(360, 300);
    const { container, rerender } = render(<AgentStat agents={roster(3)} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(container.querySelector('.agentstat-panel')).toBeNull();
    rerender(<AgentStat agents={roster(3)} panel="always" />);
    expect(container.querySelector('.agentstat-panel')).not.toBeNull();
  });

  it('shows the panel on roomy charts and never when disabled', async () => {
    sizeTo(900, 500);
    const { container, rerender } = render(<AgentStat agents={roster(3)} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(container.querySelector('.agentstat-panel')).not.toBeNull();
    rerender(<AgentStat agents={roster(3)} panel="never" />);
    expect(container.querySelector('.agentstat-panel')).toBeNull();
  });

  it('lays the chart out left to right and isolates names for any script', () => {
    const { container } = render(<AgentStat agents={[createAgent('r', 'مخطط المهام')]} />);
    expect(container.querySelector('.agentstat')?.getAttribute('dir')).toBe('ltr');
    expect(container.querySelector('.agentstat-legend bdi')?.textContent).toBe('مخطط المهام');
  });
});

describe('formatRate', () => {
  it('drops decimals from 100 t/s', () => {
    expect(formatRate(14.84)).toMatch(/^14\.8/);
    expect(formatRate(4814.2)).toMatch(/^4,814/);
  });
});

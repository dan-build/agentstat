import { describe, it, expect } from 'vitest';
import * as pkg from '../src/index';

describe('public API surface', () => {
  it('exports AgentStat as a named export', () => {
    expect(pkg.AgentStat).toBeDefined();
    // forwardRef components are objects with $$typeof in React 18
    expect(typeof pkg.AgentStat).toBe('object');
  });

  it('exports the createAgent helper', () => {
    expect(typeof pkg.createAgent).toBe('function');
    const agent = pkg.createAgent('a', 'Agent A');
    expect(agent.id).toBe('a');
    expect(agent.name).toBe('Agent A');
    expect(agent.color).toBe('#111111');
    expect(agent.visible).toBe(true);
    expect(agent.current.status).toBe('active');
    expect(Array.isArray(agent.data)).toBe(true);
    expect(agent.data).toHaveLength(0);
  });

  it('accepts a custom color in createAgent', () => {
    const agent = pkg.createAgent('a', 'A', '#ff0000');
    expect(agent.color).toBe('#ff0000');
  });

  it('exports demoAgents as a 3-agent array', () => {
    expect(Array.isArray(pkg.demoAgents)).toBe(true);
    expect(pkg.demoAgents).toHaveLength(3);
    const ids = pkg.demoAgents.map((a) => a.id);
    expect(ids).toContain('researcher');
    expect(ids).toContain('critic');
    expect(ids).toContain('executor');
  });

  it('does not leak internal helpers through the package entry', () => {
    // calculateHealth is exported from AgentStat.tsx for test access
    // but intentionally NOT re-exported from the package entry.
    expect((pkg as Record<string, unknown>).calculateHealth).toBeUndefined();
  });
});

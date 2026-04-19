import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import AgentStat from '../src/AgentStat';

// Regression: v0.1.0 crashed with "Cannot read properties of undefined
// (reading 'filter')" when rendered without an `agents` prop — common
// during SSR streaming or while consumer data is still loading.
describe('robustness — missing or empty props', () => {
  it('renders without crashing when no agents prop is provided', () => {
    // @ts-expect-error — deliberately omitting required prop
    expect(() => render(<AgentStat />)).not.toThrow();
  });

  it('renders without crashing when agents is explicitly undefined', () => {
    // @ts-expect-error — deliberately passing undefined
    expect(() => render(<AgentStat agents={undefined} />)).not.toThrow();
  });

  it('renders without crashing when agents is an empty array', () => {
    expect(() => render(<AgentStat agents={[]} />)).not.toThrow();
  });

  it('renders without crashing when all agents have visible: false', () => {
    expect(() =>
      render(
        <AgentStat
          agents={[
            {
              id: 'a',
              name: 'A',
              color: '#000',
              data: [],
              current: { tokensRate: 0, progress: 0, status: 'active' },
              visible: false,
            },
          ]}
        />
      )
    ).not.toThrow();
  });
});

// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { AgentStat, demoAgents } from '../src/index';

describe('server rendering', () => {
  it('renders markup without touching window/document', () => {
    const html = renderToString(<AgentStat agents={demoAgents} simulateData theme="system" />);
    expect(html).toContain('agentstat-canvas');
    // The legend is present in the server markup (no layout shift on hydrate).
    expect(html).toContain('Researcher');
    expect(html).toContain('aria-pressed="true"');
  });
});

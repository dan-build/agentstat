// The AgentStat panel: the library's own components, fed by the extension.
// Messages arrive by postMessage (the panel has no network access) with times
// in Unix ms; the components work in the page's performance.now() clock.

import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AgentRoster,
  AgentTimeline,
  AnomalyBanner,
  createAgentStream,
  useAgentTelemetry,
  type AgentEvent,
  type AgentStream,
} from '../../../../src/index';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };
const vscode = acquireVsCodeApi();

type Theme = 'light' | 'dark';

/** VS Code's theme, from the classes it sets on <body> (high contrast too). */
function useEditorTheme(): Theme {
  const read = (): Theme =>
    document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light')
      ? 'light'
      : 'dark';
  const [theme, setTheme] = useState<Theme>(read);
  useEffect(() => {
    const mo = new MutationObserver(() => setTheme(read()));
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);
  return theme;
}

/** A Unix-ms time as performance.now() time (same machine, same moment). */
const local = (t: unknown) => (typeof t === 'number' ? performance.now() - (Date.now() - t) : undefined);

type Message =
  | { seq: number; type: 'event'; id: string; event: AgentEvent & { since?: number } }
  | { seq: number; type: 'agent'; id: string; name?: string; color?: string; config?: { expectedTokensPerSec?: [number, number] } }
  | { seq: number; type: 'remove'; id: string };

function apply(stream: AgentStream, m: Message) {
  if (m.type === 'event') {
    const e = { ...m.event, time: local(m.event.time) } as AgentEvent & { since?: number };
    if (e.type === 'tokens' && m.event.since !== undefined) e.since = local(m.event.since);
    stream.push(m.id, e);
  } else if (m.type === 'agent') {
    stream.describe(m.id, { name: m.name, color: m.color, config: m.config });
  } else {
    stream.remove(m.id);
  }
}

function App() {
  const theme = useEditorTheme();
  // Messages go to the current stream at once, even before a re-render.
  const current = useRef<AgentStream | null>(null);
  const [stream, setStream] = useState(() => (current.current = createAgentStream()));
  const [live, setLive] = useState(true);
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const msg = ev.data as { kind: string; m?: Message; live?: boolean };
      if (msg.kind === 'message' && msg.m && current.current) apply(current.current, msg.m);
      else if (msg.kind === 'reset') setStream((current.current = createAgentStream()));
      else if (msg.kind === 'state') setLive(!!msg.live);
    };
    window.addEventListener('message', onMessage);
    vscode.postMessage({ kind: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);
  const agents = useAgentTelemetry(stream);

  return (
    <main className="page">
      {!live && <p className="note">Reconnecting to the AgentStat service…</p>}
      {live && agents.length === 0 && (
        <div className="empty">
          <p className="title">No agents yet</p>
          <p className="note">
            In Claude Code, install the AgentStat plugin, or run <code>agentstat run -- claude</code>.
          </p>
        </div>
      )}
      {agents.length > 0 && (
        <>
          <AnomalyBanner agents={agents} theme={theme} />
          <AgentRoster agents={agents} theme={theme} />
          <section className="timelines" aria-label="Status over the last 5 minutes">
            <h2>Last 5 minutes</h2>
            {agents.map((a) => (
              <div className="timeline" key={a.id}>
                <span className="name" title={a.name}>
                  {a.name}
                </span>
                <AgentTimeline agent={a} theme={theme} windowSeconds={300} />
              </div>
            ))}
          </section>
        </>
      )}
    </main>
  );
}

const style = document.createElement('style');
style.textContent = `
  body { margin: 0; padding: 0; background: var(--vscode-editor-background); color: var(--vscode-foreground);
    font-family: var(--vscode-font-family); font-size: 13px; }
  .page { max-width: 880px; margin: 0 auto; padding: 24px 24px 40px; display: flex; flex-direction: column; gap: 24px; }
  .note { color: var(--vscode-descriptionForeground); margin: 0; }
  .empty { padding: 48px 0; text-align: center; display: flex; flex-direction: column; gap: 4px; }
  .title { margin: 0; font-weight: 600; }
  code { font-family: var(--vscode-editor-font-family); }
  h2 { font-size: 12px; font-weight: 400; color: var(--vscode-descriptionForeground); margin: 0 0 8px; }
  .timelines { display: flex; flex-direction: column; gap: 8px; }
  .timeline { display: grid; grid-template-columns: minmax(0, 180px) minmax(0, 1fr); gap: 12px; align-items: center; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;
document.head.appendChild(style);
createRoot(document.getElementById('root') as HTMLElement).render(<App />);

// AgentStat in VS Code (and Cursor): a status bar summary of every agent the
// local service sees, and a panel with each agent's status and history.

import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { follow, getAgents, startService, type AgentView, type Snapshot } from './service';

const POLL_MS = 2000;
const WORKING = new Set(['active', 'thinking', 'waiting']);

const port = () => vscode.workspace.getConfiguration('agentstat').get<number>('port', 4318);

function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`;
}

/** Agent-supplied text, flattened and capped (names and tools come from agents). */
function plain(s: string, max = 40): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Safe in a markdown table: every markdown character escaped (no links, no icons). */
function md(s: string, max?: number): string {
  return plain(s, max).replace(/[\\`*_{}[\]()#+\-.!|<>~$:]/g, '\\$&');
}

/** Safe in status bar text: no `$(icon)` from agent names. */
function bar(s: string, max?: number): string {
  return plain(s, max).replace(/\$\(/g, '$\u200b(');
}

function statusWord(a: AgentView): string {
  return a.status === 'waiting' && a.tool ? `waiting on ${a.tool}` : a.status;
}

/** The status bar item: how many agents are working, or what's wrong. */
function render(item: vscode.StatusBarItem, snap: Snapshot | null) {
  if (!snap) {
    item.text = '$(graph-line) AgentStat off';
    item.tooltip = 'The AgentStat service isn’t running. Click to start it.';
    item.command = 'agentstat.startService';
    item.backgroundColor = undefined;
    return;
  }
  const agents = snap.agents;
  const working = agents.filter((a) => WORKING.has(a.status)).length;
  const troubled = agents.filter((a) => a.anomalies.length > 0);
  item.command = 'agentstat.show';
  if (troubled.length) {
    item.text =
      troubled.length === 1
        ? `$(warning) ${bar(troubled[0].name, 24)}: ${bar(troubled[0].anomalies[0], 40)}`
        : `$(warning) ${troubled.length} agents need attention`;
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else {
    item.text =
      agents.length === 0 ? '$(graph-line) AgentStat' : `$(graph-line) ${working ? `${working} working` : `${agents.length} idle`}`;
    item.backgroundColor = undefined;
  }
  const tip = new vscode.MarkdownString(undefined, true);
  if (agents.length === 0) {
    tip.appendMarkdown('No agents yet. In Claude Code, install the AgentStat plugin, or run `agentstat run -- claude`.');
  } else {
    tip.appendMarkdown('| Agent | Status | Tokens |\n|:--|:--|--:|\n');
    for (const a of agents) {
      const warn = a.anomalies.length ? ' $(warning)' : '';
      tip.appendMarkdown(
        `| ${md(a.name)}${warn} | ${md(statusWord(a), 60)} · ${duration(a.statusMs)} | ${Math.round(a.totalTokens).toLocaleString()} |\n`
      );
    }
    tip.appendMarkdown('\nClick to open the AgentStat panel.');
  }
  item.tooltip = tip;
}

class Panel {
  static current: Panel | undefined;
  private stop: (() => void) | undefined;
  private disposed = false;

  static show(ctx: vscode.ExtensionContext) {
    if (Panel.current) {
      Panel.current.panel.reveal();
      return;
    }
    Panel.current = new Panel(ctx);
  }

  private constructor(private ctx: vscode.ExtensionContext, readonly panel = Panel.create(ctx)) {
    const web = panel.webview;
    web.onDidReceiveMessage((m: { kind: string }) => {
      // The panel is ready: start (or restart) its stream; history is replayed.
      if (m.kind === 'ready') this.start();
    });
    panel.onDidDispose(() => {
      this.disposed = true;
      this.stop?.();
      Panel.current = undefined;
    });
    web.html = this.html(web);
  }

  private static create(ctx: vscode.ExtensionContext) {
    return vscode.window.createWebviewPanel('agentstat', 'AgentStat', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist')],
    });
  }

  /** (Re)connect: the panel starts over and the service replays its history. */
  start() {
    this.stop?.();
    const post = (m: unknown) => {
      if (!this.disposed) void this.panel.webview.postMessage(m);
    };
    post({ kind: 'reset' });
    this.stop = follow(
      port(),
      (m) => post({ kind: 'message', m }),
      () => post({ kind: 'reset' }),
      (live) => post({ kind: 'state', live })
    );
  }

  private html(web: vscode.Webview): string {
    const nonce = randomBytes(18).toString('base64');
    const script = web.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.js'));
    // No network: data arrives by message from the extension.
    const csp = [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src ${web.cspSource} 'unsafe-inline'`,
      'img-src data:',
    ].join('; ');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentStat</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

export function activate(ctx: vscode.ExtensionContext) {
  const item = vscode.window.createStatusBarItem('agentstat.status', vscode.StatusBarAlignment.Right, 100);
  item.name = 'AgentStat';
  item.show();
  ctx.subscriptions.push(item);

  let busy = false;
  let last = 0;
  const refresh = async (force = false) => {
    // A window you're not in polls rarely; it catches up when you return.
    if (busy || (!force && !vscode.window.state.focused && Date.now() - last < 15_000)) return;
    busy = true;
    last = Date.now();
    try {
      render(item, await getAgents(port()));
    } catch {
      render(item, null);
    } finally {
      busy = false;
    }
  };
  void refresh(true);
  const timer = setInterval(() => void refresh(), POLL_MS);
  ctx.subscriptions.push(
    { dispose: () => clearInterval(timer) },
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) void refresh(true);
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('agentstat.show', () => Panel.show(ctx)),
    vscode.commands.registerCommand('agentstat.startService', async () => {
      if (!(await startService(port()))) {
        const pick = await vscode.window.showWarningMessage(
          'The agentstat command isn’t installed (or couldn’t be started).',
          'How to install'
        );
        if (pick) void vscode.env.openExternal(vscode.Uri.parse('https://github.com/dan-build/agentstat/tree/main/desktop'));
        return;
      }
      // Give it a moment, then say so if it didn't come up.
      await new Promise((r) => setTimeout(r, 1200));
      try {
        await getAgents(port());
      } catch {
        void vscode.window.showWarningMessage(
          `The AgentStat service didn’t start on port ${port()}. Is the port in use? Change it in the agentstat.port setting.`
        );
      }
      void refresh(true);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agentstat.port')) {
        void refresh(true);
        Panel.current?.start();
      }
    })
  );
}

export function deactivate() {}

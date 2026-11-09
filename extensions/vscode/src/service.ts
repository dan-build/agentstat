// The local AgentStat service, seen from the extension host: the agent list
// (for the status bar) and the live stream (for the panel). Loopback only.

import * as http from 'node:http';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type AgentView = {
  id: string;
  name: string;
  status: string;
  statusMs: number;
  rate: number;
  totalTokens: number;
  tool: string | null;
  errors: number;
  health: number | null;
  anomalies: string[];
};

export type Snapshot = { agents: AgentView[] };

const HOST = '127.0.0.1';

/** GET /v1/agents; rejects when the service isn't running. */
export function getAgents(port: number): Promise<Snapshot> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port, path: '/v1/agents', timeout: 1500 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`status ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body) as Snapshot);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** A message from the stream: the npm library's `AgentStreamMessage` (times in Unix ms). */
export type StreamMessage = { seq: number; type: 'event' | 'agent' | 'remove'; id: string; [k: string]: unknown };

/**
 * Follow the service's stream until stopped: reconnects after a drop and
 * resumes from the last message. `onReset` runs when the service is a
 * different run than before (what was received is gone).
 */
export function follow(
  port: number,
  onMessage: (m: StreamMessage) => void,
  onReset: () => void,
  onState: (live: boolean) => void
): () => void {
  let stopped = false;
  let lastId: string | null = null;
  let instance: string | null = null;
  // The request in use; events from an older one are ignored.
  let current: http.ClientRequest | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    if (stopped) return;
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (lastId) headers['Last-Event-ID'] = lastId;
    const req = http.get({ host: HOST, port, path: '/v1/stream', headers }, (res) => {
      if (req !== current) {
        res.resume();
        return;
      }
      // Any answer but the stream (an older service, the wrong port): try again.
      if (res.statusCode !== 200) {
        res.resume();
        drop(req);
        return;
      }
      // Connected: no connect timeout any more; silence is watched below instead.
      req.setTimeout(0);
      const run = String(res.headers['x-agentstat-instance'] ?? '');
      if (run && instance && run !== instance) {
        lastId = null;
        onReset();
      }
      instance = run || instance;
      onState(true);
      // The service sends a keep-alive every 15 s; silence for longer is a dead
      // link (a laptop that slept, a connection that half-closed).
      const watch = () => {
        clearTimeout(idle);
        idle = setTimeout(() => req.destroy(new Error('idle')), 40_000);
      };
      watch();
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (chunk: string) => {
        watch();
        buf = (buf + chunk).replace(/\r\n/g, '\n');
        let end: number;
        while ((end = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, end);
          buf = buf.slice(end + 2);
          let id: string | null = null;
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('id: ')) id = line.slice(4);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (!data) continue;
          try {
            const wire = JSON.parse(data) as { m: StreamMessage };
            // Resume only after a message that was understood.
            if (id) lastId = id;
            onMessage(wire.m);
          } catch {
            // A malformed frame: skip it.
          }
        }
      });
      res.on('end', () => drop(req));
      res.on('close', () => drop(req));
      res.on('error', () => drop(req));
    });
    current = req;
    req.setTimeout(3_000, () => req.destroy(new Error('connect timeout')));
    req.on('error', () => drop(req));
  };

  function drop(req: http.ClientRequest) {
    if (stopped || req !== current) return;
    current = null;
    clearTimeout(idle);
    onState(false);
    if (retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      connect();
    }, 1000);
  }

  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    clearTimeout(idle);
    current?.destroy();
    current = null;
  };
}

/** The `agentstat` command: on PATH, else where `cargo install` puts it. */
export function findAgentstat(): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  dirs.push(path.join(os.homedir(), '.cargo', 'bin'));
  const names = process.platform === 'win32' ? ['agentstat.exe', 'agentstat'] : ['agentstat'];
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      try {
        if (fs.statSync(p).isFile()) {
          fs.accessSync(p, fs.constants.X_OK);
          return p;
        }
      } catch {
        // not here
      }
    }
  }
  return null;
}

/**
 * Start `agentstat serve` detached (it outlives the editor). Resolves false
 * when there's no binary or it couldn't be launched.
 */
export function startService(port: number): Promise<boolean> {
  const bin = findAgentstat();
  if (!bin) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(bin, ['serve', '--port', String(port)], { detached: true, stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

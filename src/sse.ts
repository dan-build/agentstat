// src/sse.ts — `@dan-build/agentstat/sse`
//
// Server → browser transport over Server-Sent Events. On the server,
// `createSseHandler` turns an AgentStream into a standard Fetch-API handler
// (Next.js route handlers, Hono, Bun, Deno, Workers); in the browser,
// `connectSse` turns its URL back into an `AgentSource` for
// `<AgentStat source>`. Framework-free and React-free (this entry also
// exports `createAgentStream`, for server code).
//
// Times: two machines' clocks don't agree, and a sleeping laptop's
// performance.now() stops while its wall clock doesn't. So an event travels
// with its age when sent, and arrives at "now − age − transit delay", where
// the delay is measured against the fastest message of the connection.
// Event ids are `<instance>:<seq>`, so a reconnect resumes where it stopped.

import { createAgentStream, type AgentSource, type AgentStreamMessage } from './stream-core';

export { createAgentStream };
export type { AgentSource, AgentStream, AgentStreamMessage } from './stream-core';
export type { Agent, AgentEvent } from './types';

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// A random id per source object, so clients can tell a restart from a resume.
const instances = new WeakMap<AgentSource, string>();
const instanceOf = (source: AgentSource) => {
  let id = instances.get(source);
  if (!id) {
    id = Math.random().toString(36).slice(2, 10);
    instances.set(source, id);
  }
  return id;
};

/** What travels: the message, its event's age when sent (ms), and when it was sent (wall clock). */
type Wire = { m: AgentStreamMessage; age?: number; sent: number };

export interface SseHandlerOptions {
  /** Comment line sent this often (ms) to keep proxies from closing the stream. Default 15 000. */
  heartbeatMs?: number;
  /**
   * Messages a client may fall behind by before it's disconnected (it then
   * reconnects and resumes), so a stalled client can't grow server memory.
   * Default 1 000.
   */
  maxQueued?: number;
}

/**
 * A Fetch-API handler streaming `source` as Server-Sent Events: what the
 * source has kept (after the client's last event, on a reconnect), then live
 * messages until the client disconnects. Pass a function to pick the source
 * per request — e.g. after checking the user may see it (return undefined →
 * 404); it must return the same object for the same stream on every request
 * (a new wrapper per request makes each reconnect a replay). The endpoint
 * exposes your agents' telemetry: protect it like any other route.
 *
 * ```ts
 * // app/api/agents/route.ts (Next.js)
 * import { createAgentStream, createSseHandler } from '@dan-build/agentstat/sse';
 * export const stream = createAgentStream();
 * export const GET = createSseHandler(stream);
 * ```
 */
export function createSseHandler(
  source: AgentSource | ((request: Request) => AgentSource | undefined | Promise<AgentSource | undefined>),
  options: SseHandlerOptions = {}
): (request: Request) => Promise<Response> {
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const maxQueued = options.maxQueued ?? 1_000;
  return async (request) => {
    const src = typeof source === 'function' ? await source(request) : source;
    if (!src || typeof src.subscribe !== 'function') return new Response('Not found', { status: 404 });
    const instance = instanceOf(src);
    // Resume after the client's last event — only if it came from this instance.
    const last =
      request.headers.get('last-event-id') ?? new URL(request.url, 'http://x').searchParams.get('lastEventId') ?? '';
    const [inst, seq] = last.split(':');
    const after = inst === instance && Number(seq) > 0 ? Number(seq) : 0;

    const enc = new TextEncoder();
    let stop = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let open = true;
        let unsubscribe = () => {};
        // Declared before stop() can run (during the history replay).
        // eslint-disable-next-line prefer-const
        let beat: ReturnType<typeof setInterval> | undefined;
        // Queue level after the history replay, which is sent all at once.
        let floor = -Infinity;
        const send = (text: string) => {
          if (!open) return;
          // A client that stopped reading live messages: let it reconnect
          // (and resume) instead of queueing them.
          if ((controller.desiredSize ?? 0) < floor - maxQueued) return stop();
          try {
            controller.enqueue(enc.encode(text));
          } catch {
            stop();
          }
        };
        stop = () => {
          if (!open) return;
          open = false;
          clearInterval(beat);
          unsubscribe();
          try {
            controller.close();
          } catch {
            // already closed
          }
        };
        // Reconnect quickly after a drop.
        send('retry: 2000\n\n');
        unsubscribe = src.subscribe((m) => {
          const wire: Wire = { m, sent: Date.now() };
          if (m.type === 'event' && typeof m.event.time === 'number') wire.age = Math.max(0, clock() - m.event.time);
          send(`id: ${instance}:${m.seq}\ndata: ${JSON.stringify(wire)}\n\n`);
        }, after);
        floor = Math.min(0, controller.desiredSize ?? 0);
        beat = setInterval(() => send(': keep-alive\n\n'), heartbeatMs);
        request.signal?.addEventListener('abort', () => stop());
        // The client may have gone while the source was being picked.
        if (request.signal?.aborted) stop();
      },
      cancel() {
        stop();
      },
    });
    return new Response(body, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        // Ask proxies such as nginx not to buffer the stream.
        'x-accel-buffering': 'no',
      },
    });
  };
}

export interface SseSourceOptions {
  /** Send cookies with a cross-origin request (EventSource `withCredentials`). */
  withCredentials?: boolean;
}

const valid = (m: unknown): m is AgentStreamMessage => {
  const x = m as AgentStreamMessage | null;
  if (!x || typeof x.seq !== 'number' || typeof x.id !== 'string') return false;
  if (x.type === 'event') return !!x.event && typeof x.event.type === 'string';
  return x.type === 'agent' || x.type === 'remove';
};

/**
 * An `AgentSource` for `<AgentStat source>` reading a `createSseHandler`
 * endpoint. One connection however many charts subscribe (browsers allow
 * only a few per site over HTTP/1.1), opened while any chart listens. After
 * a drop or an error response (a proxy during a deploy) it reconnects with
 * backoff and resumes where it stopped — as far back as the server keeps
 * (5 minutes by default); a restarted server is replayed without repeating
 * what was already shown.
 *
 * ```tsx
 * const source = useMemo(() => connectSse('/api/agents'), []);
 * <AgentStat source={source} />
 * ```
 */
export function connectSse(url: string, options: SseSourceOptions = {}): AgentSource {
  // Messages as charts see them: re-emitted into a local stream, which keeps
  // recent history for charts that subscribe later.
  const local = createAgentStream();
  let listeners = 0;
  let es: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let backoff = 1_000;
  let instance = '';
  let lastSeq = 0;
  let lastId = '';
  // Newest event time delivered (local clock), to skip replays of another
  // instance of the same stream; fastest transit seen on this connection.
  let newest = -Infinity;
  let skipBefore = -Infinity;
  let fastest = Infinity;

  const onMessage = (e: MessageEvent<string>) => {
    let wire: Wire;
    try {
      wire = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!wire || !valid(wire.m)) return;
    backoff = 1_000;
    const [inst, seqStr] = String(e.lastEventId).split(':');
    const seq = Number(seqStr);
    if (inst !== instance) {
      // A restarted server (or another replica): its numbering starts over,
      // and what it replays from before now was shown already.
      if (instance) skipBefore = newest;
      instance = inst;
      lastSeq = 0;
    }
    if (seq <= lastSeq) return; // already delivered
    lastSeq = seq;
    lastId = e.lastEventId;
    const m = wire.m;
    if (m.type === 'event') {
      // Arrival time minus the fastest transit is this message's delay.
      const transit = Date.now() - wire.sent;
      fastest = Math.min(fastest, transit);
      const time = clock() - (wire.age ?? 0) - Math.max(0, transit - fastest);
      if (time <= skipBefore + 1) return;
      newest = Math.max(newest, time);
      local.push(m.id, { ...m.event, time });
    } else if (m.type === 'agent') {
      const { name, color, config } = m;
      local.describe(m.id, { name, color, config });
    } else local.remove(m.id);
  };
  const connect = () => {
    if (typeof EventSource === 'undefined' || es) return;
    const target = lastId ? `${url}${url.includes('?') ? '&' : '?'}lastEventId=${encodeURIComponent(lastId)}` : url;
    es = new EventSource(target, { withCredentials: !!options.withCredentials });
    fastest = Infinity;
    es.onmessage = onMessage;
    es.onerror = () => {
      // The browser retries network errors itself; after an error response
      // it gives up (CLOSED): retry with backoff, resuming from the last id.
      if (!es || es.readyState !== 2) return;
      es.close();
      es = null;
      retry = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    };
  };
  const disconnect = () => {
    clearTimeout(retry);
    es?.close();
    es = null;
  };

  return {
    subscribe(listener, after = 0) {
      const off = local.subscribe(listener, after);
      listeners++;
      clearTimeout(idle);
      connect();
      return () => {
        off();
        // Close when nobody listens (after a moment: a remount resubscribes).
        if (--listeners === 0) idle = setTimeout(disconnect, 1_000);
      };
    },
  };
}

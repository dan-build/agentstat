// src/sse.ts — `@dan-build/agentstat/sse`
//
// Server → browser transport over Server-Sent Events. On the server,
// `createSseHandler` turns an AgentStream into a standard Fetch-API handler
// (Next.js route handlers, Hono, Bun, Deno, Workers); in the browser,
// `connectSse` turns its URL back into an `AgentSource` for
// `<AgentStat source>`. Framework-free; no 'use client'.
//
// Times: `performance.now()` clocks of two machines are unrelated, so event
// times travel as wall-clock milliseconds and are mapped back on arrival,
// correcting for clock skew. Event ids are `<instance>:<seq>`, so a
// reconnect resumes where it stopped, and a restarted server (new instance,
// numbering from 1 again) is replayed in full.

import type { AgentSource, AgentStreamMessage } from './stream';

/** Wall-clock ms for a time in this process's `performance.now()` clock. */
const toEpoch = (t: number) => (typeof performance !== 'undefined' ? performance.timeOrigin + t : t);

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

/** What travels: the message, its event time as wall-clock ms, and when it was sent. */
type Wire = { m: AgentStreamMessage; at?: number; sent: number };

export interface SseHandlerOptions {
  /** Comment line sent this often (ms) to keep proxies from closing the stream. Default 15 000. */
  heartbeatMs?: number;
}

/**
 * A Fetch-API handler streaming `source` as Server-Sent Events: what the
 * source has kept (after the client's last event, on a reconnect), then live
 * messages until the client disconnects. Pass a function to pick the source
 * per request — e.g. after checking the user may see it (return undefined →
 * 404). The endpoint exposes your agents' telemetry: protect it like any
 * other route.
 *
 * ```ts
 * // app/api/agents/route.ts (Next.js)
 * export const GET = createSseHandler(stream);
 * ```
 */
export function createSseHandler(
  source: AgentSource | ((request: Request) => AgentSource | undefined | Promise<AgentSource | undefined>),
  options: SseHandlerOptions = {}
): (request: Request) => Promise<Response> {
  const heartbeatMs = options.heartbeatMs ?? 15_000;
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
        const send = (text: string) => {
          try {
            controller.enqueue(enc.encode(text));
          } catch {
            stop();
          }
        };
        // Reconnect quickly after a drop.
        send('retry: 2000\n\n');
        const unsubscribe = src.subscribe((m) => {
          const wire: Wire = { m, sent: Date.now() };
          if (m.type === 'event' && typeof m.event.time === 'number') wire.at = toEpoch(m.event.time);
          send(`id: ${instance}:${m.seq}\ndata: ${JSON.stringify(wire)}\n\n`);
        }, after);
        const beat = setInterval(() => send(': keep-alive\n\n'), heartbeatMs);
        stop = () => {
          clearInterval(beat);
          unsubscribe();
          try {
            controller.close();
          } catch {
            // already closed
          }
        };
        request.signal?.addEventListener('abort', () => stop());
      },
      cancel() {
        stop();
      },
    });
    return new Response(body, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
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

/**
 * An `AgentSource` for `<AgentStat source>` reading a `createSseHandler`
 * endpoint. Each chart that subscribes opens its own connection; the browser
 * reconnects after a drop and the server resumes where it stopped.
 *
 * ```tsx
 * const source = useMemo(() => connectSse('/api/agents'), []);
 * <AgentStat source={source} />
 * ```
 */
export function connectSse(url: string, options: SseSourceOptions = {}): AgentSource {
  // Seqs as the chart sees them: a restarted server numbers from 1 again,
  // so its messages continue after the last one delivered.
  let instance = '';
  let base = 0;
  let lastLocal = 0;
  let lastId = '';
  // Smallest (receive − send) seen: network delay plus clock skew; the
  // smallest is closest to the skew alone.
  let skew = Infinity;
  return {
    subscribe(listener, after = 0) {
      if (typeof EventSource === 'undefined') return () => {};
      // Resuming (a re-subscribe of the same chart): ask for what came after.
      const resume = after > 0 && after === lastLocal && lastId ? lastId : '';
      const es = new EventSource(
        resume ? `${url}${url.includes('?') ? '&' : '?'}lastEventId=${encodeURIComponent(resume)}` : url,
        { withCredentials: !!options.withCredentials }
      );
      es.onmessage = (e: MessageEvent<string>) => {
        let wire: Wire;
        try {
          wire = JSON.parse(e.data);
        } catch {
          return;
        }
        if (!wire || !wire.m || typeof wire.m.seq !== 'number') return;
        const [inst] = String(e.lastEventId).split(':');
        if (inst !== instance) {
          // A different server instance: its numbering starts over.
          if (instance) base = lastLocal;
          instance = inst;
        }
        lastId = e.lastEventId;
        const now = Date.now();
        skew = Math.min(skew, now - wire.sent);
        const m = { ...wire.m, seq: base + wire.m.seq } as AgentStreamMessage;
        if (m.type === 'event' && typeof wire.at === 'number' && typeof performance !== 'undefined') {
          // Their wall clock → ours → this page's performance.now().
          m.event = { ...m.event, time: wire.at + skew - performance.timeOrigin };
        }
        lastLocal = Math.max(lastLocal, m.seq);
        listener(m);
      };
      return () => es.close();
    },
  };
}

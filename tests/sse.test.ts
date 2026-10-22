// SSE transport: createSseHandler (server) → connectSse (browser), end to end
// through a minimal EventSource that reads the handler's real output.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createAgentStream, type AgentStreamMessage } from '../src/stream';
import { createSseHandler, connectSse } from '../src/sse';

type Frame = { id?: string; data?: string };

/** Parse SSE text into frames (id + data). */
function parse(text: string): Frame[] {
  return text
    .split('\n\n')
    .filter((b) => b.trim())
    .map((b) => {
      const f: Frame = {};
      for (const line of b.split('\n')) {
        if (line.startsWith('id: ')) f.id = line.slice(4);
        if (line.startsWith('data: ')) f.data = line.slice(6);
      }
      return f;
    })
    .filter((f) => f.data !== undefined);
}

/** Read what a handler response has streamed so far. */
async function drain(res: Response): Promise<{ frames: Frame[]; reader: ReadableStreamDefaultReader<Uint8Array> }> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = '';
  // Everything already enqueued is readable without waiting for more.
  for (;;) {
    const r = await Promise.race([reader.read(), new Promise<null>((ok) => setTimeout(() => ok(null), 20))]);
    if (!r || r.done) break;
    text += dec.decode(r.value);
  }
  return { frames: parse(text), reader };
}

/** A minimal EventSource the test drives with frames from the handler. */
class FakeEventSource {
  static last: FakeEventSource;
  onmessage: ((e: { data: string; lastEventId: string }) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.last = this;
  }
  deliver(frames: Frame[]) {
    for (const f of frames) this.onmessage?.({ data: f.data!, lastEventId: f.id ?? '' });
  }
  close() {
    this.closed = true;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('createSseHandler', () => {
  it('streams kept history then live messages as server-sent events', async () => {
    const s = createAgentStream();
    s.push('a', { type: 'start' });
    const ac = new AbortController();
    const res = await createSseHandler(s)(new Request('http://x/agents', { signal: ac.signal }));
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    s.push('a', { type: 'tokens', count: 3 });
    const { frames, reader } = await drain(res);
    expect(frames.map((f) => JSON.parse(f.data!).m.type)).toEqual(['event', 'event']);
    expect(frames[0].id).toMatch(/^\w+:1$/);
    ac.abort(); // the client went away: the subscription ends
    await reader.cancel().catch(() => {});
  });

  it('resumes after Last-Event-ID from the same instance, replays all for another', async () => {
    const s = createAgentStream();
    s.push('a', { type: 'start' });
    s.push('a', { type: 'finish' });
    const handler = createSseHandler(s);
    const first = await drain(await handler(new Request('http://x/')));
    const id = first.frames[0].id!;
    const resumed = await drain(await handler(new Request('http://x/', { headers: { 'last-event-id': id } })));
    expect(resumed.frames.map((f) => f.id)).toEqual([first.frames[1].id]);
    const other = await drain(await handler(new Request('http://x/', { headers: { 'last-event-id': 'zzz:1' } })));
    expect(other.frames).toHaveLength(2);
  });

  it('picks the source per request; none → 404', async () => {
    const s = createAgentStream();
    const handler = createSseHandler((req) => (req.headers.get('x-user') === 'ok' ? s : undefined));
    expect((await handler(new Request('http://x/'))).status).toBe(404);
    expect((await handler(new Request('http://x/', { headers: { 'x-user': 'ok' } }))).status).toBe(200);
  });
});

describe('connectSse', () => {
  it('delivers messages with event times mapped to this page’s clock', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const s = createAgentStream();
    s.push('a', { type: 'tokens', count: 3 });
    const { frames } = await drain(await createSseHandler(s)(new Request('http://x/')));
    const got: AgentStreamMessage[] = [];
    const off = connectSse('/agents').subscribe((m) => got.push(m));
    FakeEventSource.last.deliver(frames);
    expect(got).toHaveLength(1);
    const m = got[0];
    expect(m.type === 'event' && m.event).toMatchObject({ type: 'tokens', count: 3 });
    // Same machine here: the mapped time is about the original one.
    const t = m.type === 'event' ? m.event.time! : NaN;
    expect(Math.abs(t - performance.now())).toBeLessThan(1_000);
    off();
    expect(FakeEventSource.last.closed).toBe(true);
  });

  it('corrects for a server clock that runs ahead', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const got: AgentStreamMessage[] = [];
    connectSse('/agents').subscribe((m) => got.push(m));
    const ahead = 60_000; // the server's wall clock is a minute fast
    const sent = Date.now() + ahead;
    const wire = { m: { seq: 1, type: 'event', id: 'a', event: { type: 'start' } }, at: sent - 500, sent };
    FakeEventSource.last.deliver([{ id: 'i1:1', data: JSON.stringify(wire) }]);
    const t = got[0].type === 'event' ? got[0].event.time! : NaN;
    // Half a second ago in this page's clock, not a minute in the future.
    expect(performance.now() - t).toBeGreaterThan(400);
    expect(performance.now() - t).toBeLessThan(700);
  });

  it('continues numbering after a server restart and resumes a re-subscribe', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const src = connectSse('/agents?team=1');
    const seqs: number[] = [];
    src.subscribe((m) => seqs.push(m.seq));
    const msg = (seq: number) => JSON.stringify({ m: { seq, type: 'remove', id: 'x' }, sent: Date.now() });
    FakeEventSource.last.deliver([
      { id: 'old:1', data: msg(1) },
      { id: 'old:2', data: msg(2) },
      { id: 'new:1', data: msg(1) }, // restarted: numbering starts over
    ]);
    expect(seqs).toEqual([1, 2, 3]);
    src.subscribe(() => {}, 3); // the chart re-subscribes after seq 3
    expect(FakeEventSource.last.url).toBe('/agents?team=1&lastEventId=new%3A1');
  });
});

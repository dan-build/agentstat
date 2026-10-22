// SSE transport: createSseHandler (server) → connectSse (browser), end to end
// through a minimal EventSource that reads the handler's real output.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createAgentStream, createSseHandler, connectSse, type AgentStreamMessage } from '../src/sse';

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
async function drain(res: Response): Promise<{ frames: Frame[]; reader: ReadableStreamDefaultReader<Uint8Array>; done: boolean }> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = '';
  let done = false;
  for (;;) {
    const r = await Promise.race([reader.read(), new Promise<null>((ok) => setTimeout(() => ok(null), 20))]);
    if (!r) break;
    if (r.done) {
      done = true;
      break;
    }
    text += dec.decode(r.value);
  }
  return { frames: parse(text), reader, done };
}

/** A minimal EventSource the test drives with frames from the handler. */
class FakeEventSource {
  static all: FakeEventSource[] = [];
  static get last() {
    return FakeEventSource.all[FakeEventSource.all.length - 1];
  }
  onmessage: ((e: { data: string; lastEventId: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  constructor(public url: string) {
    FakeEventSource.all.push(this);
  }
  deliver(frames: Frame[]) {
    for (const f of frames) this.onmessage?.({ data: f.data!, lastEventId: f.id ?? '' });
  }
  /** An error response: the browser gives up on this EventSource. */
  fail() {
    this.readyState = 2;
    this.onerror?.();
  }
  close() {
    this.readyState = 2;
  }
}

const wire = (m: object, extra: object = {}) => JSON.stringify({ m, sent: Date.now(), ...extra });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  FakeEventSource.all = [];
});

describe('createSseHandler', () => {
  it('streams kept history then live messages as server-sent events', async () => {
    const s = createAgentStream();
    s.push('a', { type: 'start' });
    const ac = new AbortController();
    const res = await createSseHandler(s)(new Request('http://x/agents', { signal: ac.signal }));
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(res.headers.get('connection')).toBeNull(); // hop-by-hop: not ours to set
    s.push('a', { type: 'tokens', count: 3 });
    const { frames, reader } = await drain(res);
    expect(frames.map((f) => JSON.parse(f.data!).m.type)).toEqual(['event', 'event']);
    expect(frames[0].id).toMatch(/^\w+:1$/);
    expect(JSON.parse(frames[0].data!).age).toBeGreaterThanOrEqual(0);
    ac.abort();
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

  it('sends a large history, but drops a client that stops reading live messages', async () => {
    const s = createAgentStream();
    for (let i = 0; i < 3_000; i++) s.push('a', { type: 'tokens', count: 1 });
    const res = await createSseHandler(s, { maxQueued: 50 })(new Request('http://x/'));
    // Nothing read yet: the replay alone doesn't disconnect…
    for (let i = 0; i < 40; i++) s.push('a', { type: 'tokens', count: 1 });
    // …but falling 50 live messages behind does.
    for (let i = 0; i < 20; i++) s.push('a', { type: 'tokens', count: 1 });
    const { frames, done } = await drain(res);
    expect(done).toBe(true);
    expect(frames.length).toBeGreaterThanOrEqual(3_040);
    expect(frames.length).toBeLessThan(3_060);
  });
});

describe('connectSse', () => {
  it('delivers messages with event times from their age', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const s = createAgentStream();
    s.push('a', { type: 'tokens', count: 3 });
    const { frames } = await drain(await createSseHandler(s)(new Request('http://x/')));
    const got: AgentStreamMessage[] = [];
    connectSse('/agents').subscribe((m) => got.push(m));
    FakeEventSource.last.deliver(frames);
    expect(got).toHaveLength(1);
    const m = got[0];
    expect(m.type === 'event' && m.event).toMatchObject({ type: 'tokens', count: 3 });
    const t = m.type === 'event' ? m.event.time! : NaN;
    expect(Math.abs(t - performance.now())).toBeLessThan(1_000);
  });

  it("ignores the two machines' wall clocks: a server a minute ahead", () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const got: AgentStreamMessage[] = [];
    connectSse('/agents').subscribe((m) => got.push(m));
    const m = { seq: 1, type: 'event', id: 'a', event: { type: 'start' } };
    FakeEventSource.last.deliver([{ id: 'i:1', data: wire(m, { age: 500, sent: Date.now() + 60_000 }) }]);
    const t = got[0].type === 'event' ? got[0].event.time! : NaN;
    expect(performance.now() - t).toBeGreaterThan(400);
    expect(performance.now() - t).toBeLessThan(700);
  });

  it('shares one connection between charts; a late chart gets the history', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const src = connectSse('/agents');
    const a: number[] = [];
    const b: number[] = [];
    src.subscribe((m) => a.push(m.seq));
    const ev = (seq: number) => ({ id: `i:${seq}`, data: wire({ seq, type: 'event', id: 'x', event: { type: 'tokens', count: 1 } }, { age: 0 }) });
    FakeEventSource.last.deliver([ev(1), ev(2)]);
    src.subscribe((m) => b.push(m.seq));
    FakeEventSource.last.deliver([ev(3)]);
    expect(FakeEventSource.all).toHaveLength(1);
    expect(a).toEqual([1, 2, 3]);
    expect(b).toEqual([1, 2, 3]);
  });

  it('reconnects with backoff after an error response, resuming from the last id', () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    connectSse('/agents').subscribe(() => {});
    FakeEventSource.last.deliver([{ id: 'i:7', data: wire({ seq: 7, type: 'remove', id: 'x' }) }]);
    FakeEventSource.last.fail(); // e.g. a 502 from a proxy during a deploy
    expect(FakeEventSource.all).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(FakeEventSource.all).toHaveLength(2);
    expect(FakeEventSource.last.url).toBe('/agents?lastEventId=i%3A7');
    FakeEventSource.last.fail();
    vi.advanceTimersByTime(1_999);
    expect(FakeEventSource.all).toHaveLength(2); // backing off
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.all).toHaveLength(3);
  });

  it('skips what a restarted server or another replica replays, and repeats within one', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const got: AgentStreamMessage[] = [];
    connectSse('/agents').subscribe((m) => got.push(m));
    const ev = (inst: string, seq: number, age: number) => ({
      id: `${inst}:${seq}`,
      data: wire({ seq, type: 'event', id: 'x', event: { type: 'tokens', count: 1 } }, { age }),
    });
    const es = FakeEventSource.last;
    es.deliver([ev('old', 1, 3_000), ev('old', 2, 2_000), ev('old', 2, 2_000)]); // a repeat
    es.deliver([ev('new', 1, 3_000), ev('new', 2, 2_000), ev('new', 3, 0)]); // same history, then news
    expect(got).toHaveLength(3);
  });

  it('ignores malformed messages', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const got: AgentStreamMessage[] = [];
    connectSse('/agents').subscribe((m) => got.push(m));
    FakeEventSource.last.deliver([
      { id: 'i:1', data: 'not json' },
      { id: 'i:2', data: wire({ seq: 2, type: 'event', id: 'a' }) }, // no event
      { id: 'i:3', data: wire({ seq: 3, type: 'nope', id: 'a' }) },
    ]);
    expect(got).toEqual([]);
  });

  it('closes the connection a moment after the last chart leaves', () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    const src = connectSse('/agents');
    const off = src.subscribe(() => {});
    off();
    src.subscribe(() => {})(); // a remount within the moment keeps it
    expect(FakeEventSource.last.readyState).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(FakeEventSource.last.readyState).toBe(2);
  });
});

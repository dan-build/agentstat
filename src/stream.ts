// src/stream.ts
//
// An event source for <AgentStat source={…}>: push agent events from
// anywhere (stream callbacks, a WebSocket handler, an adapter), before or
// after a chart mounts. Framework-free; recent history is kept so a chart
// that subscribes later sees it, with the events' original times.

import { useState } from 'react';
import type { Agent, AgentEvent } from './types';

/** What a source delivers to a chart. `seq` increases by one per message. */
export type AgentStreamMessage = { seq: number } & (
  | { type: 'event'; id: string; event: AgentEvent }
  | { type: 'agent'; id: string; name?: string; color?: string; config?: Agent['config'] }
  | { type: 'remove'; id: string }
);

/** Anything a chart can subscribe to (`createAgentStream()` returns one). */
export interface AgentSource {
  /**
   * Deliver messages with `seq` greater than `after` that are still kept,
   * then every new one, until the returned function is called.
   */
  subscribe(listener: (m: AgentStreamMessage) => void, after?: number): () => void;
}

export interface AgentStream extends AgentSource {
  /** Report an event for an agent; unknown ids are added to subscribed charts. */
  push(agentId: string, event: AgentEvent): void;
  /** Name, color or expected-rate band for an agent added by its events. */
  describe(agentId: string, info: { name?: string; color?: string; config?: Agent['config'] }): void;
  /** Remove an agent added by its events from subscribed charts. */
  remove(agentId: string): void;
}

/** History kept for charts that subscribe later. */
const KEEP_MS = 300_000;
const KEEP_MAX = 50_000;

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Create an event source for `<AgentStat source={stream} />`. Events are
 * timestamped when pushed (unless they carry a `time`), so a chart that
 * mounts later replays them as they happened.
 */
export function createAgentStream(): AgentStream {
  let log: AgentStreamMessage[] = [];
  let head = 0;
  let seq = 0;
  // Latest description of each agent, kept beyond the event history.
  const info = new Map<string, Extract<AgentStreamMessage, { type: 'agent' }>>();
  const listeners = new Set<(m: AgentStreamMessage) => void>();

  const emit = (m: AgentStreamMessage, now: number) => {
    log.push(m);
    // Trim from the front by age and count; compact occasionally.
    const evAt = (x: AgentStreamMessage) => (x.type === 'event' ? x.event.time ?? now : now);
    while (head < log.length && (log.length - head > KEEP_MAX || evAt(log[head]) < now - KEEP_MS)) head++;
    if (head > 1024 && head > log.length / 2) {
      log = log.slice(head);
      head = 0;
    }
    for (const l of Array.from(listeners)) l(m);
  };

  return {
    push(id, event) {
      if (typeof id !== 'string' || !event || typeof event !== 'object') return;
      const now = clock();
      const time = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : now;
      emit({ seq: ++seq, type: 'event', id, event: { ...event, time } }, now);
    },
    describe(id, d) {
      if (typeof id !== 'string' || !d) return;
      const m = { ...info.get(id), ...d, seq: ++seq, type: 'agent' as const, id };
      info.set(id, m);
      emit(m, clock());
    },
    remove(id) {
      if (typeof id !== 'string') return;
      info.delete(id);
      // Its history goes too, so a chart that subscribes later doesn't re-add it.
      log = log.slice(head).filter((m) => m.id !== id);
      head = 0;
      emit({ seq: ++seq, type: 'remove', id }, clock());
    },
    subscribe(listener, after = 0) {
      // Descriptions first (they may predate the kept history), then events.
      for (const m of info.values()) if (m.seq > after) listener(m);
      for (let i = head; i < log.length; i++) {
        const m = log[i];
        if (m.seq > after && m.type !== 'agent') listener(m);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** `createAgentStream()` for a component: the same stream for its lifetime. */
export function useAgentStream(): AgentStream {
  const [stream] = useState(createAgentStream);
  return stream;
}

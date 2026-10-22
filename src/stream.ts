// src/stream.ts
//
// An event source for <AgentStat source={…}>: push agent events from
// anywhere (stream callbacks, a WebSocket handler, an adapter), before or
// after a chart mounts. Framework-free; recent history is kept so a chart
// that subscribes later sees it, with the events' original times.

import { useState } from 'react';
import type { Agent, AgentEvent } from './types';
import { warnOnce } from './core/constants';

/**
 * What a source delivers to a chart. `seq` increases by one per message, and
 * messages are delivered in `seq` order.
 */
export type AgentStreamMessage = { seq: number } & (
  | { type: 'event'; id: string; event: AgentEvent }
  | { type: 'agent'; id: string; name?: string; color?: string; config?: Agent['config'] }
  | { type: 'remove'; id: string }
);

/** Anything a chart can subscribe to (`createAgentStream()` returns one). */
export interface AgentSource {
  /**
   * Deliver the kept messages with `seq` greater than `after`, in `seq`
   * order, then every new one, until the returned function is called.
   */
  subscribe(listener: (m: AgentStreamMessage) => void, after?: number): () => void;
}

export interface AgentStream extends AgentSource {
  /**
   * Report an event for an agent; unknown ids are added to subscribed charts.
   * `event.time` is in the `performance.now()` clock (default: now).
   */
  push(agentId: string, event: AgentEvent): void;
  /** Name, color or expected-rate band for an agent added by its events. */
  describe(agentId: string, info: { name?: string; color?: string; config?: Agent['config'] }): void;
  /** Remove an agent added by its events from subscribed charts. */
  remove(agentId: string): void;
}

/** History kept for charts that subscribe later. */
const KEEP_MS = 300_000;
const KEEP_MAX = 20_000;

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Create an event source for `<AgentStat source={stream} />`. Events are
 * timestamped when pushed (unless they carry a `time`), so a chart that
 * mounts later replays them as they happened.
 */
export function createAgentStream(): AgentStream {
  // Kept messages and when each arrived; [head, length) is live.
  let log: AgentStreamMessage[] = [];
  let at: number[] = [];
  let head = 0;
  let seq = 0;
  // Latest description of each agent, replayed even after its message has
  // aged out of the log.
  const info = new Map<string, Extract<AgentStreamMessage, { type: 'agent' }>>();
  const listeners = new Set<(m: AgentStreamMessage) => void>();

  const trim = (now: number) => {
    while (head < log.length && (log.length - head > KEEP_MAX || at[head] < now - KEEP_MS)) head++;
    if (head > 1024 && head > log.length / 2) {
      log = log.slice(head);
      at = at.slice(head);
      head = 0;
    }
  };

  const emit = (m: AgentStreamMessage) => {
    const now = clock();
    log.push(m);
    at.push(now);
    trim(now);
    for (const l of Array.from(listeners)) {
      // One failing chart must not keep the message from the others.
      try {
        l(m);
      } catch (err) {
        setTimeout(() => {
          throw err;
        });
      }
    }
  };

  return {
    push(id, event) {
      if (typeof id !== 'string' || !event || typeof event !== 'object') return;
      const now = clock();
      let time = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : now;
      if (time > now + 1_000 || time < now - 86_400_000) {
        warnOnce(
          `stream-clock:${id}`,
          `stream.push("${id}"): event time ${time} is far from performance.now() (${Math.round(now)}); times must use that clock.`
        );
      }
      time = Math.min(time, now);
      emit({ seq: ++seq, type: 'event', id, event: { ...event, time } });
    },
    describe(id, d) {
      if (typeof id !== 'string' || !d) return;
      const prev = info.get(id);
      const m = { name: prev?.name, color: prev?.color, config: prev?.config, ...d, seq: ++seq, type: 'agent' as const, id };
      info.set(id, m);
      emit(m);
    },
    remove(id) {
      if (typeof id !== 'string') return;
      info.delete(id);
      // Its history goes too, so a chart that subscribes later doesn't re-add it.
      const keep = log.map((m, i) => i >= head && m.id !== id);
      log = log.filter((_, i) => keep[i]);
      at = at.filter((_, i) => keep[i]);
      head = 0;
      emit({ seq: ++seq, type: 'remove', id });
    },
    subscribe(listener, after = 0) {
      trim(clock());
      const l = log;
      const h = head;
      const first = h < l.length ? l[h].seq : seq + 1;
      // Descriptions that aged out of the log come first (they're older than
      // anything kept), then the kept messages in order.
      // An agent with nothing kept beyond its description is long gone.
      const kept = new Set<string>();
      for (let i = h; i < l.length; i++) kept.add(l[i].id);
      for (const [id, m] of info) if (m.seq < first && !kept.has(id)) info.delete(id);
      const aged = [...info.values()].filter((m) => m.seq > after && m.seq < first);
      for (const m of aged.sort((a, b) => a.seq - b.seq)) listener(m);
      for (let i = h; i < l.length; i++) if (l[i].seq > after) listener(l[i]);
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

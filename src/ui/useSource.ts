// src/ui/useSource.ts — feed a store from an AgentSource (the chart and
// useAgentTelemetry share it).

import { useEffect, useRef } from 'react';
import type { AgentStore } from '../core/store';
import type { AgentSource } from '../stream';
import { warnOnce } from '../core/constants';

/**
 * Subscribe `store` to `source`. Re-subscribing to the same source
 * (StrictMode, a remount of the effect) resumes after the last message
 * applied; a different source (or none) first resets what the previous one
 * fed, so nothing is counted twice.
 */
export function useSourceSubscription(store: AgentStore, source: AgentSource | undefined): void {
  const seenRef = useRef<{ source?: AgentSource; seq: number; changes: number }>({ seq: 0, changes: 0 });
  useEffect(() => {
    const seen = seenRef.current;
    if (!source || typeof source.subscribe !== 'function') {
      // Source taken away: what it fed goes.
      if (seen.source) {
        store.resetSource(performance.now());
        store.publish();
      }
      seen.source = undefined;
      return;
    }
    if (seen.source !== source) {
      // A different source replays from the start: what the previous one
      // fed goes first, so nothing is counted twice.
      if (seen.source) {
        store.resetSource(performance.now());
        store.publish();
        if (++seen.changes === 3) {
          warnOnce('source-identity', 'The `source` prop changed 3 times; create it once (useAgentStream, or at module scope), not on every render.');
        }
      }
      seen.source = source;
      seen.seq = 0;
    }
    const unsubscribe = source.subscribe((m) => {
      if (m.seq <= seenRef.current.seq) return;
      seenRef.current.seq = m.seq;
      const now = performance.now();
      const n = store.list.length;
      if (m.type === 'event') {
        store.ensure(m.id, m.event.time ?? now, now);
        store.push(m.id, m.event, now);
      } else if (m.type === 'agent') {
        store.describe(m.id, m, now);
        store.publish();
      } else {
        store.removeAuto(m.id);
      }
      if (store.list.length !== n) store.publish();
    }, seenRef.current.seq);
    return unsubscribe;
  }, [source, store]);
}

// src/statuslog.ts
//
// Sparse per-agent status history. Status is discrete and changes rarely (an
// agent stays 'active' across thousands of telemetry samples, then briefly goes
// 'stuck'), so storing a status on every numeric sample would be wasteful and
// would push string work into the render hot path. Instead we record only
// TRANSITIONS — one entry when the status actually changes — and answer
// "what status was active at time T?" with a binary search over that small list.
//
// This is what lets the hover tooltip report the status at the hovered point
// (not just the agent's current status) and lets the draw loop color line
// segments by status without per-sample overhead.

import type { AgentStatus } from './AgentStat';

export interface StatusTransition {
  /** Timestamp (performance.now() domain) at which this status became active. */
  t: number;
  status: AgentStatus;
}

export class StatusLog {
  private transitions: StatusTransition[] = [];
  private readonly hardCap: number;

  constructor(hardCap = 2_000) {
    this.hardCap = Math.max(2, hardCap);
  }

  get length(): number {
    return this.transitions.length;
  }

  /**
   * Record that `status` is active as of time `t`. No-op if it matches the most
   * recent recorded status (we only store genuine transitions). Assumes
   * monotonic `t` (callers pass increasing timestamps).
   */
  record(t: number, status: AgentStatus): void {
    const n = this.transitions.length;
    if (n > 0 && this.transitions[n - 1].status === status) return;
    this.transitions.push({ t, status });
    if (this.transitions.length > this.hardCap) {
      // Drop oldest transitions; the remaining list still defines status for
      // all times at or after its new first entry.
      this.transitions.splice(0, this.transitions.length - this.hardCap);
    }
  }

  /**
   * The status in effect at time `t`: the status of the latest transition whose
   * timestamp is ≤ t. Returns undefined only if the log is empty or t precedes
   * the first recorded transition. Binary search, O(log n).
   */
  statusAt(t: number): AgentStatus | undefined {
    const a = this.transitions;
    if (a.length === 0) return undefined;
    if (t < a[0].t) return undefined;
    let lo = 0;
    let hi = a.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid].t <= t) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return a[ans].status;
  }

  /** Drop transitions strictly older than `t`, except keep the one in effect at `t`. */
  evictOlderThan(t: number): void {
    const a = this.transitions;
    if (a.length === 0) return;
    // Find the last transition with timestamp <= t; everything before it is
    // redundant for queries at or after t.
    let keepFrom = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i].t <= t) keepFrom = i;
      else break;
    }
    if (keepFrom > 0) this.transitions.splice(0, keepFrom);
  }

  /** All transitions within [fromT, toT], plus the one active at fromT. For segment coloring. */
  transitionsInRange(fromT: number, toT: number): StatusTransition[] {
    const a = this.transitions;
    if (a.length === 0) return [];
    const out: StatusTransition[] = [];
    // The status active at the window's start.
    const startStatus = this.statusAt(fromT);
    if (startStatus !== undefined) out.push({ t: fromT, status: startStatus });
    for (let i = 0; i < a.length; i++) {
      if (a[i].t > fromT && a[i].t <= toT) out.push(a[i]);
    }
    return out;
  }
}

// src/core/runs.ts — run tracking shared by the adapters whose sources report
// nested runs (LangChain callbacks/streamEvents, OpenTelemetry spans):
// model, tool and other ("chain") runs with parents, turned into AgentStat
// events per agent. React-free and server-safe.

import type { AgentEvent } from '../types';
import type { EventSink } from '../ai-sdk';

/** What is known about a run when its agent is chosen. */
export type RunInfo = {
  /** The run's name (model, tool or chain). */
  name?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
};

/** What a finished model run reported. */
export type ModelOutput = {
  /** Output tokens it reported (used if it didn't stream). */
  tokens?: number;
  /** Its output text (counted if it didn't stream and reported no tokens). */
  text?: string;
  /** It asked for tools (or structured output): its agent goes on with them. */
  callsTools?: boolean;
  /** When its output began, if it's reported as one block at the end. */
  since?: number;
};

export interface RunMapperOptions {
  /** The agent of a model or tool run: a fixed id, or chosen per run. */
  pick: string | ((run: RunInfo) => string | undefined);
  count: (text: string) => number;
  /** Runs carry no parent ids: everything belongs to the first run until it ends. */
  implicitRoot: boolean;
  /** What to do with an error thrown by the sink (default: let it throw). */
  report?: (err: unknown) => void;
  /**
   * Tools may run unreported (the app runs them): an agent whose model call
   * asked for tools is `waiting` until its next call, not handing over.
   */
  toolsOutside?: boolean;
}

type Kind = 'model' | 'tool' | 'chain';
type Run = { kind: Kind; root: string; agent?: string; name: string; streamed: boolean };

/**
 * An agent starts when its first model or tool run opens. When its last one
 * closes it is handing over (a tool call, the next model call) until it
 * continues — or until another agent of the same invocation starts a new
 * turn, or the invocation ends: then it finishes. The end of the outermost
 * run (the root) closes whatever it left open. Every method takes an optional
 * event time (`performance.now()` clock); without one, events are timed on
 * arrival.
 */
export function createRunMapper(sink: EventSink, options: RunMapperOptions) {
  const { pick, count, implicitRoot, report, toolsOutside } = options;
  const runs = new Map<string, Run>();
  // Open model/tool runs per agent; agents not finished; agents per root.
  const open = new Map<string, number>();
  const busy = new Set<string>();
  const byRoot = new Map<string, Set<string>>();
  // Agents with nothing open that haven't finished: root they belong to.
  const handover = new Map<string, string>();
  // Agents that reported an error since their last start.
  const failed = new Set<string>();
  // Agents waiting on tools that run unreported (toolsOutside).
  const outside = new Set<string>();
  let current: string | undefined;

  const emit = (id: string, e: AgentEvent, t?: number) => {
    // Whatever the agent does next ends its wait on unreported tools.
    if (outside.delete(id)) emit(id, { type: 'tool-end', name: 'tools' }, t);
    if (e.type === 'finish') busy.delete(id);
    else busy.add(id);
    if (e.type === 'error') failed.add(id);
    if (e.type === 'start') failed.delete(id);
    if (t !== undefined) e = { ...e, time: t };
    if (!report) return sink.push(id, e);
    try {
      sink.push(id, e);
    } catch (err) {
      report(err);
    }
  };

  const begin = (runId: string, parentRunId: string | undefined, kind: Kind, run: RunInfo, t?: number) => {
    // A second start for an open run: the handler is attached twice.
    if (runs.has(runId)) return undefined;
    const parent = parentRunId === undefined ? undefined : runs.get(parentRunId);
    // A run whose parent this mapper never saw (or that has none) is a root.
    const root = parent ? parent.root : implicitRoot && current !== undefined ? current : runId;
    if (implicitRoot && current === undefined) current = root;
    let agent: string | undefined;
    if (kind !== 'chain') {
      const id = typeof pick === 'function' ? pick(run) : pick;
      if (typeof id === 'string' && id) agent = id;
    }
    // Starting a new turn (not already working): see handover below.
    const fresh = !!agent && !busy.has(agent);
    const r: Run = { kind, root, agent, name: run.name ?? '', streamed: false };
    runs.set(runId, r);
    // Another agent starting a new turn in the invocation: agents that
    // handed over and didn't continue are done (agents working in parallel
    // aren't). The agent's own next run continues it.
    if (kind !== 'chain') {
      for (const [other, otherRoot] of Array.from(handover)) {
        if (other === agent) handover.delete(other);
        else if (fresh && otherRoot === root) {
          handover.delete(other);
          if (!open.has(other)) emit(other, { type: 'finish' }, t);
        }
      }
    }
    if (agent) {
      open.set(agent, (open.get(agent) ?? 0) + 1);
      const set = byRoot.get(root) ?? new Set<string>();
      set.add(agent);
      byRoot.set(root, set);
    }
    return r;
  };

  /** Close a run; returns its agent if that agent has nothing else open. */
  const close = (runId: string, r: Run): string | undefined => {
    runs.delete(runId);
    if (!r.agent) return undefined;
    const n = (open.get(r.agent) ?? 1) - 1;
    if (n > 0) {
      open.set(r.agent, n);
      return undefined;
    }
    open.delete(r.agent);
    return r.agent;
  };

  const endRoot = (rootId: string, error: boolean, t?: number) => {
    // Runs it left open (no end event came) close with it.
    for (const [id, r] of Array.from(runs)) if (r.root === rootId) close(id, r);
    for (const agent of byRoot.get(rootId) ?? []) {
      if (open.has(agent)) continue;
      // A failed invocation counts against every agent it used, even ones
      // that had already finished — once: not again for an agent whose own
      // run reported it.
      if (error && !failed.has(agent)) emit(agent, { type: 'error' }, t);
      if (busy.has(agent)) emit(agent, { type: 'finish' }, t);
      handover.delete(agent);
    }
    byRoot.delete(rootId);
    if (current === rootId) current = undefined;
  };

  const ended = (runId: string, r: Run, error: boolean, t?: number) => {
    if (r.root === runId) endRoot(runId, error, t);
  };

  return {
    chainStart(runId: string, parentRunId?: string, t?: number) {
      begin(runId, parentRunId, 'chain', {}, t);
    },
    chainEnd(runId: string, error: boolean, t?: number) {
      const r = runs.get(runId);
      if (!r) return;
      runs.delete(runId);
      ended(runId, r, error, t);
    },
    modelStart(runId: string, parentRunId: string | undefined, run: RunInfo, t?: number) {
      const r = begin(runId, parentRunId, 'model', run, t);
      // Only the agent's first open run starts it (concurrent calls, or a
      // model inside a tool, continue what's running).
      if (r?.agent && open.get(r.agent) === 1) emit(r.agent, { type: 'start' }, t);
    },
    token(runId: string, text: string, t?: number) {
      const r = runs.get(runId);
      if (!r?.agent || !text) return;
      r.streamed = true;
      emit(r.agent, { type: 'tokens', count: count(text) }, t);
    },
    modelEnd(runId: string, out: ModelOutput | undefined, error = false, t?: number) {
      const r = runs.get(runId);
      if (!r) return;
      if (r.agent) {
        if (error) emit(r.agent, { type: 'error' }, t);
        // A model that didn't stream: its whole output arrives now.
        else if (!r.streamed) {
          const n = out?.tokens ?? count(out?.text ?? '');
          if (n > 0) emit(r.agent, { type: 'tokens', count: n, ...(out?.since !== undefined ? { since: out.since } : {}) }, t);
        }
      }
      const idle = close(runId, r);
      if (idle) {
        // Asked for tools (or structured output): hand over to what's next
        // — or, when tools run unreported, wait on them.
        if (!error && out?.callsTools) {
          if (toolsOutside) {
            emit(idle, { type: 'tool-start', name: 'tools' }, t);
            outside.add(idle);
            // A call that is its own root: the app runs the tools and calls
            // again; the agent waits until then (or shutdown).
            if (r.root === runId) return void byRoot.delete(runId);
          } else handover.set(idle, r.root);
        } else emit(idle, { type: 'finish' }, t);
      }
      // A model call at the root reported its own error above.
      ended(runId, r, false, t);
    },
    toolStart(runId: string, parentRunId: string | undefined, run: RunInfo, t?: number) {
      const r = begin(runId, parentRunId, 'tool', run, t);
      if (r?.agent) emit(r.agent, { type: 'tool-start', name: r.name }, t);
    },
    toolEnd(runId: string, error: boolean, t?: number) {
      const r = runs.get(runId);
      if (!r) return;
      if (r.agent) emit(r.agent, { type: 'tool-end', name: r.name, error }, t);
      // Nothing else open: the agent's next model call continues it; another
      // agent starting (a supervisor handed off) finishes it.
      const idle = close(runId, r);
      if (idle) handover.set(idle, r.root);
      ended(runId, r, false, t);
    },
    /** An agent's own run ended (e.g. an invoke_agent span): it's done if idle. */
    agentEnd(agent: string, t?: number) {
      if (open.has(agent) || !busy.has(agent)) return;
      handover.delete(agent);
      emit(agent, { type: 'finish' }, t);
    },
    /** End everything (a stream that stopped or threw). */
    endAll(error: boolean) {
      // Roots with agents need ending; the rest only need forgetting.
      for (const root of Array.from(byRoot.keys())) endRoot(root, error);
      for (const agent of Array.from(outside)) emit(agent, { type: 'finish' });
      runs.clear();
      handover.clear();
      current = undefined;
    },
  };
}

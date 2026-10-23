// src/otel.ts — `@dan-build/agentstat/otel`
//
// OpenTelemetry GenAI spans → AgentStat events, as a span processor for any
// OTel-instrumented agent framework. No dependency on @opentelemetry/*:
// spans are read structurally (SDK 1.x and 2.x). Framework-free and
// server-safe.
//
// Mapping (GenAI semantic conventions, `gen_ai.operation.name`):
//   chat / text_completion / generate_content → a model call: start at the
//     span's start; at its end, `gen_ai.usage.output_tokens` as output (spans
//     don't stream, so a call's rate is its average), then complete — or, if
//     `gen_ai.response.finish_reasons` asks for tools, waiting on them.
//   execute_tool → a tool call (`gen_ai.tool.name`), `waiting`.
//   invoke_agent / create_agent → the agent (`gen_ai.agent.name`) that the
//     spans under it belong to; its end completes the agent.
//   anything else → structure only (a root span's end closes what it left).

import type { AdapterOptions, EventSink } from './ai-sdk';
import { createRunMapper } from './core/runs';

export type { AdapterOptions, EventSink };
export type { AgentEvent } from './types';

/** A span as the SDK passes it to a processor (only what AgentStat reads). */
export type OtelSpan = {
  name?: string;
  attributes?: Record<string, unknown>;
  /** [seconds, nanoseconds] since the epoch. */
  startTime?: [number, number];
  endTime?: [number, number];
  /** 2 = ERROR. */
  status?: { code?: number };
  spanContext(): { spanId: string };
  /** SDK 2.x. */
  parentSpanContext?: { spanId?: string };
  /** SDK 1.x. */
  parentSpanId?: string;
};

/** What the agent of a span is chosen from. */
export type OtelSpanInfo = {
  name?: string;
  attributes: Record<string, unknown>;
  /** The nearest enclosing invoke_agent / create_agent span's agent. */
  agent?: string;
};

export interface OtelOptions extends AdapterOptions {
  /**
   * The agent a span belongs to. Default: its enclosing agent span's
   * `gen_ai.agent.name` (or `.id`), else `'agent'`. A string replaces the
   * `'agent'` fallback; a function decides every span.
   */
  agentId?: string | ((span: OtelSpanInfo) => string | undefined);
}

const MODEL = new Set(['chat', 'text_completion', 'generate_content']);
const AGENT = new Set(['invoke_agent', 'create_agent']);
const estimate = (text: string) => text.length / 4;

/** HrTime → this process's performance.now() clock. */
const timeOf = (hr?: [number, number]) =>
  Array.isArray(hr) && typeof performance !== 'undefined'
    ? hr[0] * 1000 + hr[1] / 1e6 - performance.timeOrigin
    : undefined;

const agentName = (a: Record<string, unknown>) => {
  const v = a['gen_ai.agent.name'] ?? a['gen_ai.agent.id'];
  return typeof v === 'string' && v ? v : undefined;
};

/** The span processor AgentStat implements (OpenTelemetry's SpanProcessor shape). */
export interface AgentStatSpanProcessor {
  onStart(span: OtelSpan, parentContext?: unknown): void;
  onEnd(span: OtelSpan): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * A span processor that turns GenAI spans into AgentStat events. Register it
 * next to your exporter:
 *
 * ```ts
 * import { createOtelProcessor } from '@dan-build/agentstat/otel';
 * const provider = new NodeTracerProvider({
 *   spanProcessors: [createOtelProcessor(stream), new BatchSpanProcessor(exporter)],
 * });
 * ```
 */
export function createOtelProcessor(sink: EventSink, options: OtelOptions = {}): AgentStatSpanProcessor {
  const pick = options.agentId;
  const fallback = typeof pick === 'string' && pick ? pick : 'agent';
  const m = createRunMapper(sink, {
    // The run's metadata carries the span info (see `info` below).
    pick: (run) => {
      const span = run.metadata as OtelSpanInfo;
      return typeof pick === 'function' ? pick(span) : (span.agent ?? fallback);
    },
    count: options.countTokens ?? estimate,
    implicitRoot: false,
    // A failing sink must not break the instrumented code.
    report: (err) => console.error('[agentstat]', err),
  });
  // Agent of each open span (inherited from its enclosing agent span).
  const agentOf = new Map<string, string | undefined>();
  const kindOf = new Map<string, string>();

  return {
    onStart(span) {
      const id = span.spanContext?.().spanId;
      if (!id) return;
      const a = span.attributes ?? {};
      const parent = span.parentSpanContext?.spanId ?? span.parentSpanId;
      const op = String(a['gen_ai.operation.name'] ?? '');
      const agent = (AGENT.has(op) ? agentName(a) : undefined) ?? (parent ? agentOf.get(parent) : undefined);
      agentOf.set(id, agent);
      const info: OtelSpanInfo = { name: span.name, attributes: a, agent };
      const t = timeOf(span.startTime);
      const kind = MODEL.has(op) ? 'model' : op === 'execute_tool' ? 'tool' : 'chain';
      kindOf.set(id, kind);
      const run = { name: kind === 'tool' ? String(a['gen_ai.tool.name'] ?? span.name ?? '') : span.name, metadata: info };
      if (kind === 'model') m.modelStart(id, parent, run, t);
      else if (kind === 'tool') m.toolStart(id, parent, run, t);
      else m.chainStart(id, parent, t);
    },
    onEnd(span) {
      const id = span.spanContext?.().spanId;
      if (!id) return;
      const a = span.attributes ?? {};
      const t = timeOf(span.endTime);
      const error = span.status?.code === 2;
      const kind = kindOf.get(id);
      kindOf.delete(id);
      const agent = agentOf.get(id);
      agentOf.delete(id);
      if (kind === 'model') {
        const tokens = Number(a['gen_ai.usage.output_tokens']);
        const reasons = a['gen_ai.response.finish_reasons'];
        const list = Array.isArray(reasons) ? reasons.map(String) : typeof reasons === 'string' ? [reasons] : [];
        m.modelEnd(
          id,
          {
            tokens: Number.isFinite(tokens) && tokens >= 0 ? tokens : undefined,
            callsTools: list.some((r) => /tool/i.test(r)),
          },
          error,
          t
        );
      } else if (kind === 'tool') m.toolEnd(id, error, t);
      else {
        m.chainEnd(id, error, t);
        // An agent span ended: the agent is done (unless still working).
        if (AGENT.has(String(a['gen_ai.operation.name'] ?? '')) && agent) {
          const own = typeof pick === 'function' ? pick({ name: span.name, attributes: a, agent }) : agent;
          if (own) m.agentEnd(own, t);
        }
      }
    },
    forceFlush: () => Promise.resolve(),
    shutdown() {
      m.endAll(false);
      return Promise.resolve();
    },
  };
}

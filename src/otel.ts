// src/otel.ts — `@dan-build/agentstat/otel`
//
// OpenTelemetry GenAI spans → AgentStat events, as a span processor for any
// OTel-instrumented agent framework. No dependency on @opentelemetry/*:
// spans are read structurally (SDK 1.x and 2.x). Framework-free and
// server-safe.
//
// Mapping (GenAI semantic conventions, `gen_ai.operation.name`):
//   chat / text_completion / generate_content → a model call: start at the
//     span's start; at its end its output (`gen_ai.usage.output_tokens`, else
//     the text of `gen_ai.output.messages`) at its average rate since its
//     first chunk (`…time_to_first_chunk`, which is also the TTFT) or its
//     start; then complete — or, if `gen_ai.response.finish_reasons` asks for
//     tools, waiting on them until the agent's next call (apps often run
//     tools without a span).
//   execute_tool → a tool call (`gen_ai.tool.name`), `waiting`.
//   invoke_agent → the agent (`gen_ai.agent.name`, else `.id`) the spans
//     under it belong to; its end completes the agent. A CLIENT one (a
//     remote agent) is the agent's whole run.
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
  /** SpanKind: 2 = CLIENT. */
  kind?: number;
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
const estimate = (text: string) => text.length / 4;

/**
 * HrTime → this process's performance.now() clock. The SDK stamps spans from
 * the wall clock (Date.now()), so convert with the current offset between
 * the two, not with the page's time origin (they drift apart).
 */
const timeOf = (hr?: [number, number]) =>
  Array.isArray(hr) && typeof performance !== 'undefined'
    ? hr[0] * 1000 + hr[1] / 1e6 - (Date.now() - performance.now())
    : undefined;

/** Seconds attribute → ms, or undefined. */
const seconds = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v * 1000 : undefined);

/** Text of `gen_ai.output.messages` (a JSON string or an array of messages with parts). */
function outputText(v: unknown): string {
  let msgs: unknown = v;
  if (typeof v === 'string') {
    try {
      msgs = JSON.parse(v);
    } catch {
      return '';
    }
  }
  let out = '';
  for (const msg of Array.isArray(msgs) ? msgs : []) {
    for (const p of Array.isArray(msg?.parts) ? msg.parts : []) if (typeof p?.content === 'string') out += p.content;
  }
  return out;
}

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
    // Apps often run the tools a model asked for without a span; one not
    // followed by another call within 2 minutes is done.
    toolsOutsideMs: 120_000,
    // A failing sink must not break the instrumented code.
    report: (err) => report(err),
  });
  const report = (err: unknown) => console.error('[agentstat]', err);
  type Span = { kind: string; agent?: string; start?: number };
  // Open spans: kind, agent, start time.
  const spans = new Map<string, Span>();

  const start = (span: OtelSpan) => {
    const id = span.spanContext?.().spanId;
    if (!id) return;
    const a = span.attributes ?? {};
    const parentId = span.parentSpanContext?.spanId ?? span.parentSpanId;
    const parent = parentId ? spans.get(parentId) : undefined;
    const op = String(a['gen_ai.operation.name'] ?? '');
    // The span's own agent name (e.g. on execute_tool), else its agent span's.
    const agent = agentName(a) ?? parent?.agent;
    const t = timeOf(span.startTime);
    // A remote agent (CLIENT invoke_agent span) runs like one model call.
    const remote = op === 'invoke_agent' && span.kind === 2;
    const kind = MODEL.has(op) || remote ? 'model' : op === 'execute_tool' ? 'tool' : 'chain';
    spans.set(id, { kind, agent, start: t });
    const run = {
      name: kind === 'tool' ? String(a['gen_ai.tool.name'] ?? span.name ?? '') : span.name,
      metadata: { name: span.name, attributes: a, agent },
    };
    if (kind === 'model') m.modelStart(id, parentId, run, t);
    else if (kind === 'tool') m.toolStart(id, parentId, run, t);
    else m.chainStart(id, parentId, t);
  };

  const end = (span: OtelSpan) => {
    const id = span.spanContext?.().spanId;
    const s = id ? spans.get(id) : undefined;
    if (!id || !s) return;
    spans.delete(id);
    const a = span.attributes ?? {};
    const t = timeOf(span.endTime);
    const error = span.status?.code === 2;
    if (s.kind === 'model') {
      const tokens = Number(a['gen_ai.usage.output_tokens']);
      const reasons = a['gen_ai.response.finish_reasons'];
      const list = Array.isArray(reasons) ? reasons.map(String) : typeof reasons === 'string' ? [reasons] : [];
      const ttfc = seconds(a['gen_ai.response.time_to_first_chunk'] ?? a['gen_ai.client.operation.time_to_first_chunk']);
      const reported = Number.isFinite(tokens) && tokens >= 0 && a['gen_ai.usage.output_tokens'] !== undefined;
      m.modelEnd(
        id,
        {
          tokens: reported ? tokens : undefined,
          // Parsed only when needed: recorded outputs can be large.
          text: reported ? undefined : outputText(a['gen_ai.output.messages']),
          callsTools: list.some((r) => /tool/i.test(r)),
          since: s.start === undefined ? undefined : s.start + (ttfc ?? 0),
        },
        error,
        t
      );
    } else if (s.kind === 'tool') m.toolEnd(id, error, t);
    else {
      m.chainEnd(id, error, t);
      if (String(a['gen_ai.operation.name'] ?? '') !== 'invoke_agent') return;
      const own = typeof pick === 'function' ? pick({ name: span.name, attributes: a, agent: s.agent }) : (s.agent ?? fallback);
      if (own) m.agentEnd(own, t);
    }
  };

  // Telemetry must never break the instrumented code.
  const safe = (fn: (span: OtelSpan) => void) => (span: OtelSpan) => {
    try {
      fn(span);
    } catch (err) {
      report(err);
    }
  };

  return {
    onStart: safe(start),
    onEnd: safe(end),
    forceFlush: () => Promise.resolve(),
    shutdown() {
      m.endAll(false);
      spans.clear();
      return Promise.resolve();
    },
  };
}

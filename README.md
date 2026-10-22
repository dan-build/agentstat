# AgentStat

[![npm version](https://img.shields.io/npm/v/@dan-build/agentstat?style=flat-square)](https://www.npmjs.com/package/@dan-build/agentstat)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@dan-build/agentstat?style=flat-square&label=min%2Bgzip)](https://bundlephobia.com/package/@dan-build/agentstat)
[![types](https://img.shields.io/npm/types/@dan-build/agentstat?style=flat-square)](https://www.npmjs.com/package/@dan-build/agentstat)
[![license](https://img.shields.io/npm/l/@dan-build/agentstat?style=flat-square)](./LICENSE)

**Live telemetry for LLM agents, rendered honestly.**

A React component that shows what your agents are doing right now: token rate,
progress and status over time, a health score built only from signals you
actually provide, and opt-in detection of stalls, runaway spikes and status
thrashing. One canvas, about 17 KB min+gzip, no dependencies besides React.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/dan-build/agentstat/main/docs/screenshot-dark.png">
  <img src="https://raw.githubusercontent.com/dan-build/agentstat/main/docs/screenshot-light.png" alt="AgentStat showing three agents' token rates over 30 seconds. The Coder agent has stopped producing output while still reporting Active, and a red marker reads “Coder · stalled 15s while active”. A tooltip inspects a Planner sample: 3.3 t/s, 46%, Thinking." width="100%">
</picture>

---

## Quick start

```bash
npm install @dan-build/agentstat
```

```tsx
'use client';
import { AgentStat, demoAgents } from '@dan-build/agentstat';

export default function Demo() {
  return <AgentStat agents={demoAgents} simulateData height={400} />;
}
```

`simulateData` drives the chart with demo data, so you can check the install
before wiring anything. Pass `simulateData={{ seed: 1 }}` for a reproducible run
(screenshots, visual tests).

## Your own agents

The `agents` prop is the roster — which agents exist and in what order. Live
values arrive through the ref:

```tsx
'use client';
import { useMemo, useRef } from 'react';
import { AgentStat, createAgent, type AgentStatRef } from '@dan-build/agentstat';

export default function Monitor() {
  const ref = useRef<AgentStatRef>(null);
  const agents = useMemo(() => [createAgent('planner', 'Planner'), createAgent('coder', 'Coder')], []);

  // Forward what your stream emits (stream callbacks, WebSocket, SSE, MCP, …):
  // ref.current?.push('planner', { type: 'tokens', count: 12 });

  return <AgentStat ref={ref} agents={agents} metric="tokens" anomalyDetection height={420} />;
}
```

### Event streams

`createAgentStream()` (or `useAgentStream()` in a component) gives you a
source to push events into from anywhere, even before a chart mounts. Agents
appear on the chart as their first events arrive, so no roster is needed:

```tsx
const stream = createAgentStream(); // e.g. module-level, or useAgentStream()

stream.push('coder', { type: 'tokens', count: 7 });
stream.describe('coder', { name: 'Coder' }); // optional: name, color, config
stream.remove('coder');                      // optional

<AgentStat source={stream} metric="tokens" anomalyDetection />
```

The stream keeps the last 5 minutes of events, and a chart that mounts later
replays them at their original times (`time`, if you pass one, uses the
`performance.now()` clock). Agents in the `agents` prop come first (and their
names and colors win); stream agents follow in arrival order, including an
agent you removed from the prop if its events keep coming. The event types are
those of `push` below.

Create the stream once — `useAgentStream()`, or at module scope — and pass the
same object on every render: a different `source` (or none) starts the
chart's stream data over — the agents it added, and everything recorded for
`agents`-prop agents it fed, including what you sent them through the ref — and
replays the new one's history.

### From a server

When the agents run on a server (a route handler, a worker), stream their
events to the browser over Server-Sent Events with
`@dan-build/agentstat/sse`:

```ts
// server — e.g. app/api/agents/route.ts (any Fetch-API runtime)
import { createAgentStream } from '@dan-build/agentstat';
import { createSseHandler } from '@dan-build/agentstat/sse';

export const stream = createAgentStream(); // feed it with the adapters below
export const GET = createSseHandler(stream);
```

```tsx
// browser
import { connectSse } from '@dan-build/agentstat/sse';

const source = useMemo(() => connectSse('/api/agents'), []);
<AgentStat source={source} metric="tokens" anomalyDetection />
```

A chart that connects gets the stream's last 5 minutes, then live events; it
reconnects after a drop and resumes where it stopped. Event times are
corrected for the difference between the server's clock and the browser's.
The endpoint exposes your agents' telemetry, so protect it like any route:
`createSseHandler(request => …)` can pick a stream per request (return
`undefined` for a 404).

### Stream events

`push` takes raw events, and AgentStat derives the token rate, time to first
token, inter-token latency and status from them, so you don't compute rates:

```ts
ref.current?.push('coder', { type: 'start' });                     // → thinking
ref.current?.push('coder', { type: 'tokens', count: 7 });          // → active (or { total: 1240 })
ref.current?.push('coder', { type: 'tool-start', name: 'bash' });  // → waiting
ref.current?.push('coder', { type: 'tool-end', name: 'bash' });    // → thinking
ref.current?.push('coder', { type: 'finish' });                    // → complete
ref.current?.getStats('coder'); // { totalTokens, ttftMs, interTokenMs, tool, statusMs }
```

Every event takes an optional `time` (`performance.now()` clock; a time before
something already recorded for the agent is moved up to it). Tool calls can
nest or run in parallel; the agent is `waiting` while any is open. TTFT also
feeds the health score's latency trend. Send `finish` when a run ends: an
agent left `active` with no output is a stall.

`total` is a running count for the agent: the first one only sets the starting
point, and a smaller one than before starts a new count. A status you set with
`updateAgent` (`stuck`, `hallucinating`) holds until you change it there.

### Samples

If you already have rates, `updateAgent` takes a partial sample, so report
only what changed:

```ts
ref.current?.updateAgent('planner', { tokensRate: 18.4 });
ref.current?.updateAgent('planner', { status: 'thinking' });
ref.current?.updateAgent('planner', { latencyMs: 820, progress: 40 });
ref.current?.updateAgent('planner', { status: 'waiting' }); // tool call, subagents, a person
```

Use `push` or `updateAgent`'s `tokensRate` for an agent, not both.

The positional form `updateAgent(id, tokensRate, progress, status)` still works.

Input is validated: `NaN`, `Infinity`, unknown statuses and unknown ids are
ignored with a one-time console warning instead of breaking the chart.

Changing `name`, `color`, `config` or `visible` on an existing agent in the
`agents` prop is applied. Passing a new array with the same agents on every
render is fine.

### Vercel AI SDK

`@dan-build/agentstat/ai-sdk` (AI SDK v5–v7; no dependency on `ai`, and it
also runs on the server):

```tsx
import { createChatTracker, tapAiSdkStream } from '@dan-build/agentstat/ai-sdk';

// useChat: call the tracker whenever messages or status change.
const track = useMemo(() => createChatTracker(stream, 'chat'), [stream]);
const { messages, status } = useChat();
useEffect(() => track(messages, status), [track, messages, status]);

// streamText: feed its full stream (or use createAiSdkTap per part).
const result = streamText({ model, prompt, tools });
await tapAiSdkStream(stream, 'writer', result.fullStream);
```

Text and reasoning count as output (with the stream taps, tool-call arguments
too); a tool call is `waiting` until its result. After a request ends, the
chat tracker keeps waiting only on a call awaiting approval or on tools you
list in `{ clientTools: ['askUser'] }` (tools your frontend runs), so a person
taking over 5 minutes shows as a stall (`waitingStallMs`); other open calls
end with the request (e.g. the user pressed Stop). The chat tracker
doesn't report messages that were there on its first call or that change
while no request runs (restored history, `setMessages`). Token counts are
estimated from characters (~4 per token); pass `{ countTokens }` for exact
ones. Full example:
[`examples/vercel-ai-sdk.tsx`](./examples/vercel-ai-sdk.tsx).

### LangChain and LangGraph

`@dan-build/agentstat/langchain` (LangChain.js / LangGraph.js; no dependency on
`@langchain/*`) works from callbacks or from `streamEvents`:

```ts
import { bySubgraph, createLangChainCallbacks, tapLangChainStream } from '@dan-build/agentstat/langchain';

// Callbacks: pass to an invocation (once); child runs inherit them.
await agent.invoke(input, { callbacks: [createLangChainCallbacks(stream, { agentId: 'researcher' })] });

// LangGraph multi-agent: one chart agent per sub-agent (supervisor, swarm).
await tapLangChainStream(stream, graph.streamEvents(input, { version: 'v2' }), { agentId: bySubgraph('supervisor') });
```

An agent is busy while it has a model or tool run open — streamed tokens (or
the reported output tokens of a call that didn't stream), and tool calls as
`waiting` — and complete once nothing is running; the end of the invocation
closes whatever it left open, failing the agents if it errored (a stopped
run, via an AbortSignal, isn't an error). Between its runs an agent counts as busy
(`thinking` after a tool), so a graph node that works for over 30 s without
a model or tool call reads as a thinking stall until the run ends.
`streamEvents` has no error events, so feed it through `tapLangChainStream`
(or call `tap.end(true)` from `createLangChainTap` when the stream throws).

`agentId` can be a function of the run (`{ name, metadata, tags }`).
`bySubgraph(fallback)` routes a run to its `createAgent` agent's name, else to
the LangGraph subgraph it runs in (each agent of a supervisor or swarm), else
to `fallback`. An agent called from inside a tool routes by name only if it
has one; nested teams collapse to the outer team.

### AG-UI

`@dan-build/agentstat/ag-ui` maps AG-UI protocol events (no dependency on
`@ag-ui/*`):

```ts
import { createAgUiTap } from '@dan-build/agentstat/ag-ui';

const tap = createAgUiTap(stream, 'researcher');
agent.subscribe({
  onEvent: ({ event }) => tap(event),
  // A failed connection sends no event: end the run yourself.
  onRunFailed: () => tap({ type: 'RUN_ERROR' }),
});
```

Runs map to start/finish (`RUN_ERROR` counts an error), message, reasoning
and tool-argument deltas to output, and a tool call is `waiting` from
`TOOL_CALL_END` to `TOOL_CALL_RESULT` (or the end of the run, for tools your
frontend runs). A stopped run (`RUN_ERROR` with code `abort`) isn't counted
as an error. Subagent events are left to their own agents; give a child
agent's own stream its own tap.
Pass events as the AG-UI client delivers them: it expands `*_CHUNK` events,
and raw chunk streams lose tool calls.

More integrations — LangChain, WebSocket/SSE, MCP — are in the
[integration guide](https://agentstat.sdaniel.cc/docs/real-data-integration/).

---

## What you see

- **Lines over time** for progress (`metric="progress"`), token rate
  (`"tokens"`), or both on two axes (`"both"`). The default, `"auto"`, plots
  progress once every visible agent reports it and token rate otherwise.
  Progress an agent never reported is unknown, not 0%: under `"progress"` or
  `"both"` it has no progress line (its token line and markers still show),
  it reads "–" when inspected, and `getLiveMetrics` says `progressKnown:
  false`. Time is labelled relative to now.
- **A live tip** at the right edge for agents that are reporting. An agent that
  stops reporting keeps its line where its data ends; nothing is extrapolated.
- **A legend** to show or hide agents. It stays on one row; agents that don't
  fit move into a "+N" menu with a "Show all" shortcut. Hidden agents are
  still monitored.
- **A panel** with each agent's rate, health and status (text and icon, not
  color alone). By default it steps aside on small charts so the data stays
  readable (`panel="auto"`; or `"always"` / `"never"`).
- **Hover or keyboard inspection** of any sample, with its age, rate, progress
  and the status it had at that moment.

With no `windowSeconds`, the chart shows up to the last 10 s, anchored to the
newest sample. Set `windowSeconds` (e.g. `60`, `300`, `900`) for a longer
wall-clock window; long windows are downsampled to the canvas resolution.

## Anomaly detection

```tsx
<AgentStat
  agents={agents}
  anomalyDetection
  onAnomaly={(agentId, anomaly) => console.warn(agentId, anomaly.message)}
/>
```

| Kind | Meaning | How it's detected |
|------|---------|-------------------|
| **stall** | Claims to be working but isn't producing — a hung call, a dropped stream. | Output below 5% of the agent's normal rate for 10 s while `active` (30 s while `thinking`, since reasoning is quiet), or no data at all for that long. While `waiting`, only a wait over 5 minutes (`waitingStallMs`). |
| **spike** | A runaway: burning tokens far above normal. | Compared with the agent's own usual peak: a sustained jump (last second ≥ 1.5×), a lone burst (≥ 4×), or a climb that keeps rising over 30 s. Bursty output and resuming after a pause don't count. |
| **thrash** | Flapping between states. | 4 status changes within 4 s that involve a problem state (moving between `active`, `thinking`, `waiting` and `complete` is normal). |

Each anomaly carries the numbers that triggered it (`stalled 12s while active`,
`runaway output 100/s (4.4× the usual peak of ~23/s)`).

- **Markers:** warning = ▲ amber, critical = ◆ red. Each marker shows the agent's
  name.
- **Screen readers:** new and resolved anomalies are announced through live
  regions.
- **Callbacks:** `onAnomaly` fires once when an anomaly starts (and once more if
  it escalates to critical); `onAnomalyEnd` fires once when it ends.
- **Measured, not guessed:** `npm run eval:detectors` replays labelled
  scenarios through the real store, including an adversarial set and a holdout
  set written by independent reviewers.

**Limitations.** The detectors only see token rate and status, so keep the
status current (including `complete` when an agent is idle):

- **Report waiting.** A tool call, an orchestrator waiting on workers, or a
  user who stopped typing all look like "no output". With `push`, tool calls
  set `waiting` for you; otherwise report `waiting` (or `complete` while
  idle). Waiting reported as `active` alerts after 10 s, as `thinking` after
  30 s.
- **A wait that never ends** is only flagged after `waitingStallMs` (5 min):
  AgentStat can't tell that the workers an orchestrator waits on are gone.
- **Requests that differ a lot in speed** (one run at 80 t/s, the next at
  150) can briefly read as a runaway after a pause.
- **Tool-call loops** that only alternate working states aren't flagged as
  thrash: that alternation is also how healthy agents work.
- **Rates computed per small chunk** (alternating 0 and high values) can hide
  runaways; use `push`, or send a rate averaged over about a second.
- **If you only send rates and never a status**, only a stream that goes
  completely silent counts as a stall. Sending a status even once turns full
  stall detection on.

```tsx
<AgentStat agents={agents} anomalyDetection anomalyConfig={{ stallDurationMs: 20_000, spikeRatio: 2 }} />
```

The detector also works without the chart:

```ts
import { detectAnomalies } from '@dan-build/agentstat';
const found = detectAnomalies(tokenSamples, statusChanges, 'active', performance.now());
```

## Health score

`onHealthChange` and `ref.getHealth(id)` return:

| Field | Meaning |
|-------|---------|
| `score` | 0–100 composite over the components below that have data, minus penalties for active anomalies. |
| `tokenEfficiency` | How close the recent average rate is to `config.expectedTokensPerSec` (100 = inside the band). |
| `stability` | Steadiness of the token rate relative to its own level. |
| `hallucinationRisk` | **Only from your signal**: `1 − confidenceScore` if you pass one, 100 while you report status `'hallucinating'`, otherwise `null`. Telemetry can't detect hallucinations. |
| `latencyTrend` | Direction of the `latencyMs` you report (`improving` / `stable` / `degrading`), `null` until there are four samples. |

---

## API

### Props

| Prop | Type | Default | |
|------|------|---------|---|
| `agents` | `Agent[]` | `[]` | The roster. |
| `height` | `number \| string` | `520` | Any CSS length. Width is always 100%. |
| `metric` | `'auto' \| 'progress' \| 'tokens' \| 'both'` | `'auto'` | Which series to plot; `'auto'` = progress once every visible agent reports it, else token rate. |
| `windowSeconds` | `number` | — | Wall-clock window. Unset: last 10 s of data. |
| `theme` | `'light' \| 'dark' \| 'system'` | inferred | Unset: dark if `styles.background` is dark. |
| `styles` | `{ background, borderColor, textColor, gridColor }` | — | Any CSS color, including `var(--token)`. |
| `tokenAxisMax` | `number` | auto | Pin the token axis. Auto rises instantly, eases down slowly. |
| `referenceLine` | `{ value, label?, color? }` | — | Against the left axis. |
| `smoothing` | `number` in `[0, 1)` | `0` | Display-only; damps spikes on screen, never in data. |
| `anomalyDetection` | `boolean` | `false` | |
| `anomalyConfig` | `Partial<AnomalyConfig>` | — | Merged over `DEFAULT_ANOMALY_CONFIG`. |
| `onAnomaly` | `(id, anomaly) => void` | — | Once per anomaly, plus escalation. |
| `onAnomalyEnd` | `(id, anomaly) => void` | — | Once when an anomaly ends. |
| `onHealthChange` | `(id, health) => void` | — | When the score or a signal changes. |
| `onPointClick` | `(id, point) => void` | — | Click or Enter on a sample. |
| `simulateData` | `boolean \| { seed?: number }` | `false` | Demo data. |
| `maxHistoryPoints` | `number` | `100000` | Memory cap per series; retention is time-based. |
| `panel` | `'auto' \| 'always' \| 'never'` | `'auto'` | The per-agent panel; `auto` hides it under 560 × 340 px. |
| `ariaLabel` | `string` | generated | Accessible name of the chart. |
| `className`, `style` | | — | Applied to the root. |

### Ref

```ts
interface AgentStatRef {
  updateAgent(id: string, sample: AgentSample): void;
  updateAgent(id: string, tokensRate: number, progress: number, status: AgentStatus): void;
  getHealth(id: string): HealthMetrics | undefined;
  getAnomalies(id: string): Anomaly[];
  getLiveMetrics(id: string): { tokensRate: number; progress: number; status: AgentStatus; progressKnown: boolean } | undefined;
  push(id: string, event: AgentEvent): void;
  getStats(id: string): AgentStreamStats | undefined;
}

type AgentEvent = { time?: number } & (
  | { type: 'start' }
  | { type: 'tokens'; count?: number; total?: number }
  | { type: 'tool-start'; name?: string }
  | { type: 'tool-end'; name?: string; error?: boolean }
  | { type: 'error' }
  | { type: 'finish' }
);

type AgentSample = {
  tokensRate?: number;
  progress?: number;        // 0–100
  status?: AgentStatus;     // 'active' | 'thinking' | 'waiting' | 'stuck' | 'complete' | 'hallucinating'
  latencyMs?: number;       // enables latencyTrend
  confidenceScore?: number; // 0–1, enables hallucinationRisk
  errorCount?: number;
};
```

### Agent

```ts
type Agent = {
  id: string;
  name: string;
  color?: string;          // any CSS color; omit to use the theme palette
  current: { tokensRate: number; progress: number; status: AgentStatus };
  config?: { expectedTokensPerSec?: [number, number] };
  visible?: boolean;       // initial visibility, default true
};
```

`createAgent(id, name, color?)` builds one with zeroed values.

---

## Theming

Light and dark themes ship built in. All text clears WCAG AA contrast, and the
default series palette is hue-distinct and at least 3:1 against both
backgrounds. Use `theme="system"` to follow the OS, or `styles` to match your
surface:

```tsx
<AgentStat agents={agents} theme="dark" styles={{ background: 'var(--surface-1)' }} />
```

Omit `color` on agents to use the palette, which switches with the theme.

## Accessibility

- **The chart:** a focusable image whose description summarizes every visible
  agent (status, rate, health).
- **Keyboard:** <kbd>←</kbd>/<kbd>→</kbd> step through samples, <kbd>↑</kbd>/<kbd>↓</kbd>
  switch agent, <kbd>Home</kbd>/<kbd>End</kbd> jump, <kbd>Enter</kbd> activates
  the sample, <kbd>Esc</kbd> clears, <kbd>Space</kbd> pauses.
- **Controls:** legend chips and Pause are toggle buttons (`aria-pressed`) with
  visible focus rings and 24 px targets.
- **Announcements:** anomalies go to a polite live region, and critical ones to
  an alert region.
- **Reduced motion:** with `prefers-reduced-motion`, the live dot stops pulsing,
  values snap instead of easing, and controls don't scale on press.
- **Not color alone:** status and severity are always paired with text, icons
  or marker shapes.
- **Any language:** the chart is laid out left to right in every locale, since
  time runs left to right. Agent names in any script, including Arabic and
  Hebrew, render correctly.

## Framework notes

- **Next.js App Router:** the build ships with `'use client'`, so you can import
  it from server components. It server-renders the legend and panel, then draws
  on the client.
- **React:** 18 and 19.
- **Modules:** ESM and CommonJS, typed for both.
- **Tree-shaking:** importing only `detectAnomalies` adds about 1 KB.

## Browser support

Evergreen browsers from 2022 on: Chrome/Edge 94+, Firefox 93+, Safari 15.4+.

## Documentation

- [Overview](https://agentstat.sdaniel.cc/docs/overview/)
- [Real data integration](https://agentstat.sdaniel.cc/docs/real-data-integration/)
- [API reference](https://agentstat.sdaniel.cc/docs/api-reference/)
- [Examples](https://agentstat.sdaniel.cc/docs/examples/)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Security issues: [SECURITY.md](./SECURITY.md).

## License

MIT © [dan-build](https://github.com/dan-build)

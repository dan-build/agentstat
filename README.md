# AgentStat

<!--
  Badges — uncomment after the first `npm publish`. These hit npm's registry
  for real-time numbers, so they'll 404 until the package actually exists.

  [![npm version](https://img.shields.io/npm/v/agentstat?style=flat-square)](https://www.npmjs.com/package/agentstat)
  [![bundle size](https://img.shields.io/bundlephobia/minzip/agentstat?style=flat-square&label=min%2Bgzip)](https://bundlephobia.com/package/agentstat)
  [![types](https://img.shields.io/npm/types/agentstat?style=flat-square)](https://www.npmjs.com/package/agentstat)
  [![license](https://img.shields.io/npm/l/agentstat?style=flat-square)](./LICENSE)
-->

**Real-time agent telemetry, rendered honestly.**  
A lightweight, canvas-powered React component for live LLM and agent monitoring —
live token rates, progress, status transitions, health scoring, and opt-in
anomaly detection.

<!--
  Demo recording — replace demo.gif with a ~30s screen capture of
  `npm run dev` showing the live chart animating and the trigger buttons
  driving status/progress. Recommended: 800×450, < 2MB, loop silently.
  Placeholder is intentionally left here so a missing GIF renders as
  alt text, not a broken image icon.
-->
![AgentStat demo — live token rates, progress, and health scoring](./demo.gif)

Catmull-Rom splines with a stable time-anchored axis, a unified live tip, status
transitions, automatic health scoring, and opt-in anomaly detection — built for
long-running production monitoring on a single canvas.

---

## Quick Start

```bash
npm install @dan-build/agentstat
# package name is finalized at publish time; examples below use `agentstat`
```

A live-animating chart in four lines, with the built-in simulation and a ready-made roster of demo agents:

```tsx
'use client';
import { AgentStat, demoAgents } from '@dan-build/agentstat';

export default function Demo() {
  return <AgentStat agents={demoAgents} simulateData height={400} />;
}
```

That's it. No agent objects to construct, no ref, no wiring. Use this to verify the install and see what the component looks like.

When you're ready for your own agents, `createAgent(id, name, color?)` fills in the structural defaults so you only name what matters:

```tsx
import { AgentStat, createAgent } from '@dan-build/agentstat';

const agents = [
  createAgent('chat-agent', 'Chat Assistant', '#1d4ed8'),
  createAgent('planner',    'Planner',        '#B91C1C'),
];

export default function MyMonitor() {
  return <AgentStat agents={agents} simulateData height={400} />;
}
```

> **⚠️ Memoize your `agents` array.** Either wrap it in `useMemo` or declare it at module scope. AgentStat treats `agents` as the *roster* — which agents exist and in what order — and reads runtime values (`tokensRate`, `progress`, `status`, `visible`) from its own internal store, which is updated by `ref.current.updateAgent(...)`. Passing a fresh array literal on every render is fine **as long as the id list doesn't change**; if it does, any per-agent state for ids that were added/removed is resynced. Use `updateAgent` for runtime values — changes to `color`, `config`, etc. on existing agents via the `agents` prop are not applied.

---

## Production

In production, AgentStat visualises your real telemetry — it does **not** simulate data. `simulateData` defaults to `false`; push live metrics imperatively via the ref:

```tsx
'use client';

import { useRef } from 'react';
import { AgentStat, type Agent, type AgentStatRef } from '@dan-build/agentstat';

const agent: Agent = {
  id: 'chat-agent',
  name: 'Chat Assistant',
  color: '#1d4ed8',
  data: [],
  current: { tokensRate: 0, progress: 0, status: 'active' },
  visible: true,
};

export default function MonitoredChat() {
  const ref = useRef<AgentStatRef>(null);

  // Wire this up to your telemetry source (Vercel AI SDK, LangChain, WS/SSE, MCP, …).
  // ref.current?.updateAgent('chat-agent', tokensPerSecond, progressPercent, 'active');

  return (
    <AgentStat
      ref={ref}
      agents={[agent]}
      simulateData={false}
      height={560}
    />
  );
}
```

See the full integration guide for ready-made patterns:  
**[→ Real Data Integration](https://agentstat.sdaniel.cc/docs/real-data-integration/)** — Vercel AI SDK (`useCompletion`), LangChain / LangGraph, WebSocket / SSE, Model Context Protocol (MCP), VS Code extensions.

---

## Features

- **Buttery smooth curves** — Catmull-Rom splines with zero jitter
- **Live pulsing dot** with soft glow and area fill
- **Automatic health scoring** — token efficiency, stability, hallucination risk, latency trend
- **Multi-agent support** with individual visibility toggles
- **Hover tooltips & click callbacks**
- **Fully imperative ref API** — works perfectly with Vercel AI SDK, LangChain, WebSocket, MCP, etc.
```tsx
import { AgentStat, demoAgents } from '@dan-build/agentstat';

// Plot token rate on an auto-scaled axis
<AgentStat agents={demoAgents} metric="tokens" simulateData height={400} />

// Dual-axis: progress (left, solid) + token rate (right, dashed)
<AgentStat agents={demoAgents} metric="both" simulateData height={400} />

// Pin the token axis ceiling for a stable scale
<AgentStat agents={demoAgents} metric="tokens" tokenAxisMax={50} height={400} />
```


- **Retina-ready & performant** — built for long-running production monitoring

> **History window.** With no `windowSeconds` set, the chart shows a bounded
> rolling view of recent activity (a fixed span, kept short so the line renders
> without downsampling and stays stable). Set **`windowSeconds`** for an explicit
> time-based sliding window (e.g. 60 / 300 / 900), which slices each agent's
> buffer to that span and downsamples (LTTB) when the slice has more points than
> the canvas can resolve. `maxHistoryPoints` remains as a buffer cap but is no
> longer the primary control now that eviction is time-based — see `ROADMAP.md`.

---

## Anomaly detection

AgentStat doesn't just plot your agent's metrics — it can *understand* them.
Turn on `anomalyDetection` and it watches each agent's token-rate and status
streams and automatically flags the moments that matter:

```tsx
<AgentStat
  agents={agents}
  anomalyDetection
  onAnomaly={(agentId, anomaly) => {
    console.warn(`[${agentId}] ${anomaly.kind}: ${anomaly.message}`);
    // e.g. page on-call, write to your logging pipeline, etc.
  }}
/>
```

That's the whole setup. Anomalies appear on the chart as markers (a guide line,
a colored dot, and a label) and fire `onAnomaly`. It works even with a single
agent and a handful of data points — you don't need production scale to see it
catch a stall.

### What it detects

| Kind | What it means | How it's detected |
|------|---------------|-------------------|
| **stall** | The agent claims to be working (`active`/`thinking`) but isn't producing tokens — a hung tool call, deadlock, or infinite wait. | Token rate at/near zero for a sustained period while status is active. |
| **spike** | A runaway loop — the agent suddenly burns tokens far above its normal rate. | Statistical outlier (z-score) vs the agent's *own* rolling baseline, so it self-calibrates per agent. |
| **thrash** | The agent is unstable, flipping between states. | Status changes more than N times within a short window. |

Each anomaly is **explainable** — it carries the numbers that triggered it, e.g.
`stalled 8s while active` or `token spike 80/s (3.2σ above ~10/s)`.

### Tuning

Defaults are conservative. Override any threshold via `anomalyConfig`:

```tsx
<AgentStat
  agents={agents}
  anomalyDetection
  anomalyConfig={{
    stallDurationMs: 3000,  // flag a stall after 3s (default 5s)
    spikeZScore: 4,         // require a bigger outlier (default 3)
    thrashChangeCount: 6,   // tolerate more status churn (default 4)
  }}
/>
```

### Reading anomalies programmatically

```tsx
const ref = useRef<AgentStatRef>(null);
// ...
const active = ref.current?.getAnomalies('chat-agent') ?? [];
if (active.some(a => a.kind === 'stall')) { /* ... */ }
```

### Health score

When detection is on, the per-agent **health score** is penalized by these real,
observed signals (a stall counts against health more than a transient spike).
This is grounded in actual behavior rather than a hand-supplied confidence value.

### Use it standalone

The detector is exported, so you can run it on your own buffers without the
chart:

```tsx
import { detectAnomalies, DEFAULT_ANOMALY_CONFIG } from '@dan-build/agentstat';

const anomalies = detectAnomalies(
  tokenSamples,   // {t, v}[]
  statusChanges,  // {t, status}[]
  currentStatus,
  performance.now(),
  DEFAULT_ANOMALY_CONFIG
);
```

> **Note:** detection is opt-in and off by default. The thresholds are reasoned
> defaults, not tuned against a corpus of real agents — the on-chart markers make
> miscalibration obvious, so tune to your workload.


## Browser support

AgentStat uses Canvas2D and modern CSS color syntax (`rgb(r g b / alpha)`). This means effectively **Chromium 111+, Firefox 113+, Safari 16.4+** (all shipped in 2023). If you need to support older browsers, pin to a transpile target that polyfills these.

---

## Documentation

- [Overview & Features](https://agentstat.sdaniel.cc/docs/overview/)
- [Real Data Integration](https://agentstat.sdaniel.cc/docs/real-data-integration/)
- [API Reference](https://agentstat.sdaniel.cc/docs/api-reference/)
- [Examples](https://agentstat.sdaniel.cc/docs/examples/)

---

## License

MIT © [dan-build](https://github.com/dan-build)
---
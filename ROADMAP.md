# Roadmap

Status as of v0.4.0. See `CHANGELOG.md` for what shipped.

## Shipped

- **v0.2:** time-based windowing, LTTB downsampling, load-tested at 10 agents
  / 20 Hz.
- **v0.3:** stall / spike / thrash anomaly detection; a rendering-correctness
  pass.
- **v0.4:** input hardening and a crash-proof render loop; health metrics only
  from real signals; partial `updateAgent`; light/dark/system theming; keyboard
  and screen-reader support; gated CI and publishing.

## Next — v0.5: core architecture

- Split the component into a framework-free store (`useSyncExternalStore`), a
  renderer, shared scales and small UI pieces.
- Typed-array ring buffers and incremental per-pixel min/max downsampling, so
  long windows cost the same as short ones.
- Monotone curve interpolation, so the drawn line can't overshoot the data.
- More robust detectors: median/MAD baselines with hysteresis, and level-shift
  detection for runaway loops.
- Event-based ingest: report token counts and tool calls; the library derives
  rate, time-to-first-token and inter-token latency.
- Status-colored line segments, using the status history already kept.

## Then — v0.6: zero-wiring adapters

- `createAgentStream()` / `useAgentStream()` and `<AgentStat source={stream} />`.
- Adapters for the Vercel AI SDK, AG-UI events, LangChain / LangGraph callbacks,
  OpenTelemetry GenAI spans, and SSE / WebSocket.
- Small companion components: status badge, stall banner, step timeline.

## Later

- A local OTLP receiver (`npx agentstat`) for a live view of coding agents and
  orchestrators.
- A web-component build for non-React hosts and editor webviews.
- Thresholds calibrated on real agent traces.

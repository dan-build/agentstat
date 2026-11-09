# Desktop spike

Throwaway code that answers three questions before the real app is built. Measured on the
oldest Mac we support: MacBook Pro (2015, Intel i5-5257U, Iris 6100), macOS 12.7.6,
Command Line Tools only (no Xcode).

| Binary | Question |
|---|---|
| `agentstat-spike` | Does GPUI build and open a window without Xcode? |
| `chart` | Can GPUI draw a live multi-agent chart smoothly? (`SERIES`, `POINTS`, `MODE`, `STROKE`, `GROUP`, `SECS`) |
| `otlp` | Does Claude Code's OpenTelemetry reach a local receiver, and what does it send? |

```sh
cd desktop
cargo build --release -p agentstat-spike --bins
SECS=20 SERIES=8 ./target/release/chart
./target/release/otlp   # then run claude with OTEL_* pointed at http://127.0.0.1:4318, protocol http/json
```

## Results (2026-11-08)

**Build: yes.** `gpui` 0.2.2 from crates.io with the `runtime_shaders` feature compiles the
Metal shaders at launch, so no Xcode is needed. Cold release build 17.5 min, incremental
~2.5 min; release binary 4 MB. Deployment target macOS 12.

**Drawing: yes, for the views we plan; no for 50 full-width lines.** Cost grows with the
total number of line points, not the number of paths (merging paths didn't help).

| Scene | Redraw | fps | paint p50 | CPU (one core) |
|---|---|---|---|---|
| empty window | every frame | 74 | — | 9% |
| empty window | on data (20 Hz) | 19 | — | 4% |
| detail chart, 8 agents × 600 points | every frame | 71 | 2.5 ms | 63% |
| detail chart, 8 agents × 600 points | on data (20 Hz) | 18 | 1.3 ms | 15% |
| fleet, 50 agents × 60 points | on data (20 Hz) | 19 | 0.8 ms | 11% |
| 50 agents × 600 points, custom strip | every frame | 16 | 20 ms | 73% |
| 50 agents × 600 points, GPUI stroker | every frame | 13–15 | 27–29 ms | 64–72% |

The custom triangle-strip stroker (mitered joins, no tessellator) beats GPUI's general
stroker by ~30% on paint time.

**Telemetry: yes.** With `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_{METRICS,LOGS}_EXPORTER=otlp`,
`OTEL_EXPORTER_OTLP_PROTOCOL=http/json` and the endpoint set, Claude Code sends
`claude_code.token.usage` / `cost.usage` / `session.count` / `active_time.total` metrics and
`api_request`, `tool_decision`, `tool_result`, `user_prompt`, `assistant_response` events, all
keyed by `session.id`. Tokens arrive once per model call (with `duration_ms`), not streamed;
prompt text is not included by default.

# AgentStat desktop

The native side of AgentStat: a local service, its command line, and a GPUI
app. A Cargo workspace:

| Crate | What it is |
|---|---|
| `core` (`agentstat-core`) | The telemetry logic (event ingest, status, rates, health, anomaly detection), ported from `src/` and checked against it on every eval scenario. |
| `daemon` (`agentstat`) | The local service and the `agentstat` command. |
| `app` (`agentstat-app`) | The desktop app (GPUI, macOS): every agent on this machine, live. |
| `spike` | Throwaway code from the GPUI go/no-go spike. |

## The `agentstat` command

```sh
cargo build --release -p agentstat
./target/release/agentstat run -- claude      # Claude Code, with its telemetry going to AgentStat
./target/release/agentstat watch              # live table of every agent
```

`run` starts the service in the background if needed and runs the command
with OpenTelemetry pointed at it (`CLAUDE_CODE_ENABLE_TELEMETRY=1`,
OTLP/HTTP JSON to `http://127.0.0.1:4318`). Any OpenTelemetry SDK configured
the same way works; only Claude Code's events are mapped so far.

The service listens on 127.0.0.1 only and answers only requests addressed to
localhost:

| Endpoint | |
|---|---|
| `POST /v1/logs` | OTLP/HTTP JSON log records. |
| `GET /v1/agents` | Every agent: status, rate, tokens, tool, health, anomalies. |
| `GET /v1/stream` | Server-Sent Events in the npm library's format: `connectSse('http://127.0.0.1:4318/v1/stream')` feeds `<AgentStat source>`. |

Prompt and response text is never read or stored.

## The app

```sh
cargo build --release -p agentstat-app -p agentstat
./target/release/agentstat-app
```

It reads the service's stream (starting the service if it isn't running) into
the same core store the npm chart uses: a fleet list with each agent's status
and a sparkline, the selected agent's last minute, and recent anomalies. Calls
reported when they end (Claude Code) are drawn as plateaus at their average
rate, never as invented instantaneous rates. Light and dark follow the system.

It redraws twice a second when nothing is moving, and 25 times a second while
the selected agent works and the window is in front (on a 2015 dual-core Intel:
about 1% and 6% of one core). `AGENTSTAT_DEBUG=1` logs the redraw rate.

## Tests

```sh
npm run parity:gen                  # at the repo root: traces from the TypeScript code
cargo test --release -p agentstat-core -p agentstat
```

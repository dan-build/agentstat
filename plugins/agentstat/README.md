# AgentStat for Claude Code

Every Claude Code session and subagent, live in AgentStat: a turn starting and
ending, each tool starting and ending (and whether it failed), subagents as
their own rows, named after the project you're in.

## Install

You need the `agentstat` command (its service receives the events, and the
desktop app and `agentstat watch` show them):

```sh
cargo install --path desktop/daemon   # from a checkout of dan-build/agentstat
```

Then, in Claude Code:

```
/plugin marketplace add dan-build/agentstat
/plugin install agentstat@agentstat
```

Start the service once with `agentstat serve` (the desktop app starts it for
you). For token counts as well, run Claude Code through `agentstat run -- claude`,
which also turns on Claude Code's OpenTelemetry; the plugin and telemetry
work together without counting anything twice.

## What it sends, and where

Each hook posts its input to `http://127.0.0.1:4318/v1/hooks/claude` (set
`AGENTSTAT_PORT` to change the port; `agentstat run` sets it for you). It's one
local request of a few milliseconds, made in order so the service sees events
as they happened; when the service isn't running it fails at once and Claude
carries on. Hook input includes your prompt and tool inputs and outputs: it
only travels to your own machine, and the service keeps names, ids and
timings and drops the rest. The service refuses data from web pages.

The plugin also adds an `agentstat` MCP server with one tool, `fleet_status`,
so Claude can see what your other agents are doing.

## Requirements and limits

- `curl` (built into macOS and most Linux systems). Windows needs Git Bash or WSL.
- The MCP server needs `agentstat` on your PATH; without it, `/mcp` shows it as
  failed and everything else still works.
- Interrupting Claude mid-reply sends no signal; that turn shows as ended when
  Claude Code reports it's waiting for input (about a minute later). Esc during
  a tool, and every normal turn, end at once.
- A tool you decline in the permission dialog stays open until the turn ends.

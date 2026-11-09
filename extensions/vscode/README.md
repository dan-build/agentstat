# AgentStat for VS Code

Your agents, live, without leaving the editor: every Claude Code session (and
anything else reporting to AgentStat) in the status bar, and a panel with each
agent's status, output and the last five minutes of what it did.

- **Status bar:** how many agents are working; a warning when one stalls,
  runs away or flaps. Hover for every agent's status, click for the panel.
- **Panel** (`AgentStat: Show Agents`): active anomalies, a table of agents
  (status, tool, tokens, health), and a timeline per agent.

Works in VS Code and in editors built on it, such as Cursor.

## Setup

AgentStat runs a small local service that agents report to. Install the
`agentstat` command, then connect Claude Code with the plugin:

```
/plugin marketplace add dan-build/agentstat
/plugin install agentstat@agentstat
```

If the service isn't running, the status bar says so; click it to start it.

## Settings

- `agentstat.port`: the service's port on 127.0.0.1 (default 4318).

Nothing leaves your machine: the extension talks only to the service on
127.0.0.1, and the panel has no network access.

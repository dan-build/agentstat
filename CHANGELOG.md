# Changelog

All notable changes to AgentStat are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/).

## [0.1.2] — 2026-06-17

### Added
- `maxHistoryPoints?: number` prop (default: 420) — makes the internal rolling buffer size configurable. Addresses the v0.1 "most recent ~420 samples" limitation and gives consumers control over memory footprint vs. visible history depth for long-running production monitors.
- `className?: string` and `style?: React.CSSProperties` on the root container — first-class support for design-system integration, Tailwind classes, emotion, etc.
- Hardened input sanitization in `updateAgent(...)` and the built-in simulator: `tokensRate` is clamped to `≥ 0`; `progress` is clamped to `[0, 100]`. Prevents malformed telemetry from breaking the chart or health math.

### Changed
- Buffer eviction logic now respects `maxHistoryPoints` everywhere (update path + simulation path).
- Pause UX is now visually obvious: a subtle "PAUSED" label is drawn directly on the canvas when the chart is paused.
- Documentation refreshed: README now highlights the new props and updated "History window" guidance; CHANGELOG Known Limitations section revised to reflect configurability.

### Fixed / Robustness
- Minor hardening around short/empty buffers in health scoring and drawing (no behavior change for normal usage).
- All existing tests continue to pass; new props are covered by expanded type surface and manual verification paths.

This is a focused **professionalization and robustness release**. No breaking changes. The component is now even easier to drop into real production dashboards while giving power users the dials they asked for.

## [0.1.1] — 2026-04-21

### Fixed
- All install instructions, JSDoc comments, and example imports now use the correct scoped package name `@dan-build/agentstat`.

## [0.1.0] — 2026-04-20

Initial public release.

### Added

- `AgentStat` React component rendering live LLM/agent telemetry to a canvas — token rates, progress, status, and a composite health score per agent.
- `createAgent(id, name, color?)` — one-line factory for the common `Agent` shape, filling in `data`, `current`, and `visible` defaults.
- `demoAgents` — ready-made 3-agent roster (Researcher / Critic / Executor) for demos, docs, and first-run exploration. Pair with `simulateData` for a zero-wiring chart.
- Imperative ref API: `updateAgent(id, tokensRate, progress, status)`, `getHealth(id)`, `getLiveMetrics(id)`.
- Automatic health scoring via `calculateHealth` — weights token efficiency, stability, hallucination risk, and latency trend; self-renormalizes when `latencyMs` is not provided so healthy agents reach 100.
- Built-in simulation mode (`simulateData: true`) for demos; disabled by default in production.
- Per-agent visibility toggles, hover tooltips with `onSpikeClick` callback, keyboard pause (spacebar), auto-theming from `styles.background`.
- DPR-aware canvas rendering with pixel-accurate hover hit-testing.
- Ref-driven animation loop (empty deps, refs-only reads) — the RAF loop is created once and never restarts.
- Canvas a11y: `role="img"`, dynamic `aria-label`, `:focus-visible` keyboard outline.
- Full TypeScript type exports: `Agent`, `AgentDataPoint`, `AgentStatus`, `AgentStatProps`, `AgentStatRef`, `HealthMetrics`.

### Tooling

- ESM + CJS builds via tsup; `.d.ts` declarations for both module systems.
- Vitest test suite covering `calculateHealth`, the `initialAgents` merge logic, robustness to missing props, and the public API surface.
- ESLint flat config (ESLint 9) scoped to `src/`.
- GitHub Actions CI running typecheck, lint, test, and build on push to `main` and all PRs.

### Known limitations

- The chart shows the most recent ~420 samples per agent. On-screen time span depends on the consumer's `updateAgent` call rate. A configurable time window is planned for v0.2 — see `ROADMAP.md`.
- Performance has been verified at the demo configuration (3 agents, sim tick). Validated load testing at higher scale (10 agents × 20 Hz, 30-minute session) is planned for v0.2.

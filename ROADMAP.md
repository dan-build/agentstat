# Roadmap

Status as of v0.3.0. The big v0.2 items (time-based windowing, downsampling,
validated load testing) and the v0.3 items (anomaly detection plus a rendering
correctness pass) have shipped — see `CHANGELOG.md`. This file now tracks what's
next.

## Shipped

- **v0.2 — Configurable time window.** Time-indexed buffers (`{t, value}`),
  `windowSeconds` prop, LTTB downsampling for long windows, and a per-input
  downsample cache. Done.
- **v0.2 — Validated load testing.** `dev/Stress.tsx` harness; dirty-frame
  rendering and downsample-cache fixes brought INP into the "good" band at the
  10-agent / 20 Hz target. Done.
- **v0.3 — Anomaly detection.** Stall / spike / thrash detection from the agent's
  own streams, with on-chart markers and `onAnomaly`. Done.
- **v0.3 — Rendering correctness pass.** Stable time-anchored x-domain, bounded
  default rolling view, always-on time eviction, unified live tip, sticky token
  axis, representative health metrics, and curve-quality improvements. Done.

## Next (candidate v0.4)

### Surface the default view as a prop

`DEFAULT_VIEW_MS` (the no-window visible span) is currently an internal constant
(10 s). It should become a `defaultViewSeconds?: number` prop so consumers can
tune the live view without forking. Additive, non-breaking. The value is
deliberately short so the no-window line stays below the downsample threshold and
renders without LTTB; document that tradeoff if the prop is exposed.

### Resolve `maxHistoryPoints`

After time-based eviction became always-on, `maxHistoryPoints` is no longer the
primary memory control and its documented "~420 samples" framing is misleading.
Decide between (a) formally deprecating it with a clear migration note, or (b)
re-defining it as an explicit hard cap that coexists with time eviction. Either
way the prop's doc comment and the README should stop implying it governs the
visible window.

### Status-colored line segments

The per-point status data (`StatusLog`) already exists, but the line is not yet
shaded by status (e.g. tinting the stretch where an agent was `stuck` /
`hallucinating`). This is the natural next use of data we already retain.

### Fix the flaky `user-lock` sim test

One component test (`user-lock` sim re-roll) is intermittently flaky (~1 in 10)
due to RNG timing in the simulator. It's a test-harness timing issue, not a
product defect, but it should be made deterministic (inject the RNG or the clock)
so CI is trustworthy.

## Later (nice-to-haves)

- **Time-interpolated live tip.** The tip currently eases toward the latest
  sample; interpolating between the two most recent real samples by wall-clock
  time would make the leading edge even smoother at low update rates. It must not
  extrapolate past real data (no inventing future values — this is a telemetry
  tool).
- **Vertical-axis label customization.** Let consumers label/format the axis
  (units, custom ranges) rather than the fixed `%` / token-rate defaults.
- **Paused-tooltip mode.** Hovering while paused already freezes hover state
  cleanly; document and lightly formalize it.
- **Configurable sim recovery.** Make the simulator's auto-recovery timing
  configurable so demo scripting is easier.

# Changelog

All notable changes to AgentStat are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/).

## [0.3.0] — 2026-06-25

Two themes in this release. First, **anomaly detection** — the first feature that
does something a generic charting library fundamentally can't: it understands
*agent behavior*, not just plots numbers. Second, a thorough **rendering
correctness and quality pass** on the chart itself: the time axis, the live tip,
the curve, and the health readout were all reworked so what you see is an
accurate, stable reflection of the data. **No breaking changes** — every new
prop is additive and defaults to prior behavior.

### Added — anomaly detection

- **`anomalyDetection?: boolean`** (default `false`) — enable automatic detection
  of three real agent failure modes, derived purely from data the agent already
  emits (no consumer-supplied confidence magic):
  - **Stall** — token rate sits at/near zero for a sustained period *while the
    status still claims `active`/`thinking`*. The agent says it's working but
    isn't producing output (hung tool call, deadlock, infinite wait).
  - **Spike / runaway** — token rate jumps to a statistical outlier (z-score)
    against the agent's *own* rolling baseline. Self-calibrating, so it adapts to
    each agent's normal range instead of using brittle absolute thresholds.
  - **Thrash** — status oscillates rapidly (e.g. active→stuck→active→stuck)
    within a short window.
  When on, anomalies are drawn on the chart as markers (a dashed guide line, a
  severity-colored dot — amber for warning, red for critical — and a plain-
  language label like `stalled 8s while active` or
  `token spike 80/s (3.2σ above ~10/s)`), and reported via `onAnomaly`.
- **`anomalyConfig?: Partial<AnomalyConfig>`** — override detection thresholds
  (stall duration, spike z-score, thrash count/window, etc.). Merged over
  `DEFAULT_ANOMALY_CONFIG`; only the fields you set change.
- **`onAnomaly?: (agentId, anomaly) => void`** — fires once per distinct anomaly
  occurrence (not every frame, not every detection tick). Use it to log, alert,
  or page.
- **`ref.getAnomalies(id)`** — returns the anomalies currently active for an
  agent (empty array when none, or when detection is off).
- New exports: `detectAnomalies`, `DEFAULT_ANOMALY_CONFIG`, and the types
  `Anomaly`, `AnomalyKind`, `AnomalySeverity`, `AnomalyConfig` — so you can run
  detection standalone or type your own handlers.

### Fixed — chart rendering correctness

These fixes address cases where the rendered line did not faithfully or stably
represent the underlying data. They affect every consumer, not just the demo.

- **Time-axis warping (the line appeared to "rewrite history").** In the
  no-window view the x-domain was anchored to wall-clock time and to the oldest
  *downsampled* point, both of which shifted every frame — so the same data was
  re-projected onto a moving coordinate system and the line crawled and warped
  even though its values were fixed. The x-domain is now anchored to real sample
  timestamps over a fixed span: history holds its x-position and the line scrolls
  cleanly left. Applied identically to the draw loop and the hover hit-test so
  the two never disagree.
- **Progressive cramming / slowdown over a session.** With no window set, the
  view stretched to the buffer's entire (growing) extent, squeezing ever more
  time into the same pixels — the line condensed, downsampling worked harder, and
  point positions drifted as old samples evicted. The no-window view is now a
  bounded rolling window (see `DEFAULT_VIEW_MS`), so density stays constant and
  the draw cost stays flat regardless of session length.
- **Buffers never evicted in no-window mode.** Memory grew to the hard cap and
  the per-frame window slice walked thousands of stale points. Time-based
  eviction now always runs, bounded to the active view, so memory and slice cost
  stay bounded in every mode.
- **Live tip lagged the dot.** The newest sample and the lerped live dot were
  both pinned to the right edge at *different* y-values, leaving a tiny vertical
  segment that shrank as the lerp caught up — the dot appeared to lead while the
  line trailed behind it. The tip is now a single leading point the curve flows
  into, so the dot and the line end are the same point.
- **Token-axis instability.** The token-rate axis ceiling snapped to every change
  in the observed max, moving all historical points vertically on each rescale.
  It is now a *sticky* ceiling: it rises immediately so a spike never clips, holds
  steady through normal fluctuation (dead-band), and only eases downward slowly
  when the true max has dropped and stayed down.
- **Health numbers oscillated and didn't track the line.** `tokenEfficiency` was
  computed from a single instantaneous sample, so it jittered every tick. It now
  derives from a representative recent average (the same window stability uses),
  so the number reflects what the chart shows. Behavior verified unchanged
  against the existing health tests.

### Changed — chart rendering quality

- **Area fill follows the line's curve.** The filled area beneath each line was
  built from straight polyline segments while the line itself was a smooth
  spline, leaving a visibly jagged fill edge under a smooth curve. Both now trace
  the identical Catmull-Rom path.
- **Cleaner spline.** Round line joins replace the default miter (no sharp spikes
  at vertices), and spline control points are clamped to each segment's own span
  so steep changes can't overshoot into loops — a tidier, more faithful curve on
  spiky data.
- **`calculateHealth(agent, recentRates, anomalies?)`** now takes an optional
  third argument. When detected anomalies are passed, the composite health
  **score** is penalized by real, data-derived signals (a stall hurts more than
  a transient spike; critical more than warning). **Fully backward compatible:**
  called with the original two arguments (or an empty anomaly list), the score is
  byte-identical to 0.2.x — verified by the existing health tests, which pass
  unchanged.

### Added — view bounding

- **`DEFAULT_VIEW_MS`** — internal constant (currently 10 s) defining the visible
  span when no `windowSeconds` is set. Chosen so the visible sample count stays
  below the downsample threshold at typical update rates, keeping the line
  downsample-free and rock-stable. *Note for a future minor release: this is a
  strong candidate to surface as a `defaultViewSeconds` prop so consumers can
  tune it without a code change.*

### Demo / dev harness

- The `dev/` demo app was rebuilt as a locked single-screen "instrument" layout
  with a dark default and a light/dark toggle, a progress/tokens/both metric
  switch, folded-in trigger and health panels, and a recover control that clears
  a stuck/anomaly agent's user-lock. The demo is not part of the published
  package, but it now exercises the real component faithfully.

### Performance

- Detection runs on the existing 500 ms sync interval, **not** the render hot
  path — the animation loop only *renders* cached results. So this does not
  regress the input-latency / INP work from 0.2.0; an idle chart with detection
  on stays idle.
- The bounded default view keeps the no-window draw downsample-free in the common
  case, so per-frame chart cost stays flat as a session runs long.

### Tests

- 128 tests total (up from 94). New: the `anomaly` detector module (24 cases,
  including the false-positive edges — flat-baseline spikes, brief idle dips,
  healthy steady agents, division-by-zero guards) and component integration
  (off-by-default returns empty, `onAnomaly` fires once per occurrence, a
  healthy agent triggers nothing), plus health-score penalty tests. The
  rendering fixes above live in the draw/scale layer, which the existing
  stubbed-canvas suite intentionally does not pin; the health-metric change was
  verified against the existing health assertions.

### Known limitations / honest notes

- Default detection thresholds (3σ spike, 5 s stall, 4 status changes / 4 s
  thrash) are reasoned defaults, not field-tuned against a corpus of real agents.
  They are fully overridable via `anomalyConfig`, and the on-chart markers make
  miscalibration visible so you can tune to your workload.
- Detection is **opt-in**. With `anomalyDetection={false}` (the default) there is
  zero behavioral or performance change from 0.2.0's detection-free path.
- "Anomaly detection" here is explainable rolling statistics (z-score, flatline,
  transition frequency) — deliberately not a model and not branded "AI". Every
  flag carries the numbers that triggered it.
- `maxHistoryPoints` is now largely superseded by time-based eviction and the
  bounded default view; it is retained for compatibility but no longer the
  primary memory control. Expect it to be formally deprecated in a future minor.
- The live tip advances toward each new sample by interpolation; at update rates
  well below the frame rate the leading edge is smoothed but still chasing
  discrete samples (it does not predict future values — by design for a
  telemetry tool).

### Tests

- 128 tests total (up from 94). New: the `anomaly` detector module (24 cases,
  including the false-positive edges — flat-baseline spikes, brief idle dips,
  healthy steady agents, division-by-zero guards) and component integration
  (off-by-default returns empty, `onAnomaly` fires once per occurrence, a
  healthy agent triggers nothing), plus health-score penalty tests.

### Known limitations / honest notes

- Default thresholds (3σ spike, 5 s stall, 4 status changes / 4 s thrash) are
  reasoned defaults, not field-tuned against a corpus of real agents. They are
  fully overridable via `anomalyConfig`, and the on-chart markers make
  miscalibration visible so you can tune to your workload.
- Detection is **opt-in**. With `anomalyDetection={false}` (the default) there is
  zero behavioral or performance change from 0.2.0.
- "Anomaly detection" here is explainable rolling statistics (z-score, flatline,
  transition frequency) — deliberately not a model and not branded "AI". Every
  flag carries the numbers that triggered it.


## [0.2.0] — 2026-06-19

A feature-and-correctness release. Three things that matter: the chart can now
plot **token rate** (not just progress), it supports a **time-based sliding
window** with downsampling for long-running sessions, and several rendering
correctness/perf issues from the 0.1.x line are fixed. **No breaking changes** —
every new prop is additive and defaults to prior behavior.

### Added

- **`metric?: 'progress' | 'tokens' | 'both'`** (default `'progress'`). The chart
  was previously hardcoded to plot the progress curve even though token rate is
  the headline metric — so the rendered line did not match what the library
  advertised. Now:
  - `'progress'` — unchanged 0.1.x behavior (0–100% on a fixed left axis).
  - `'tokens'` — plots token rate on a **data-driven auto-scaled axis**, so a
    slow agent and a fast one are both legible instead of one flatlining.
  - `'both'` — **dual-axis**: progress on the left (solid), token rate on the
    right (dashed overlay), each on its own scale.
- **`tokenAxisMax?: number`** — pins the token-rate axis ceiling. Defaults to
  auto-scaling to the highest visible token rate (with headroom), rounded to a
  clean 1/2/5 × 10ⁿ value (e.g. 35 → 50, 99 → 100).
- **`windowSeconds?: number`** — show only the last N seconds of history as a
  time-based sliding window, independent of sample count, with a time-linear
  x-axis. Omit it for the legacy count-based view bounded by `maxHistoryPoints`.
- **`smoothing?: number`** (default `0` = off, range `[0, 1)`) — optional visual
  smoothing of the **rendered line only**, via an exponential moving average.
  Damps frame-to-frame jitter from noisy metrics. **Display-only and off by
  default by design:** it softens real spikes, so health scoring and hover
  tooltip values always read the raw data and are never affected — only the
  drawn curve is. Leave at 0 when faithfully seeing every spike matters more
  than a calm line.
- **`ChartMetric`** type exported from the package entry so consumers can type
  their own `metric` values.
- Internal `TimeSeriesBuffer` module (not part of the public API): O(1)
  amortized append, count cap, time-based eviction, window slicing, and
  **LTTB (Largest-Triangle-Three-Buckets) downsampling** that preserves visual
  peaks/troughs naive sampling would drop. Used for the windowed render path.
- Internal `StatusLog` module (not public API): a sparse per-agent log of status
  *transitions* (one entry per change, not per sample) with O(log n) `statusAt`
  lookup. Enables true per-point status history without per-sample overhead.

### Changed

- Buffers are now time-indexed (`{t, value}`) rather than raw `number[]`. Both
  write paths (`updateAgent` and the built-in simulator) timestamp samples and
  evict by time when a window is active.
- All value→pixel conversions — the drawn spline, live dot, axis labels, and the
  hover hit-test — now route through one shared scale derivation. This is a
  correctness invariant: the hover target sits exactly on the rendered line in
  every metric/window combination, where previously the hit-test could drift.
- The hover tooltip now reports the **real per-point timestamp and status** for
  the hovered sample. Time comes from the time-indexed buffer; status comes from
  the sparse status-transition log (`statusAt`), so hovering a historical point
  shows the status that was active *then*, not the agent's current status. It
  also reports both the progress and token-rate value at that point so the
  tooltip is fully self-consistent.
- The reference line is interpreted against the left axis (progress % when
  progress is shown, otherwise the token-rate scale) instead of always 0–100.

### Fixed

- **Hover hit-test correctness.** The tooltip could mis-associate or mislabel the
  hovered point; it now uses the same windowed/downsampled point set and scale
  as the draw loop, so what you hover is what's drawn.
- **Per-frame canvas allocations.** The 2D context was re-fetched every frame and
  the area-fill and line gradients were rebuilt every frame for every agent.
  Context is now cached; gradients are cached per (geometry, color) and reused
  until a resize or color change. At the demo roster this cut ~1,200 gradient
  allocations/sec to a handful, scaling linearly with agent count.
- **Downsample cache correctness in live mode.** The window/downsample cache
  initially invalidated on every sample append, defeating itself during live
  streaming. The cache key is now authoritative with a window-proportional
  recompute interval, so steady-state windowed rendering does near-zero
  redundant work.

### Performance

This release was validated with a real Chrome DevTools trace at the 10-agent /
20 Hz target scale (via the new dev-only `dev/Stress.tsx` harness), which
surfaced and fixed several bottlenecks that data-layer measurement alone had
missed:

- **Dirty-frame rendering.** The canvas previously redrew every animation frame
  unconditionally — even when nothing changed — saturating the main thread and
  starving user input (measured INP ~544 ms, dominated by input *delay*). The
  RAF loop now skips the redraw when nothing has changed (no new data, lines
  converged, no scrolling window, no resize/toggle), while still redrawing
  during animation and throttled redraws for a scrolling time window. Result:
  INP dropped from ~544 ms to ~16 ms (idle) and hover INP from ~216 ms to
  ~136 ms — both in the "good" band.
- **Downsample cache thrash (tokens/both mode).** The token-axis auto-scale scan
  and the draw loop requested different downsample resolutions from the same
  single-slot buffer cache, evicting each other every frame and forcing two full
  LTTB passes per buffer per frame. Both now share one target, so the scan reuses
  the draw's cached result (measured ~178× less buffer work in that path).
- **Spline density.** Rendered point density was ~2 points per horizontal pixel;
  reduced to ~1 per 2 px, which is visually identical after Catmull-Rom
  smoothing but ~4× fewer `bezierCurveTo` calls per frame.
- **Token-axis scan.** Reduced from an every-frame full-resolution buffer walk to
  a bucketed (~4×/sec) scan over a downsampled set, with hysteresis so the axis
  no longer visibly rescales each frame.
- **Hover lookup.** The companion-series lookup is now a copy-free O(log n)
  binary search on the buffer (`nearestValueAt`) instead of allocating and
  linearly scanning a full array copy per candidate point on every mouse move.

For reference, the underlying data-layer cost (windowed slice + LTTB) is
~0.4 ms/frame at 10 agents / 20 Hz / 15 min.

### Tests

- Test suite expanded from 41 to **94 tests**: the `TimeSeriesBuffer` (append,
  eviction, slicing, LTTB endpoint/spike/monotonicity, cache bucketing, and the
  copy-free `nearestValueAt` binary search verified against a brute-force scan),
  the `StatusLog` (transition dedup, binary-search `statusAt` boundaries,
  eviction, range queries), metric selection across all three modes, `niceMax`
  axis rounding, `windowSeconds` integration, per-point status history, and
  display-only `smoothing` (including proof that health/tooltip values stay raw).
  Typecheck and lint clean.

### Known limitations

- Performance was validated in Chrome at 10 agents / 20 Hz via `dev/Stress.tsx`,
  with INP in the "good" band after the dirty-frame fix. Behavior at much larger
  scale (e.g. 20+ agents with very long windows) is improved but not formally
  benchmarked; the harness is included so you can measure your own workload.
- Status-colored line *segments* (visually shading the timeline where an agent
  was `stuck`/`hallucinating`) are not yet drawn — the per-point status data now
  exists to support this, but the rendering is deferred to a later release.
- One component test (`user-lock` sim re-roll) is intermittently flaky (~1 in 10
  runs) due to RNG timing in the simulator; it is a test-harness timing issue,
  not a product defect, and is tracked for a follow-up fix.

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

## [0.1.0] — 2026-04-19

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

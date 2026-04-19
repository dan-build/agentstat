# Roadmap

Known gaps as of v0.1.0 and planned work for v0.2.

## v0.2 — Configurable time window

The v0.1 chart shows the most recent ~420 samples per agent regardless of elapsed time. This was a deliberate scope cut — the naïve approach of uncapping the buffer would either blow the 60fps budget (Catmull-Rom over ~18k points × N agents × 60fps is not free) or silently downsample without telling the user.

**Design for v0.2:**

- Replace raw `number[]` buffers in `progressBufferRef` / `tokensBufferRef` with time-indexed entries: `{ t: number; value: number }[]`.
- Restore a `windowSeconds?: number` prop and the 1m / 5m / 15m overlay button group (removed in v0.1 as FIX 1).
- Cap buffer length at ~20,000 entries with time-based eviction (drop entries older than `max(allWindows)`).
- On render, slice `progressBuf` to `t >= now - windowSeconds * 1000` before computing spline points.
- Implement downsampling (LTTB or bucketed-max-per-pixel) when the sliced window exceeds ~2× canvas width in points. Cache the downsampled result per `(agentId, windowSeconds, lastSampleTime)` tuple to avoid redundant work when nothing changed.
- Hover hit-test respects the same slice (currently iterates the full buffer).
- Re-add the feature bullet to README. Update the "History window" blockquote to describe the configurable window.

**Acceptance criteria:**

- `npm test` adds two test files: buffer eviction behavior and downsample correctness.
- Manual verification: mount with 5 agents, switch between 1m / 5m / 15m during live sim — line should redraw smoothly in each view without re-entering the RAF loop.
- Chrome DevTools performance trace at 10 agents / 20 Hz / 15m window shows steady 60fps for 60s.

## v0.2 — Validated load testing

The "60fps" claim in README today is verified only for 3 agents × sim tick rate (~18 Hz) × 420-point buffer, which is the demo configuration. It has not been tested at real production scale.

**Plan:**

- Build a dev-only stress harness at `dev/Stress.tsx`: 10 agents, 20 Hz `updateAgent` calls per agent via `setInterval`, mountable from a dev route.
- Instrument with `performance.mark` / `performance.measure` around `animate()` to collect per-frame times.
- Run a 30-minute session in Chrome with the Performance panel recording.
- Report: frame-time p50 / p95 / p99, memory high-water mark, evidence of RAF loop restarts or GC pauses.
- Publish baseline numbers in README. If p95 exceeds ~16.6 ms at target scale, profile and optimize before shipping v0.2.

## Post-v0.2 (nice-to-haves)

- Vertical-axis label customization (current Y axis says "0% — 100%" but for real token-rate mode this is misleading).
- A dual-axis mode (progress + token rate on separate scales).
- A paused-tooltip mode (currently hovering while paused freezes hover state cleanly; document this).
- Customizable auto-recovery behavior for sim mode so demo scripting is easier.

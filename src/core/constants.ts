// src/core/constants.ts — shared layout, timing and math helpers.

/** Plot inset inside the canvas, in CSS px. */
export const PAD = { left: 52, right: 52, top: 48, bottom: 40 };

// Visible span when no `windowSeconds` is set. Short on purpose: at typical
// rates the slice stays under the downsample threshold, so the exact same
// points render every frame and nothing shifts.
export const DEFAULT_VIEW_MS = 10_000;
// A sample older than this (relative to the right edge) is not extended to
// the edge — a quiet agent's line ends where its data ends.
export const STALE_MS = 2_500;
export const HEALTH_TICK_MS = 500;
// History kept for the anomaly detectors regardless of the visible window:
// covers the default 30 s spike baseline plus the recent second and margin.
export const DETECTOR_HISTORY_MS = 40_000;
export const HEALTH_WINDOW_MS = 5_000;
export const LATENCY_HISTORY = 20;
export const DEFAULT_CAP = 100_000;
export const MAX_PANEL_ROWS = 6;
// Episodes stay open briefly after the detector stops reporting them, so a
// detector that flickers at its threshold doesn't fire onAnomaly repeatedly.
export const EPISODE_GRACE_MS = 2_000;
export const HIT_RADIUS = 32;
export const TIME_STEPS_S = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const warned = /*#__PURE__*/ new Set<string>();
/** console.warn once per key, so bad input is visible without flooding logs. */
export const warnOnce = (key: string, message: string) => {
  if (warned.has(key) || typeof console === 'undefined') return;
  warned.add(key);
  if (warned.size > 200) warned.clear();
  console.warn(`[agentstat] ${message}`);
};

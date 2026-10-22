// src/core/view.ts
//
// View geometry, shared by drawing, hover and keyboard inspection so they can
// never disagree about where a sample is.

import type { TimeSeriesBuffer, TSPoint } from '../timeseries';
import type { ChartMetric } from '../types';
import { DEFAULT_VIEW_MS, PAD, clamp } from './constants';
import { niceMax } from './curve';
import type { AgentStore } from './store';

export type View = {
  cssW: number;
  cssH: number;
  w: number;
  h: number;
  /** Wall time the view represents (the pause time while paused). */
  viewNow: number;
  tStart: number;
  tEnd: number;
  span: number;
  sliceNow: number;
  effWinMs: number;
  windowed: boolean;
  drawTarget: number;
  recomputeMs: number;
  primaryIsTokens: boolean;
  safeTokenMax: number;
  xOf: (t: number) => number;
  primaryToY: (v: number) => number;
  tokenToY: (v: number) => number;
  progressToY: (v: number) => number;
};

export interface ViewOptions {
  metric: ChartMetric;
  windowSeconds?: number;
  tokenAxisMax?: number;
}

export function computeView(
  store: AgentStore,
  opts: ViewOptions,
  now: number,
  cssW: number,
  cssH: number
): View {
  const w = Math.max(1, cssW - PAD.left - PAD.right);
  const h = Math.max(1, cssH - PAD.top - PAD.bottom);
  const viewNow = store.pausedAt ?? now;
  const winMs = opts.windowSeconds !== undefined && opts.windowSeconds > 0 ? opts.windowSeconds * 1000 : undefined;
  const primaryIsTokens = opts.metric === 'tokens';
  const primaryMap = primaryIsTokens ? store.tokens : store.progress;

  let tEnd: number;
  let span: number;
  if (winMs !== undefined) {
    tEnd = viewNow;
    span = winMs;
  } else {
    // Anchor to the newest sample across visible agents (one shared time
    // axis), spanning at most DEFAULT_VIEW_MS.
    let newest = -Infinity;
    let oldest = Infinity;
    for (const rec of store.list) {
      if (!rec.visible) continue;
      const buf = primaryMap.get(rec.id);
      if (!buf || buf.length === 0) continue;
      newest = Math.max(newest, Math.min(buf.lastT, viewNow));
      oldest = Math.min(oldest, buf.firstT);
    }
    if (Number.isFinite(newest)) {
      tEnd = newest;
      span = clamp(newest - oldest, 1, DEFAULT_VIEW_MS);
    } else {
      tEnd = viewNow;
      span = DEFAULT_VIEW_MS;
    }
  }
  const tStart = tEnd - span;
  const effWinMs = winMs ?? DEFAULT_VIEW_MS;
  const drawTarget = Math.max(8, Math.ceil(w / 2));
  const recomputeMs = Math.max(16, effWinMs * 0.005);
  const sliceNow = winMs !== undefined ? viewNow : tEnd;

  // Token axis: sticky ceiling, recomputed at most 4×/s.
  let safeTokenMax = 100;
  if (opts.metric !== 'progress') {
    let tokenMax = opts.tokenAxisMax;
    if (tokenMax === undefined || !(tokenMax > 0)) {
      const cache = store.axis;
      const bucket = Math.floor(now / 250);
      if (bucket !== cache.bucket) {
        let observed = 0;
        for (const rec of store.list) {
          if (!rec.visible) continue;
          const buf = store.tokens.get(rec.id);
          if (!buf) continue;
          // Same parameters as the draw → hits the same downsample cache.
          const pts = buf.windowed(sliceNow, effWinMs, drawTarget, recomputeMs).points;
          for (let i = 0; i < pts.length; i++) if (pts[i].v > observed) observed = pts[i].v;
          if (rec.current.tokensRate > observed) observed = rec.current.tokensRate;
        }
        const target = niceMax(observed * 1.15);
        // Rise immediately (never clip a spike); ease down only when the true
        // ceiling has dropped well below the current one. The dead band in
        // between is what keeps historical points still.
        if (cache.value === 0 || target > cache.value) cache.value = target;
        else if (target < cache.value * 0.6) cache.value = Math.max(target, cache.value * 0.92);
        cache.bucket = bucket;
      }
      tokenMax = cache.value;
    }
    safeTokenMax = tokenMax > 0 && Number.isFinite(tokenMax) ? tokenMax : 100;
  }

  const progressToY = (v: number) => PAD.top + h - (h * clamp(v, 0, 100)) / 100;
  const tokenToY = (v: number) => PAD.top + h - (h * clamp(v, 0, safeTokenMax)) / safeTokenMax;
  return {
    cssW,
    cssH,
    w,
    h,
    viewNow,
    tStart,
    tEnd,
    span,
    sliceNow,
    effWinMs,
    windowed: winMs !== undefined,
    drawTarget,
    recomputeMs,
    primaryIsTokens,
    safeTokenMax,
    xOf: (t: number) => PAD.left + clamp((t - tStart) / span, 0, 1) * w,
    primaryToY: primaryIsTokens ? tokenToY : progressToY,
    tokenToY,
    progressToY,
  };
}

/** Samples of `buf` in view (raw), never past the right edge. */
export function pointsFor(buf: TimeSeriesBuffer, view: View): TSPoint[] {
  const pts = buf.windowed(view.sliceNow, view.effWinMs, view.drawTarget, view.recomputeMs).points;
  let end = pts.length;
  while (end > 0 && pts[end - 1].t > view.tEnd) end--;
  return end === pts.length ? pts : pts.slice(0, end);
}

/** The buffer for the metric on the primary (left) axis. */
export function primaryBuffer(store: AgentStore, id: string, view: View): TimeSeriesBuffer | undefined {
  return (view.primaryIsTokens ? store.tokens : store.progress).get(id);
}

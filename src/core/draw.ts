// src/core/draw.ts
//
// Paints one frame. Pure with respect to React: it reads the store and view,
// writes only to the canvas and the gradient cache, and reports what happened
// to the inspected point so the component can update the tooltip.

import type { Anomaly } from '../anomaly';
import { parseColor, withAlpha } from '../color';
import { formatAxisValue, formatTick } from '../format';
import { FONT_SANS, type ThemeMode, type ThemeTokens } from '../theme';
import type { ChartMetric } from '../types';
import type { ColorResolver } from './colors';
import { PAD, STALE_MS, TIME_STEPS_S, clamp } from './constants';
import { emaPoints, splinePath } from './curve';
import type { AgentStore } from './store';
import { computeView, pointsFor, primaryBuffer } from './view';

/** The sample being inspected (hover or keyboard). */
export type HoverTarget = {
  agentId: string;
  /** Sample time of the inspected point. */
  t: number;
  /** Drawn (possibly smoothed) primary value, for placing the marker. */
  drawV: number;
};

export type GradientCache = { key: string; map: Map<string, CanvasGradient> };

export interface DrawOptions {
  metric: ChartMetric;
  windowSeconds?: number;
  tokenAxisMax?: number;
  smoothing: number;
  referenceLine?: { value: number; label?: string; color?: string };
  anomalyDetection: boolean;
}

export interface DrawContext {
  store: AgentStore;
  opts: DrawOptions;
  theme: { mode: ThemeMode; t: ThemeTokens };
  colors: ColorResolver;
  gradients: GradientCache;
  /** Resolve a consumer color (may be `var(--x)`). */
  resolveColor: (c: string) => string;
  hover: HoverTarget | null;
  reduceMotion: boolean;
}

/**
 * What became of the inspected point: still on screen at (x, y), scrolled
 * out (`'gone'`), or there was none.
 */
export type HoverResult = { x: number; y: number; cssW: number } | 'gone' | null;

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  cssW: number,
  cssH: number,
  now: number,
  dc: DrawContext
): HoverResult {
  if (cssW < 1 || cssH < 1) return null;
  const { store, opts: L, colors } = dc;
  const { t: tk, mode } = dc.theme;

  ctx.fillStyle = tk.bg;
  ctx.fillRect(0, 0, cssW, cssH);

  const view = computeView(store, L, now, cssW, cssH);
  const { w, h, xOf, primaryToY, tokenToY, progressToY, safeTokenMax } = view;
  if (w < 16 || h < 16) return null;
  const metric = L.metric;
  const showProgress = metric !== 'tokens';
  const colorOf = (rec: (typeof store.list)[number], index: number) => colors.resolve(rec, index, mode, tk);

  // ── Axes
  ctx.font = `500 11px ${FONT_SANS}`;
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  for (const pct of [100, 75, 50, 25, 0]) {
    const y = Math.round(PAD.top + h - (h * pct) / 100) + 0.5;
    ctx.strokeStyle = tk.grid;
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(PAD.left + w, y);
    ctx.stroke();
    ctx.fillStyle = tk.textTertiary;
    ctx.textAlign = 'right';
    ctx.fillText(showProgress ? `${pct}%` : formatAxisValue((safeTokenMax * pct) / 100), PAD.left - 10, y);
    if (metric === 'both') {
      ctx.textAlign = 'left';
      ctx.fillText(formatAxisValue((safeTokenMax * pct) / 100), PAD.left + w + 10, y);
    }
  }
  // Unit captions under the token axes.
  const captionY = PAD.top + h + 20;
  ctx.fillStyle = tk.textTertiary;
  if (!showProgress) {
    ctx.textAlign = 'right';
    ctx.fillText('t/s', PAD.left - 10, captionY);
  }
  if (metric === 'both') {
    ctx.textAlign = 'left';
    ctx.fillText('t/s', PAD.left + w + 10, captionY);
  }
  // Relative time ticks.
  const targetTicks = Math.max(2, Math.floor(w / 90));
  const stepS =
    TIME_STEPS_S.find((s) => view.span / 1000 / s <= targetTicks) ?? TIME_STEPS_S[TIME_STEPS_S.length - 1];
  if (view.span >= 1000) {
    ctx.textAlign = 'center';
    for (let k = 0; ; k++) {
      const t = view.tEnd - k * stepS * 1000;
      if (t < view.tStart - 1) break;
      const x = xOf(t);
      const label = formatTick(view.viewNow - t);
      ctx.textAlign = k === 0 ? 'right' : x - PAD.left < 20 ? 'left' : 'center';
      ctx.fillText(label, k === 0 ? PAD.left + w : x, captionY);
    }
  }

  // ── Reference line (against the left axis)
  const rl = L.referenceLine;
  if (rl && Number.isFinite(rl.value)) {
    const y = Math.round(showProgress ? progressToY(rl.value) : tokenToY(rl.value)) + 0.5;
    const col = rl.color ? dc.resolveColor(rl.color) : tk.reference;
    ctx.strokeStyle = col;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(PAD.left + w, y);
    ctx.stroke();
    ctx.setLineDash([]);
    if (rl.label) {
      ctx.fillStyle = tk.textTertiary;
      ctx.textAlign = 'right';
      // Above the line, unless that would collide with the top controls.
      ctx.fillText(rl.label, PAD.left + w - 4, y - 9 < PAD.top + 4 ? y + 10 : y - 9);
    }
  }

  // ── Gradient cache (geometry + theme + how many fills stack)
  const visibleCount = store.list.reduce((n, r) => n + (r.visible ? 1 : 0), 0);
  const gkey = `${PAD.top}:${h}:${PAD.left}:${w}:${tk.bg}:${visibleCount}`;
  const gcache = dc.gradients;
  if (gcache.key !== gkey) {
    gcache.key = gkey;
    gcache.map.clear();
  }

  // ── Series
  type Marker = { x: number; anomaly: Anomaly; name: string };
  const markers: Marker[] = [];
  let drewAny = false;
  store.list.forEach((rec, idx) => {
    if (!rec.visible) return;
    const buf = primaryBuffer(store, rec.id, view);
    if (!buf || buf.length === 0) return;
    const raw = pointsFor(buf, view);
    if (raw.length === 0) return;
    const col = colorOf(rec, idx);
    const pts = emaPoints(raw, L.smoothing);
    const lv = store.live.get(rec.id);
    const livePrimary = lv ? (view.primaryIsTokens ? lv.tokensRate : lv.progress) : pts[pts.length - 1].v;
    const sp = pts.map((p) => ({ x: xOf(p.t), y: primaryToY(p.v) }));
    // The tip is the eased live value at the right edge — but only while the
    // agent is actually reporting. A quiet agent's line ends at its data.
    const lastT = raw[raw.length - 1].t;
    const live = view.tEnd - lastT <= STALE_MS;
    if (live) {
      const tip = { x: PAD.left + w, y: primaryToY(livePrimary) };
      if (PAD.left + w - sp[sp.length - 1].x < 1.5) sp[sp.length - 1] = tip;
      else sp.push(tip);
    }
    const tip = sp[sp.length - 1];
    drewAny = true;

    if (sp.length >= 2) {
      const fillKey = `f:${col.css}`;
      let fill = gcache.map.get(fillKey);
      if (!fill) {
        fill = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + h);
        // Fills stack where lines overlap, so they thin out as agents are added.
        fill.addColorStop(0, withAlpha(col.rgba, 0.12 / Math.sqrt(Math.max(1, visibleCount))));
        fill.addColorStop(1, withAlpha(col.rgba, 0));
        gcache.map.set(fillKey, fill);
      }
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(sp[0].x, sp[0].y);
      splinePath(ctx, sp);
      ctx.lineTo(tip.x, PAD.top + h);
      ctx.lineTo(sp[0].x, PAD.top + h);
      ctx.closePath();
      ctx.fill();

      const lineKey = `l:${col.css}`;
      let line = gcache.map.get(lineKey);
      if (!line) {
        line = ctx.createLinearGradient(PAD.left, 0, PAD.left + w, 0);
        line.addColorStop(0, withAlpha(col.rgba, 0.15));
        line.addColorStop(0.22, withAlpha(col.rgba, 0.75));
        line.addColorStop(1, withAlpha(col.rgba, 1));
        gcache.map.set(lineKey, line);
      }
      ctx.strokeStyle = line;
      ctx.lineWidth = 1.75;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(sp[0].x, sp[0].y);
      splinePath(ctx, sp);
      ctx.stroke();
    }

    // Dual-axis companion: token rate, dashed, on the right axis.
    if (metric === 'both') {
      const tBuf = store.tokens.get(rec.id);
      if (tBuf && tBuf.length > 0) {
        const traw = pointsFor(tBuf, view);
        if (traw.length > 0) {
          const tp = emaPoints(traw, L.smoothing).map((p) => ({ x: xOf(p.t), y: tokenToY(p.v) }));
          if (view.tEnd - traw[traw.length - 1].t <= STALE_MS) {
            const tt = { x: PAD.left + w, y: tokenToY(lv?.tokensRate ?? traw[traw.length - 1].v) };
            if (PAD.left + w - tp[tp.length - 1].x < 1.5) tp[tp.length - 1] = tt;
            else tp.push(tt);
          }
          if (tp.length >= 2) {
            ctx.strokeStyle = withAlpha(col.rgba, 0.6);
            ctx.lineWidth = 1.25;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(tp[0].x, tp[0].y);
            splinePath(ctx, tp);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
      }
    }

    // Live dot: colored core with a soft halo, bg-colored pip for a crisp eye.
    // The halo breathes only when motion is allowed.
    const pulse = dc.reduceMotion || !live ? 0.5 : 0.5 + 0.5 * Math.sin(now / 420);
    ctx.save();
    ctx.shadowColor = col.css;
    ctx.shadowBlur = live ? 8 + pulse * 6 : 0;
    ctx.fillStyle = col.css;
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, live ? 2.75 : 2.25, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = tk.bg;
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 1, 0, Math.PI * 2);
    ctx.fill();

    if (L.anomalyDetection) {
      for (const an of store.anomalies.get(rec.id) ?? []) {
        markers.push({ x: clamp(xOf(an.t), PAD.left, PAD.left + w), anomaly: an, name: rec.name });
      }
    }
  });

  // ── Anomaly markers (above every series). Severity is carried by shape and
  // wording as well as color: ▲ warning, ◆ critical.
  markers.forEach((m, i) => {
    const critical = m.anomaly.severity === 'critical';
    const col = critical ? tk.critical : tk.warning;
    const rgba = parseColor(col);
    ctx.strokeStyle = rgba ? withAlpha(rgba, critical ? 0.45 : 0.35) : col;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(m.x) + 0.5, PAD.top);
    ctx.lineTo(Math.round(m.x) + 0.5, PAD.top + h);
    ctx.stroke();
    ctx.setLineDash([]);

    const my = PAD.top + 8 + i * 16;
    ctx.fillStyle = col;
    ctx.strokeStyle = tk.bg;
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (critical) {
      ctx.moveTo(m.x, my - 4.5);
      ctx.lineTo(m.x + 4.5, my);
      ctx.lineTo(m.x, my + 4.5);
      ctx.lineTo(m.x - 4.5, my);
    } else {
      ctx.moveTo(m.x, my - 4.5);
      ctx.lineTo(m.x + 4.5, my + 3.5);
      ctx.lineTo(m.x - 4.5, my + 3.5);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.fill();

    const label = `${m.name} · ${m.anomaly.message}`;
    ctx.font = `500 11px ${FONT_SANS}`;
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(label).width;
    const right = m.x + 9 + tw <= PAD.left + w;
    ctx.textAlign = right ? 'left' : 'right';
    const lx = right ? m.x + 9 : m.x - 9;
    // A background-colored halo keeps the label legible over lines.
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = tk.bg;
    ctx.strokeText(label, lx, my);
    ctx.fillStyle = col;
    ctx.fillText(label, lx, my);
  });

  // ── Hover / keyboard inspection marker
  let hoverResult: HoverResult = null;
  const hv = dc.hover;
  if (hv) {
    const rec = store.byId.get(hv.agentId);
    if (!rec || !rec.visible || hv.t < view.tStart) {
      hoverResult = 'gone';
    } else {
      const x = xOf(hv.t);
      const y = primaryToY(hv.drawV);
      const col = colorOf(rec, store.list.indexOf(rec));
      ctx.strokeStyle = tk.reference;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, PAD.top);
      ctx.lineTo(Math.round(x) + 0.5, PAD.top + h);
      ctx.stroke();
      ctx.fillStyle = tk.bg;
      ctx.strokeStyle = col.css;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      hoverResult = { x, y, cssW };
    }
  }

  // ── Empty states
  if (!drewAny) {
    ctx.fillStyle = tk.textTertiary;
    ctx.font = `500 12px ${FONT_SANS}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const msg =
      store.list.length === 0
        ? 'No agents to display'
        : visibleCount === 0
          ? 'All agents hidden — use the legend to show one'
          : 'Waiting for telemetry…';
    // A background halo keeps the message clear of the grid line behind it.
    ctx.lineWidth = 8;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = tk.bg;
    ctx.strokeText(msg, PAD.left + w / 2, PAD.top + h / 2);
    ctx.fillText(msg, PAD.left + w / 2, PAD.top + h / 2);
  }
  return hoverResult;
}

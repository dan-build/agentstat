'use client';

import React, {
  useRef,
  useEffect,
  useState,
  useCallback,
  forwardRef,
  useImperativeHandle,
  useMemo,
  useId,
  useLayoutEffect,
  useSyncExternalStore,
} from 'react';

import { TimeSeriesBuffer, type TSPoint } from './timeseries';
import { StatusLog } from './statuslog';
import {
  detectAnomalies,
  DEFAULT_ANOMALY_CONFIG,
  type Anomaly,
  type AnomalyConfig,
  type AnomalyKind,
  type AnomalySeverity,
} from './anomaly';
import { calculateHealth } from './health';
import { parseColor, resolveCssVar, withAlpha, isDarkColor, type RGBA } from './color';
import { tokensFor, FONT_SANS, FONT_MONO, type ThemeMode, type ThemeTokens } from './theme';
import { simStep, mulberry32, SIM_TICK_MS, type SimState, type Rng } from './simulator';
import {
  formatAgo,
  formatAxisValue,
  formatInt,
  formatPercent,
  formatRate,
  formatStatus,
  formatTick,
} from './format';
import {
  AGENT_STATUSES,
  type Agent,
  type AgentDataPoint,
  type AgentSample,
  type AgentStatus,
  type ChartMetric,
  type HealthMetrics,
} from './types';

export type {
  Agent,
  AgentDataPoint,
  AgentSample,
  AgentStatus,
  ChartMetric,
  HealthMetrics,
} from './types';
// Exported for unit tests; not re-exported from the package entry.
export { calculateHealth } from './health';

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentStatProps {
  /**
   * The roster: which agents exist and in what order. Changes to `name`,
   * `color`, `config` and `visible` on existing ids are applied; runtime
   * values (rate, progress, status) come from `ref.current.updateAgent`.
   */
  agents: Agent[];
  /** Height of the chart. Number = px; any CSS length is accepted. Default 520. */
  height?: number | string;
  /** @deprecated Width is always 100% of the container. */
  width?: number;
  /**
   * Color theme. `'system'` follows the OS setting. When omitted, the theme is
   * inferred from `styles.background` (dark background → dark theme).
   */
  theme?: 'light' | 'dark' | 'system';
  referenceLine?: { value: number; label?: string; color?: string };
  onHealthChange?: (agentId: string, health: HealthMetrics) => void;
  /** Called when a sample on the chart is clicked (or activated with Enter). */
  onPointClick?: (agentId: string, point: AgentDataPoint) => void;
  /** @deprecated Renamed to `onPointClick`; fires for any point, not only spikes. */
  onSpikeClick?: (agentId: string, point: AgentDataPoint) => void;
  /**
   * Generate demo data. Pass `{ seed }` for a reproducible run (screenshots,
   * docs, tests). Never enable this in front of real telemetry.
   */
  simulateData?: boolean | { seed?: number };
  /** Color overrides. Any CSS color, including `var(--token)`. */
  styles?: {
    background?: string;
    borderColor?: string;
    textColor?: string;
    gridColor?: string;
  };
  /** CSS class name applied to the root container. */
  className?: string;
  /** Inline styles applied to the root container. */
  style?: React.CSSProperties;
  /** Accessible name for the chart. Defaults to a description of the roster. */
  ariaLabel?: string;
  /**
   * The per-agent panel (rate, health, status) over the bottom-left of the
   * chart. `'auto'` (default) hides it when the chart is too small for it to
   * leave the data readable (under 560 × 340 px).
   */
  panel?: 'auto' | 'always' | 'never';
  /**
   * Hard cap on samples kept per agent and series. Retention is time-based
   * (1.5× the visible window); this cap only bounds memory for very high
   * update rates. Default 100 000.
   */
  maxHistoryPoints?: number;
  /** Which series to plot. Default 'progress'. */
  metric?: ChartMetric;
  /**
   * Fixed upper bound for the token-rate axis. By default the axis
   * auto-scales: it rises immediately for a new high and eases down only
   * after the peak has stayed well below it.
   */
  tokenAxisMax?: number;
  /**
   * Show the last `windowSeconds` of history on a wall-clock axis. When
   * unset, the chart shows up to the last 10 s of data, anchored to the newest
   * sample. Long windows are downsampled (LTTB) to the canvas resolution.
   */
  windowSeconds?: number;
  /**
   * Display-only smoothing of the drawn line, in [0, 1). 0 (default) draws raw
   * values. Smoothing damps real spikes on screen; health, anomalies and the
   * tooltip always use raw data.
   */
  smoothing?: number;
  /**
   * Detect stalls (no output while active), spikes (outliers vs the agent's
   * own baseline) and status thrashing. Draws markers, announces them to
   * screen readers and fires `onAnomaly`. Default false.
   */
  anomalyDetection?: boolean;
  /** Override anomaly thresholds; merged over DEFAULT_ANOMALY_CONFIG. */
  anomalyConfig?: Partial<AnomalyConfig>;
  /**
   * Called once when an anomaly starts (and again if it escalates from
   * warning to critical) — not on every detection tick.
   */
  onAnomaly?: (agentId: string, anomaly: Anomaly) => void;
}

export interface AgentStatRef {
  /** Report a partial sample; omitted fields keep their previous value. */
  updateAgent(id: string, sample: AgentSample): void;
  /** Positional form, kept for compatibility. */
  updateAgent(id: string, tokensRate: number, progress: number, status: AgentStatus): void;
  getHealth: (id: string) => HealthMetrics | undefined;
  /** Anomalies currently active for an agent (empty if none or detection off). */
  getAnomalies: (id: string) => Anomaly[];
  /** Values currently drawn at the live tip (eased toward the latest sample). */
  getLiveMetrics: (
    id: string
  ) => { tokensRate: number; progress: number; status: AgentStatus } | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS — exported to cut onboarding boilerplate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an `Agent` with sensible defaults. Omit `color` to use the theme's
 * palette, which is tuned for contrast on light and dark backgrounds.
 *
 * ```tsx
 * const agent = createAgent('chat-agent', 'Chat Assistant');
 * <AgentStat agents={[agent]} />
 * ```
 */
export const createAgent = (id: string, name: string, color?: string): Agent => ({
  id,
  name,
  ...(color ? { color } : {}),
  current: { tokensRate: 0, progress: 0, status: 'active' },
  visible: true,
});

/**
 * A ready-made 3-agent roster for demos and first-run exploration. Pair with
 * `simulateData`:
 *
 * ```tsx
 * import { AgentStat, demoAgents } from '@dan-build/agentstat';
 * <AgentStat agents={demoAgents} simulateData height={400} />
 * ```
 */
export const demoAgents: Agent[] = [
  {
    id: 'researcher',
    name: 'Researcher',
    current: { tokensRate: 14.8, progress: 42, status: 'active' },
    visible: true,
    config: { expectedTokensPerSec: [10, 20] },
  },
  {
    id: 'critic',
    name: 'Critic',
    current: { tokensRate: 4.2, progress: 18, status: 'thinking' },
    visible: true,
    config: { expectedTokensPerSec: [5, 15] },
  },
  {
    id: 'executor',
    name: 'Executor',
    current: { tokensRate: 21.5, progress: 91, status: 'active' },
    visible: true,
    config: { expectedTokensPerSec: [15, 30] },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// INTERNALS
// ─────────────────────────────────────────────────────────────────────────────

/** Mutable per-agent state owned by the component. */
type AgentRecord = {
  id: string;
  name: string;
  color?: string;
  config?: Agent['config'];
  visible: boolean;
  current: Agent['current'];
};

type LiveValues = { tokensRate: number; progress: number; status: AgentStatus };

type HoverTarget = {
  agentId: string;
  /** Sample time of the hovered point. */
  t: number;
  /** Drawn (possibly smoothed) primary value, for placing the marker. */
  drawV: number;
};

type HoverInfo = {
  agentId: string;
  /** Age of the sample when it was selected, in ms. */
  ageMs: number;
  name: string;
  color: string;
  point: AgentDataPoint;
  x: number;
  y: number;
};

type RowSnapshot = {
  id: string;
  name: string;
  /** Explicit agent color; palette colors are resolved at render time. */
  color?: string;
  visible: boolean;
  status: AgentStatus;
  rate: number;
  score: number | null;
};

type View = {
  cssW: number;
  cssH: number;
  w: number;
  h: number;
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

const PAD = { left: 52, right: 52, top: 48, bottom: 40 };
// Visible span when no `windowSeconds` is set. Short on purpose: at typical
// rates the slice stays under the downsample threshold, so the exact same
// points render every frame and nothing shifts.
const DEFAULT_VIEW_MS = 10_000;
// A sample older than this (relative to the right edge) is not extended to
// the edge — a quiet agent's line ends where its data ends.
const STALE_MS = 2_500;
const HEALTH_TICK_MS = 500;
const HEALTH_WINDOW_MS = 5_000;
const LATENCY_HISTORY = 20;
const DEFAULT_CAP = 100_000;
const MAX_PANEL_ROWS = 6;
// Episodes stay open briefly after the detector stops reporting them, so a
// detector that flickers at its threshold doesn't fire onAnomaly repeatedly.
const EPISODE_GRACE_MS = 2_000;
const HIT_RADIUS = 32;
const TIME_STEPS_S = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Display-only exponential moving average over a point series. Returns a new
 * array; never mutates input. 0 returns the input unchanged.
 */
const emaPoints = (pts: TSPoint[], factor: number): TSPoint[] => {
  if (!(factor > 0) || pts.length === 0) return pts;
  const a = Math.min(0.95, factor);
  const out = new Array<TSPoint>(pts.length);
  let prev = pts[0].v;
  out[0] = pts[0];
  for (let i = 1; i < pts.length; i++) {
    prev = prev * a + pts[i].v * (1 - a);
    out[i] = { t: pts[i].t, v: prev };
  }
  return out;
};

/**
 * Round an upper bound up to a "nice" axis maximum (1/2/5 × 10ⁿ), at least
 * `floor`. Non-finite input falls back to `floor`.
 *
 * Exported for unit testing — not re-exported from the package entry.
 */
export const niceMax = (raw: number, floor = 10): number => {
  const v = Number.isFinite(raw) ? Math.max(raw, floor) : floor;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const frac = v / base;
  const niceFrac = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return niceFrac * base;
};

// Build (don't stroke) a Catmull-Rom path through `points`. Shared by the
// stroked line and the area fill so both follow the identical curve. Control
// points are clamped to the segment's vertical span to prevent loops.
const splinePath = (ctx: CanvasRenderingContext2D, points: { x: number; y: number }[], tension = 0.4) => {
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const c1x = p1.x + ((p2.x - p0.x) * tension) / 3;
    let c1y = p1.y + ((p2.y - p0.y) * tension) / 3;
    const c2x = p2.x - ((p3.x - p1.x) * tension) / 3;
    let c2y = p2.y - ((p3.y - p1.y) * tension) / 3;
    const loY = Math.min(p1.y, p2.y);
    const hiY = Math.max(p1.y, p2.y);
    const slack = (hiY - loY) * 0.5 + 0.01;
    c1y = clamp(c1y, loY - slack, hiY + slack);
    c2y = clamp(c2y, loY - slack, hiY + slack);
    ctx.bezierCurveTo(
      clamp(c1x, p1.x, p2.x),
      c1y,
      clamp(c2x, p1.x, p2.x),
      c2y,
      p2.x,
      p2.y
    );
  }
};

const warned = /*#__PURE__*/ new Set<string>();
const warnOnce = (key: string, message: string) => {
  if (warned.has(key) || typeof console === 'undefined') return;
  warned.add(key);
  if (warned.size > 200) warned.clear();
  console.warn(`[agentstat] ${message}`);
};

const sameBand = (a?: [number, number], b?: [number, number]) =>
  a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1]);

const toAgent = (r: AgentRecord): Agent => ({
  id: r.id,
  name: r.name,
  color: r.color,
  config: r.config,
  visible: r.visible,
  current: r.current,
});

const statusTone = (s: AgentStatus): 'warning' | 'critical' | undefined =>
  s === 'stuck' ? 'warning' : s === 'hallucinating' ? 'critical' : undefined;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Subscribe to a media query, tolerating engines that only have addListener.
const watchMedia = (query: string, cb: (matches: boolean) => void): (() => void) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mq = window.matchMedia(query);
  const handler = () => cb(mq.matches);
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }
  mq.addListener?.(handler);
  return () => mq.removeListener?.(handler);
};

/** Normalize an `Agent` prop into the component's mutable record. */
const makeRecord = (a: Agent): AgentRecord => {
  const num = (v: unknown, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : 0;
  const status = AGENT_STATUSES.includes(a.current?.status) ? a.current.status : 'active';
  return {
    id: a.id,
    name: a.name ?? a.id,
    color: a.color,
    config: a.config,
    visible: a.visible ?? true,
    current: {
      ...a.current,
      tokensRate: num(a.current?.tokensRate, 0, Infinity),
      progress: num(a.current?.progress, 0, 100),
      status,
    },
  };
};

/**
 * Buffers for one agent, holding one real sample: the state the consumer
 * declared. No backfilled history — a telemetry chart must not draw data
 * that never happened.
 */
const createSeries = (rec: AgentRecord, maxHistoryPoints: number, now: number) => {
  const cap = Math.max(2, Math.floor(maxHistoryPoints) || DEFAULT_CAP);
  const progress = new TimeSeriesBuffer(cap);
  const tokens = new TimeSeriesBuffer(cap);
  progress.push(now, rec.current.progress);
  tokens.push(now, rec.current.tokensRate);
  const status = new StatusLog();
  status.record(now, rec.current.status);
  return { progress, tokens, status };
};

/** Build roster state from the `agents` prop (first render only). */
const buildRoster = (agents: Agent[], maxHistoryPoints: number) => {
  const list: AgentRecord[] = [];
  const byId = new Map<string, AgentRecord>();
  const props = new Map<string, Agent>();
  const progress = new Map<string, TimeSeriesBuffer>();
  const tokens = new Map<string, TimeSeriesBuffer>();
  const status = new Map<string, StatusLog>();
  const now = typeof performance !== 'undefined' ? performance.now() : 0;
  for (const a of Array.isArray(agents) ? agents : []) {
    if (!a || typeof a.id !== 'string' || props.has(a.id)) continue;
    const rec = makeRecord(a);
    const series = createSeries(rec, maxHistoryPoints, now);
    list.push(rec);
    byId.set(a.id, rec);
    props.set(a.id, a);
    progress.set(a.id, series.progress);
    tokens.set(a.id, series.tokens);
    status.set(a.id, series.status);
  }
  return { list, byId, props, progress, tokens, status };
};

// useLayoutEffect warns during server rendering in React 18; it only matters
// in the browser anyway.
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// Measure UI text with the same font the chips use, to decide how many legend
// chips fit on one row. Falls back to an average glyph width.
let measureCtx: CanvasRenderingContext2D | null | undefined;
const measureChipText = (text: string): number => {
  if (measureCtx === undefined) {
    try {
      measureCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    } catch {
      measureCtx = null;
    }
  }
  const w = measureCtx && typeof measureCtx.measureText === 'function'
    ? ((measureCtx.font = `500 12px ${FONT_SANS}`), measureCtx.measureText(text).width)
    : 0;
  return w > 0 ? w : text.length * 6.8;
};
// Chip chrome: padding (2 × 10) + swatch (8) + gap (6).
const CHIP_CHROME = 34;
const CHIP_TEXT_MAX = 16 * 7; // matches the 16ch max width
const MORE_CHIP = 48;
const PAUSE_CHIP = 96;

/** Live value of a media query; false during server rendering or when disabled. */
const useMediaQuery = (query: string, enabled = true): boolean =>
  useSyncExternalStore(
    useCallback((onChange: () => void) => (enabled ? watchMedia(query, onChange) : () => {}), [query, enabled]),
    () =>
      enabled &&
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia(query).matches,
    () => false
  );

// ─────────────────────────────────────────────────────────────────────────────
// STYLES — scoped to the component's class names. Motion is opt-in under
// prefers-reduced-motion: no-preference; hover styling only on devices that
// can hover.
// ─────────────────────────────────────────────────────────────────────────────

const CSS = `
.agentstat{position:relative;font-family:var(--as-font);color:var(--as-text);-webkit-tap-highlight-color:transparent}
.agentstat *,.agentstat *::before,.agentstat *::after{box-sizing:border-box}
.agentstat-canvas{display:block;width:100%;height:100%;border-radius:12px;cursor:crosshair;background:var(--as-bg);border:1px solid var(--as-frame)}
.agentstat-canvas:focus-visible{outline:2px solid var(--as-focus);outline-offset:2px}
.agentstat-surface{background:var(--as-surface);border:1px solid transparent;box-shadow:var(--as-shadow);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.agentstat-legend{position:absolute;top:12px;right:12px;display:flex;flex-wrap:nowrap;justify-content:flex-end;gap:4px;max-width:calc(100% - 120px)}
.agentstat-more-btn{font-variant-numeric:tabular-nums}
.agentstat-menu{position:absolute;top:44px;right:12px;z-index:20;display:flex;flex-direction:column;gap:2px;min-width:180px;max-width:min(280px,calc(100% - 24px));max-height:calc(100% - 56px);overflow:auto;overscroll-behavior:contain;padding:4px;border-radius:12px;transform-origin:top right}
.agentstat-menu .agentstat-btn{justify-content:flex-start;min-height:32px;border-radius:8px;background:transparent;box-shadow:none;-webkit-backdrop-filter:none;backdrop-filter:none}
.agentstat-menu .agentstat-btn::before{content:none}
.agentstat-menu .agentstat-name{max-width:none}
.agentstat-menu-all{color:var(--as-text-secondary)}
@media (prefers-reduced-motion:no-preference){.agentstat-menu{transition-property:opacity,scale;transition-duration:150ms;transition-timing-function:cubic-bezier(0.23,1,0.32,1)}@starting-style{.agentstat-menu{opacity:0;scale:0.97}}}
@starting-style{.agentstat-menu{opacity:0}}
.agentstat[data-theme-switching] *{transition:none!important}
.agentstat-btn{position:relative;appearance:none;margin:0;display:inline-flex;align-items:center;gap:6px;min-height:24px;padding:0 10px;border-radius:999px;font:500 12px/1 var(--as-font);color:var(--as-text-secondary);cursor:pointer;white-space:nowrap;transition-property:background-color,color,transform;transition-duration:150ms;transition-timing-function:cubic-bezier(0.23,1,0.32,1)}
.agentstat-btn[aria-pressed="true"]{color:var(--as-text)}
.agentstat-btn.is-off{color:var(--as-text-tertiary)}
.agentstat-btn:focus-visible{outline:2px solid var(--as-focus);outline-offset:2px}
.agentstat-btn::before{content:"";position:absolute;inset:-8px -2px}
@media (hover:hover) and (pointer:fine){.agentstat-btn:hover{background-image:linear-gradient(var(--as-selected),var(--as-selected))}}
@media (prefers-reduced-motion:no-preference){.agentstat-btn:active{transform:scale(0.96)}}
.agentstat-swatch{width:8px;height:8px;border-radius:50%;flex-shrink:0;background:var(--c);box-shadow:inset 0 0 0 1.5px var(--c)}
.agentstat-btn.is-off .agentstat-swatch{background:transparent}
.agentstat-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;max-width:16ch}
.agentstat-panel{position:absolute;left:12px;bottom:12px;padding:8px 10px;border-radius:10px;pointer-events:none;display:grid;grid-template-columns:auto minmax(0,auto) auto auto auto;column-gap:10px;row-gap:4px;align-items:center;font-size:12px;line-height:1.3;max-width:calc(100% - 24px)}
.agentstat-head{font-size:11px;font-weight:500;letter-spacing:0.05em;text-transform:uppercase;color:var(--as-text-tertiary);white-space:nowrap}
.agentstat-num{font-variant-numeric:tabular-nums;text-align:right;color:var(--as-text);white-space:nowrap}
.agentstat-secondary{color:var(--as-text-secondary)}
.agentstat-more{grid-column:1/-1;font-size:11px;color:var(--as-text-tertiary)}
.agentstat-status{display:inline-flex;align-items:center;gap:4px;color:var(--as-text-secondary);white-space:nowrap}
.agentstat-status[data-tone="warning"]{color:var(--as-warning)}
.agentstat-status[data-tone="critical"]{color:var(--as-critical)}
.agentstat-status svg{flex-shrink:0}
.agentstat-pause{position:absolute;left:12px;top:12px}
.agentstat-icon{position:relative;width:12px;height:12px;flex-shrink:0}
.agentstat-icon svg{position:absolute;inset:0;transition-property:opacity,transform,filter;transition-duration:300ms;transition-timing-function:cubic-bezier(0.2,0,0,1)}
.agentstat-icon svg[data-on="false"]{opacity:0;transform:scale(0.25);filter:blur(4px)}
@media (prefers-reduced-motion:reduce){.agentstat-icon svg{transition-property:opacity}.agentstat-icon svg[data-on="false"]{transform:none;filter:none}}
.agentstat-tooltip{position:absolute;left:0;top:0;z-index:10;pointer-events:none;padding:6px 10px;border-radius:8px;font-size:12px;line-height:1.35;white-space:nowrap;color:var(--as-text);transform:translate(-50%,calc(-100% - 12px))}
.agentstat-tooltip[data-place="below"]{transform:translate(-50%,12px)}
.agentstat-tooltip-head{display:flex;align-items:center;gap:6px;font-weight:500}
.agentstat-tooltip-age{margin-left:auto;padding-left:12px;font-weight:400;color:var(--as-text-tertiary);font-variant-numeric:tabular-nums}
.agentstat-tooltip-body{margin-top:2px;color:var(--as-text-secondary);font-variant-numeric:tabular-nums}
@media (prefers-reduced-motion:no-preference){.agentstat-tooltip{transition-property:opacity,scale;transition-duration:125ms;transition-timing-function:cubic-bezier(0.23,1,0.32,1)}}
@starting-style{.agentstat-tooltip{opacity:0;scale:0.97}}
.agentstat-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
`;

const StatusIcon = ({ status }: { status: AgentStatus }) => {
  const common = {
    width: 10,
    height: 10,
    viewBox: '0 0 10 10',
    'aria-hidden': true,
    focusable: false,
  } as const;
  switch (status) {
    case 'thinking':
      return (
        <svg {...common} fill="currentColor">
          <circle cx="1.5" cy="5" r="1.1" />
          <circle cx="5" cy="5" r="1.1" />
          <circle cx="8.5" cy="5" r="1.1" />
        </svg>
      );
    case 'stuck':
      return (
        <svg {...common} fill="currentColor">
          <rect x="2" y="1.5" width="2" height="7" rx="0.6" />
          <rect x="6" y="1.5" width="2" height="7" rx="0.6" />
        </svg>
      );
    case 'complete':
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1.8 5.3 4 7.4 8.2 2.8" />
        </svg>
      );
    case 'hallucinating':
      return (
        <svg {...common} fill="currentColor">
          <path d="M5 .8 9.4 8.8H.6z" />
        </svg>
      );
    default:
      return (
        <svg {...common} fill="currentColor">
          <circle cx="5" cy="5" r="3" />
        </svg>
      );
  }
};

/** Legend chip / menu row that shows or hides one agent. */
const AgentToggle = ({
  row,
  color,
  onToggle,
}: {
  row: RowSnapshot;
  color: string;
  onToggle: (id: string) => void;
}) => (
  <button
    type="button"
    className={`agentstat-btn agentstat-surface${row.visible ? '' : ' is-off'}`}
    aria-pressed={row.visible}
    title={row.name}
    onClick={() => onToggle(row.id)}
    style={{ '--c': color } as React.CSSProperties}
  >
    <span className="agentstat-swatch" aria-hidden="true" />
    <span className="agentstat-name">
      <bdi>{row.name}</bdi>
    </span>
  </button>
);

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

// No type arguments on the call: they make the compiler drop the pure
// annotation, which would keep the whole component in tree-shaken bundles.
const AgentStat = /*#__PURE__*/ forwardRef(function AgentStat(
  {
    // Default to [] so a missing prop (data still loading, SSR streaming,
    // plain JS callers) renders an empty chart instead of throwing.
    agents: initialAgents = [],
    height = 520,
    theme,
    referenceLine,
    onHealthChange,
    onPointClick,
    onSpikeClick,
    simulateData = false,
    styles = {},
    className,
    style: rootStyle,
    ariaLabel,
    panel = 'auto',
    maxHistoryPoints = DEFAULT_CAP,
    metric = 'progress',
    tokenAxisMax,
    windowSeconds,
    smoothing = 0,
    anomalyDetection = false,
    anomalyConfig,
    onAnomaly,
  }: AgentStatProps,
  ref: React.ForwardedRef<AgentStatRef>
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const dprRef = useRef(1);
  const lastTimeRef = useRef(0);
  const lastDrawRef = useRef(0);
  // Raised by any write that changes what's drawn. The rAF loop runs for the
  // component's lifetime but only repaints when this is set, a value is still
  // easing, or a wall-clock window is scrolling.
  const dirtyRef = useRef(true);
  const gradientCacheRef = useRef<{ key: string; map: Map<string, CanvasGradient> }>({
    key: '',
    map: new Map(),
  });
  const colorCacheRef = useRef<Map<string, { css: string; rgba: RGBA }>>(new Map());
  const tokenMaxCacheRef = useRef({ bucket: -1, value: 0 });
  const frameErrorRef = useRef(false);

  // ── Canonical data store (refs only; the draw loop never reads React state)
  // The initial roster is built once, purely, so the legend and panel are in
  // the first (and server-rendered) markup; the effect below reconciles later
  // changes to the `agents` prop.
  const [initialRoster] = useState(() => buildRoster(initialAgents, maxHistoryPoints));
  const agentsRef = useRef<AgentRecord[]>(initialRoster.list);
  const byIdRef = useRef<Map<string, AgentRecord>>(initialRoster.byId);
  const propsByIdRef = useRef<Map<string, Agent>>(initialRoster.props);
  const progressBufferRef = useRef<Map<string, TimeSeriesBuffer>>(initialRoster.progress);
  const tokensBufferRef = useRef<Map<string, TimeSeriesBuffer>>(initialRoster.tokens);
  const statusLogRef = useRef<Map<string, StatusLog>>(initialRoster.status);
  const latencyLogRef = useRef<Map<string, number[]>>(new Map());
  const liveValuesRef = useRef<Map<string, LiveValues>>(new Map());
  const healthCacheRef = useRef<Map<string, HealthMetrics>>(new Map());
  const anomaliesRef = useRef<Map<string, Anomaly[]>>(new Map());
  const episodesRef = useRef<
    Map<string, Map<AnomalyKind, { severity: AnomalySeverity; lastSeen: number }>>
  >(new Map());
  // Agents whose anomalous status was set by the consumer; the simulator must
  // not auto-recover them.
  const userLockedRef = useRef<Set<string>>(new Set());
  const simStateRef = useRef<Map<string, SimState>>(new Map());
  const pausedAtRef = useRef<number | null>(null);
  const hoverRef = useRef<HoverTarget | null>(null);
  const reducedMotionRef = useRef(false);

  // ── Prop mirrors for the stable callbacks
  const latest = useRef({
    metric,
    tokenAxisMax,
    windowSeconds,
    smoothing,
    referenceLine,
    anomalyDetection,
    anomalyConfig: { ...DEFAULT_ANOMALY_CONFIG, ...anomalyConfig } as AnomalyConfig,
    onAnomaly,
    onHealthChange,
    onPointClick: onPointClick ?? onSpikeClick,
    maxHistoryPoints,
  });
  useEffect(() => {
    const prev = latest.current;
    latest.current = {
      metric,
      tokenAxisMax,
      windowSeconds,
      smoothing,
      referenceLine,
      anomalyDetection,
      anomalyConfig: { ...DEFAULT_ANOMALY_CONFIG, ...anomalyConfig },
      onAnomaly,
      onHealthChange,
      onPointClick: onPointClick ?? onSpikeClick,
      maxHistoryPoints,
    };
    if (
      prev.metric !== metric ||
      prev.tokenAxisMax !== tokenAxisMax ||
      prev.windowSeconds !== windowSeconds ||
      prev.smoothing !== smoothing ||
      prev.referenceLine !== referenceLine ||
      prev.anomalyDetection !== anomalyDetection
    ) {
      tokenMaxCacheRef.current.bucket = -1;
      dirtyRef.current = true;
    }
  });

  // ── React state (DOM overlays only)
  // Seeded from the prop so the legend and panel are in the first (and
  // server-rendered) markup.
  const [rows, setRows] = useState<RowSnapshot[]>(() =>
    (Array.isArray(initialAgents) ? initialAgents : [])
      .filter((a) => a && typeof a.id === 'string')
      .map((a) => ({
        id: a.id,
        name: a.name ?? a.id,
        color: a.color,
        visible: a.visible ?? true,
        status: a.current?.status ?? 'active',
        rate: Number.isFinite(a.current?.tokensRate) ? a.current.tokensRate : 0,
        score: null,
      }))
  );
  const [summary, setSummary] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [alertText, setAlertText] = useState('');
  const [paused, setPaused] = useState(false);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const descId = useId();
  const menuId = useId();
  // Rendered size in CSS px, for layout decisions in the DOM overlays. 0×0
  // until measured (and during server rendering).
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [menuOpen, setMenuOpen] = useState(false);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)', theme === 'system');

  // ── Theme
  const mode: ThemeMode =
    theme === 'dark' || theme === 'light'
      ? theme
      : theme === 'system'
        ? systemDark
          ? 'dark'
          : 'light'
        : isDarkColor(styles.background)
          ? 'dark'
          : 'light';
  const tokens: ThemeTokens = useMemo(() => {
    const base = tokensFor(mode);
    return {
      ...base,
      bg: styles.background || base.bg,
      text: styles.textColor || base.text,
      grid: styles.gridColor || base.grid,
    };
  }, [mode, styles.background, styles.textColor, styles.gridColor]);
  const frameColor = styles.borderColor || (mode === 'dark' ? '#1f1f23' : '#e7e7e4');
  // Canvas can't resolve var(); this holds the resolved values for drawing.
  const themeRef = useRef<{ mode: ThemeMode; t: ThemeTokens }>({ mode, t: tokens });

  useEffect(() => {
    reducedMotionRef.current = prefersReducedMotion();
    return watchMedia('(prefers-reduced-motion: reduce)', (m) => {
      reducedMotionRef.current = m;
      dirtyRef.current = true;
    });
  }, []);

  const resolveTheme = useCallback(() => {
    const el = rootRef.current;
    const t = themeRef.current.t;
    const r = (v: string) => resolveCssVar(v, el);
    themeRef.current = {
      mode: themeRef.current.mode,
      t: { ...t, bg: r(t.bg), text: r(t.text), grid: r(t.grid), reference: r(t.reference) },
    };
    colorCacheRef.current.clear();
    gradientCacheRef.current.key = '';
    dirtyRef.current = true;
  }, []);

  useEffect(() => {
    themeRef.current = { mode, t: tokens };
    resolveTheme();
  }, [mode, tokens, resolveTheme]);

  // Switching theme must not animate every color at once: disable overlay
  // transitions before the new colors paint, restore them after two frames.
  const prevModeRef = useRef(mode);
  useIsomorphicLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || prevModeRef.current === mode) return;
    prevModeRef.current = mode;
    root.setAttribute('data-theme-switching', '');
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => root.removeAttribute('data-theme-switching'));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      root.removeAttribute('data-theme-switching');
    };
  }, [mode]);

  /** Color for a roster entry: its own color, else the palette by position. */
  const colorOf = useCallback((rec: AgentRecord, index: number) => {
    const { mode: m, t } = themeRef.current;
    const key = `${m}|${index}|${rec.color ?? ''}`;
    const cached = colorCacheRef.current.get(key);
    if (cached) return cached;
    const fallback = t.palette[index % t.palette.length];
    let css = rec.color ? resolveCssVar(rec.color, rootRef.current) : fallback;
    let rgba = parseColor(css);
    if (!rgba) {
      warnOnce(`color:${rec.color}`, `Unrecognized color "${rec.color}" for agent "${rec.id}"; using the palette.`);
      css = fallback;
      rgba = parseColor(fallback) ?? { r: 37, g: 99, b: 235, a: 1 };
    }
    const out = { css, rgba };
    colorCacheRef.current.set(key, out);
    return out;
  }, []);

  // ── Buffers
  const retentionMs = () => {
    const winS = latest.current.windowSeconds;
    return (winS !== undefined && winS > 0 ? winS * 1000 : DEFAULT_VIEW_MS) * 1.5;
  };

  const ensureBuffers = useCallback((rec: AgentRecord) => {
    if (progressBufferRef.current.has(rec.id)) return;
    const series = createSeries(rec, latest.current.maxHistoryPoints, performance.now());
    progressBufferRef.current.set(rec.id, series.progress);
    tokensBufferRef.current.set(rec.id, series.tokens);
    statusLogRef.current.set(rec.id, series.status);
  }, []);

  const dropAgentState = (id: string) => {
    byIdRef.current.delete(id);
    progressBufferRef.current.delete(id);
    tokensBufferRef.current.delete(id);
    statusLogRef.current.delete(id);
    latencyLogRef.current.delete(id);
    liveValuesRef.current.delete(id);
    healthCacheRef.current.delete(id);
    anomaliesRef.current.delete(id);
    episodesRef.current.delete(id);
    userLockedRef.current.delete(id);
    simStateRef.current.delete(id);
    if (hoverRef.current?.agentId === id) hoverRef.current = null;
  };

  /** Reconcile the roster with the `agents` prop. */
  const syncRoster = (incoming: Agent[]) => {
    const prevProps = propsByIdRef.current;
    const nextProps = new Map<string, Agent>();
    const next: AgentRecord[] = [];
    for (const a of Array.isArray(incoming) ? incoming : []) {
      if (!a || typeof a.id !== 'string') continue;
      if (nextProps.has(a.id)) {
        warnOnce(`dup:${a.id}`, `Duplicate agent id "${a.id}" ignored.`);
        continue;
      }
      nextProps.set(a.id, a);
      let rec = byIdRef.current.get(a.id);
      if (!rec) {
        rec = makeRecord(a);
        byIdRef.current.set(a.id, rec);
        ensureBuffers(rec);
      } else {
        // Apply static fields that changed since the last prop we saw. Runtime
        // values stay with updateAgent; a legend toggle isn't clobbered by a
        // re-render that passes the same `visible` again.
        const prev = prevProps.get(a.id);
        if (!prev || prev.name !== a.name) rec.name = a.name ?? a.id;
        if (!prev || prev.color !== a.color) rec.color = a.color;
        if (!prev || !sameBand(prev.config?.expectedTokensPerSec, a.config?.expectedTokensPerSec)) {
          rec.config = a.config;
        }
        if (prev && (prev.visible ?? true) !== (a.visible ?? true)) rec.visible = a.visible ?? true;
      }
      next.push(rec);
    }
    for (const id of Array.from(byIdRef.current.keys())) {
      if (!nextProps.has(id)) dropAgentState(id);
    }
    propsByIdRef.current = nextProps;
    agentsRef.current = next;
    colorCacheRef.current.clear();
    dirtyRef.current = true;
  };


  // ── DOM snapshot (legend, panel, screen-reader summary)
  const publishSnapshot = useCallback(() => {
    const next: RowSnapshot[] = agentsRef.current.map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      visible: r.visible,
      status: r.current.status,
      // The latest real sample, not the eased tip value: frames can be
      // throttled (background tabs), and a readout must not lag behind data.
      rate: r.current.tokensRate,
      score: healthCacheRef.current.get(r.id)?.score ?? null,
    }));
    setRows((prev) => {
      const same =
        prev.length === next.length &&
        prev.every(
          (p, i) =>
            p.id === next[i].id &&
            p.name === next[i].name &&
            p.color === next[i].color &&
            p.visible === next[i].visible &&
            p.status === next[i].status &&
            p.score === next[i].score &&
            Math.abs(p.rate - next[i].rate) < 0.05
        );
      return same ? prev : next;
    });
    const visible = next.filter((r) => r.visible);
    setSummary(
      visible.length === 0
        ? 'No agents are shown.'
        : visible
            .map(
              (r) =>
                `${r.name}: ${formatStatus(r.status)}, ${formatRate(r.rate).replace('t/s', 'tokens per second')}${
                  r.score !== null ? `, health ${r.score}` : ''
                }.`
            )
            .join(' ')
    );
  }, []);

  useEffect(() => {
    syncRoster(initialAgents);
    publishSnapshot();
    // syncRoster/publishSnapshot only touch refs and stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAgents, publishSnapshot]);

  // ── Ingest
  const pushSample = (rec: AgentRecord, now: number) => {
    const pBuf = progressBufferRef.current.get(rec.id);
    const tBuf = tokensBufferRef.current.get(rec.id);
    if (!pBuf || !tBuf) return;
    // Rate and progress are sampled together so both series stay aligned.
    pBuf.push(now, rec.current.progress);
    tBuf.push(now, rec.current.tokensRate);
    // While paused, retention is measured from the pause so the frozen view
    // keeps its history.
    const anchor = pausedAtRef.current ?? now;
    const retain = retentionMs();
    pBuf.evictOlderThan(anchor, retain);
    tBuf.evictOlderThan(anchor, retain);
    statusLogRef.current.get(rec.id)?.evictOlderThan(anchor - retain);
    if (pausedAtRef.current === null) dirtyRef.current = true;
  };

  const ingest = useCallback((id: string, sample: AgentSample) => {
    const rec = byIdRef.current.get(id);
    if (!rec) {
      warnOnce(`unknown:${id}`, `updateAgent("${id}") ignored: no agent with that id is in the agents prop.`);
      return;
    }
    if (!sample || typeof sample !== 'object') return;
    const num = (field: keyof AgentSample, lo: number, hi: number): number | undefined => {
      const v = sample[field];
      if (v === undefined) return undefined;
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        warnOnce(`${id}:${field}`, `updateAgent("${id}"): ignored non-finite ${field} (${String(v)}).`);
        return undefined;
      }
      return clamp(v, lo, hi);
    };
    const tokensRate = num('tokensRate', 0, Infinity);
    const progress = num('progress', 0, 100);
    const latencyMs = num('latencyMs', 0, Infinity);
    const confidenceScore = num('confidenceScore', 0, 1);
    const errorCount = num('errorCount', 0, Infinity);
    let status = sample.status;
    if (status !== undefined && !AGENT_STATUSES.includes(status)) {
      warnOnce(`${id}:status:${String(status)}`, `updateAgent("${id}"): unknown status "${String(status)}" ignored.`);
      status = undefined;
    }

    if (status === 'stuck' || status === 'hallucinating') userLockedRef.current.add(id);
    else if (status !== undefined) userLockedRef.current.delete(id);

    const cur = rec.current;
    if (tokensRate !== undefined) cur.tokensRate = tokensRate;
    if (progress !== undefined) cur.progress = progress;
    if (confidenceScore !== undefined) cur.confidenceScore = confidenceScore;
    if (errorCount !== undefined) cur.errorCount = errorCount;
    if (latencyMs !== undefined) {
      cur.latencyMs = latencyMs;
      const log = latencyLogRef.current.get(id) ?? [];
      log.push(latencyMs);
      if (log.length > LATENCY_HISTORY) log.splice(0, log.length - LATENCY_HISTORY);
      latencyLogRef.current.set(id, log);
    }
    const now = performance.now();
    if (status !== undefined) {
      cur.status = status;
      statusLogRef.current.get(id)?.record(now, status);
      if (pausedAtRef.current === null) dirtyRef.current = true;
    }
    if (tokensRate !== undefined || progress !== undefined) pushSample(rec, now);
    // pushSample/retentionMs read refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      updateAgent: ((
        id: string,
        a: AgentSample | number,
        progress?: number,
        status?: AgentStatus
      ) => {
        if (typeof a === 'object' && a !== null) ingest(id, a);
        else ingest(id, { tokensRate: a, progress, status });
      }) as AgentStatRef['updateAgent'],
      getHealth: (id) => {
        const h = healthCacheRef.current.get(id);
        return h ? { ...h } : undefined;
      },
      getAnomalies: (id) => (anomaliesRef.current.get(id) ?? []).map((a) => ({ ...a })),
      getLiveMetrics: (id) => {
        const lv = liveValuesRef.current.get(id);
        const rec = byIdRef.current.get(id);
        if (!lv || !rec) return undefined;
        // Status is discrete and never eased: report it as of now.
        return { tokensRate: lv.tokensRate, progress: lv.progress, status: rec.current.status };
      },
    }),
    [ingest]
  );

  // ── Simulation (demo only)
  const simOn = !!simulateData;
  const simSeed = typeof simulateData === 'object' ? simulateData.seed : undefined;
  useEffect(() => {
    if (!simOn) return;
    const rng: Rng = simSeed !== undefined ? mulberry32(simSeed) : Math.random;
    const touched = new Set<string>();
    // Both maps live for the component's lifetime (mutated, never replaced).
    const byId = byIdRef.current;
    const simStates = simStateRef.current;
    const interval = setInterval(() => {
      if (pausedAtRef.current !== null) return;
      const now = performance.now();
      for (const rec of agentsRef.current) {
        const prev = simStateRef.current.get(rec.id) ?? {
          anomalyTicks: 0,
          confidence: rec.current.confidenceScore ?? 0.9,
        };
        const step = simStep(toAgent(rec), prev, userLockedRef.current.has(rec.id), rng);
        simStateRef.current.set(rec.id, step.state);
        rec.current.tokensRate = step.tokensRate;
        rec.current.progress = step.progress;
        rec.current.confidenceScore = step.confidenceScore;
        touched.add(rec.id);
        if (step.status !== rec.current.status) {
          rec.current.status = step.status;
          statusLogRef.current.get(rec.id)?.record(now, step.status);
        }
        pushSample(rec, now);
      }
    }, SIM_TICK_MS);
    return () => {
      clearInterval(interval);
      // Don't leave demo-only signals on agents once the simulator stops.
      for (const id of touched) {
        const rec = byId.get(id);
        if (rec) delete rec.current.confidenceScore;
      }
      simStates.clear();
    };
    // pushSample reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simOn, simSeed]);

  // ── Health + anomaly tick (runs for hidden agents too: hiding a line must
  // not stop monitoring it)
  useEffect(() => {
    const interval = setInterval(() => {
      const L = latest.current;
      const detectOn = L.anomalyDetection;
      const cfg = L.anomalyConfig;
      const now = performance.now();
      for (const rec of agentsRef.current) {
        const tBuf = tokensBufferRef.current.get(rec.id);
        let found: Anomaly[] = [];
        if (detectOn && tBuf) {
          const tokens = tBuf.since(now - retentionMs());
          const changes =
            statusLogRef.current.get(rec.id)?.transitionsInRange(now - cfg.thrashWindowMs, now) ?? [];
          found = detectAnomalies(tokens, changes, rec.current.status, now, cfg);
          const prev = anomaliesRef.current.get(rec.id) ?? [];
          if (found.length || prev.length) dirtyRef.current = true;
          anomaliesRef.current.set(rec.id, found);

          // Fire once per episode (and on escalation), not once per tick.
          const eps = episodesRef.current.get(rec.id) ?? new Map();
          for (const a of found) {
            const open = eps.get(a.kind);
            const escalated = open?.severity === 'warning' && a.severity === 'critical';
            if (!open || escalated) {
              L.onAnomaly?.(rec.id, { ...a });
              const text = `${rec.name}: ${a.message}.`;
              if (a.severity === 'critical') setAlertText(text);
              else setAnnouncement(text);
            }
            eps.set(a.kind, { severity: a.severity, lastSeen: now });
          }
          for (const [kind, ep] of Array.from(eps)) {
            if (now - ep.lastSeen > EPISODE_GRACE_MS) eps.delete(kind);
          }
          episodesRef.current.set(rec.id, eps);
        } else if (anomaliesRef.current.has(rec.id)) {
          anomaliesRef.current.delete(rec.id);
          episodesRef.current.delete(rec.id);
          dirtyRef.current = true;
        }

        const rates = tBuf ? tBuf.valuesSince(now - HEALTH_WINDOW_MS) : [];
        const health = calculateHealth(
          toAgent(rec),
          rates,
          detectOn ? found : undefined,
          latencyLogRef.current.get(rec.id)
        );
        const cached = healthCacheRef.current.get(rec.id);
        // Ease the headline score so it doesn't flicker; a large drop (e.g.
        // an anomaly penalty) surfaces immediately.
        let score = health.score;
        if (cached && health.score >= cached.score - 15) {
          score = Math.round(cached.score * 0.6 + health.score * 0.4);
        }
        const smoothed = { ...health, score };
        const changed =
          !cached ||
          Math.abs(cached.score - smoothed.score) >= 1 ||
          cached.hallucinationRisk !== smoothed.hallucinationRisk ||
          cached.latencyTrend !== smoothed.latencyTrend;
        healthCacheRef.current.set(rec.id, smoothed);
        if (changed) L.onHealthChange?.(rec.id, { ...smoothed });
      }
      // The DOM overlays don't need updates nobody can see.
      if (typeof document === 'undefined' || !document.hidden) publishSnapshot();
    }, HEALTH_TICK_MS);
    return () => clearInterval(interval);
  }, [publishSnapshot]);

  // ── View geometry, shared by drawing, hover and keyboard inspection so they
  // can never disagree about where a sample is.
  const computeView = useCallback((now: number, cssW: number, cssH: number): View => {
    const L = latest.current;
    const w = Math.max(1, cssW - PAD.left - PAD.right);
    const h = Math.max(1, cssH - PAD.top - PAD.bottom);
    const viewNow = pausedAtRef.current ?? now;
    const winMs = L.windowSeconds !== undefined && L.windowSeconds > 0 ? L.windowSeconds * 1000 : undefined;
    const primaryIsTokens = L.metric === 'tokens';
    const primaryMap = primaryIsTokens ? tokensBufferRef.current : progressBufferRef.current;

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
      for (const rec of agentsRef.current) {
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
    if (L.metric !== 'progress') {
      let tokenMax = L.tokenAxisMax;
      if (tokenMax === undefined || !(tokenMax > 0)) {
        const cache = tokenMaxCacheRef.current;
        const bucket = Math.floor(now / 250);
        if (bucket !== cache.bucket) {
          let observed = 0;
          for (const rec of agentsRef.current) {
            if (!rec.visible) continue;
            const buf = tokensBufferRef.current.get(rec.id);
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
  }, []);

  /** Samples of `buf` in view (raw), never past the right edge. */
  const pointsFor = (buf: TimeSeriesBuffer, view: View): TSPoint[] => {
    const pts = buf.windowed(view.sliceNow, view.effWinMs, view.drawTarget, view.recomputeMs).points;
    let end = pts.length;
    while (end > 0 && pts[end - 1].t > view.tEnd) end--;
    return end === pts.length ? pts : pts.slice(0, end);
  };

  const primaryBuffer = (id: string, view: View) =>
    (view.primaryIsTokens ? tokensBufferRef.current : progressBufferRef.current).get(id);

  // ── Drawing
  const draw = (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, now: number) => {
    const dpr = dprRef.current;
    const cssW = canvas.width / dpr;
    const cssH = canvas.height / dpr;
    if (cssW < 1 || cssH < 1) return;
    const { t: tk } = themeRef.current;
    const L = latest.current;

    ctx.fillStyle = tk.bg;
    ctx.fillRect(0, 0, cssW, cssH);

    const view = computeView(now, cssW, cssH);
    const { w, h, xOf, primaryToY, tokenToY, progressToY, safeTokenMax } = view;
    if (w < 16 || h < 16) return;
    const metric = L.metric;
    const showProgress = metric !== 'tokens';
    const reduceMotion = reducedMotionRef.current;

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
      ctx.fillText(
        showProgress ? `${pct}%` : formatAxisValue((safeTokenMax * pct) / 100),
        PAD.left - 10,
        y
      );
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
      TIME_STEPS_S.find((s) => (view.span / 1000) / s <= targetTicks) ??
      TIME_STEPS_S[TIME_STEPS_S.length - 1];
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
      const col = rl.color ? resolveCssVar(rl.color, rootRef.current) : tk.reference;
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

    // ── Gradient cache (geometry + theme)
    const gkey = `${PAD.top}:${h}:${PAD.left}:${w}:${tk.bg}:${agentsRef.current.reduce((n, r) => n + (r.visible ? 1 : 0), 0)}`;
    const gcache = gradientCacheRef.current;
    if (gcache.key !== gkey) {
      gcache.key = gkey;
      gcache.map.clear();
    }

    // ── Series
    type Marker = { x: number; anomaly: Anomaly; name: string };
    const markers: Marker[] = [];
    let drewAny = false;
    const visibleCount = agentsRef.current.reduce((n, r) => n + (r.visible ? 1 : 0), 0);
    agentsRef.current.forEach((rec, idx) => {
      if (!rec.visible) return;
      const buf = primaryBuffer(rec.id, view);
      if (!buf || buf.length === 0) return;
      const raw = pointsFor(buf, view);
      if (raw.length === 0) return;
      const col = colorOf(rec, idx);
      const pts = emaPoints(raw, L.smoothing);
      const lv = liveValuesRef.current.get(rec.id);
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
        const tBuf = tokensBufferRef.current.get(rec.id);
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
      const pulse = reduceMotion || !live ? 0.5 : 0.5 + 0.5 * Math.sin(now / 420);
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
        for (const an of anomaliesRef.current.get(rec.id) ?? []) {
          markers.push({ x: clamp(xOf(an.t), PAD.left, PAD.left + w), anomaly: an, name: rec.name });
        }
      }
    });

    // ── Anomaly markers (above every series). Severity is carried by shape
    // and wording as well as color: ▲ warning, ◆ critical.
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
    const hv = hoverRef.current;
    if (hv) {
      const rec = byIdRef.current.get(hv.agentId);
      if (!rec || !rec.visible || hv.t < view.tStart) {
        hoverRef.current = null;
        setHover(null);
      } else {
        const x = xOf(hv.t);
        const y = primaryToY(hv.drawV);
        const col = colorOf(rec, agentsRef.current.indexOf(rec));
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
        // Keep the tooltip pinned to the point as the chart scrolls, without
        // a React render per frame.
        const tipEl = tooltipRef.current;
        if (tipEl) {
          tipEl.style.left = `${clamp(x, 90, cssW - 90)}px`;
          tipEl.style.top = `${y}px`;
          tipEl.dataset.place = y < 72 ? 'below' : 'above';
        }
      }
    }

    // ── Empty states
    if (!drewAny) {
      ctx.fillStyle = tk.textTertiary;
      ctx.font = `500 12px ${FONT_SANS}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const msg =
        agentsRef.current.length === 0
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
  };

  const frame = (now: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let ctx = ctxRef.current;
    if (!ctx) {
      ctx = canvas.getContext('2d');
      ctxRef.current = ctx;
    }
    if (!ctx) return;
    const delta = lastTimeRef.current ? Math.min((now - lastTimeRef.current) / 16.67, 2.5) : 1;
    lastTimeRef.current = now;

    // Ease live values toward their targets (all agents, visible or not, so
    // getLiveMetrics is always current). Frozen while paused; snapped under
    // reduced motion.
    const EPS = 0.05;
    let animating = false;
    const paused = pausedAtRef.current !== null;
    const snap = reducedMotionRef.current;
    for (const rec of agentsRef.current) {
      let lv = liveValuesRef.current.get(rec.id);
      if (!lv) {
        lv = { tokensRate: rec.current.tokensRate, progress: rec.current.progress, status: rec.current.status };
        liveValuesRef.current.set(rec.id, lv);
      }
      lv.status = rec.current.status;
      if (paused) continue;
      const dp = rec.current.progress - lv.progress;
      const dt = rec.current.tokensRate - lv.tokensRate;
      if (snap || (Math.abs(dp) <= EPS && Math.abs(dt) <= EPS)) {
        lv.progress = rec.current.progress;
        lv.tokensRate = rec.current.tokensRate;
        continue;
      }
      lv.progress = lerp(lv.progress, rec.current.progress, 1 - Math.pow(0.78, delta));
      lv.tokensRate = lerp(lv.tokensRate, rec.current.tokensRate, 1 - Math.pow(0.88, delta));
      if (rec.visible) animating = true;
    }

    // A wall-clock window scrolls continuously; 30 fps is plenty for that.
    const windowDue =
      !paused &&
      latest.current.windowSeconds !== undefined &&
      latest.current.windowSeconds > 0 &&
      now - lastDrawRef.current >= 33;
    if (!dirtyRef.current && !animating && !windowDue) return;
    dirtyRef.current = false;
    lastDrawRef.current = now;
    draw(ctx, canvas, now);
  };
  const frameRef = useRef(frame);
  useEffect(() => {
    frameRef.current = frame;
  });

  useEffect(() => {
    let raf = 0;
    let alive = true;
    const loop = () => {
      if (!alive) return;
      try {
        frameRef.current(performance.now());
      } catch (err) {
        // A bad frame must never stop the chart: log once, keep looping.
        if (!frameErrorRef.current) {
          frameErrorRef.current = true;
          console.error('[agentstat] render error (the chart keeps running):', err);
        }
      } finally {
        if (alive) raf = requestAnimationFrame(loop);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, []);

  // ── Sizing: container resizes (not just window), DPR changes when the
  // window moves between displays, and mounting inside a hidden container.
  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const rect = canvas.getBoundingClientRect();
    const pw = Math.max(1, Math.round(rect.width * dpr));
    const ph = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    dprRef.current = dpr;
    const ctx = canvas.getContext('2d');
    ctxRef.current = ctx;
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    gradientCacheRef.current.key = '';
    dirtyRef.current = true;
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
  }, []);

  useEffect(() => {
    resizeCanvas();
    resolveTheme();
    const canvas = canvasRef.current;
    let ro: ResizeObserver | null = null;
    if (canvas && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => resizeCanvas());
      ro.observe(canvas);
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', resizeCanvas);
    }
    let stopDpr = () => {};
    const watchDpr = () => {
      stopDpr();
      if (typeof window === 'undefined') return;
      stopDpr = watchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`, () => {
        resizeCanvas();
        watchDpr();
      });
    };
    watchDpr();
    return () => {
      ro?.disconnect();
      if (!ro && typeof window !== 'undefined') window.removeEventListener('resize', resizeCanvas);
      stopDpr();
    };
  }, [resizeCanvas, resolveTheme]);

  // ── Inspection (hover + keyboard)
  const currentView = () => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const dpr = dprRef.current;
    return computeView(performance.now(), canvas.width / dpr, canvas.height / dpr);
  };

  const selectPoint = (rec: AgentRecord, raw: TSPoint[], drawn: TSPoint[], i: number, view: View) => {
    const p = drawn[i];
    const rawV = raw[i].v;
    if (hoverRef.current?.agentId === rec.id && hoverRef.current.t === p.t) return;
    const other = view.primaryIsTokens
      ? progressBufferRef.current.get(rec.id)
      : tokensBufferRef.current.get(rec.id);
    const companion = other?.nearestValueAt(p.t);
    const point: AgentDataPoint = {
      time: p.t,
      tokensRate: view.primaryIsTokens ? rawV : (companion ?? rec.current.tokensRate),
      progress: view.primaryIsTokens ? (companion ?? rec.current.progress) : rawV,
      status: statusLogRef.current.get(rec.id)?.statusAt(p.t) ?? rec.current.status,
    };
    hoverRef.current = { agentId: rec.id, t: p.t, drawV: p.v };
    const idx = agentsRef.current.indexOf(rec);
    setHover({
      agentId: rec.id,
      ageMs: view.viewNow - p.t,
      name: rec.name,
      color: rec.color ?? themeRef.current.t.palette[idx % themeRef.current.t.palette.length],
      point,
      x: clamp(view.xOf(p.t), 90, view.cssW - 90),
      y: view.primaryToY(p.v),
    });
    dirtyRef.current = true;
  };

  const clearHover = () => {
    if (!hoverRef.current) return;
    hoverRef.current = null;
    setHover(null);
    dirtyRef.current = true;
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const view = currentView();
    if (!canvas || !view) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    if (mx < PAD.left || mx > PAD.left + view.w || my < PAD.top || my > PAD.top + view.h) {
      clearHover();
      return;
    }
    let best: { rec: AgentRecord; raw: TSPoint[]; drawn: TSPoint[]; i: number } | null = null;
    let bestDist = HIT_RADIUS;
    for (const rec of agentsRef.current) {
      if (!rec.visible) continue;
      const buf = primaryBuffer(rec.id, view);
      if (!buf) continue;
      const raw = pointsFor(buf, view);
      if (raw.length === 0) continue;
      const drawn = emaPoints(raw, latest.current.smoothing);
      for (let i = 0; i < drawn.length; i++) {
        const d = Math.hypot(view.xOf(drawn[i].t) - mx, view.primaryToY(drawn[i].v) - my);
        if (d < bestDist) {
          bestDist = d;
          best = { rec, raw, drawn, i };
        }
      }
    }
    if (best) selectPoint(best.rec, best.raw, best.drawn, best.i, view);
    else clearHover();
  };

  const firePointClick = () => {
    const cb = latest.current.onPointClick;
    if (cb && hover) cb(hover.agentId, { ...hover.point });
  };

  const togglePause = () => {
    const next = pausedAtRef.current === null;
    pausedAtRef.current = next ? performance.now() : null;
    setPaused(next);
    dirtyRef.current = true;
  };

  // Keyboard inspection: ←/→ step through samples, ↑/↓ switch agent,
  // Home/End jump, Enter activates, Esc clears, Space pauses.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (e.key === ' ') {
      e.preventDefault();
      togglePause();
      return;
    }
    if (e.key === 'Escape') {
      clearHover();
      return;
    }
    if (e.key === 'Enter') {
      firePointClick();
      return;
    }
    const nav = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!nav.includes(e.key)) return;
    e.preventDefault();
    const view = currentView();
    if (!view) return;
    const visible = agentsRef.current.filter((r) => r.visible);
    if (visible.length === 0) return;
    let ai = Math.max(0, visible.findIndex((r) => r.id === hoverRef.current?.agentId));
    if (e.key === 'ArrowUp') ai = (ai - 1 + visible.length) % visible.length;
    if (e.key === 'ArrowDown') ai = (ai + 1) % visible.length;
    const rec = visible[ai];
    const buf = primaryBuffer(rec.id, view);
    if (!buf) return;
    const raw = pointsFor(buf, view);
    if (raw.length === 0) return;
    const drawn = emaPoints(raw, latest.current.smoothing);
    const curT = hoverRef.current?.agentId === rec.id ? hoverRef.current.t : undefined;
    let i = drawn.length - 1;
    if (curT !== undefined) {
      i = drawn.findIndex((p) => p.t >= curT);
      if (i < 0) i = drawn.length - 1;
    }
    if (hoverRef.current) {
      if (e.key === 'ArrowLeft') i -= 1;
      if (e.key === 'ArrowRight') i += 1;
    }
    if (e.key === 'Home') i = 0;
    if (e.key === 'End') i = drawn.length - 1;
    selectPoint(rec, raw, drawn, clamp(i, 0, drawn.length - 1), view);
  };

  const handleShowAll = () => {
    for (const id of rows.map((r) => r.id)) {
      const rec = byIdRef.current.get(id);
      if (rec) rec.visible = true;
    }
    tokenMaxCacheRef.current.bucket = -1;
    dirtyRef.current = true;
    publishSnapshot();
  };

  // Close the overflow menu on a pointer press outside it.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || moreBtnRef.current?.contains(t)) return;
      setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [menuOpen]);

  const handleToggleAgent = (id: string) => {
    const rec = byIdRef.current.get(id);
    if (!rec) return;
    rec.visible = !rec.visible;
    tokenMaxCacheRef.current.bucket = -1;
    dirtyRef.current = true;
    publishSnapshot();
  };

  // ── Render
  const palette = tokens.palette;
  const colorFor = (r: RowSnapshot) => r.color ?? palette[rows.indexOf(r) % palette.length];
  const visibleRows = rows.filter((r) => r.visible);
  const panelRows = visibleRows.slice(0, MAX_PANEL_ROWS);
  const showPanel =
    panel === 'always' || (panel === 'auto' && (size.w === 0 || (size.w >= 560 && size.h >= 340)));

  // Legend: one row of chips; whatever doesn't fit moves into a "+N" menu.
  let chipCount = rows.length;
  if (size.w > 0) {
    const available = size.w - 24 - PAUSE_CHIP - 8;
    const widths = rows.map((r) => Math.min(CHIP_TEXT_MAX, measureChipText(r.name)) + CHIP_CHROME);
    const total = widths.reduce((a, b) => a + b, 0) + Math.max(0, widths.length - 1) * 4;
    if (total > available) {
      let used = MORE_CHIP;
      chipCount = 0;
      while (chipCount < widths.length && used + widths[chipCount] + 4 <= available) {
        used += widths[chipCount] + 4;
        chipCount++;
      }
    }
  }
  const chipRows = rows.slice(0, chipCount);
  const overflowRows = rows.slice(chipCount);
  const hiddenCount = rows.length - visibleRows.length;
  const label =
    ariaLabel ??
    `Live agent telemetry chart, ${visibleRows.length} of ${rows.length} agent${rows.length === 1 ? '' : 's'} shown.`;

  const rootVars = {
    '--as-bg': tokens.bg,
    '--as-surface': tokens.surface,
    '--as-text': tokens.text,
    '--as-text-secondary': tokens.textSecondary,
    '--as-text-tertiary': tokens.textTertiary,
    '--as-focus': tokens.focus,
    '--as-selected': tokens.selected,
    '--as-warning': tokens.warning,
    '--as-critical': tokens.critical,
    '--as-shadow': tokens.shadow,
    '--as-frame': frameColor,
    '--as-font': FONT_SANS,
    '--as-font-mono': FONT_MONO,
  } as React.CSSProperties;

  return (
    <div
      ref={rootRef}
      className={className ? `agentstat ${className}` : 'agentstat'}
      data-theme={mode}
      // The chart is laid out left to right in every locale (time runs left to
      // right); names in any script are isolated with <bdi>.
      dir="ltr"
      style={{ width: '100%', height, ...rootVars, ...rootStyle }}
    >
      <style>{CSS}</style>
      <canvas
        ref={canvasRef}
        className="agentstat-canvas"
        role="img"
        aria-label={label}
        aria-describedby={descId}
        aria-keyshortcuts="Space ArrowLeft ArrowRight ArrowUp ArrowDown Home End Enter Escape"
        tabIndex={0}
        onMouseMove={handleMouseMove}
        onMouseLeave={clearHover}
        onBlur={clearHover}
        onClick={firePointClick}
        onKeyDown={handleKeyDown}
      />
      <p id={descId} className="agentstat-sr">
        {summary} Use the arrow keys to inspect samples and Space to pause.
      </p>
      <div role="status" className="agentstat-sr">
        {announcement}
      </div>
      <div role="alert" className="agentstat-sr">
        {alertText}
      </div>

      {rows.length > 0 && (
        <div className="agentstat-legend" role="group" aria-label="Agents">
          {chipRows.map((r) => (
            <AgentToggle key={r.id} row={r} color={colorFor(r)} onToggle={handleToggleAgent} />
          ))}
          {overflowRows.length > 0 && (
            <button
              ref={moreBtnRef}
              type="button"
              className="agentstat-btn agentstat-surface agentstat-more-btn"
              aria-expanded={menuOpen}
              aria-controls={menuId}
              aria-label={`${overflowRows.length} more agent${overflowRows.length === 1 ? '' : 's'}`}
              onClick={() => setMenuOpen((o) => !o)}
            >
              +{overflowRows.length}
            </button>
          )}
        </div>
      )}

      {menuOpen && overflowRows.length > 0 && (
        <div
          ref={menuRef}
          id={menuId}
          className="agentstat-menu agentstat-surface"
          role="group"
          aria-label="More agents"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setMenuOpen(false);
              moreBtnRef.current?.focus();
            }
          }}
        >
          {hiddenCount > 0 && (
            <button type="button" className="agentstat-btn agentstat-menu-all" onClick={handleShowAll}>
              Show all agents
            </button>
          )}
          {overflowRows.map((r) => (
            <AgentToggle key={r.id} row={r} color={colorFor(r)} onToggle={handleToggleAgent} />
          ))}
        </div>
      )}

      {showPanel && panelRows.length > 0 && (
        <div className="agentstat-panel agentstat-surface" aria-hidden="true">
          <span />
          <span className="agentstat-head">Agent</span>
          <span className="agentstat-head" style={{ textAlign: 'right' }}>Rate</span>
          <span className="agentstat-head" style={{ textAlign: 'right' }}>Health</span>
          <span className="agentstat-head">Status</span>
          {panelRows.map((r) => (
            <React.Fragment key={r.id}>
              <span className="agentstat-swatch" style={{ '--c': colorFor(r) } as React.CSSProperties} />
              <span className="agentstat-name agentstat-secondary" title={r.name}>
                <bdi>{r.name}</bdi>
              </span>
              <span className="agentstat-num">{formatRate(r.rate)}</span>
              <span className="agentstat-num">{r.score === null ? '–' : formatInt(r.score)}</span>
              <span className="agentstat-status" data-tone={statusTone(r.status)}>
                <StatusIcon status={r.status} />
                {formatStatus(r.status)}
              </span>
            </React.Fragment>
          ))}
          {visibleRows.length > panelRows.length && (
            <span className="agentstat-more">+{visibleRows.length - panelRows.length} more</span>
          )}
        </div>
      )}

      <div className="agentstat-pause">
        <button
          type="button"
          className="agentstat-btn agentstat-surface"
          aria-pressed={paused}
          onClick={togglePause}
        >
          <span className="agentstat-icon" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" data-on={!paused}>
              <rect x="2.5" y="2" width="2.5" height="8" rx="0.75" />
              <rect x="7" y="2" width="2.5" height="8" rx="0.75" />
            </svg>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" data-on={paused}>
              {/* Nudged right of center: a triangle's visual mass sits left. */}
              <path d="M3.75 2.2v7.6a.6.6 0 0 0 .9.52l6.1-3.8a.6.6 0 0 0 0-1.04l-6.1-3.8a.6.6 0 0 0-.9.52Z" />
            </svg>
          </span>
          {paused ? 'Resume' : 'Pause'}
        </button>
      </div>

      {hover && (
        <div
          ref={tooltipRef}
          className="agentstat-tooltip agentstat-surface"
          data-place={hover.y < 72 ? 'below' : 'above'}
          style={{ left: hover.x, top: hover.y }}
          aria-hidden="true"
        >
          <div className="agentstat-tooltip-head">
            <span className="agentstat-swatch" style={{ '--c': hover.color } as React.CSSProperties} />
            <bdi>{hover.name}</bdi>
            <span className="agentstat-tooltip-age">
              {formatAgo(hover.ageMs)}
            </span>
          </div>
          <div className="agentstat-tooltip-body">
            {formatRate(hover.point.tokensRate)} · {formatPercent(hover.point.progress)} ·{' '}
            {formatStatus(hover.point.status)}
          </div>
        </div>
      )}
    </div>
  );
});

export default AgentStat;

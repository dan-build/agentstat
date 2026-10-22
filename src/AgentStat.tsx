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
  useSyncExternalStore,
} from 'react';

import type { TSPoint } from './timeseries';
import { DEFAULT_ANOMALY_CONFIG, type Anomaly, type AnomalyConfig } from './anomaly';
import { isDarkColor, resolveCssVar } from './color';
import { tokensFor, FONT_SANS, FONT_MONO, type ThemeMode, type ThemeTokens } from './theme';
import { mulberry32, SIM_TICK_MS, type Rng } from './simulator';
import { formatRate, formatStatus } from './format';
import type { Agent, AgentDataPoint, AgentSample, AgentStatus, ChartMetric, HealthMetrics } from './types';
import { DEFAULT_CAP, HEALTH_TICK_MS, HIT_RADIUS, PAD, clamp } from './core/constants';
import { emaPoints } from './core/curve';
import { AgentStore, type RowSnapshot } from './core/store';
import type { AgentRecord } from './core/record';
import { computeView, pointsFor, primaryBuffer, type View } from './core/view';
import { ColorResolver } from './core/colors';
import { drawFrame, type DrawContext, type GradientCache, type HoverTarget } from './core/draw';
import { CSS } from './ui/styles';
import { Legend } from './ui/Legend';
import { Panel } from './ui/Panel';
import { Tooltip, type HoverInfo } from './ui/Tooltip';
import { PauseButton } from './ui/PauseButton';
import { prefersReducedMotion, useIsomorphicLayoutEffect, useMediaQuery, watchMedia } from './ui/hooks';

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
export { niceMax } from './core/curve';

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
// COMPONENT
//
// Composition only: the store (src/core/store.ts) owns the data, drawFrame
// (src/core/draw.ts) paints the canvas, and the overlays in src/ui render
// from the store's row snapshot.
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
  const frameErrorRef = useRef(false);
  const hoverRef = useRef<HoverTarget | null>(null);
  const reducedMotionRef = useRef(false);

  // The store is created once, synchronously, so the legend and panel are in
  // the first (and server-rendered) markup.
  const [store] = useState(
    () =>
      new AgentStore(
        initialAgents,
        { windowSeconds, maxHistoryPoints },
        typeof performance !== 'undefined' ? performance.now() : 0
      )
  );
  const [gradients] = useState<GradientCache>(() => ({ key: '', map: new Map() }));
  const [colors] = useState(() => new ColorResolver(() => rootRef.current));
  // Reused every frame; its changing fields are refreshed before each draw.
  const [drawCtx] = useState<DrawContext>(() => ({
    store,
    opts: { metric: 'progress', smoothing: 0, anomalyDetection: false },
    theme: { mode: 'light', t: tokensFor('light') },
    colors,
    gradients,
    resolveColor: (c) => resolveCssVar(c, rootRef.current),
    hover: null,
    reduceMotion: false,
  }));
  const rows = useSyncExternalStore(store.subscribe, store.getRows, store.getRows);

  // ── Latest props, read by the render loop and timers
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
    };
    store.setOptions({ windowSeconds, maxHistoryPoints });
    if (
      prev.metric !== metric ||
      prev.tokenAxisMax !== tokenAxisMax ||
      prev.windowSeconds !== windowSeconds ||
      prev.smoothing !== smoothing ||
      prev.referenceLine !== referenceLine ||
      prev.anomalyDetection !== anomalyDetection
    ) {
      store.invalidate(true);
    }
  });

  // ── React state (DOM overlays only)
  const [announcement, setAnnouncement] = useState('');
  const [alertText, setAlertText] = useState('');
  const [paused, setPaused] = useState(false);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const descId = useId();
  // Rendered size in CSS px, for layout decisions in the DOM overlays. 0×0
  // until measured (and during server rendering).
  const [size, setSize] = useState({ w: 0, h: 0 });
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
      store.invalidate();
    });
  }, [store]);

  const resolveTheme = useCallback(() => {
    const el = rootRef.current;
    const t = themeRef.current.t;
    const r = (v: string) => resolveCssVar(v, el);
    themeRef.current = {
      mode: themeRef.current.mode,
      t: { ...t, bg: r(t.bg), text: r(t.text), grid: r(t.grid), reference: r(t.reference) },
    };
    colors.clear();
    gradients.key = '';
    store.invalidate();
  }, [colors, gradients, store]);

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

  // ── Roster
  useEffect(() => {
    store.syncRoster(initialAgents, performance.now());
    colors.clear();
    store.publish();
  }, [initialAgents, store, colors]);

  // ── Imperative API
  useImperativeHandle(
    ref,
    () => ({
      updateAgent: ((id: string, a: AgentSample | number, progress?: number, status?: AgentStatus) => {
        const sample = typeof a === 'object' && a !== null ? a : { tokensRate: a, progress, status };
        store.ingest(id, sample, performance.now());
      }) as AgentStatRef['updateAgent'],
      getHealth: (id) => store.getHealth(id),
      getAnomalies: (id) => store.getAnomalies(id),
      getLiveMetrics: (id) => store.getLiveMetrics(id),
    }),
    [store]
  );

  // ── Simulation (demo only)
  const simOn = !!simulateData;
  const simSeed = typeof simulateData === 'object' ? simulateData.seed : undefined;
  useEffect(() => {
    if (!simOn) return;
    const rng: Rng = simSeed !== undefined ? mulberry32(simSeed) : Math.random;
    const interval = setInterval(() => store.simTick(rng, performance.now()), SIM_TICK_MS);
    return () => {
      clearInterval(interval);
      store.simStop();
    };
  }, [simOn, simSeed, store]);

  // ── Health + anomaly tick
  useEffect(() => {
    const interval = setInterval(() => {
      const L = latest.current;
      store.healthTick(performance.now(), L.anomalyDetection, L.anomalyConfig, (ev) => {
        if (ev.kind === 'anomaly') {
          L.onAnomaly?.(ev.id, { ...ev.anomaly });
          const text = `${ev.name}: ${ev.anomaly.message}.`;
          if (ev.anomaly.severity === 'critical') setAlertText(text);
          else setAnnouncement(text);
        } else {
          L.onHealthChange?.(ev.id, { ...ev.health });
        }
      });
      // The DOM overlays don't need updates nobody can see.
      if (typeof document === 'undefined' || !document.hidden) store.publish();
    }, HEALTH_TICK_MS);
    return () => clearInterval(interval);
  }, [store]);

  // ── Render loop
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

    const animating = store.stepLive(delta, reducedMotionRef.current);
    const L = latest.current;
    // A wall-clock window scrolls continuously; 30 fps is plenty for that.
    const windowDue =
      store.pausedAt === null &&
      L.windowSeconds !== undefined &&
      L.windowSeconds > 0 &&
      now - lastDrawRef.current >= 33;
    if (!store.takeDirty() && !animating && !windowDue) return;
    lastDrawRef.current = now;

    const dpr = dprRef.current;
    drawCtx.opts = L;
    drawCtx.theme = themeRef.current;
    drawCtx.hover = hoverRef.current;
    drawCtx.reduceMotion = reducedMotionRef.current;
    const result = drawFrame(ctx, canvas.width / dpr, canvas.height / dpr, now, drawCtx);
    if (result === 'gone') {
      hoverRef.current = null;
      setHover(null);
    } else if (result) {
      // Keep the tooltip pinned to the point as the chart scrolls, without a
      // React render per frame.
      const tipEl = tooltipRef.current;
      if (tipEl) {
        tipEl.style.left = `${clamp(result.x, 90, result.cssW - 90)}px`;
        tipEl.style.top = `${result.y}px`;
        tipEl.dataset.place = result.y < 72 ? 'below' : 'above';
      }
    }
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
    gradients.key = '';
    store.invalidate();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
  }, [gradients, store]);

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
    return computeView(store, latest.current, performance.now(), canvas.width / dpr, canvas.height / dpr);
  };

  const selectPoint = (rec: AgentRecord, raw: TSPoint[], drawn: TSPoint[], i: number, view: View) => {
    const p = drawn[i];
    const rawV = raw[i].v;
    if (hoverRef.current?.agentId === rec.id && hoverRef.current.t === p.t) return;
    const other = view.primaryIsTokens ? store.progress.get(rec.id) : store.tokens.get(rec.id);
    const companion = other?.nearestValueAt(p.t);
    const point: AgentDataPoint = {
      time: p.t,
      tokensRate: view.primaryIsTokens ? rawV : (companion ?? rec.current.tokensRate),
      progress: view.primaryIsTokens ? (companion ?? rec.current.progress) : rawV,
      status: store.status.get(rec.id)?.statusAt(p.t) ?? rec.current.status,
    };
    hoverRef.current = { agentId: rec.id, t: p.t, drawV: p.v };
    const idx = store.list.indexOf(rec);
    const palette = themeRef.current.t.palette;
    setHover({
      agentId: rec.id,
      ageMs: view.viewNow - p.t,
      name: rec.name,
      color: rec.color ?? palette[idx % palette.length],
      point,
      x: clamp(view.xOf(p.t), 90, view.cssW - 90),
      y: view.primaryToY(p.v),
    });
    store.invalidate();
  };

  const clearHover = () => {
    if (!hoverRef.current) return;
    hoverRef.current = null;
    setHover(null);
    store.invalidate();
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
    for (const rec of store.list) {
      if (!rec.visible) continue;
      const buf = primaryBuffer(store, rec.id, view);
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
    const next = store.pausedAt === null;
    store.setPaused(next, performance.now());
    setPaused(next);
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
    const visible = store.list.filter((r) => r.visible);
    if (visible.length === 0) return;
    let ai = Math.max(0, visible.findIndex((r) => r.id === hoverRef.current?.agentId));
    if (e.key === 'ArrowUp') ai = (ai - 1 + visible.length) % visible.length;
    if (e.key === 'ArrowDown') ai = (ai + 1) % visible.length;
    const rec = visible[ai];
    const buf = primaryBuffer(store, rec.id, view);
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

  const handleToggleAgent = (id: string) => {
    store.toggleVisible(id);
    store.publish();
  };

  const handleShowAll = () => {
    store.showAll();
    store.publish();
  };

  // ── Render
  const palette = tokens.palette;
  const colorFor = (r: RowSnapshot) => r.color ?? palette[rows.indexOf(r) % palette.length];
  const visibleRows = rows.filter((r) => r.visible);
  const showPanel =
    panel === 'always' || (panel === 'auto' && (size.w === 0 || (size.w >= 560 && size.h >= 340)));
  const summary = useMemo(
    () =>
      visibleRows.length === 0
        ? 'No agents are shown.'
        : visibleRows
            .map(
              (r) =>
                `${r.name}: ${formatStatus(r.status)}, ${formatRate(r.rate).replace('t/s', 'tokens per second')}${
                  r.score !== null ? `, health ${r.score}` : ''
                }.`
            )
            .join(' '),
    // visibleRows is derived from rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows]
  );
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

      <Legend rows={rows} colorFor={colorFor} width={size.w} onToggle={handleToggleAgent} onShowAll={handleShowAll} />
      {showPanel && <Panel rows={visibleRows} colorFor={colorFor} />}
      <PauseButton paused={paused} onToggle={togglePause} />
      {hover && <Tooltip hover={hover} innerRef={tooltipRef} />}
    </div>
  );
});

export default AgentStat;

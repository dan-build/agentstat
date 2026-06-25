'use client';

import React, {
  useRef,
  useEffect,
  useState,
  useCallback,
  forwardRef,
  useImperativeHandle,
  useMemo,
} from 'react';

import { TimeSeriesBuffer } from './timeseries';
import { StatusLog } from './statuslog';
import {
  detectAnomalies,
  DEFAULT_ANOMALY_CONFIG,
  type Anomaly,
  type AnomalyConfig,
} from './anomaly';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type AgentStatus = 'active' | 'stuck' | 'thinking' | 'complete' | 'hallucinating';

/**
 * Which series the chart plots on the primary visual.
 * - 'progress' (default): the historical 0–100% progress curve (v0.1 behavior).
 * - 'tokens': the token-rate curve on a data-driven auto-scaled axis.
 * - 'both': progress on the left axis, token rate on the right (dual-axis).
 */
export type ChartMetric = 'progress' | 'tokens' | 'both';

export type AgentDataPoint = {
  time: number;
  tokensRate: number;
  progress: number;
  status: AgentStatus;
  latencyMs?: number;
  confidenceScore?: number;
  errorCount?: number;
};

export type HealthMetrics = {
  score: number;
  tokenEfficiency: number;
  stability: number;
  hallucinationRisk: number;
  latencyTrend: 'improving' | 'stable' | 'degrading';
};

export type Agent = {
  id: string;
  name: string;
  color: string;
  /**
   * Always pass `[]`. AgentStat manages its own internal buffer
   * and does not read from this array at runtime.
   */
  data: AgentDataPoint[];
  current: {
    tokensRate: number;
    progress: number;
    status: AgentStatus;
    latencyMs?: number;
    confidenceScore?: number;
    errorCount?: number;
  };
  config?: {
    expectedTokensPerSec?: [number, number];
    maxHallucinationThreshold?: number;
  };
  visible: boolean;
};

export interface AgentStatProps {
  agents: Agent[];
  height?: number;
  /** @deprecated width is always 100% of its container. Pass only height. */
  width?: number;
  referenceLine?: { value: number; label?: string; color?: string };
  onHealthChange?: (agentId: string, health: HealthMetrics) => void;
  onSpikeClick?: (agentId: string, point: AgentDataPoint) => void;
  simulateData?: boolean;
  styles?: {
    background?: string;
    borderColor?: string;
    textColor?: string;
    gridColor?: string;
  };
  /** CSS class name applied to the root container div. */
  className?: string;
  /** Inline styles applied to the root container div (merged with internal positioning). */
  style?: React.CSSProperties;
  /**
   * Maximum number of historical data points kept per agent (rolling buffer).
   * Default 420 ≈ 20–80s of history depending on your `updateAgent` call rate.
   * Lower values reduce memory; higher values give longer visible history.
   * Planned for v0.2: time-based windowing on top of this cap.
   */
  maxHistoryPoints?: number;
  /**
   * Which series to plot. Default 'progress' preserves v0.1 behavior exactly.
   * 'tokens' plots token rate on an auto-scaled axis; 'both' shows progress on
   * the left axis and token rate on the right (dual-axis).
   */
  metric?: ChartMetric;
  /**
   * Upper bound for the token-rate axis. By default the axis auto-scales to the
   * highest token rate currently visible (with headroom), so a quiet agent and a
   * fast one are both legible. Pass a fixed number to pin the axis — useful when
   * you want a stable scale across mounts or known rate ceilings.
   */
  tokenAxisMax?: number;
  /**
   * Show only the last `windowSeconds` of history (time-based sliding window),
   * independent of sample count. When set, the chart slices each agent's buffer
   * to this window before drawing and downsamples (LTTB) if the slice has far
   * more points than the canvas can resolve. Leave undefined for the legacy
   * count-based view bounded by `maxHistoryPoints`.
   */
  windowSeconds?: number;
  /**
   * Optional visual smoothing of the **rendered line only**, in [0, 1).
   * 0 (default) = OFF: the line shows raw values exactly. Higher values apply an
   * exponential moving average to the drawn curve, damping frame-to-frame jitter
   * from noisy metrics. ~0.2–0.4 is a gentle smooth; 0.6+ is heavy.
   *
   * IMPORTANT — this is a *display* choice and it DAMPS REAL SPIKES. AgentStat is
   * a monitoring tool; a genuine token-rate anomaly will be visually softened
   * when smoothing is on. Health scoring and hover tooltip values always read
   * the RAW data and are never affected — only the drawn curve is. Leave at 0 if
   * faithfully seeing every spike matters more than a calm line.
   */
  smoothing?: number;
  /**
   * Enable automatic anomaly detection (default false). When on, AgentStat
   * watches each agent's token-rate and status streams and flags stalls (idle
   * while active), runaway spikes (statistical outliers vs the agent's own
   * baseline), and status thrashing — drawing markers on the chart and firing
   * `onAnomaly`. This is the agent-aware analysis a generic chart can't do.
   */
  anomalyDetection?: boolean;
  /**
   * Override anomaly thresholds. Merged over sensible defaults
   * (DEFAULT_ANOMALY_CONFIG). Only the fields you set are changed.
   */
  anomalyConfig?: Partial<AnomalyConfig>;
  /**
   * Called when an anomaly is detected for an agent. Fires once per distinct
   * anomaly occurrence (not every frame). Use it to log, alert, or page.
   */
  onAnomaly?: (agentId: string, anomaly: Anomaly) => void;
}

export interface AgentStatRef {
  updateAgent: (id: string, tokensRate: number, progress: number, status: AgentStatus) => void;
  getHealth: (id: string) => HealthMetrics | undefined;
  /** Anomalies currently active for an agent (empty if none or detection off). */
  getAnomalies: (id: string) => Anomaly[];
  getLiveMetrics: (
    id: string
  ) => { tokensRate: number; progress: number; status: AgentStatus } | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

const lerp = (start: number, end: number, t: number): number =>
  start + (end - start) * t;

// Default visible time span (ms) when no `windowSeconds` is set. Kept short (10s)
// deliberately: at typical update rates the visible sample count then falls
// BELOW the downsample threshold, so LTTB is skipped entirely and the exact same
// points render every frame — rock-stable, no point-position switching, and
// cheaper. A longer default re-introduces downsampling, whose periodic recompute
// reselects representative points and makes the line appear to shift. Consumers
// who want a longer history set `windowSeconds` explicitly and accept the
// (cached, downsampled) longer view.
const DEFAULT_VIEW_MS = 10_000;

/**
 * Display-only exponential moving average over a point series' values. Returns
 * a NEW array; never mutates input. `factor` in [0,1): 0 returns points
 * unchanged. Smooths the rendered curve without touching stored data — callers
 * apply this to the draw points only, never to the buffer, health, or tooltip.
 */
const emaPoints = (
  pts: { t: number; v: number }[],
  factor: number
): { t: number; v: number }[] => {
  if (factor <= 0 || pts.length === 0) return pts;
  const a = Math.min(0.95, factor); // guard: never fully freeze the line
  const out = new Array(pts.length);
  let prev = pts[0].v;
  out[0] = pts[0];
  for (let i = 1; i < pts.length; i++) {
    prev = prev * a + pts[i].v * (1 - a);
    out[i] = { t: pts[i].t, v: prev };
  }
  return out;
};

/**
 * Round an upper bound up to a visually "nice" axis maximum (1/2/5 × 10ⁿ),
 * so the token-rate axis shows clean labels (e.g. 20, 50, 100) rather than
 * arbitrary values like 37.4. Always returns at least `floor`.
 *
 * Exported for unit testing — NOT re-exported from the package entry
 * (src/index.ts), so it isn't public API. Mirrors the calculateHealth convention.
 */
export const niceMax = (raw: number, floor = 10): number => {
  const v = Math.max(raw, floor);
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const frac = v / base;
  const niceFrac = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return niceFrac * base;
};

/**
 * Health calculation now accepts the live rate buffer so stability
 * is computed from real data — not from agent.data which is always empty.
 *
 * Exported for unit testing — not re-exported from the package entry
 * (src/index.ts), so consumers don't see this as public API.
 */
export const calculateHealth = (
  agent: Agent,
  recentRates: number[],
  anomalies?: Anomaly[]
): HealthMetrics => {
  const { current, config } = agent;

  const [minTok = 5, maxTok = 25] = config?.expectedTokensPerSec ?? [];
  const idealTok = (minTok + maxTok) / 2;
  // Efficiency is computed from a REPRESENTATIVE recent rate, not the single
  // instantaneous sample. Reading current.tokensRate made the number oscillate
  // every tick as the live rate wandered within its band — it looked random and
  // didn't track the drawn line. Averaging the recent window gives a stable value
  // that reflects what the chart actually shows. (Test-safe: the efficiency tests
  // pass recentRates equal to tokensRate, so the average equals current and every
  // asserted value is unchanged. Falls back to current when no window is given.)
  const effWindow = recentRates.slice(-30);
  const repRate =
    effWindow.length > 0
      ? effWindow.reduce((s, r) => s + r, 0) / effWindow.length
      : current.tokensRate;
  const tokenEfficiency =
    repRate >= minTok && repRate <= maxTok
      ? 100
      : Math.max(0, 100 - Math.abs(repRate - idealTok) * 4);

  const recent = recentRates.slice(-30);
  const tokenVariance =
    recent.length > 1
      ? recent.reduce(
          (acc, r, i, arr) => (i === 0 ? 0 : acc + Math.abs(r - arr[i - 1])),
          0
        ) / recent.length
      : 0;
  const stability = Math.max(0, 100 - tokenVariance * 2.5);

  const explicitHallucination = current.status === 'hallucinating' ? 1 : 0;
  const confidenceRisk =
    current.confidenceScore !== undefined ? 1 - current.confidenceScore : 0.1;
  const hallucinationRisk = Math.round(
    Math.max(explicitHallucination, confidenceRisk) * 100
  );

  const latencyTrend: HealthMetrics['latencyTrend'] =
    current.latencyMs !== undefined
      ? current.latencyMs < 500
        ? 'improving'
        : current.latencyMs > 2000
        ? 'degrading'
        : 'stable'
      : 'stable';

  const base =
    tokenEfficiency * 0.35 +
    stability * 0.25 +
    (100 - hallucinationRisk) * 0.3;

  const score = Math.round(
    current.latencyMs === undefined
      ? base / 0.9
      : base +
          (latencyTrend === 'improving'
            ? 100
            : latencyTrend === 'degrading'
            ? 0
            : 50) *
            0.1
  );

  // Real, data-derived penalty from detected anomalies (stall/spike/thrash).
  // Unlike the legacy confidenceScore path, these come from actual behavior the
  // detector observed. Additive and backward compatible: with no anomalies
  // argument (or an empty list) the score is exactly the legacy value.
  let anomalyPenalty = 0;
  if (anomalies && anomalies.length) {
    for (const a of anomalies) {
      // Critical issues hurt more than warnings; stalls/thrash indicate the
      // agent is stuck or unstable, which is worse than a transient spike.
      const base = a.severity === 'critical' ? 30 : 15;
      const kindWeight = a.kind === 'stall' ? 1.0 : a.kind === 'thrash' ? 0.9 : 0.7;
      anomalyPenalty += base * kindWeight;
    }
  }

  return {
    score: Math.max(0, Math.min(100, score - anomalyPenalty)),
    tokenEfficiency: Math.round(tokenEfficiency),
    stability: Math.round(stability),
    hallucinationRisk,
    latencyTrend,
  };
};

// Build (but don't stroke) a Catmull-Rom spline path through `points` into the
// current path. Shared by the stroked line AND the area fill so both follow the
// identical curve — otherwise the fill's top edge is a jagged polyline under a
// smooth line. Caller handles beginPath/moveTo framing and stroke/fill.
const splinePath = (
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
  tension = 0.4
) => {
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const c1x = p1.x + ((p2.x - p0.x) * tension) / 3;
    let c1y = p1.y + ((p2.y - p0.y) * tension) / 3;
    const c2x = p2.x - ((p3.x - p1.x) * tension) / 3;
    let c2y = p2.y - ((p3.y - p1.y) * tension) / 3;
    // Clamp control points vertically to the segment span (+slack) so a steep
    // change can't overshoot/loop — the classic untidy-spline artifact.
    const loY = Math.min(p1.y, p2.y);
    const hiY = Math.max(p1.y, p2.y);
    const slack = (hiY - loY) * 0.5 + 0.01;
    c1y = Math.max(loY - slack, Math.min(hiY + slack, c1y));
    c2y = Math.max(loY - slack, Math.min(hiY + slack, c2y));
    ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2.x, p2.y);
  }
};

const drawCatmullRom = (
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
  tension = 0.4
) => {
  if (points.length < 2) return;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  splinePath(ctx, points, tension);
  ctx.stroke();
};

/** Returns true when the hex background is perceptually dark. */
const bgIsDark = (bg: string): boolean => {
  if (!bg || !bg.startsWith('#') || bg.length < 7) return true;
  const r = parseInt(bg.slice(1, 3), 16);
  const g = parseInt(bg.slice(3, 5), 16);
  const b = parseInt(bg.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS — exported to cut onboarding boilerplate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an `Agent` with sensible defaults. Intended for quick starts and
 * examples — consumers with real telemetry typically construct their own
 * `Agent` objects with full `config` and `current` detail.
 *
 * ```tsx
 * const agent = createAgent('chat-agent', 'Chat Assistant', '#1d4ed8');
 * <AgentStat agents={[agent]} />
 * ```
 */
export const createAgent = (
  id: string,
  name: string,
  color: string = '#111111'
): Agent => ({
  id,
  name,
  color,
  data: [],
  current: { tokensRate: 0, progress: 0, status: 'active' },
  visible: true,
});

/**
 * A ready-made 3-agent roster for demos, docs, and first-run exploration.
 * Pair with `simulateData` to see the chart come to life with zero wiring:
 *
 * ```tsx
 * import { AgentStat, demoAgents } from 'agentstat';
 * <AgentStat agents={demoAgents} simulateData height={400} />
 * ```
 *
 * For real deployments, build your own `Agent` array — this preset exists
 * purely to remove friction while evaluating the component.
 */
export const demoAgents: Agent[] = [
  {
    id: 'researcher',
    name: 'Researcher',
    color: '#111111',
    data: [],
    current: { tokensRate: 14.8, progress: 42, status: 'active' },
    visible: true,
    config: { expectedTokensPerSec: [10, 20] },
  },
  {
    id: 'critic',
    name: 'Critic',
    color: '#B91C1C',
    data: [],
    current: { tokensRate: 4.2, progress: 18, status: 'thinking' },
    visible: true,
    config: { expectedTokensPerSec: [5, 15] },
  },
  {
    id: 'executor',
    name: 'Executor',
    color: '#1D4ED8',
    data: [],
    current: { tokensRate: 21.5, progress: 91, status: 'active' },
    visible: true,
    config: { expectedTokensPerSec: [15, 30] },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

const AgentStat = forwardRef<AgentStatRef, AgentStatProps>(
  (
    {
      // Default to [] so the component is robust to a missing/undefined
      // `agents` prop. This happens in practice when consumers render the
      // component before their data has loaded, during SSR streaming, or
      // from plain JavaScript (where TypeScript can't enforce the prop).
      agents: initialAgents = [],
      height = 520,
      referenceLine,
      onHealthChange,
      onSpikeClick,
      simulateData = false,
      styles = {},
      className,
      style: rootStyle,
      maxHistoryPoints = 420,
      metric = 'progress',
      tokenAxisMax,
      windowSeconds,
      smoothing = 0,
      anomalyDetection = false,
      anomalyConfig,
      onAnomaly,
    },
    ref
  ) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    // Cache the 2D context. getContext returns the same object on repeat calls
    // for a given canvas, but caching avoids the per-frame call entirely and
    // gives us one place to bail if the context is unavailable.
    const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
    // Per-frame-stable gradient cache. Gradients depend only on geometry
    // (vertical extent) and agent color, none of which change frame-to-frame
    // unless the canvas resizes. Keyed so a resize or color change rebuilds.
    const gradientCacheRef = useRef<{
      key: string;
      fills: Map<string, CanvasGradient>;
    }>({ key: '', fills: new Map() });
    const animationRef = useRef<number>();
    const lastTimeRef = useRef<number>(performance.now());
    // DPR stored in a ref so the stable animate closure always has the latest value.
    const dprRef = useRef<number>(1);

    // ── Canonical data store ──────────────────────────────────────────────────
    // The animation loop reads from these refs only — never from React state.
    // This keeps animate() stable (no deps) so the RAF loop never restarts.
    const agentsRef = useRef<Agent[]>(initialAgents);
    const progressBufferRef = useRef<Map<string, TimeSeriesBuffer>>(new Map());
    const tokensBufferRef = useRef<Map<string, TimeSeriesBuffer>>(new Map());
    // Sparse per-agent status transition history (records only changes).
    const statusLogRef = useRef<Map<string, StatusLog>>(new Map());
    const liveValuesRef = useRef<
      Map<string, { tokensRate: number; progress: number; status: AgentStatus }>
    >(new Map());
    const healthCacheRef = useRef<Record<string, HealthMetrics>>({});
    const pausedRef = useRef<boolean>(false);
    // Dirty-frame tracking. The RAF loop keeps running (invariant: never
    // restarts), but it skips the expensive redraw when nothing changed —
    // otherwise the canvas repaints 60×/sec even while idle, saturating the
    // main thread and starving user input (observed as high INP / input delay).
    // `dirtyRef` is raised by any data write; the loop also redraws while lines
    // are still animating toward their targets, and (throttled) while a time
    // window scrolls.
    const dirtyRef = useRef<boolean>(true);
    const lastDrawRef = useRef<number>(0);
    // Tracks agent ids whose anomalous status was set by the consumer
    // (via updateAgent). The simulation tick respects this lock and will not
    // auto-recover these agents. Cleared the moment updateAgent is called
    // with a non-anomalous status.
    const userLockedRef = useRef<Set<string>>(new Set());

    // Prop refs — animate reads styles and referenceLine without needing them as deps.
    const stylesRef = useRef(styles);
    const referenceLineRef = useRef(referenceLine);
    const maxHistoryPointsRef = useRef(maxHistoryPoints);
    const metricRef = useRef(metric);
    const tokenAxisMaxRef = useRef(tokenAxisMax);
    const windowSecondsRef = useRef(windowSeconds);
    const smoothingRef = useRef(smoothing);
    // Cached token-axis ceiling + the time bucket it was computed for, so the
    // O(points) max-scan runs at most a few times per second instead of every
    // frame. Recomputing every frame was the dominant cost in tokens/both mode
    // and also caused the whole chart to visibly rescale on each frame.
    const tokenMaxCacheRef = useRef<{ bucket: number; value: number }>({
      bucket: -1,
      value: 0,
    });
    // Anomaly detection state. Detection runs on a throttled interval (not every
    // frame); the draw loop only renders these cached results. `firedRef` tracks
    // which (agent, kind, anchorTime) anomalies already fired onAnomaly, so the
    // callback fires once per occurrence rather than repeatedly while it persists.
    const anomalyDetectionRef = useRef(anomalyDetection);
    const anomalyConfigRef = useRef<AnomalyConfig>({
      ...DEFAULT_ANOMALY_CONFIG,
      ...anomalyConfig,
    });
    const onAnomalyRef = useRef(onAnomaly);
    const anomaliesRef = useRef<Map<string, Anomaly[]>>(new Map());
    const anomalyFiredRef = useRef<Set<string>>(new Set());
    useEffect(() => { stylesRef.current = styles; }, [styles]);
    useEffect(() => { referenceLineRef.current = referenceLine; }, [referenceLine]);
    useEffect(() => { maxHistoryPointsRef.current = maxHistoryPoints; }, [maxHistoryPoints]);
    useEffect(() => { metricRef.current = metric; dirtyRef.current = true; }, [metric]);
    useEffect(() => { tokenAxisMaxRef.current = tokenAxisMax; dirtyRef.current = true; }, [tokenAxisMax]);
    useEffect(() => { windowSecondsRef.current = windowSeconds; dirtyRef.current = true; }, [windowSeconds]);
    useEffect(() => { smoothingRef.current = smoothing; dirtyRef.current = true; }, [smoothing]);
    useEffect(() => { anomalyDetectionRef.current = anomalyDetection; dirtyRef.current = true; }, [anomalyDetection]);
    useEffect(() => { anomalyConfigRef.current = { ...DEFAULT_ANOMALY_CONFIG, ...anomalyConfig }; }, [anomalyConfig]);
    useEffect(() => { onAnomalyRef.current = onAnomaly; }, [onAnomaly]);

    // Callback refs — stable references to the latest callbacks.
    const onHealthChangeRef = useRef(onHealthChange);
    const onSpikeClickRef = useRef(onSpikeClick);
    useEffect(() => { onHealthChangeRef.current = onHealthChange; }, [onHealthChange]);
    useEffect(() => { onSpikeClickRef.current = onSpikeClick; }, [onSpikeClick]);

    // ── React state (UI overlays only) ────────────────────────────────────────
    const [uiAgents, setUiAgents] = useState<Agent[]>(initialAgents);
    const [paused, setPaused] = useState(false);
    const [hoveredPoint, setHoveredPoint] = useState<{
      point: AgentDataPoint;
      agentId: string;
    } | null>(null);

    // ── Overlay theming ───────────────────────────────────────────────────────
    const isDark = useMemo(
      () => bgIsDark(styles.background || '#ffffff'),
      [styles.background]
    );

    const ot = useMemo(
      () =>
        isDark
          ? {
              bg: 'rgba(8,8,10,0.90)',
              border: 'rgba(255,255,255,0.07)',
              text: 'rgba(255,255,255,0.85)',
              muted: 'rgba(255,255,255,0.38)',
              activeBtnBg: 'rgba(255,255,255,0.13)',
              inactiveText: 'rgba(255,255,255,0.35)',
            }
          : {
              bg: 'rgba(255,255,255,0.95)',
              border: 'rgba(0,0,0,0.07)',
              text: 'rgba(0,0,0,0.82)',
              muted: 'rgba(0,0,0,0.35)',
              activeBtnBg: 'rgba(0,0,0,0.07)',
              inactiveText: 'rgba(0,0,0,0.32)',
            },
      [isDark]
    );

    const overlayBase: React.CSSProperties = {
      background: ot.bg,
      border: `1px solid ${ot.border}`,
      borderRadius: 8,
      fontFamily: 'monospace',
    };

    // ── Buffer init ───────────────────────────────────────────────────────────
    const ensureBuffers = useCallback((agent: Agent) => {
      if (!progressBufferRef.current.has(agent.id)) {
        const cap = Math.max(2, maxHistoryPointsRef.current);
        const pBuf = new TimeSeriesBuffer(Math.max(cap, 20_000));
        const tBuf = new TimeSeriesBuffer(Math.max(cap, 20_000));
        // Seed ~80 backdated samples so the line has initial shape on first
        // paint instead of popping in from a single point. Spaced 55ms apart
        // (the sim tick), ending "now", so they fall within typical windows.
        const now = performance.now();
        const seedCount = 80;
        for (let i = seedCount - 1; i >= 0; i--) {
          const t = now - i * 55;
          pBuf.push(t, agent.current.progress);
          tBuf.push(t, agent.current.tokensRate);
        }
        progressBufferRef.current.set(agent.id, pBuf);
        tokensBufferRef.current.set(agent.id, tBuf);
        // Seed the status log with the agent's initial status at the buffer's
        // start time, so statusAt() answers correctly across the seeded span.
        const sLog = new StatusLog();
        sLog.record(now - (seedCount - 1) * 55, agent.current.status);
        statusLogRef.current.set(agent.id, sLog);
      }
    }, []);

    useEffect(() => {
      // Always ensure buffers exist for every incoming agent (ensureBuffers is
      // idempotent — it's a no-op for ids whose buffers are already set).
      initialAgents.forEach(ensureBuffers);

      // Shape-compare: same length AND same ids in same order.
      // If a consumer passes a fresh array literal each render but the roster is
      // unchanged, this guard prevents clobbering live ref-side mutations from
      // updateAgent(). Property changes on existing agents (color, config, etc.)
      // are intentionally ignored here — use updateAgent() for runtime updates.
      const prevIds = agentsRef.current.map((a) => a.id);
      const nextIds = initialAgents.map((a) => a.id);
      const shapeUnchanged =
        prevIds.length === nextIds.length &&
        prevIds.every((id, i) => id === nextIds[i]);
      if (shapeUnchanged) return;

      // Shape changed. Prune per-agent state for removed ids so the refs don't
      // leak entries for agents the consumer no longer tracks.
      const nextSet = new Set(nextIds);
      prevIds.forEach((id) => {
        if (!nextSet.has(id)) {
          progressBufferRef.current.delete(id);
          tokensBufferRef.current.delete(id);
          statusLogRef.current.delete(id);
          liveValuesRef.current.delete(id);
          delete healthCacheRef.current[id];
          userLockedRef.current.delete(id);
        }
      });

      // Merge: kept ids keep their ref-side state (preserves updateAgent
      // mutations); new ids take the parent's incoming agent as-is. Order
      // follows the parent's new array.
      const prevById = new Map(agentsRef.current.map((a) => [a.id, a]));
      const merged = initialAgents.map((a) => prevById.get(a.id) ?? a);
      agentsRef.current = merged;
      setUiAgents(merged);
    }, [initialAgents, ensureBuffers]);

    // ── Imperative ref API ────────────────────────────────────────────────────
    useImperativeHandle(
      ref,
      () => ({
        updateAgent: (
          id: string,
          tokensRate: number,
          progress: number,
          status: AgentStatus
        ) => {
          // Lock anomalous user-triggered statuses so the simulation's
          // auto-recovery doesn't flip them back to 'active' after ~3s.
          // Any non-anomalous status from the consumer clears the lock.
          if (status === 'stuck' || status === 'hallucinating') {
            userLockedRef.current.add(id);
          } else {
            userLockedRef.current.delete(id);
          }
          // Write directly to the ref — animation picks it up on the next frame.
          agentsRef.current = agentsRef.current.map((agent) => {
            if (agent.id !== id) return agent;
            const progressBuf = progressBufferRef.current.get(id);
            const tokensBuf = tokensBufferRef.current.get(id);
            if (!progressBuf || !tokensBuf) return agent;
            // Clamp for robustness — bad telemetry from consumers should never break the chart
            const safeTokens = Math.max(0, tokensRate);
            const safeProgress = Math.max(0, Math.min(100, progress));
            const now = performance.now();
            progressBuf.push(now, safeProgress);
            tokensBuf.push(now, safeTokens);
            statusLogRef.current.get(id)?.record(now, status);
            dirtyRef.current = true;
            // Evict by time so memory and the per-frame window-slice scan stay
            // bounded. Retain 1.5× the ACTIVE view — the explicit window when set,
            // otherwise the default no-window view. Previously no-window mode never
            // evicted, so the buffer grew to its 20k cap and the slice walked
            // thousands of stale points every frame.
            const winS = windowSecondsRef.current;
            const retain = (winS !== undefined ? winS * 1000 : DEFAULT_VIEW_MS) * 1.5;
            progressBuf.evictOlderThan(now, retain);
            tokensBuf.evictOlderThan(now, retain);
            statusLogRef.current.get(id)?.evictOlderThan(now - retain);
            return {
              ...agent,
              current: { ...agent.current, tokensRate: safeTokens, progress: safeProgress, status },
            };
          });
        },
        getHealth: (id) => healthCacheRef.current[id],
        getAnomalies: (id) => anomaliesRef.current.get(id) ?? [],
        getLiveMetrics: (id) => liveValuesRef.current.get(id),
      }),
      []
    );

    // ── Simulation tick — writes to refs only, zero React re-renders ──────────
    useEffect(() => {
      if (!simulateData) return;
      const interval = setInterval(() => {
        if (pausedRef.current) return;
        agentsRef.current = agentsRef.current.map((agent) => {
          if (!agent.visible) return agent;

          const status = agent.current.status;

          // ── Anomaly entry / auto-recovery ──────────────────────────────
          // errorCount reused as anomaly tick counter.
          const inAnomaly = status === 'stuck' || status === 'hallucinating';
          const anomalyTick = agent.current.errorCount ?? 0;
          // User has pinned this agent's status via updateAgent — the sim
          // must not auto-recover it or randomly flip it into a new anomaly.
          const userLocked = userLockedRef.current.has(agent.id);

          let nextStatus = status;
          let nextErrorCount = anomalyTick;

          if (userLocked) {
            // Preserve status as-is. Token-rate and progress drift below still
            // runs, so locked agents keep their visual signature (stuck agents
            // keep bleeding tokens, hallucinating agents keep oscillating).
          } else if (!inAnomaly && Math.random() > 0.96) {
            nextStatus = (['stuck', 'hallucinating'] as AgentStatus[])[
              Math.floor(Math.random() * 2)
            ];
            nextErrorCount = 0;
          } else if (inAnomaly) {
            nextErrorCount = anomalyTick + 1;
            // Auto-recover after ~3 seconds (55ms × ~55 ticks)
            if (nextErrorCount > 55) {
              nextStatus = 'active';
              nextErrorCount = 0;
            }
          }

          // ── tokensRate follows status ─────────────────────────────────
          // Stuck agents slow to near-zero (graph flattens low, health drops).
          // Hallucinating agents spike erratically (graph chaotic, health drops).
          // Recovery ramps back toward expected range.
          const [minTok = 5, maxTok = 25] = agent.config?.expectedTokensPerSec ?? [];
          const targetTok = (minTok + maxTok) / 2;

          let newTokens: number;
          if (nextStatus === 'stuck') {
            newTokens = Math.max(0.5, agent.current.tokensRate * 0.88);
          } else if (nextStatus === 'hallucinating') {
            newTokens = Math.max(1, Math.min(35, agent.current.tokensRate + (Math.random() * 8 - 4)));
          } else if (status !== 'active' && nextStatus === 'active') {
            // Recovery: ramp back up toward expected range
            newTokens = Math.min(targetTok, agent.current.tokensRate + Math.random() * 2);
          } else {
            // Healthy generation: a mean-reverting walk toward the middle of the
            // agent's expected band, with mild noise. Real token rates hover in a
            // characteristic range and drift back toward it rather than wandering
            // freely — this reverts ~12% toward target each tick plus small jitter,
            // so the line looks like a settled agent, not directionless noise.
            const reversion = (targetTok - agent.current.tokensRate) * 0.12;
            const jitter = Math.random() * 1.6 - 0.8;
            newTokens = Math.max(minTok * 0.6, Math.min(maxTok * 1.15, agent.current.tokensRate + reversion + jitter));
          }

          // ── progress reflects status ──────────────────────────────────
          const progressIncrement =
            nextStatus === 'stuck'          ? 0 :
            nextStatus === 'hallucinating'  ? 0.15 :
            Math.random() * 0.9;
          const newProgress = Math.min(100, agent.current.progress + progressIncrement);

          // ── confidenceScore: stable when healthy, low during anomaly ──
          // Stable 0.95 prevents score jitter during normal operation.
          // Confidence eases toward a target (low during an anomaly, high when
          // healthy) rather than teleporting to a fresh random value each tick.
          // The old per-tick randomness made the health score visibly flicker —
          // a real agent's confidence doesn't jump around frame to frame.
          const confTarget = inAnomaly ? 0.3 : 0.95;
          const prevConf = agent.current.confidenceScore ?? 0.9;
          const nextConfidence = prevConf + (confTarget - prevConf) * 0.25;

          const progressBuf = progressBufferRef.current.get(agent.id);
          const tokensBuf = tokensBufferRef.current.get(agent.id);
          if (progressBuf && tokensBuf) {
            const now = performance.now();
            progressBuf.push(now, newProgress);
            tokensBuf.push(now, newTokens);
            statusLogRef.current.get(agent.id)?.record(now, nextStatus);
            dirtyRef.current = true;
            const winS = windowSecondsRef.current;
            const retain = (winS !== undefined ? winS * 1000 : DEFAULT_VIEW_MS) * 1.5;
            progressBuf.evictOlderThan(now, retain);
            tokensBuf.evictOlderThan(now, retain);
            statusLogRef.current.get(agent.id)?.evictOlderThan(now - retain);
          }

          return {
            ...agent,
            current: {
              ...agent.current,
              tokensRate: newTokens,
              progress: newProgress,
              status: nextStatus,
              confidenceScore: nextConfidence,
              errorCount: nextErrorCount,
            },
          };
        });
      }, 55);
      return () => clearInterval(interval);
    }, [simulateData]);

    // ── UI sync tick — syncs ref→state, fires onHealthChange at 500ms ─────────
    useEffect(() => {
      const interval = setInterval(() => {
        const current = agentsRef.current;
        setUiAgents([...current]);
        const detectOn = anomalyDetectionRef.current;
        const acfg = anomalyConfigRef.current;
        const nowT = performance.now();
        current.forEach((agent) => {
          if (!agent.visible) return;

          // ── Anomaly detection first, so health can reflect fresh results ──
          if (detectOn) {
            const tokBuf = tokensBufferRef.current.get(agent.id);
            const tokens = tokBuf ? tokBuf.toArray().map((p) => ({ t: p.t, v: p.v })) : [];
            const changes =
              statusLogRef.current
                .get(agent.id)
                ?.transitionsInRange(nowT - acfg.thrashWindowMs, nowT) ?? [];
            const found = detectAnomalies(
              tokens,
              changes,
              agent.current.status,
              nowT,
              acfg
            );
            const prev = anomaliesRef.current.get(agent.id) ?? [];
            anomaliesRef.current.set(agent.id, found);
            if (found.length !== prev.length || found.length > 0) dirtyRef.current = true;
            for (const a of found) {
              const key = `${agent.id}:${a.kind}:${Math.round(a.t)}`;
              if (!anomalyFiredRef.current.has(key)) {
                anomalyFiredRef.current.add(key);
                onAnomalyRef.current?.(agent.id, a);
              }
            }
          } else if (anomaliesRef.current.has(agent.id)) {
            anomaliesRef.current.delete(agent.id);
            dirtyRef.current = true;
          }

          const rates = tokensBufferRef.current.get(agent.id)?.values() ?? [];
          const health = calculateHealth(
            agent,
            rates,
            detectOn ? anomaliesRef.current.get(agent.id) : undefined
          );
          const cached = healthCacheRef.current[agent.id];
          // Smooth the displayed score with an EMA so the headline number
          // settles into a representative value instead of flickering on every
          // tick. The component metrics (efficiency/stability/etc.) are shown
          // raw; only the composite score is smoothed, and it still moves
          // promptly on real change (alpha 0.4 ≈ responds within ~2-3 ticks).
          // A large drop (e.g. an anomaly penalty kicking in) bypasses smoothing
          // so genuine problems surface immediately rather than easing in.
          const prevScore = cached?.score;
          let displayScore = health.score;
          if (prevScore !== undefined) {
            const bigDrop = health.score < prevScore - 15;
            displayScore = bigDrop
              ? health.score // surface real degradation instantly
              : Math.round(prevScore * 0.6 + health.score * 0.4);
          }
          const smoothed = { ...health, score: displayScore };
          if (!cached || Math.abs(cached.score - smoothed.score) >= 1) {
            healthCacheRef.current[agent.id] = smoothed;
            onHealthChangeRef.current?.(agent.id, smoothed);
          }
        });
        // Bound the fired-set so it can't grow without limit over long sessions.
        if (anomalyFiredRef.current.size > 1000) {
          anomalyFiredRef.current = new Set(
            Array.from(anomalyFiredRef.current).slice(-500)
          );
        }
      }, 500);
      return () => clearInterval(interval);
    }, []);

    // ── Canvas resize — stores DPR in ref for use in animate and mousemove ────
    const resizeCanvas = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      dprRef.current = dpr;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      const ctx = canvas.getContext('2d');
      ctxRef.current = ctx;
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dirtyRef.current = true; // geometry changed — force a redraw
    }, []);

    // Shared scale derivation — used by BOTH the animation draw loop and the
    // hover hit-test so they can never compute different y-coordinates for the
    // same data point. Reads exclusively from refs. Declared before animate so
    // animate can list it as a (ref-stable) dependency.
    const deriveScale = useCallback((h: number, padTop: number, scanTarget = 256) => {
      const metric = metricRef.current;
      const primaryIsTokens = metric === 'tokens';
      let tokenMax = tokenAxisMaxRef.current;
      if (tokenMax === undefined) {
        const now = performance.now();
        const winMs =
          windowSecondsRef.current !== undefined
            ? windowSecondsRef.current * 1000
            : undefined;
        const effectiveWinMs = winMs ?? DEFAULT_VIEW_MS;
        // Recompute the axis max at most ~4×/sec (250ms buckets), not every
        // frame. Between recomputes we reuse the cached ceiling — the max of a
        // live stream doesn't change meaningfully frame-to-frame, and a stable
        // axis also stops the chart from visibly rescaling on every tick.
        const bucket = Math.floor(now / 250);
        const cache = tokenMaxCacheRef.current;
        if (bucket !== cache.bucket) {
          let observed = 0;
          // Scan using the SAME targetPoints + recomputeMs the draw loop uses,
          // so this call HITS the draw's downsample cache instead of evicting it.
          // (Using a different target here caused per-frame cache thrash — two
          // full LTTB passes per buffer per frame — which was the dominant
          // tokens/both-mode cost. Measured ~178× worse than sharing the cache.)
          const recMs = Math.max(16, effectiveWinMs * 0.005);
          agentsRef.current.forEach((agent) => {
            if (!agent.visible) return;
            const buf = tokensBufferRef.current.get(agent.id);
            if (!buf) return;
            const pts = buf.windowed(now, effectiveWinMs, scanTarget, recMs).points;
            for (let i = 0; i < pts.length; i++) {
              if (pts[i].v > observed) observed = pts[i].v;
            }
            if (agent.current.tokensRate > observed) observed = agent.current.tokensRate;
          });
          const target = niceMax(observed * 1.15);
          // Sticky axis ceiling. A token axis that snaps to every change in the
          // observed max makes the whole line jump vertically on each rescale —
          // historical points appear to "move" even though their values are
          // fixed. That's the opposite of what a readable chart needs. So:
          //   - Rise immediately to a new high (a spike must never clip).
          //   - Otherwise HOLD. Only when the true ceiling has been well below
          //     the current one for a sustained period do we ease downward, and
          //     we ease (not snap) so the line glides rather than jumps.
          // Result: the axis is stable through normal fluctuation and the line
          // behaves like progress mode — points keep their position.
          if (cache.value === 0 || target > cache.value) {
            cache.value = target; // immediate rise — never clip a spike
          } else if (target < cache.value * 0.6) {
            // True max has dropped a lot and stayed there: ease down ~8% per
            // recompute (~4×/sec → a few seconds to settle) instead of snapping.
            cache.value = Math.max(target, cache.value * 0.92);
          }
          // Between 60% and 100% of the current ceiling we deliberately do
          // nothing — this dead-band is what keeps the axis (and the line) still.
          cache.bucket = bucket;
        }
        tokenMax = cache.value;
      }
      const safeTokenMax = tokenMax && tokenMax > 0 ? tokenMax : 100;
      const primaryToY = primaryIsTokens
        ? (v: number) =>
            padTop + h - (h * Math.max(0, Math.min(safeTokenMax, v))) / safeTokenMax
        : (v: number) => padTop + h - (h * v) / 100;
      return {
        primaryIsTokens,
        primaryBufferRef: primaryIsTokens ? tokensBufferRef : progressBufferRef,
        primaryToY,
        safeTokenMax,
      };
    }, []);

    // ── Animation loop ────────────────────────────────────────────────────────
    // STABLE — empty deps array means this is created once and never recreated.
    // All data comes from refs. The RAF loop runs for the full component lifetime.
    const animate = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      // Use the cached context; fall back to a one-time fetch if animate runs
      // before resizeCanvas has populated it (e.g. first frame after mount).
      let ctx = ctxRef.current;
      if (!ctx) {
        ctx = canvas.getContext('2d');
        ctxRef.current = ctx;
      }
      if (!ctx) return;

      const now = performance.now();
      const delta = Math.min((now - lastTimeRef.current) / 16.67, 2.5);
      lastTimeRef.current = now;

      // ── Dirty check: should we actually redraw this frame? ──────────────────
      // Redraw when: new data arrived (dirtyRef), any line is still animating
      // toward its target, a time window is scrolling, or the chart is paused
      // (so the PAUSED overlay paints once). Otherwise skip the costly draw and
      // just reschedule — this is what frees the main thread between updates and
      // fixes the input-delay/INP problem.
      const EPS = 0.05;
      let stillAnimating = false;
      const liveMap = liveValuesRef.current;
      for (const agent of agentsRef.current) {
        const lv = liveMap.get(agent.id);
        if (!lv) {
          stillAnimating = true;
          break;
        }
        if (
          Math.abs(lv.progress - agent.current.progress) > EPS ||
          Math.abs(lv.tokensRate - agent.current.tokensRate) > EPS
        ) {
          stillAnimating = true;
          break;
        }
      }
      // A live time window scrolls continuously, so it must keep redrawing — but
      // 30fps is plenty for a sliding axis, so throttle it rather than run at 60.
      const windowScrolling = windowSecondsRef.current !== undefined;
      const windowDue = windowScrolling && now - lastDrawRef.current >= 33;

      if (!dirtyRef.current && !stillAnimating && !windowDue) {
        animationRef.current = requestAnimationFrame(animate);
        return;
      }
      dirtyRef.current = false;
      lastDrawRef.current = now;

      const dpr = dprRef.current;
      // All drawing coordinates are in CSS pixels thanks to setTransform(dpr,...).
      // We must use cssWidth/cssHeight here — canvas.width is physical pixels.
      const cssWidth = canvas.width / dpr;
      const cssHeight = canvas.height / dpr;

      const s = stylesRef.current;
      const darkBg = bgIsDark(s.background || '#ffffff');

      ctx.fillStyle = s.background || '#ffffff';
      ctx.fillRect(0, 0, cssWidth, cssHeight);

      const pad = { left: 56, right: 48, top: 40, bottom: 56 };
      const w = cssWidth - pad.left - pad.right;
      const h = cssHeight - pad.top - pad.bottom;
      // Shared spline density, computed once. Passed into deriveScale so the
      // token-axis scan reuses the same downsample cache the draw loop fills
      // (avoids per-frame cache thrash). Also used directly by the draw below.
      const drawTargetPoints = Math.max(8, Math.ceil(w / 2));

      // Gradient cache. Both the line and fill gradients depend on geometry
      // (which only changes on resize) and agent color. We key the whole cache
      // on geometry and clear it when geometry changes; within a stable
      // geometry, each agent's gradients are built once and reused every frame.
      const geomKey = `${pad.top}:${h}:${pad.left}:${cssWidth - pad.right}`;
      const gcache = gradientCacheRef.current;
      if (gcache.key !== geomKey) {
        gcache.key = geomKey;
        gcache.fills.clear();
      }
      const fillCache = gcache.fills;

      // ── Metric + axis scaling ───────────────────────────────────────────────
      // The chart can plot progress (fixed 0–100), token rate (auto-scaled), or
      // both (dual-axis). All value→Y conversions below route through the scale
      // functions defined here so the drawn line, the live dot, the axis labels,
      // and the hover hit-test can never use different scales.
      const metric = metricRef.current;
      const showProgress = metric === 'progress' || metric === 'both';

      // Single source of truth for scale math (shared with the hover hit-test).
      const { primaryIsTokens, primaryBufferRef, primaryToY, safeTokenMax } =
        deriveScale(h, pad.top, drawTargetPoints);

      const progressToY = (v: number) => pad.top + h - (h * v) / 100;
      const tokenToY = (v: number) =>
        pad.top + h - (h * Math.max(0, Math.min(safeTokenMax, v))) / safeTokenMax;


      // Y-axis labels + grid lines
      ctx.font = '10px monospace';
      ctx.textAlign = 'right';
      const labelAlpha = darkBg ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)';
      const gridColor =
        s.gridColor || (darkBg ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)');

      // Left axis labels: progress (%) when progress is shown, else token rate.
      // Grid lines are drawn from whichever axis is on the left to avoid clutter.
      const leftAxisIsProgress = showProgress;
      [100, 75, 50, 25, 0].forEach((pct) => {
        const y = pad.top + h - (h * pct) / 100;
        ctx.fillStyle = labelAlpha;
        ctx.textAlign = 'right';
        const leftLabel = leftAxisIsProgress
          ? pct + '%'
          : Math.round((safeTokenMax * pct) / 100).toString();
        ctx.fillText(leftLabel, pad.left - 8, y + 4);
        // Right axis labels only in dual-axis 'both' mode (token rate).
        if (metric === 'both') {
          ctx.textAlign = 'left';
          ctx.fillText(
            Math.round((safeTokenMax * pct) / 100).toString(),
            cssWidth - pad.right + 8,
            y + 4
          );
        }
        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(cssWidth - pad.right, y);
        ctx.stroke();
      });
      ctx.textAlign = 'right';

      // Reference line — interpreted against the LEFT axis (progress % when
      // progress is shown, otherwise the token-rate scale).
      const rl = referenceLineRef.current;
      if (rl) {
        const y = leftAxisIsProgress ? progressToY(rl.value) : tokenToY(rl.value);
        const rlColor =
          rl.color || (darkBg ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)');
        ctx.strokeStyle = rlColor;
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(cssWidth - pad.right, y);
        ctx.stroke();
        ctx.setLineDash([]);
        if (rl.label) {
          ctx.textAlign = 'left';
          ctx.fillStyle = rlColor;
          ctx.fillText(rl.label, cssWidth - pad.right + 8, y + 4);
          ctx.textAlign = 'right';
        }
      }

      // Agent lines
      const drawNow = performance.now();
      const winMs =
        windowSecondsRef.current !== undefined
          ? windowSecondsRef.current * 1000
          : undefined;
      // Effective slice window. Even with no explicit windowSeconds we slice to
      // DEFAULT_VIEW_MS so LTTB operates on a bounded set (~constant cost) rather
      // than the whole accumulating buffer — this is what keeps the draw fast and
      // smooth indefinitely instead of degrading as the session lengthens.
      const effectiveWinMs = winMs ?? DEFAULT_VIEW_MS;
      // Reuse the shared target computed above (also passed to deriveScale's
      // axis scan) so the scan and the draw hit the SAME downsample cache.
      const targetPoints = drawTargetPoints;
      // LTTB recompute interval: recompute often enough that the window's left
      // edge is never more than ~0.5% of the visible span stale. For a 15m
      // window that's ~4.5s (cheap, big perf win); for a 5s window it's 25ms
      // (near-exact). Aggressive on long windows where perf matters, effectively
      // off on short ones where staleness would be visible.
      const recomputeMs = Math.max(16, effectiveWinMs * 0.005);

      agentsRef.current.forEach((agent) => {
        if (!agent.visible) return;
        const primaryBuf = primaryBufferRef.current.get(agent.id);
        if (!primaryBuf || primaryBuf.length < 2) return;

        if (!liveValuesRef.current.has(agent.id)) {
          liveValuesRef.current.set(agent.id, {
            tokensRate: agent.current.tokensRate,
            progress: agent.current.progress,
            status: agent.current.status,
          });
        }
        const live = liveValuesRef.current.get(agent.id)!;
        live.progress = lerp(
          live.progress,
          agent.current.progress,
          1 - Math.pow(0.78, delta)
        );
        live.tokensRate = lerp(
          live.tokensRate,
          agent.current.tokensRate,
          1 - Math.pow(0.88, delta)
        );
        // Status is discrete — copy, never lerp.
        live.status = agent.current.status;

        const livePrimary = primaryIsTokens ? live.tokensRate : live.progress;

        // liveX/liveY are the current "tip" of the line in CSS pixels
        const liveX = cssWidth - pad.right;
        const liveY = primaryToY(livePrimary);

        // Windowed + (if needed) downsampled points. x maps by TIME across the
        // window so the horizontal axis is time-linear; when no window is set,
        // the full retained span maps left→right.
        const { points: rawPts } = primaryBuf.windowed(drawNow, effectiveWinMs, targetPoints, recomputeMs);
        if (rawPts.length < 2) return;
        // Display-only smoothing (opt-in via `smoothing`). Operates on the draw
        // points; buffer/health/tooltip remain raw.
        const pts = emaPoints(rawPts, smoothingRef.current);
        // ── Stable x-domain ────────────────────────────────────────────────
        // The x-axis must be anchored to DATA time, not wall-clock, or every
        // frame re-projects the same points onto a shifting domain and the line
        // appears to warp/crawl (history must hold its x-position and only
        // scroll left as new data arrives).
        //   - tEnd is the newest SAMPLE time (not drawNow), so the right edge
        //     tracks real data; the live tip is extrapolated to the edge below.
        //   - tStart is tEnd minus a fixed span: the window length when one is
        //     set, otherwise the buffer's own time extent (rawPts span). Because
        //     the span is a fixed duration, points keep a stable x as the pair
        //     (tStart,tEnd) advances together — a clean leftward scroll.
        const newestT = pts[pts.length - 1].t;
        // No-window span: bounded to DEFAULT_VIEW_MS so the view scrolls at a
        // CONSTANT density instead of growing to the buffer's full extent (which
        // crammed more time into the same pixels every second, slowing the draw
        // and shifting point positions). We take the smaller of the buffer's
        // actual extent (so a young buffer fills left-to-right rather than
        // starting zoomed-in) and the default cap. rawPts[0] is the true oldest
        // retained sample; it moves only on real eviction, keeping x stable.
        const oldestT = rawPts[0].t;
        const bufferExtent = Math.max(1, newestT - oldestT);
        const noWindowSpan = Math.min(bufferExtent, DEFAULT_VIEW_MS);
        const tEnd = winMs !== undefined ? drawNow : newestT;
        const tStart = winMs !== undefined ? drawNow - winMs : tEnd - noWindowSpan;
        const tSpan = Math.max(1, tEnd - tStart);
        const xOf = (t: number) =>
          pad.left + Math.max(0, Math.min(1, (t - tStart) / tSpan)) * w;

        // Map every buffered sample to its true time-x. The newest sample sits
        // slightly left of the right edge (it was taken a few ms ago), and the
        // lerped live value is the SINGLE leading tip at the edge. Previously the
        // newest sample was also pinned to the edge with its raw y, so the line
        // drew to that raw point and then a tiny vertical segment jumped to the
        // lerped dot — the dot appeared to lead while the line trailed and caught
        // up. Letting the sample keep its real x (and not duplicating the tip)
        // makes the curve flow smoothly into the dot.
        const splinePoints = pts.map((p) => ({ x: xOf(p.t), y: primaryToY(p.v) }));
        // The tip is "now": its x is the right edge, its y is the lerped live
        // value. If the newest sample already maps to (essentially) the edge,
        // replace it so we don't stack two points at the same x; otherwise append
        // the tip so the line extends from the last sample out to the live edge.
        const tip = { x: liveX, y: liveY };
        const last = splinePoints[splinePoints.length - 1];
        if (last && liveX - last.x < 1.5) {
          splinePoints[splinePoints.length - 1] = tip;
        } else {
          splinePoints.push(tip);
        }

        // Subtle area fill beneath the line (cached per agent color)
        const fillKey = 'fill:' + agent.color;
        let fillGrad = fillCache.get(fillKey);
        if (!fillGrad) {
          fillGrad = ctx.createLinearGradient(0, pad.top, 0, pad.top + h);
          // Fade the area fill from a tint of the agent color to fully
          // transparent. The transparent stop must match the background's
          // color channel (white on light, black on dark) so the fill fades
          // into the canvas instead of leaving a faint white veil on dark bg.
          fillGrad.addColorStop(0, agent.color + (darkBg ? '20' : '12'));
          fillGrad.addColorStop(1, darkBg ? 'rgba(0,0,0,0)' : 'rgba(255,255,255,0)');
          fillCache.set(fillKey, fillGrad);
        }
        ctx.fillStyle = fillGrad;
        ctx.beginPath();
        ctx.moveTo(splinePoints[0].x, splinePoints[0].y);
        splinePath(ctx, splinePoints, 0.4); // same curve as the stroked line
        ctx.lineTo(liveX, pad.top + h);
        ctx.lineTo(splinePoints[0].x, pad.top + h);
        ctx.closePath();
        ctx.fill();

        // Main line: fades in from the left, full color at the right edge
        // (cached per agent color)
        const lineKey = 'line:' + agent.color;
        let lineGrad = fillCache.get(lineKey);
        if (!lineGrad) {
          lineGrad = ctx.createLinearGradient(
            pad.left,
            0,
            cssWidth - pad.right,
            0
          );
          lineGrad.addColorStop(0, agent.color + '00');
          lineGrad.addColorStop(0.10, agent.color + '14');
          lineGrad.addColorStop(0.22, agent.color + '99');
          lineGrad.addColorStop(1, agent.color);
          fillCache.set(lineKey, lineGrad);
        }
        ctx.save();
        ctx.strokeStyle = lineGrad;
        ctx.lineWidth = 1.75;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        drawCatmullRom(ctx, splinePoints, 0.4);
        ctx.restore();

        // Live dot — a soft outer glow (color halo) plus a solid core with a
        // small background-colored center, so the "live tip" reads clearly on
        // either theme and differentiates agents at a glance (the glow is
        // functional: it's how overlapping agent tips stay distinguishable).
        const glowPulse = 0.5 + 0.5 * Math.sin(drawNow / 420);
        ctx.save();
        ctx.shadowColor = agent.color;
        ctx.shadowBlur = 8 + glowPulse * 6;
        ctx.fillStyle = agent.color;
        ctx.beginPath();
        ctx.arc(liveX, liveY, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        // Center pip in the background color (no shadow), for a crisp eye.
        ctx.shadowBlur = 0;
        ctx.fillStyle = s.background || (darkBg ? '#0a0b0d' : '#ffffff');
        ctx.beginPath();
        ctx.arc(liveX, liveY, 1, 0, Math.PI * 2);
        ctx.fill();

        // Dual-axis overlay: in 'both' mode, draw the token-rate series as a
        // dashed line on the right-axis scale. Same color, lighter weight, so
        // it reads as a companion to the solid progress line above.
        if (metric === 'both') {
          const tokBuf = tokensBufferRef.current.get(agent.id);
          if (tokBuf && tokBuf.length >= 2) {
            const { points: rawTpts } = tokBuf.windowed(drawNow, effectiveWinMs, targetPoints, recomputeMs);
            const tpts = emaPoints(rawTpts, smoothingRef.current);
            if (tpts.length >= 2) {
              const tokPoints = tpts.map((p) => ({ x: xOf(p.t), y: tokenToY(p.v) }));
              const tTip = { x: liveX, y: tokenToY(live.tokensRate) };
              const tLast = tokPoints[tokPoints.length - 1];
              if (tLast && liveX - tLast.x < 1.5) tokPoints[tokPoints.length - 1] = tTip;
              else tokPoints.push(tTip);
              ctx.strokeStyle = agent.color + '99';
              ctx.lineWidth = 1;
              ctx.setLineDash([3, 3]);
              drawCatmullRom(ctx, tokPoints, 0.4);
              ctx.setLineDash([]);
            }
          }
        }

        // ── Anomaly markers ────────────────────────────────────────────────
        // Render the throttled detector's cached results for this agent. Drawn
        // last so markers sit above the line. Anchored with the SAME xOf() time
        // mapping as the curve, so a marker sits exactly under its moment.
        if (anomalyDetectionRef.current) {
          const anomalies = anomaliesRef.current.get(agent.id);
          if (anomalies && anomalies.length) {
            anomalies.forEach((an, ai) => {
              const ax = xOf(an.t);
              // Clamp into the plot area (a stall anchor can predate the window).
              const mx = Math.max(pad.left, Math.min(cssWidth - pad.right, ax));
              const isCritical = an.severity === 'critical';
              const col = isCritical ? '#DC2626' : '#D97706'; // red-600 / amber-600
              // Vertical guide line.
              ctx.strokeStyle = col + (isCritical ? '66' : '44');
              ctx.lineWidth = 1;
              ctx.setLineDash([2, 3]);
              ctx.beginPath();
              ctx.moveTo(mx, pad.top);
              ctx.lineTo(mx, pad.top + h);
              ctx.stroke();
              ctx.setLineDash([]);
              // Marker dot at the top, stacked if multiple so they don't overlap.
              const my = pad.top + 6 + ai * 14;
              ctx.fillStyle = col;
              ctx.beginPath();
              ctx.arc(mx, my, 3.5, 0, Math.PI * 2);
              ctx.fill();
              // Label to the side, kept on-canvas.
              ctx.font = '9px monospace';
              ctx.textBaseline = 'middle';
              const label = an.message;
              const tw = ctx.measureText(label).width;
              const labelX = mx + 7 + tw > cssWidth - pad.right ? mx - 7 - tw : mx + 7;
              ctx.textAlign = 'left';
              ctx.fillStyle = col;
              ctx.fillText(label, labelX, my);
              ctx.textBaseline = 'alphabetic';
            });
          }
        }
      });

      // Professional paused-state indicator (drawn on-canvas so it survives
      // any parent re-renders and is pixel-perfect with the chart).
      if (pausedRef.current) {
        ctx.fillStyle = darkBg ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)';
        ctx.font = '10px monospace';
        ctx.textAlign = 'right';
        ctx.fillText('PAUSED', cssWidth - pad.right - 6, pad.top + 12);
      }

      animationRef.current = requestAnimationFrame(animate);
    }, [deriveScale]); // deriveScale is ref-stable (empty deps), so the RAF loop still never restarts

    useEffect(() => {
      resizeCanvas();
      window.addEventListener('resize', resizeCanvas);
      animationRef.current = requestAnimationFrame(animate);
      return () => {
        window.removeEventListener('resize', resizeCanvas);
        if (animationRef.current) cancelAnimationFrame(animationRef.current);
      };
    }, [animate, resizeCanvas]);

    // ── Mouse handler ─────────────────────────────────────────────────────────
    // Also stable — reads from refs, no state in closure.
    // Uses CSS-pixel coordinates throughout: mouseX/mouseY from getBoundingClientRect
    // are already CSS pixels; we derive cssWidth/cssHeight by dividing canvas.width by dpr.
    const handleMouseMove = useCallback(
      (e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const dpr = dprRef.current;
        const cssWidth = canvas.width / dpr;
        const cssHeight = canvas.height / dpr;
        const mouseX = e.clientX - rect.left; // CSS pixels
        const mouseY = e.clientY - rect.top;  // CSS pixels

        const pad = { left: 56, right: 48, top: 40, bottom: 56 };
        const w = cssWidth - pad.left - pad.right;
        const h = cssHeight - pad.top - pad.bottom;

        if (
          mouseX < pad.left ||
          mouseX > cssWidth - pad.right ||
          mouseY < pad.top ||
          mouseY > cssHeight - pad.bottom
        ) {
          setHoveredPoint(null);
          return;
        }

        let closest: { point: AgentDataPoint; agentId: string } | null = null;
        let minDist = Infinity;

        // Use the SAME primary buffer + scale + windowing the draw loop uses, so
        // the hover target sits exactly on the rendered line in every mode.
        // MUST equal the draw loop's targetPoints (w/2) so hover reads the same
        // cached downsample the line was drawn from — identical points → hovered
        // point sits exactly on the rendered line, and the axis scan shares it.
        const targetPoints = Math.max(8, Math.ceil(w / 2));
        const { primaryIsTokens, primaryBufferRef, primaryToY } = deriveScale(h, pad.top, targetPoints);
        const hoverNow = performance.now();
        const winMs =
          windowSecondsRef.current !== undefined
            ? windowSecondsRef.current * 1000
            : undefined;
        const effectiveWinMs = winMs ?? DEFAULT_VIEW_MS;
        // Match the draw loop's recompute interval so hover reads the SAME
        // cached downsample the line was drawn from (shared cache → identical
        // points → hover target sits exactly on the rendered line).
        const recomputeMs = Math.max(16, effectiveWinMs * 0.005);

        agentsRef.current.forEach((agent) => {
          if (!agent.visible) return;
          const primaryBuf = primaryBufferRef.current.get(agent.id);
          if (!primaryBuf) return;
          const { points: rawPts } = primaryBuf.windowed(hoverNow, effectiveWinMs, targetPoints, recomputeMs);
          if (rawPts.length < 2) return;
          // Hit-test geometry must match the DRAWN line, so smooth identically.
          // But the tooltip must report RAW values — so we keep both, aligned by
          // index: smoothed for the y used in distance, raw for what we display.
          const sm = smoothingRef.current;
          const drawPts = emaPoints(rawPts, sm);
          // Use the SAME stable data-anchored x-domain as the draw loop (anchored
          // to the newest sample, fixed span) so the hover target sits exactly on
          // the rendered line instead of a wall-clock-shifted projection.
          const newestT = drawPts[drawPts.length - 1].t;
          const oldestT = rawPts[0].t;
          const bufferExtent = Math.max(1, newestT - oldestT);
          const noWindowSpan = Math.min(bufferExtent, DEFAULT_VIEW_MS);
          const tEnd = winMs !== undefined ? hoverNow : newestT;
          const tStart = winMs !== undefined ? hoverNow - winMs : tEnd - noWindowSpan;
          const tSpan = Math.max(1, tEnd - tStart);
          const otherBuf = primaryIsTokens
            ? progressBufferRef.current.get(agent.id)
            : tokensBufferRef.current.get(agent.id);

          drawPts.forEach((p, idx) => {
            const x =
              pad.left + Math.max(0, Math.min(1, (p.t - tStart) / tSpan)) * w;
            const y = primaryToY(p.v); // smoothed: matches the rendered curve
            const dist = Math.hypot(x - mouseX, y - mouseY);
            if (dist < minDist && dist < 32) {
              minDist = dist;
              // Report RAW values at this point, never the smoothed ones.
              const rawV = rawPts[idx].v;
              // Copy-free O(log n) lookup on the companion buffer (no toArray).
              const companion = otherBuf
                ? otherBuf.nearestValueAt(p.t)
                : undefined;
              const progressAtT = primaryIsTokens
                ? companion ?? agent.current.progress
                : rawV;
              const tokensAtT = primaryIsTokens
                ? rawV
                : companion ?? agent.current.tokensRate;
              closest = {
                point: {
                  // Both `time` and `status` are now the REAL historical values
                  // at the hovered sample: time from the time-indexed buffer,
                  // status from the sparse status-transition log (statusAt).
                  // Falls back to current status only if no transition predates
                  // the point (shouldn't happen post-seed).
                  time: p.t,
                  tokensRate: tokensAtT,
                  progress: progressAtT,
                  status:
                    statusLogRef.current.get(agent.id)?.statusAt(p.t) ??
                    agent.current.status,
                },
                agentId: agent.id,
              };
            }
          });
        });
        setHoveredPoint(closest);
      },
      [deriveScale] // deriveScale is ref-stable
    );

    const handleCanvasKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLCanvasElement>) => {
        if (e.key === ' ') {
          e.preventDefault();
          setPaused((p) => {
            const next = !p;
            pausedRef.current = next;
            dirtyRef.current = true; // repaint once to show/clear the PAUSED overlay
            return next;
          });
        } else if (e.key === 'Escape') {
          setHoveredPoint(null);
        }
      },
      []
    );

    const handleToggleAgent = useCallback((id: string) => {
      agentsRef.current = agentsRef.current.map((a) =>
        a.id === id ? { ...a, visible: !a.visible } : a
      );
      dirtyRef.current = true;
      setUiAgents((prev) =>
        prev.map((a) => (a.id === id ? { ...a, visible: !a.visible } : a))
      );
    }, []);

    // ── Render ────────────────────────────────────────────────────────────────
    const borderColor =
      styles.borderColor || (isDark ? '#1f1f23' : '#e5e5e0');

    // a11y label — kept static rather than derived from the live agents list so
    // it doesn't churn for screen readers on every state change.
    const visibleCount = uiAgents.filter((a) => a.visible).length;
    const ariaLabel = `Real-time telemetry chart showing ${visibleCount} agent${
      visibleCount === 1 ? '' : 's'
    }.`;

    return (
      <div
        className={className}
        style={{ width: '100%', height, position: 'relative', ...rootStyle }}
      >
        {/* Scoped focus ring — :focus-visible only applies for keyboard focus,
            so mouse clicks on the canvas don't trigger a visible outline. */}
        <style>{`.agentstat-canvas:focus-visible{outline:2px solid #3b82f6;outline-offset:2px;}`}</style>
        <canvas
          ref={canvasRef}
          className="agentstat-canvas"
          role="img"
          aria-label={ariaLabel}
          style={{
            width: '100%',
            height: '100%',
            borderRadius: 12,
            border: `1px solid ${borderColor}`,
            background: styles.background || '#ffffff',
            display: 'block',
            cursor: 'crosshair',
          }}
          tabIndex={0}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoveredPoint(null)}
          onClick={() => {
            if (hoveredPoint && onSpikeClickRef.current) {
              onSpikeClickRef.current(hoveredPoint.agentId, hoveredPoint.point);
            }
          }}
          onKeyDown={handleCanvasKeyDown}
        />

        {/* Agent visibility toggles */}
        <div
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 4,
            maxWidth: '55%',
            justifyContent: 'flex-end',
          }}
        >
          {uiAgents.map((agent) => (
            <button
              key={agent.id}
              onClick={() => handleToggleAgent(agent.id)}
              style={{
                ...overlayBase,
                padding: '3px 10px',
                fontSize: 11,
                background: agent.visible ? ot.activeBtnBg : 'transparent',
                color: agent.visible ? agent.color : ot.inactiveText,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                textDecoration: agent.visible ? 'none' : 'line-through',
                transition: 'all 0.1s ease',
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  backgroundColor: agent.color,
                  flexShrink: 0,
                }}
              />
              {agent.name}
            </button>
          ))}
        </div>

        {/* Telemetry panel — reads live values directly from refs at render time */}
        <div
          style={{
            ...overlayBase,
            position: 'absolute',
            bottom: 12,
            left: 12,
            padding: '8px 12px',
            pointerEvents: 'none',
          }}
        >
          {uiAgents
            .filter((a) => a.visible)
            .map((agent) => {
              const rates = tokensBufferRef.current.get(agent.id)?.values() ?? [];
              // Read from the smoothed cache (updated every 500ms, >1pt threshold).
              // Avoids the random confidenceScore causing the displayed number to
              // shuffle every frame even when the line is visually flat.
              const health =
                healthCacheRef.current[agent.id] ??
                calculateHealth(agent, rates);
              const live = liveValuesRef.current.get(agent.id);
              const displayTok = (
                live?.tokensRate ?? agent.current.tokensRate
              ).toFixed(1);
              return (
                <div
                  key={agent.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    marginBottom: 3,
                    fontSize: 11,
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      backgroundColor: agent.color,
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ color: ot.muted, minWidth: 76 }}>
                    {agent.name}
                  </span>
                  <span
                    style={{
                      color: ot.text,
                      minWidth: 52,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {displayTok} t/s
                  </span>
                  <span
                    style={{
                      color: ot.text,
                      minWidth: 36,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {health.score}%
                  </span>
                  <span
                    style={{
                      color: ot.muted,
                      fontSize: 9,
                      textTransform: 'uppercase',
                      letterSpacing: '0.08em',
                    }}
                  >
                    {agent.current.status}
                  </span>
                </div>
              );
            })}
        </div>

        {/* Pause */}
        <div style={{ position: 'absolute', bottom: 12, right: 12 }}>
          <button
            onClick={() => {
              setPaused((p) => {
                const next = !p;
                pausedRef.current = next;
                return next;
              });
            }}
            style={{
              ...overlayBase,
              padding: '4px 14px',
              fontSize: 11,
              cursor: 'pointer',
              color: ot.text,
              transition: 'background 0.1s ease',
            }}
          >
            {paused ? 'RESUME' : 'PAUSE'}
          </button>
        </div>

        {/* Hover tooltip */}
        {hoveredPoint && (
          <div
            style={{
              ...overlayBase,
              position: 'absolute',
              top: 12,
              left: '50%',
              transform: 'translateX(-50%)',
              padding: '5px 12px',
              fontSize: 11,
              pointerEvents: 'none',
              zIndex: 10,
              color: ot.text,
              whiteSpace: 'nowrap',
            }}
          >
            {hoveredPoint.point.status} ·{' '}
            {hoveredPoint.point.tokensRate.toFixed(1)} t/s ·{' '}
            {hoveredPoint.point.progress.toFixed(0)}%
          </div>
        )}
      </div>
    );
  }
);

AgentStat.displayName = 'AgentStat';
export default AgentStat;
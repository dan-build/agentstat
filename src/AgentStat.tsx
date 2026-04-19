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

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type AgentStatus = 'active' | 'stuck' | 'thinking' | 'complete' | 'hallucinating';

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
}

export interface AgentStatRef {
  updateAgent: (id: string, tokensRate: number, progress: number, status: AgentStatus) => void;
  getHealth: (id: string) => HealthMetrics | undefined;
  getLiveMetrics: (
    id: string
  ) => { tokensRate: number; progress: number; status: AgentStatus } | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

const lerp = (start: number, end: number, t: number): number =>
  start + (end - start) * t;

/**
 * Health calculation now accepts the live rate buffer so stability
 * is computed from real data — not from agent.data which is always empty.
 *
 * Exported for unit testing — not re-exported from the package entry
 * (src/index.ts), so consumers don't see this as public API.
 */
export const calculateHealth = (agent: Agent, recentRates: number[]): HealthMetrics => {
  const { current, config } = agent;

  const [minTok = 5, maxTok = 25] = config?.expectedTokensPerSec ?? [];
  const idealTok = (minTok + maxTok) / 2;
  const tokenEfficiency =
    current.tokensRate >= minTok && current.tokensRate <= maxTok
      ? 100
      : Math.max(0, 100 - Math.abs(current.tokensRate - idealTok) * 4);

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

  // Weighted composite score. The four dimensions nominally carry weights that
  // sum to 1.0, but the latency dimension only contributes a signal when the
  // consumer actually supplied `latencyMs`. Two cases:
  //
  //   1. latencyMs is undefined: we have no latency signal, so we drop the 0.1
  //      latency weight entirely and renormalize the remaining three weights.
  //      A perfectly-healthy agent with no latency data thus reaches 100 —
  //      not the ~90 cap the old formula produced.
  //
  //   2. latencyMs is defined: score latency on the same 0–100 scale as the
  //      other dimensions (improving=100, stable=50, degrading=0), then apply
  //      its 0.1 weight. Perfect + improving latency reaches 100; perfect +
  //      stable latency reaches 95; perfect + degrading latency reaches 90.
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

  return {
    score: Math.max(0, Math.min(100, score)),
    tokenEfficiency: Math.round(tokenEfficiency),
    stability: Math.round(stability),
    hallucinationRisk,
    latencyTrend,
  };
};

const drawCatmullRom = (
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
  tension = 0.4
) => {
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    ctx.bezierCurveTo(
      p1.x + ((p2.x - p0.x) * tension) / 3,
      p1.y + ((p2.y - p0.y) * tension) / 3,
      p2.x - ((p3.x - p1.x) * tension) / 3,
      p2.y - ((p3.y - p1.y) * tension) / 3,
      p2.x,
      p2.y
    );
  }
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
    },
    ref
  ) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const animationRef = useRef<number>();
    const lastTimeRef = useRef<number>(performance.now());
    // DPR stored in a ref so the stable animate closure always has the latest value.
    const dprRef = useRef<number>(1);

    // ── Canonical data store ──────────────────────────────────────────────────
    // The animation loop reads from these refs only — never from React state.
    // This keeps animate() stable (no deps) so the RAF loop never restarts.
    const agentsRef = useRef<Agent[]>(initialAgents);
    const progressBufferRef = useRef<Map<string, number[]>>(new Map());
    const tokensBufferRef = useRef<Map<string, number[]>>(new Map());
    const liveValuesRef = useRef<
      Map<string, { tokensRate: number; progress: number; status: AgentStatus }>
    >(new Map());
    const healthCacheRef = useRef<Record<string, HealthMetrics>>({});
    const pausedRef = useRef<boolean>(false);
    // Tracks agent ids whose anomalous status was set by the consumer
    // (via updateAgent). The simulation tick respects this lock and will not
    // auto-recover these agents. Cleared the moment updateAgent is called
    // with a non-anomalous status.
    const userLockedRef = useRef<Set<string>>(new Set());

    // Prop refs — animate reads styles and referenceLine without needing them as deps.
    const stylesRef = useRef(styles);
    const referenceLineRef = useRef(referenceLine);
    useEffect(() => { stylesRef.current = styles; }, [styles]);
    useEffect(() => { referenceLineRef.current = referenceLine; }, [referenceLine]);

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
        progressBufferRef.current.set(
          agent.id,
          Array(80).fill(agent.current.progress)
        );
        tokensBufferRef.current.set(
          agent.id,
          Array(80).fill(agent.current.tokensRate)
        );
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
            const progressBuf = progressBufferRef.current.get(id) || [];
            const tokensBuf = tokensBufferRef.current.get(id) || [];
            progressBuf.push(progress);
            tokensBuf.push(tokensRate);
            if (progressBuf.length > 420) progressBuf.shift();
            if (tokensBuf.length > 420) tokensBuf.shift();
            progressBufferRef.current.set(id, progressBuf);
            tokensBufferRef.current.set(id, tokensBuf);
            return {
              ...agent,
              current: { ...agent.current, tokensRate, progress, status },
            };
          });
        },
        getHealth: (id) => healthCacheRef.current[id],
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
            newTokens = Math.max(1, Math.min(35, agent.current.tokensRate + (Math.random() * 1.8 - 0.9)));
          }

          // ── progress reflects status ──────────────────────────────────
          const progressIncrement =
            nextStatus === 'stuck'          ? 0 :
            nextStatus === 'hallucinating'  ? 0.15 :
            Math.random() * 0.9;
          const newProgress = Math.min(100, agent.current.progress + progressIncrement);

          // ── confidenceScore: stable when healthy, low during anomaly ──
          // Stable 0.95 prevents score jitter during normal operation.
          const nextConfidence = inAnomaly ? Math.random() * 0.35 : 0.95;

          const progressBuf = progressBufferRef.current.get(agent.id) || [];
          const tokensBuf = tokensBufferRef.current.get(agent.id) || [];
          progressBuf.push(newProgress);
          tokensBuf.push(newTokens);
          if (progressBuf.length > 420) progressBuf.shift();
          if (tokensBuf.length > 420) tokensBuf.shift();
          progressBufferRef.current.set(agent.id, progressBuf);
          tokensBufferRef.current.set(agent.id, tokensBuf);

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
        current.forEach((agent) => {
          if (!agent.visible) return;
          const rates = tokensBufferRef.current.get(agent.id) || [];
          const health = calculateHealth(agent, rates);
          const cached = healthCacheRef.current[agent.id];
          if (!cached || Math.abs(cached.score - health.score) > 1) {
            healthCacheRef.current[agent.id] = health;
            onHealthChangeRef.current?.(agent.id, health);
          }
        });
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
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }, []);

    // ── Animation loop ────────────────────────────────────────────────────────
    // STABLE — empty deps array means this is created once and never recreated.
    // All data comes from refs. The RAF loop runs for the full component lifetime.
    const animate = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const now = performance.now();
      const delta = Math.min((now - lastTimeRef.current) / 16.67, 2.5);
      lastTimeRef.current = now;

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

      // Y-axis labels + grid lines
      ctx.font = '10px monospace';
      ctx.textAlign = 'right';
      const labelAlpha = darkBg ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)';
      const gridColor =
        s.gridColor || (darkBg ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)');

      [100, 75, 50, 25, 0].forEach((v) => {
        const y = pad.top + h - (h * v) / 100;
        ctx.fillStyle = labelAlpha;
        ctx.fillText(v + '%', pad.left - 8, y + 4);
        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(cssWidth - pad.right, y);
        ctx.stroke();
      });

      // Reference line
      const rl = referenceLineRef.current;
      if (rl) {
        const y = pad.top + h - (h * rl.value) / 100;
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
      agentsRef.current.forEach((agent) => {
        if (!agent.visible) return;
        const progressBuf = progressBufferRef.current.get(agent.id) || [];
        if (progressBuf.length < 2) return;

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

        // liveX/liveY are the current "tip" of the line in CSS pixels
        const liveX = cssWidth - pad.right;
        const liveY = pad.top + h - (h * live.progress) / 100;

        const splinePoints = progressBuf.map((val, i) => ({
          x: pad.left + (i / Math.max(1, progressBuf.length - 1)) * w,
          y: pad.top + h - (h * val) / 100,
        }));
        splinePoints.push({ x: liveX, y: liveY });

        // Subtle area fill beneath the line
        const fillGrad = ctx.createLinearGradient(0, pad.top, 0, pad.top + h);
        fillGrad.addColorStop(0, agent.color + '12');
        fillGrad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = fillGrad;
        ctx.beginPath();
        ctx.moveTo(pad.left, pad.top + h);
        splinePoints.forEach((p) => ctx.lineTo(p.x, p.y));
        ctx.lineTo(liveX, pad.top + h);
        ctx.closePath();
        ctx.fill();

        // Main line: fades in from the left, full color at the right edge
        const lineGrad = ctx.createLinearGradient(
          pad.left,
          0,
          cssWidth - pad.right,
          0
        );
        lineGrad.addColorStop(0, 'rgba(255,255,255,0)');
        lineGrad.addColorStop(0.12, agent.color + '22');
        lineGrad.addColorStop(1, agent.color);
        ctx.strokeStyle = lineGrad;
        ctx.lineWidth = 1.5;
        ctx.lineCap = 'round';
        drawCatmullRom(ctx, splinePoints, 0.4);

        // Live dot — solid color with a small white/bg center
        ctx.shadowBlur = 0;
        ctx.fillStyle = agent.color;
        ctx.beginPath();
        ctx.arc(liveX, liveY, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = s.background || '#ffffff';
        ctx.beginPath();
        ctx.arc(liveX, liveY, 1, 0, Math.PI * 2);
        ctx.fill();
      });

      animationRef.current = requestAnimationFrame(animate);
    }, []); // ← intentionally empty: reads exclusively from refs

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

        agentsRef.current.forEach((agent) => {
          if (!agent.visible) return;
          const progressBuf = progressBufferRef.current.get(agent.id) || [];
          progressBuf.forEach((val, i) => {
            // x, y computed in CSS pixels — same space as mouseX/mouseY
            const x =
              pad.left + (i / Math.max(1, progressBuf.length - 1)) * w;
            const y = pad.top + h - (h * val) / 100;
            const dist = Math.hypot(x - mouseX, y - mouseY);
            if (dist < minDist && dist < 32) {
              minDist = dist;
              closest = {
                point: {
                  time: Date.now(),
                  tokensRate:
                    tokensBufferRef.current.get(agent.id)?.[i] ??
                    agent.current.tokensRate,
                  progress: val,
                  status: agent.current.status,
                },
                agentId: agent.id,
              };
            }
          });
        });
        setHoveredPoint(closest);
      },
      [] // stable: reads from refs
    );

    const handleCanvasKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLCanvasElement>) => {
        if (e.key === ' ') {
          e.preventDefault();
          setPaused((p) => {
            const next = !p;
            pausedRef.current = next;
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
      <div style={{ width: '100%', height, position: 'relative' }}>
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
              const rates = tokensBufferRef.current.get(agent.id) || [];
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
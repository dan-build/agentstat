import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import AgentStat, {
  type Agent,
  type AgentStatRef,
  type HealthMetrics,
} from '../src/AgentStat';

// ─────────────────────────────────────────────────────────────────────────────
// THEME
// Dark is the default ("instrument" look). Light is a toggle that maps to the
// component's existing tested light path (styles.background = white). Both are
// first-class; the only thing that changes is the token set below + the
// `styles` we hand to <AgentStat/>.
// ─────────────────────────────────────────────────────────────────────────────

type Mode = 'dark' | 'light';

interface Theme {
  appBg: string;
  panelBg: string;
  canvasBg: string;
  border: string;
  borderStrong: string;
  text: string;
  text2: string;
  text3: string;
  hover: string;
  gridColor: string;
  refLine: string;
}

const THEMES: Record<Mode, Theme> = {
  dark: {
    appBg: '#0a0b0d',
    panelBg: 'rgba(14,16,20,0.72)',
    canvasBg: '#0e1014',
    border: 'rgba(255,255,255,0.07)',
    borderStrong: 'rgba(255,255,255,0.12)',
    text: 'rgba(255,255,255,0.92)',
    text2: 'rgba(255,255,255,0.46)',
    text3: 'rgba(255,255,255,0.30)',
    hover: 'rgba(255,255,255,0.06)',
    gridColor: 'rgba(255,255,255,0.05)',
    refLine: 'rgba(255,255,255,0.14)',
  },
  light: {
    appBg: '#FAFAF8',
    panelBg: '#FFFFFF',
    canvasBg: '#FFFFFF',
    border: 'rgba(0,0,0,0.08)',
    borderStrong: 'rgba(0,0,0,0.16)',
    text: '#111111',
    text2: 'rgba(0,0,0,0.55)',
    text3: 'rgba(0,0,0,0.35)',
    hover: 'rgba(0,0,0,0.04)',
    gridColor: 'rgba(0,0,0,0.04)',
    refLine: 'rgba(0,0,0,0.14)',
  },
};

// Agent accent colors. IMPORTANT: AgentStat intentionally ignores color changes
// to existing agents made through the `agents` prop (runtime values come via
// updateAgent; the roster prop only defines identity/order). So per-theme colors
// would silently fail to apply on a light/dark toggle — the agent would keep its
// first-render color. We therefore choose colors that read clearly on BOTH
// backgrounds and keep them stable across themes.
const agentColor = (id: string): string => {
  const map: Record<string, string> = {
    '1': '#6366f1', // indigo — visible on white and near-black
    '2': '#f43f5e', // rose
    '3': '#0ea5e9', // sky
  };
  return map[id] ?? '#888';
};

const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  thinking: 'Thinking',
  stuck: 'Stuck',
  hallucinating: 'Anomaly',
  complete: 'Done',
};

const STATUS_COLOR: Record<string, string> = {
  active: '#34d399',
  thinking: '#60a5fa',
  stuck: '#fbbf24',
  hallucinating: '#f87171',
  complete: '#9ca3af',
};

const TRIGGERS = [
  { id: '1', label: 'Researcher → burst', sub: '28 t/s', tok: 28.4, prog: 87, stat: 'active' as const },
  { id: '2', label: 'Critic → stuck', sub: '0.8 t/s', tok: 0.8, prog: 9, stat: 'stuck' as const },
  { id: '3', label: 'Executor → anomaly', sub: 'hallucinating', tok: 3.1, prog: 45, stat: 'hallucinating' as const },
  { id: '1', label: 'Researcher → normalize', sub: '12.5 t/s', tok: 12.5, prog: 73, stat: 'thinking' as const },
];

const MONO = '"IBM Plex Mono", ui-monospace, "Cascadia Code", monospace';

export default function App() {
  const [mode, setMode] = useState<Mode>('dark');
  const [metric, setMetric] = useState<'progress' | 'tokens' | 'both'>('progress');
  const t = THEMES[mode];

  const agents = useMemo<Agent[]>(
    () => [
      { id: '1', name: 'Researcher', color: agentColor('1'), data: [], current: { tokensRate: 14.8, progress: 42, status: 'active' }, visible: true, config: { expectedTokensPerSec: [10, 20] } },
      { id: '2', name: 'Critic', color: agentColor('2'), data: [], current: { tokensRate: 4.2, progress: 18, status: 'thinking' }, visible: true, config: { expectedTokensPerSec: [5, 15] } },
      { id: '3', name: 'Executor', color: agentColor('3'), data: [], current: { tokensRate: 21.5, progress: 91, status: 'active' }, visible: true, config: { expectedTokensPerSec: [15, 30] } },
    ],
    []
  );

  const [healthMetrics, setHealthMetrics] = useState<Record<string, HealthMetrics>>({});
  const [liveMetrics, setLiveMetrics] = useState<
    Record<string, { tokensRate: number; progress: number; status: Agent['current']['status'] }>
  >({});
  const ref = useRef<AgentStatRef>(null);

  // The chart needs a real pixel height (its root renders `height` as a number).
  // The locked frame sizes the chart cell with `1fr`, so we measure that cell and
  // hand the component a concrete height — correct at every viewport size rather
  // than relying on a CSS-height override of the numeric prop.
  const chartCellRef = useRef<HTMLDivElement>(null);
  const [chartHeight, setChartHeight] = useState(420);
  useEffect(() => {
    const el = chartCellRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const hgt = entries[0]?.contentRect.height;
      if (hgt && Math.abs(hgt - chartHeight) > 1) setChartHeight(Math.floor(hgt));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [chartHeight]);

  useEffect(() => {
    const interval = setInterval(() => {
      const next: Record<string, { tokensRate: number; progress: number; status: Agent['current']['status'] }> = {};
      agents.forEach((a) => {
        const live = ref.current?.getLiveMetrics(a.id);
        if (live) next[a.id] = live;
      });
      setLiveMetrics(next);
    }, 400);
    return () => clearInterval(interval);
  }, [agents]);

  const handleHealthChange = useCallback((id: string, h: HealthMetrics) => {
    setHealthMetrics((prev) => ({ ...prev, [id]: h }));
  }, []);

  const trigger = useCallback(
    (id: string, tok: number, prog: number, stat: Agent['current']['status']) => {
      ref.current?.updateAgent(id, tok, prog, stat);
    },
    []
  );

  // ── shared style helpers ──────────────────────────────────────────────────
  const eyebrow: React.CSSProperties = {
    fontSize: 9, fontWeight: 600, letterSpacing: '0.12em',
    textTransform: 'uppercase', color: t.text3, marginBottom: 8,
  };
  const panel: React.CSSProperties = {
    background: t.panelBg, border: `1px solid ${t.border}`,
    borderRadius: 12, backdropFilter: 'blur(10px)',
  };

  return (
    <div
      style={{
        height: '100vh', width: '100vw', overflow: 'hidden',
        background: t.appBg, color: t.text, fontFamily: MONO,
        display: 'grid', gridTemplateRows: '56px 1fr',
        transition: 'background 0.25s ease, color 0.25s ease',
      }}
    >
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0 24px', borderBottom: `1px solid ${t.border}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <span style={{ fontFamily: '"Ogg", Georgia, serif', fontStyle: 'italic', fontWeight: 300, fontSize: 22, letterSpacing: '-0.01em', color: t.text }}>
            AgentStat
          </span>
          <span style={{ fontSize: 10.5, letterSpacing: '0.04em', textTransform: 'uppercase', color: t.text3 }}>
            real-time agent telemetry · v0.3.0
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: t.text2, letterSpacing: '0.04em' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#34d399', boxShadow: '0 0 7px 1px rgba(52,211,153,0.7)' }} />
            STREAMING
          </span>
          {/* Metric switch — puts the SAME quantity on the line and the cards */}
          <div style={{ display: 'flex', border: `1px solid ${t.border}`, borderRadius: 7, overflow: 'hidden' }}>
            {(['progress', 'tokens', 'both'] as const).map((m, i) => (
              <button
                key={m}
                onClick={() => setMetric(m)}
                style={{
                  appearance: 'none', border: 'none',
                  borderLeft: i === 0 ? 'none' : `1px solid ${t.border}`,
                  background: metric === m ? t.hover : 'transparent',
                  color: metric === m ? t.text : t.text2,
                  fontFamily: MONO, fontSize: 11, padding: '5px 11px', cursor: 'pointer',
                }}
              >
                {m}
              </button>
            ))}
          </div>
          <button
            onClick={() => setMode((m) => (m === 'dark' ? 'light' : 'dark'))}
            style={{
              appearance: 'none', border: `1px solid ${t.border}`, borderRadius: 7,
              background: 'transparent', color: t.text2, fontFamily: MONO, fontSize: 11,
              padding: '5px 12px', cursor: 'pointer',
            }}
          >
            {mode === 'dark' ? '☀ light' : '☾ dark'}
          </button>
        </div>
      </header>

      {/* ── Stage: chart (left) + instrument column (right) ─────────────────── */}
      <main
        style={{
          display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 300px',
          gap: 16, padding: 16, minHeight: 0,
        }}
      >
        {/* Left: chart + trigger strip */}
        <div style={{ display: 'grid', gridTemplateRows: 'minmax(0,1fr) auto', gap: 12, minHeight: 0, minWidth: 0 }}>
          <div ref={chartCellRef} style={{ minHeight: 0, position: 'relative' }}>
            <AgentStat
              ref={ref}
              agents={agents}
              height={chartHeight}
              metric={metric}
              simulateData
              anomalyDetection
              onHealthChange={handleHealthChange}
              referenceLine={{ value: 50, label: 'Threshold', color: t.refLine }}
              styles={{
                background: t.canvasBg,
                borderColor: t.border,
                textColor: t.text,
                gridColor: t.gridColor,
              }}
            />
          </div>

          {/* Trigger strip — actions live with the controls, not in a section */}
          <div style={{ ...panel, display: 'flex', gap: 8, padding: 10, flexWrap: 'wrap' }}>
            <span style={{ ...eyebrow, marginBottom: 0, alignSelf: 'center', marginRight: 4 }}>Inject</span>
            {TRIGGERS.map((b, i) => (
              <button
                key={i}
                onClick={() => trigger(b.id, b.tok, b.prog, b.stat)}
                style={{
                  flex: '1 1 auto', minWidth: 130, textAlign: 'left',
                  background: 'transparent', border: `1px solid ${t.border}`,
                  borderRadius: 8, padding: '8px 12px', cursor: 'pointer',
                  color: t.text, fontFamily: MONO, fontSize: 12,
                  transition: 'background 0.12s, border-color 0.12s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = t.hover; e.currentTarget.style.borderColor = t.borderStrong; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = t.border; }}
              >
                <div>{b.label}</div>
                <div style={{ fontSize: 10, color: t.text3, marginTop: 2 }}>{b.sub}</div>
              </button>
            ))}
            {/* Escape hatch: re-asserting a non-anomalous status clears the
                per-agent user-lock, letting the sim resume normal behavior.
                Without this, a stuck/anomaly agent stays pinned with no way back. */}
            <button
              onClick={() => {
                agents.forEach((a) => {
                  const [mn, mx] = a.config?.expectedTokensPerSec ?? [10, 20];
                  trigger(a.id, (mn + mx) / 2, a.current.progress, 'active');
                });
              }}
              title="Recover all agents"
              aria-label="Recover all agents"
              style={{
                flex: '0 0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 34, height: 34, alignSelf: 'center',
                background: 'transparent', border: `1px solid ${t.border}`,
                borderRadius: 8, cursor: 'pointer', color: t.text2, padding: 0,
                transition: 'background 0.12s, color 0.12s, border-color 0.12s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = t.hover; e.currentTarget.style.color = t.text; e.currentTarget.style.borderColor = t.borderStrong; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = t.text2; e.currentTarget.style.borderColor = t.border; }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
          </div>
        </div>

        {/* Right: health readouts, one compact card per agent */}
        <div style={{ display: 'grid', gridTemplateRows: `auto repeat(${agents.length}, minmax(0,1fr))`, gap: 10, minHeight: 0 }}>
          <span style={eyebrow}>Health</span>
          {agents.map((agent) => {
            const live = liveMetrics[agent.id];
            const h = healthMetrics[agent.id] ?? { score: 100, tokenEfficiency: 100, stability: 100, hallucinationRisk: 0, latencyTrend: 'stable' as const };
            const tok = (live?.tokensRate ?? agent.current.tokensRate).toFixed(1);
            const status = live?.status ?? agent.current.status;
            const progress = Math.round(live?.progress ?? agent.current.progress);
            const scoreColor = h.score > 70 ? '#34d399' : h.score > 40 ? '#fbbf24' : '#f87171';
            return (
              <div key={agent.id} style={{ ...panel, padding: '12px 14px', display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: agent.color, boxShadow: `0 0 6px ${agent.color}` }} />
                    <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: t.text2 }}>{agent.name}</span>
                  </span>
                  <span style={{ fontSize: 8.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: STATUS_COLOR[status] }}>
                    {STATUS_LABEL[status] ?? status}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 30, fontWeight: 300, lineHeight: 1, color: scoreColor, fontVariantNumeric: 'tabular-nums' }}>{h.score}</span>
                  <span style={{ fontSize: 12, color: t.text3 }}>health</span>
                  <span style={{ marginLeft: 'auto', fontSize: 13, color: t.text, fontVariantNumeric: 'tabular-nums' }}>{tok}<span style={{ fontSize: 10, color: t.text3 }}> t/s</span></span>
                </div>
                {/* score bar */}
                <div style={{ height: 2, background: t.border, borderRadius: 2, marginBottom: 8, position: 'relative' }}>
                  <div style={{ position: 'absolute', inset: '0 auto 0 0', width: `${h.score}%`, background: scoreColor, borderRadius: 2, transition: 'width 0.6s ease-out' }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: t.text3, fontVariantNumeric: 'tabular-nums' }}>
                  <span>prog {progress}%</span>
                  <span>stab {h.stability}%</span>
                  <span>eff {h.tokenEfficiency}%</span>
                </div>
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}

import React, { useState, useRef, useCallback, useEffect } from 'react';
import AgentStat, {
  type Agent,
  type AgentStatRef,
  type HealthMetrics,
} from '../src/AgentStat';

// ─────────────────────────────────────────────────────────────────────────────
// AGENTS
// Bold, intentional colors — not Tailwind defaults.
// ─────────────────────────────────────────────────────────────────────────────

const initialAgents: Agent[] = [
  {
    id: '1',
    name: 'Researcher',
    color: '#111111',
    data: [],
    current: { tokensRate: 14.8, progress: 42, status: 'active' },
    visible: true,
    config: { expectedTokensPerSec: [10, 20] },
  },
  {
    id: '2',
    name: 'Critic',
    color: '#B91C1C',
    data: [],
    current: { tokensRate: 4.2, progress: 18, status: 'thinking' },
    visible: true,
    config: { expectedTokensPerSec: [5, 15] },
  },
  {
    id: '3',
    name: 'Executor',
    color: '#1D4ED8',
    data: [],
    current: { tokensRate: 21.5, progress: 91, status: 'active' },
    visible: true,
    config: { expectedTokensPerSec: [15, 30] },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  thinking: 'Thinking',
  stuck: 'Stuck',
  hallucinating: 'Anomaly',
  complete: 'Done',
};

const STATUS_COLOR: Record<string, string> = {
  active: '#111111',
  thinking: '#1D4ED8',
  stuck: '#B45309',
  hallucinating: '#B91C1C',
  complete: '#6B7280',
};

const TRIGGERS = [
  { id: '1', label: 'Researcher → High burst (28 t/s)', tok: 28.4, prog: 87, stat: 'active' as const },
  { id: '2', label: 'Critic → Stuck',                  tok: 0.8,  prog: 9,  stat: 'stuck' as const },
  { id: '3', label: 'Executor → Anomaly',              tok: 3.1,  prog: 45, stat: 'hallucinating' as const },
  { id: '1', label: 'Researcher → Normalize',          tok: 12.5, prog: 73, stat: 'thinking' as const },
  { id: '2', label: 'Critic → Surge (19 t/s)',         tok: 18.9, prog: 95, stat: 'active' as const },
];

// ─────────────────────────────────────────────────────────────────────────────
// SHARED STYLES
// ─────────────────────────────────────────────────────────────────────────────

const label: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: '0.12em',
  color: 'rgba(0,0,0,0.35)',
  textTransform: 'uppercase',
  marginBottom: 16,
};

const metricLabel: React.CSSProperties = {
  fontSize: 9,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'rgba(0,0,0,0.35)',
  marginBottom: 2,
};

// ─────────────────────────────────────────────────────────────────────────────
// APP
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  const [agents] = useState(initialAgents);
  const [healthMetrics, setHealthMetrics] = useState<Record<string, HealthMetrics>>({});

  // Poll live metrics from the imperative ref so they properly trigger re-renders.
  // Reading from a ref directly in JSX is inert — it never causes updates.
  const [liveMetrics, setLiveMetrics] = useState<
    Record<
      string,
      { tokensRate: number; progress: number; status: Agent['current']['status'] }
    >
  >({});
  const agentStatRef = useRef<AgentStatRef>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      const next: Record<
        string,
        { tokensRate: number; progress: number; status: Agent['current']['status'] }
      > = {};
      agents.forEach((a) => {
        const live = agentStatRef.current?.getLiveMetrics(a.id);
        if (live) next[a.id] = live;
      });
      setLiveMetrics(next);
    }, 500);
    return () => clearInterval(interval);
  }, [agents]);

  const handleHealthChange = useCallback(
    (agentId: string, health: HealthMetrics) => {
      setHealthMetrics((prev) => ({ ...prev, [agentId]: health }));
    },
    []
  );

  const updateAgent = useCallback(
    (id: string, tokensRate: number, progress: number, status: Agent['current']['status']) => {
      agentStatRef.current?.updateAgent(id, tokensRate, progress, status);
    },
    []
  );

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#FAFAF8',
        color: '#111111',
        fontFamily: '"IBM Plex Mono", ui-monospace, "Cascadia Code", monospace',
      }}
    >
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header
        style={{
          borderBottom: '1px solid rgba(0,0,0,0.08)',
          padding: '0 40px',
          height: 48,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        {/* Wordmark — matches the docs site. Renders in Ogg Light Italic
            when /fonts/ogg-light-italic.woff2 is present, otherwise falls
            back to Georgia (system serif italic). */}
        <span
          style={{
            fontFamily: '"Ogg", Georgia, "Times New Roman", serif',
            fontStyle: 'italic',
            fontWeight: 300,
            fontSize: 22,
            letterSpacing: '-0.01em',
            lineHeight: 1,
          }}
        >
          AgentStat
        </span>
        <span
          style={{
            fontSize: 11,
            color: 'rgba(0,0,0,0.32)',
            letterSpacing: '0.04em',
          }}
        >
          Real-time LLM health monitoring · v0.1.0
        </span>
      </header>

      <div
        style={{
          maxWidth: 1120,
          margin: '0 auto',
          padding: '40px 40px 80px',
        }}
      >
        {/* ── Canvas ───────────────────────────────────────────────────────── */}
        <AgentStat
          ref={agentStatRef}
          agents={agents}
          height={520}
          simulateData={true}
          onHealthChange={handleHealthChange}
          referenceLine={{
            value: 50,
            label: 'Threshold',
            color: 'rgba(0,0,0,0.14)',
          }}
          styles={{
            background: '#FFFFFF',
            borderColor: '#E5E5E0',
            textColor: '#111111',
            gridColor: 'rgba(0,0,0,0.04)',
          }}
        />

        {/* ── Bottom panels ─────────────────────────────────────────────────── */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 56,
            marginTop: 64,
          }}
        >
          {/* Trigger */}
          <section>
            <div style={label}>Trigger</div>
            <div
              style={{
                border: '1px solid rgba(0,0,0,0.08)',
                borderRadius: 12,
                overflow: 'hidden',
              }}
            >
              {TRIGGERS.map((btn, i) => (
                <button
                  key={i}
                  onClick={() => updateAgent(btn.id, btn.tok, btn.prog, btn.stat)}
                  style={{
                    width: '100%',
                    padding: '14px 20px',
                    background: 'transparent',
                    border: 'none',
                    borderBottom:
                      i < TRIGGERS.length - 1
                        ? '1px solid rgba(0,0,0,0.05)'
                        : 'none',
                    textAlign: 'left',
                    fontSize: 13,
                    color: '#111111',
                    fontFamily: 'inherit',
                    cursor: 'pointer',
                    transition: 'background 0.12s ease',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background =
                      'rgba(0,0,0,0.025)';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background =
                      'transparent';
                  }}
                >
                  {btn.label}
                </button>
              ))}
            </div>
          </section>

          {/* Health */}
          <section>
            <div style={label}>Health</div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 16,
              }}
            >
              {agents.map((agent) => {
                const live = liveMetrics[agent.id];
                const health = healthMetrics[agent.id] ?? {
                  score: 100,
                  tokenEfficiency: 100,
                  stability: 100,
                  hallucinationRisk: 0,
                };
                const tokensRate = (
                  live?.tokensRate ?? agent.current.tokensRate
                ).toFixed(1);
                // Prefer the live status synced from the component's ref;
                // fall back to the initial agent snapshot before the first poll.
                const status = live?.status ?? agent.current.status;
                // Progress mirrors the line on the graph — same data source.
                const progress = Math.round(
                  live?.progress ?? agent.current.progress
                );

                return (
                  <div
                    key={agent.id}
                    style={{
                      background: '#FFFFFF',
                      padding: 20,
                      borderRadius: 12,
                      border: '1px solid rgba(0,0,0,0.07)',
                    }}
                  >
                    {/* Name */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 7,
                        marginBottom: 14,
                      }}
                    >
                      <span
                        style={{
                          width: 5,
                          height: 5,
                          borderRadius: '50%',
                          background: agent.color,
                          flexShrink: 0,
                        }}
                      />
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          letterSpacing: '0.1em',
                          textTransform: 'uppercase',
                          color: 'rgba(0,0,0,0.38)',
                        }}
                      >
                        {agent.name}
                      </span>
                    </div>

                    {/* Score */}
                    <div
                      style={{
                        fontSize: 36,
                        fontWeight: 300,
                        lineHeight: 1,
                        marginBottom: 8,
                      }}
                    >
                      {health.score}
                      <span style={{ fontSize: 14, opacity: 0.3 }}>%</span>
                    </div>

                    {/* Bar */}
                    <div
                      style={{
                        height: 1,
                        background: 'rgba(0,0,0,0.06)',
                        marginBottom: 12,
                        position: 'relative',
                      }}
                    >
                      <div
                        style={{
                          position: 'absolute',
                          left: 0,
                          top: 0,
                          height: '100%',
                          width: `${health.score}%`,
                          background: agent.color,
                          transition: 'width 0.8s ease-out',
                        }}
                      />
                    </div>

                    {/* Progress — mirrors the line on the graph above */}
                    <div style={{ marginBottom: 14 }}>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'baseline',
                          justifyContent: 'space-between',
                          marginBottom: 4,
                        }}
                      >
                        <span style={metricLabel}>Progress</span>
                        <span
                          style={{
                            fontSize: 11,
                            fontVariantNumeric: 'tabular-nums',
                            color: 'rgba(0,0,0,0.72)',
                          }}
                        >
                          {progress}%
                        </span>
                      </div>
                      <div
                        style={{
                          height: 1,
                          background: 'rgba(0,0,0,0.06)',
                          position: 'relative',
                        }}
                      >
                        <div
                          style={{
                            position: 'absolute',
                            left: 0,
                            top: 0,
                            height: '100%',
                            width: `${progress}%`,
                            background: agent.color,
                            opacity: 0.5,
                            transition: 'width 0.4s ease-out',
                          }}
                        />
                      </div>
                    </div>

                    {/* Metrics grid */}
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 1fr',
                        gap: 10,
                      }}
                    >
                      <div>
                        <div style={metricLabel}>t/s</div>
                        <div
                          style={{
                            fontSize: 14,
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          {tokensRate}
                        </div>
                      </div>
                      <div>
                        <div style={metricLabel}>Status</div>
                        <div
                          style={{
                            fontSize: 11,
                            color:
                              STATUS_COLOR[status] || '#111111',
                          }}
                        >
                          {STATUS_LABEL[status] || status}
                        </div>
                      </div>
                      <div>
                        <div style={metricLabel}>Stability</div>
                        <div style={{ fontSize: 14 }}>
                          {health.stability ?? '—'}%
                        </div>
                      </div>
                      <div>
                        <div style={metricLabel}>Efficiency</div>
                        <div style={{ fontSize: 14 }}>
                          {health.tokenEfficiency ?? '—'}%
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
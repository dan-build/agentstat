// dev/Stress.tsx
//
// Dev-only load harness for AgentStat. NOT part of the published package.
//
// Purpose: drive the component at production-like scale (configurable agent
// count and update frequency) and surface per-frame timing so you can validate
// the "60fps" claim with a real Chrome DevTools Performance trace.
//
// How to use:
//   1. Mount this from a dev route (see dev/main.tsx wiring note below).
//   2. Open Chrome DevTools → Performance, record ~60s.
//   3. Read the on-screen p50/p95/p99 overlay AND the DevTools frame chart.
//      The overlay is a convenience; the DevTools trace is the source of truth
//      (it captures paint, GC, and compositing the overlay can't see).
//
// Acceptance target (from ROADMAP): at 10 agents / 20 Hz, p95 frame time should
// stay at or under ~16.6 ms with no RAF-loop restarts and no runaway memory.

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AgentStat, type Agent, type AgentStatRef } from '../src/index';

const COLORS = [
  '#111111', '#B91C1C', '#1D4ED8', '#047857', '#7C3AED',
  '#DB2777', '#EA580C', '#0891B2', '#4D7C0F', '#9333EA',
];

interface StressConfig {
  agentCount: number;
  hz: number;
  windowSeconds?: number;
  metric: 'progress' | 'tokens' | 'both';
}

export default function Stress() {
  const [cfg, setCfg] = useState<StressConfig>({
    agentCount: 10,
    hz: 20,
    windowSeconds: 300,
    metric: 'both',
  });

  const ref = useRef<AgentStatRef>(null);

  const agents = useMemo<Agent[]>(
    () =>
      Array.from({ length: cfg.agentCount }, (_, i) => ({
        id: `agent-${i}`,
        name: `Agent ${i}`,
        color: COLORS[i % COLORS.length],
        data: [],
        visible: true,
        config: { expectedTokensPerSec: [8, 24] as [number, number] },
        current: { tokensRate: 12, progress: 0, status: 'active' as const },
      })),
    [cfg.agentCount]
  );

  // ── Driver: push updates at `hz` per agent ────────────────────────────────
  useEffect(() => {
    const phases = agents.map(() => Math.random() * Math.PI * 2);
    const progress = agents.map(() => 0);
    const period = 1000 / cfg.hz;
    const id = setInterval(() => {
      const t = performance.now() / 1000;
      agents.forEach((a, i) => {
        // Smooth-ish token rate plus noise; occasional spike to exercise LTTB.
        const base = 14 + Math.sin(t * 0.6 + phases[i]) * 8;
        const spike = Math.random() < 0.01 ? 20 : 0;
        const tok = Math.max(0, base + spike + (Math.random() * 3 - 1.5));
        progress[i] = Math.min(100, progress[i] + Math.random() * 0.5);
        if (progress[i] >= 100) progress[i] = 0;
        ref.current?.updateAgent(a.id, tok, progress[i], 'active');
      });
    }, period);
    return () => clearInterval(id);
  }, [agents, cfg.hz]);

  // ── Frame-time sampler ────────────────────────────────────────────────────
  // Measures wall-clock gap between animation frames. This captures the full
  // frame budget (the component's draw + browser paint), which is what the
  // 60fps claim is actually about.
  const [stats, setStats] = useState<{ p50: number; p95: number; p99: number; max: number; fps: number }>(
    { p50: 0, p95: 0, p99: 0, max: 0, fps: 0 }
  );
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const samples: number[] = [];
    const tick = () => {
      const now = performance.now();
      samples.push(now - last);
      last = now;
      if (samples.length >= 120) {
        const sorted = [...samples].sort((a, b) => a - b);
        const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
        const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
        setStats({
          p50: at(0.5),
          p95: at(0.95),
          p99: at(0.99),
          max: sorted[sorted.length - 1],
          fps: 1000 / mean,
        });
        samples.length = 0;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const overOneFrame = stats.p95 > 16.7;

  return (
    <div style={{ maxWidth: 1100, margin: '24px auto', fontFamily: 'monospace' }}>
      <h1 style={{ fontSize: 16, marginBottom: 12 }}>AgentStat — stress harness</h1>

      <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap', fontSize: 13 }}>
        <label>
          Agents:{' '}
          <select
            value={cfg.agentCount}
            onChange={(e) => setCfg((c) => ({ ...c, agentCount: +e.target.value }))}
          >
            {[3, 5, 10, 15, 20].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label>
          Hz:{' '}
          <select value={cfg.hz} onChange={(e) => setCfg((c) => ({ ...c, hz: +e.target.value }))}>
            {[5, 10, 20, 30, 60].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label>
          Window:{' '}
          <select
            value={cfg.windowSeconds ?? 0}
            onChange={(e) =>
              setCfg((c) => ({ ...c, windowSeconds: +e.target.value || undefined }))
            }
          >
            <option value={0}>none</option>
            <option value={60}>1m</option>
            <option value={300}>5m</option>
            <option value={900}>15m</option>
          </select>
        </label>
        <label>
          Metric:{' '}
          <select
            value={cfg.metric}
            onChange={(e) => setCfg((c) => ({ ...c, metric: e.target.value as StressConfig['metric'] }))}
          >
            <option value="progress">progress</option>
            <option value="tokens">tokens</option>
            <option value="both">both</option>
          </select>
        </label>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 20,
          marginBottom: 12,
          padding: '8px 12px',
          borderRadius: 8,
          background: overOneFrame ? '#FEF2F2' : '#F0FDF4',
          border: `1px solid ${overOneFrame ? '#FCA5A5' : '#86EFAC'}`,
          fontSize: 13,
        }}
      >
        <span>p50: <b>{stats.p50.toFixed(1)}ms</b></span>
        <span>p95: <b style={{ color: overOneFrame ? '#B91C1C' : '#047857' }}>{stats.p95.toFixed(1)}ms</b></span>
        <span>p99: <b>{stats.p99.toFixed(1)}ms</b></span>
        <span>max: <b>{stats.max.toFixed(1)}ms</b></span>
        <span>~fps: <b>{stats.fps.toFixed(0)}</b></span>
        <span style={{ marginLeft: 'auto', opacity: 0.7 }}>
          {overOneFrame ? '⚠ p95 over 16.7ms budget' : '✓ within frame budget'}
        </span>
      </div>

      <AgentStat
        ref={ref}
        agents={agents}
        metric={cfg.metric}
        windowSeconds={cfg.windowSeconds}
        simulateData={false}
        height={480}
      />

      <p style={{ fontSize: 12, opacity: 0.6, marginTop: 12 }}>
        The on-screen stats are a convenience sampler. For the authoritative
        verdict, record a Chrome DevTools Performance trace for ~60s and inspect
        frame times, long tasks, and GC. The RAF loop should never restart
        (no repeated &quot;Animation Frame Fired&quot; gaps tied to React re-mounts).
      </p>
    </div>
  );
}

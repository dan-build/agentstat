// dev/BreakIt.tsx
//
// Worst-case scenes for reviewing the UI under hostile data and layouts.
// Open /?break=<scene>&theme=light|dark, where <scene> is one of:
//   many    — 24 agents (legend and panel overflow)
//   long    — very long agent names, large and tiny values
//   narrow  — a 360 px wide container (phone layout)
//   short   — a 260 px tall chart (panel vs. plot area)
//   rtl     — right-to-left document with mixed-direction names
//   empty   — no agents; and all agents hidden
//   menu    — 24 agents with the overflow menu opened
//   dense   — 50 Hz spiky data in a 60 s window (exercises downsampling)
import { useEffect, useMemo, useRef } from 'react';
import AgentStat, { createAgent, type Agent, type AgentStatRef } from '../src/AgentStat';
import { mulberry32 } from '../src/simulator';

type Scene = 'many' | 'long' | 'narrow' | 'short' | 'rtl' | 'empty' | 'menu' | 'dense';

const NAMES_LONG = [
  'Retrieval-Augmented Research Coordinator (EU West, shard 7)',
  'Planner',
  'A',
  'tool-executor-with-an-extremely-long-hyphenated-identifier-0f3a9c',
];
const NAMES_RTL = ['مخطط المهام', 'Researcher', 'עוזר כתיבה', 'Coder 2'];

function rosterFor(scene: Scene): Agent[] {
  if (scene === 'empty') return [];
  if (scene === 'many' || scene === 'menu')
    return Array.from({ length: 24 }, (_, i) => createAgent(`a${i}`, `Agent ${i + 1}`));
  if (scene === 'long') return NAMES_LONG.map((n, i) => createAgent(`l${i}`, n));
  if (scene === 'rtl') return NAMES_RTL.map((n, i) => createAgent(`r${i}`, n));
  return ['Planner', 'Researcher', 'Coder'].map((n, i) => createAgent(`n${i}`, n));
}

export default function BreakIt({ scene, theme }: { scene: Scene; theme: 'light' | 'dark' }) {
  const ref = useRef<AgentStatRef>(null);
  const agents = useMemo(() => rosterFor(scene), [scene]);

  useEffect(() => {
    const rng = mulberry32(3);
    let t = 0;
    const dense = scene === 'dense';
    const id = setInterval(() => {
      t += dense ? 0.02 : 0.1;
      agents.forEach((a, i) => {
        // Long scene: one agent with a huge rate, one with a tiny one.
        const big = scene === 'long' && i === 0 ? 4800 : 0;
        const tiny = scene === 'long' && i === 2 ? -11.5 : 0;
        // Dense scene: rare one-sample spikes that downsampling must keep.
        const spike = dense && rng() < 0.002 ? 25 : 0;
        const rate = Math.max(0.01, big + 12 + tiny + spike + 6 * Math.sin(t / 2 + i) + (rng() - 0.5) * 2);
        ref.current?.updateAgent(a.id, {
          tokensRate: rate,
          progress: Math.min(100, t * (2 + i * 0.3)),
          status: i % 5 === 3 ? 'thinking' : i % 7 === 6 ? 'stuck' : 'active',
        });
      });
    }, dense ? 20 : 100);
    // Open the overflow menu for review, the way a user would.
    const open =
      scene === 'menu'
        ? setTimeout(() => document.querySelector<HTMLButtonElement>('.agentstat-more-btn')?.click(), 2000)
        : undefined;
    return () => {
      clearInterval(id);
      clearTimeout(open);
    };
  }, [agents, scene]);

  const width = scene === 'narrow' ? 360 : undefined;
  const height = scene === 'short' ? 260 : scene === 'narrow' ? 420 : 560;
  return (
    <div
      dir={scene === 'rtl' ? 'rtl' : undefined}
      lang={scene === 'rtl' ? 'ar' : undefined}
      style={{
        minHeight: '100vh',
        padding: 24,
        boxSizing: 'border-box',
        background: theme === 'dark' ? '#060607' : '#f4f4f2',
      }}
    >
      <div style={{ width, maxWidth: '100%' }}>
        <AgentStat
          ref={ref}
          agents={agents}
          theme={theme}
          metric="tokens"
          anomalyDetection
          height={height}
          windowSeconds={scene === 'dense' ? 60 : undefined}
        />
      </div>
      {scene === 'empty' && (
        <div style={{ marginTop: 24, width: 640 }}>
          <AgentStat
            agents={[createAgent('h1', 'Hidden 1'), { ...createAgent('h2', 'Hidden 2'), visible: false }].map((a) => ({
              ...a,
              visible: false,
            }))}
            theme={theme}
            height={240}
          />
        </div>
      )}
    </div>
  );
}

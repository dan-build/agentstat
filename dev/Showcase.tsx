// dev/Showcase.tsx
//
// Deterministic scene for the README screenshots (`npm run screenshots`).
// Open http://localhost:5173/?shot=light (or dark) to preview it.
//
// The data is scripted, not simulated, so every capture tells the same story:
// a planner alternating between thinking and bursts of output, a researcher
// streaming steadily, and a coder that stops producing while still claiming
// to be active — which the stall detector flags.
import { useEffect, useMemo, useRef } from 'react';
import AgentStat, { createAgent, type AgentStatRef } from '../src/AgentStat';
import { mulberry32 } from '../src/simulator';

const TICK_MS = 100;
const CODER_STALLS_AT_S = 25;
const INSPECT_AT_S = 38.5;

export default function Showcase({ theme }: { theme: 'light' | 'dark' }) {
  const ref = useRef<AgentStatRef>(null);
  const agents = useMemo(
    () => [
      { ...createAgent('planner', 'Planner'), config: { expectedTokensPerSec: [2, 20] as [number, number] } },
      { ...createAgent('researcher', 'Researcher'), config: { expectedTokensPerSec: [15, 32] as [number, number] } },
      { ...createAgent('coder', 'Coder'), config: { expectedTokensPerSec: [8, 20] as [number, number] } },
    ],
    []
  );

  useEffect(() => {
    const rng = mulberry32(11);
    const noise = (amp: number) => (rng() * 2 - 1) * amp;
    // Real token streams wander rather than jitter: low-pass the noise.
    const wander = { planner: 0, researcher: 0, coder: 0 };
    const drift = (k: keyof typeof wander, amp: number) =>
      (wander[k] = wander[k] * 0.82 + noise(amp));
    let t = 0;
    let planner = 2;
    let coder = 12;
    const progress = { planner: 4, researcher: 10, coder: 6 };

    const id = setInterval(() => {
      t += TICK_MS / 1000;
      const api = ref.current;
      if (!api) return;

      // Planner: alternating 5 s phases of bursts and thinking, offset so the
      // capture (~40 s) lands in the middle of a steady burst, where the
      // panel's 500 ms refresh matches the line.
      const plannerActive = Math.floor((t + 4) / 5) % 2 === 0;
      planner +=
        ((plannerActive ? 15 : 2.2) - planner) * 0.18 + drift('planner', plannerActive ? 0.35 : 0.12);
      progress.planner = Math.min(100, progress.planner + (plannerActive ? 0.22 : 0.04));
      api.updateAgent('planner', {
        tokensRate: Math.max(0, planner),
        progress: progress.planner,
        status: plannerActive ? 'active' : 'thinking',
      });

      // Researcher: steady stream with a slow swell.
      const researcher = 23 + 4.5 * Math.sin(t / 3.2) + drift('researcher', 0.55);
      progress.researcher = Math.min(100, progress.researcher + 0.2);
      api.updateAgent('researcher', {
        tokensRate: researcher,
        progress: progress.researcher,
        status: 'active',
        latencyMs: 600 + 80 * Math.sin(t / 5),
      });

      // Coder: healthy, then silent while still reporting `active`.
      if (t < CODER_STALLS_AT_S) {
        coder += (11 + 2.5 * Math.sin(t / 2.2) - coder) * 0.3 + drift('coder', 0.45);
        progress.coder = Math.min(100, progress.coder + 0.12);
      } else {
        coder *= 0.55;
      }
      api.updateAgent('coder', {
        tokensRate: coder < 0.05 ? 0 : coder,
        progress: progress.coder,
        status: 'active',
      });
    }, TICK_MS);

    // Pin an inspection tooltip on the planner a few seconds back, using the
    // same keyboard path a user would.
    const inspect = setTimeout(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('.agentstat-canvas');
      if (!canvas) return;
      canvas.focus({ preventScroll: true });
      const key = (k: string) =>
        canvas.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      key('End');
      for (let i = 0; i < 48; i++) key('ArrowLeft');
    }, INSPECT_AT_S * 1000);

    return () => {
      clearInterval(id);
      clearTimeout(inspect);
    };
  }, []);

  const bg = theme === 'dark' ? '#060607' : '#f4f4f2';
  return (
    <div
      className="shot"
      style={{ minHeight: '100vh', background: bg, padding: 40, boxSizing: 'border-box' }}
    >
      {/* The staged focus comes from a scripted keypress; hide its ring. */}
      <style>{'.shot .agentstat-canvas:focus-visible{outline:none}'}</style>
      <AgentStat
        ref={ref}
        agents={agents}
        theme={theme}
        metric="tokens"
        windowSeconds={30}
        tokenAxisMax={40}
        anomalyDetection
        height={640}
      />
    </div>
  );
}

// Smoke test of the *built* package (dist/), which tests of src/ can't cover:
// build-only transforms such as property mangling. Skipped until `npm run
// build` has produced dist/; `npm run check` runs it after the build.
import { describe, it, expect, vi } from 'vitest';
import { render, act, screen, fireEvent } from '@testing-library/react';
import { createRef } from 'react';

type Pkg = typeof import('../src/index');
const DIST = '../dist/index.js';
const pkg: Pkg | null = await import(/* @vite-ignore */ DIST).catch(() => null);

describe.skipIf(!pkg)('built package', () => {
  it('renders, ingests, scores, detects, toggles and pauses', async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400,
      toJSON: () => ({}),
    } as DOMRect);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { AgentStat, createAgent } = pkg!;
    const ref = createRef<import('../src/index').AgentStatRef>();
    const onAnomaly = vi.fn();
    render(
      <AgentStat
        ref={ref}
        agents={[createAgent('a', 'Planner'), createAgent('b', 'Coder')]}
        metric="both"
        windowSeconds={10}
        anomalyDetection
        anomalyConfig={{ stallDurationMs: 1000 }}
        onAnomaly={onAnomaly}
      />
    );
    for (let i = 0; i < 30; i++) {
      act(() => {
        ref.current?.updateAgent('a', { tokensRate: 15, progress: i, status: 'active', latencyMs: 400 + i * 20 });
        ref.current?.updateAgent('b', 0, i, 'active');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(ref.current?.getHealth('a')?.latencyTrend).toBe('degrading');
    expect(ref.current?.getAnomalies('b').some((x: { kind: string }) => x.kind === 'stall')).toBe(true);
    expect(onAnomaly).toHaveBeenCalled();
    expect(ref.current?.getLiveMetrics('a')?.tokensRate).toBeCloseTo(15, 0);
    fireEvent.click(screen.getByRole('button', { name: 'Coder' }));
    expect(screen.getByRole('button', { name: 'Coder' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(errors).not.toHaveBeenCalled();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
});

// Paths in variables: the type checker mustn't need dist/ (CI typechecks first).
const AI_SDK = '../dist/ai-sdk.js';
const AG_UI = '../dist/ag-ui.js';
const LANGCHAIN = '../dist/langchain.js';
const SSE = '../dist/sse.js';
const aiSdk: typeof import('../src/ai-sdk') | null = await import(/* @vite-ignore */ AI_SDK).catch(() => null);
const agUi: typeof import('../src/ag-ui') | null = await import(/* @vite-ignore */ AG_UI).catch(() => null);
const langchain: typeof import('../src/langchain') | null = await import(/* @vite-ignore */ LANGCHAIN).catch(() => null);
const sse: typeof import('../src/sse') | null = await import(/* @vite-ignore */ SSE).catch(() => null);

describe.skipIf(!sse || !pkg)('built SSE transport', () => {
  it('serves a stream as server-sent events', async () => {
    const stream = pkg!.createAgentStream();
    stream.push('a', { type: 'start' });
    const res = await sse!.createSseHandler(stream)(new Request('http://x/'));
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes('data: ')) text += new TextDecoder().decode((await reader.read()).value);
    expect(res.headers.get('content-type')).toMatch(/event-stream/);
    expect(text).toMatch(/id: \w+:1\ndata: \{"m":/);
    await reader.cancel();
  });
});

describe.skipIf(!aiSdk || !agUi || !langchain)('built adapters', () => {
  it('map parts and events', () => {
    const got: string[] = [];
    const sink = { push: (_id: string, e: { type: string }) => got.push(e.type) };
    const tap = aiSdk!.createAiSdkTap(sink, 'a');
    tap({ type: 'start-step' });
    tap({ type: 'tool-call', toolCallId: 'c', toolName: 't' });
    tap({ type: 'tool-result', toolCallId: 'c' });
    const ag = agUi!.createAgUiTap(sink, 'b');
    ag({ type: 'RUN_STARTED' });
    ag({ type: 'RUN_FINISHED' });
    const lc = langchain!.createLangChainCallbacks(sink, { agentId: 'c' });
    lc.handleToolStart({ id: ['x', 'Search'] }, '', 'r1');
    lc.handleToolEnd(null, 'r1');
    expect(got).toEqual(['start', 'tool-start', 'tool-end', 'start', 'finish', 'tool-start', 'tool-end', 'finish']);
  });
});

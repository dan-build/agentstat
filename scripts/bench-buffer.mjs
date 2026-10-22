// Benchmarks the sample buffer at realistic and heavy loads.
//
//   node --expose-gc scripts/bench-buffer.mjs
//
// Scenario: N agents × 2 series reporting at 20 Hz into a 15-minute window,
// drawn on a ~1000 px wide chart (500 target points). Reports push cost,
// windowed() cost on a cache miss, and retained heap.
import { build } from 'esbuild';

const out = await build({
  entryPoints: ['src/timeseries.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
});
const mod = await import(
  'data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64')
);
const { TimeSeriesBuffer } = mod;

const HZ = 20;
const WINDOW_S = 900;
const TARGET = 500;
const gc = globalThis.gc ?? (() => {});
// JS heap plus typed-array backing stores (which live outside the heap).
const heap = () => {
  gc();
  gc();
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
};
const ms = (fn, reps) => {
  const t0 = performance.now();
  for (let i = 0; i < reps; i++) fn(i);
  return (performance.now() - t0) / reps;
};

for (const agents of [10, 50]) {
  const before = heap();
  const bufs = [];
  for (let a = 0; a < agents * 2; a++) bufs.push(new TimeSeriesBuffer());
  const samples = WINDOW_S * HZ * 1.5; // retention is 1.5× the window
  let t = 0;
  const pushOne = (i) => {
    t = i * (1000 / HZ);
    for (const b of bufs) {
      b.push(t, 10 + Math.sin(i / 50) * 5 + ((i * 7919) % 13) / 13);
      b.evictOlderThan(t, WINDOW_S * 1500);
    }
  };
  const pushMs = ms(pushOne, samples);
  const retained = heap() - before;
  // Cache miss: a new `now` bucket every call (worst case: every series at once).
  const missMs = ms((i) => {
    for (const b of bufs) b.windowed(t + i * 1e6, WINDOW_S * 1e6, TARGET, WINDOW_S * 5);
  }, 20);
  // Steady state: 60 fps for 10 s of wall time after a warm-up frame;
  // report the slowest frame.
  for (const b of bufs) b.windowed(t, WINDOW_S * 1000, TARGET, WINDOW_S * 5);
  let worst = 0;
  for (let f = 1; f <= 600; f++) {
    const now = t + f * 16.7;
    const t0 = performance.now();
    for (const b of bufs) b.windowed(now, WINDOW_S * 1000, TARGET, WINDOW_S * 5);
    worst = Math.max(worst, performance.now() - t0);
  }
  const hitMs = ms(() => {
    for (const b of bufs) b.windowed(t, WINDOW_S * 1000, TARGET, WINDOW_S * 5);
  }, 200);
  console.log(
    `${agents} agents: push ${(pushMs * 1000).toFixed(1)} µs/tick (all series) · ` +
      `all-miss ${missMs.toFixed(2)} ms · worst frame over 10 s ${worst.toFixed(2)} ms · hit ${(hitMs * 1000).toFixed(1)} µs · ` +
      `retained ${(retained / 1048576).toFixed(1)} MB (${bufs[0].length} samples/series)`
  );
}

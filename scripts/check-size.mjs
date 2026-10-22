// Size and packaging guardrails, run after `npm run build`:
//   - the bundle (as a consumer ships it: minified + gzip) stays within budget;
//   - the client directive survived bundling (Next.js App Router needs it);
//   - tree-shaking works: importing only the detector doesn't pull in the
//     React component.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Raise deliberately, with a reason in the commit. History (consumer-bundled
// min+gzip): 0.4.1 17.3 KB → store/renderer split 17.8 KB → typed-array ring
// buffer + M4 downsampling 18.0 KB (buffer recompute 4–6× faster, 3.4× less
// memory; see scripts/bench-buffer.mjs) → detectors v2 19.6 KB (false alarms
// on all three eval sets 49 → 2.9 per agent-hour; see scripts/eval-detectors.mjs)
// → event ingest 21.2 KB (`push` derives rate/TTFT/status from raw stream
// events, plus the `waiting` status: event-driven agents at ~2 false alarms
// per agent-hour on a fresh holdout, without hand-computed rates) → event
// streams 22.4 KB (`createAgentStream` + `source`: agents and history arrive
// without wiring; the base for the AI SDK / AG-UI adapters).
const BUDGETS = { 'dist/index.js': 22_500, 'dist/index.cjs': 23_000 };
// The standalone detectors (detectAnomalies) on their own.
const TREESHAKE_BUDGET = 2_500;

let failed = false;
const report = (ok, msg) => {
  failed ||= !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
};

// Measured the way consumers ship it: bundled and minified with React
// external, then gzipped. (Minifying the file on its own overstates the size:
// it can't shorten top-level names or merge imports.)
for (const [file, budget] of Object.entries(BUDGETS)) {
  const src = readFileSync(file, 'utf8');
  const out = await build({
    entryPoints: [file],
    bundle: true,
    minify: true,
    write: false,
    format: file.endsWith('.cjs') ? 'cjs' : 'esm',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const gz = gzipSync(out.outputFiles[0].contents).length;
  report(gz <= budget, `${file}: ${gz} B bundled min+gzip (budget ${budget} B)`);
  report(/^['"]use client['"]/.test(src), `${file}: starts with 'use client'`);
}

// Adapters: small, and free of the client directive so they run on servers.
// langchain 1.5 → 2.2 KB: per-agent run counting, per-invocation roots and
// handover (concurrent runs, supervisors, parallel agents, failed and stopped
// runs end correctly — verified live against LangGraph).
const ADAPTER_BUDGETS = { 'dist/ai-sdk.js': 2_000, 'dist/ag-ui.js': 2_000, 'dist/langchain.js': 2_200 };
for (const [file, ADAPTER_BUDGET] of Object.entries(ADAPTER_BUDGETS)) {
  const out = await build({ entryPoints: [file], bundle: true, minify: true, write: false, format: 'esm', logLevel: 'silent' });
  const gz = gzipSync(out.outputFiles[0].contents).length;
  report(gz <= ADAPTER_BUDGET, `${file}: ${gz} B bundled min+gzip (budget ${ADAPTER_BUDGET} B)`);
  report(!/use client/.test(readFileSync(file, 'utf8')), `${file}: no 'use client' (server-safe)`);
}

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const out = await build({
  stdin: { contents: `export { detectAnomalies } from ${JSON.stringify(entry)};`, resolveDir: '.' },
  bundle: true,
  minify: true,
  write: false,
  format: 'esm',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});
const shaken = gzipSync(out.outputFiles[0].contents).length;
report(shaken <= TREESHAKE_BUDGET, `tree-shaken detectAnomalies import: ${shaken} B (budget ${TREESHAKE_BUDGET} B)`);

// Internal members are renamed at build time (mangleProps /^_/). A public
// name starting with "_" would be renamed in the code but not in the types.
const dts = ['dist/index.d.ts', 'dist/ai-sdk.d.ts', 'dist/ag-ui.d.ts', 'dist/langchain.d.ts'].map((f) => readFileSync(f, 'utf8')).join('\n');
const underscored = dts.match(/\b_[A-Za-z]\w*/g) ?? [];
report(underscored.length === 0, `dist/*.d.ts expose no _-prefixed names${underscored.length ? `: ${[...new Set(underscored)].join(', ')}` : ''}`);

process.exit(failed ? 1 : 0);

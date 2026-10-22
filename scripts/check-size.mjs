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
// buffer + M4 downsampling 18.0 KB (10–30× faster frames, 3.4× less memory).
const BUDGETS = { 'dist/index.js': 18_500, 'dist/index.cjs': 19_000 };
const TREESHAKE_BUDGET = 2_000;

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
const dts = readFileSync('dist/index.d.ts', 'utf8');
const underscored = dts.match(/\b_[A-Za-z]\w*/g) ?? [];
report(underscored.length === 0, `dist/index.d.ts exposes no _-prefixed names${underscored.length ? `: ${[...new Set(underscored)].join(', ')}` : ''}`);

process.exit(failed ? 1 : 0);

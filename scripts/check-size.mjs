// Size and packaging guardrails, run after `npm run build`:
//   - the bundle (as a consumer ships it: minified + gzip) stays within budget;
//   - the client directive survived bundling (Next.js App Router needs it);
//   - tree-shaking works: importing only the detector doesn't pull in the
//     React component.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';

// Raise deliberately, with a reason in the commit. History: 9 KB (0.3) →
// 17 KB (0.4: accessibility, theming) → 18 KB (0.4.1: legend overflow menu,
// adaptive panel).
const BUDGETS = { 'dist/index.js': 18_000, 'dist/index.cjs': 19_000 };
const TREESHAKE_BUDGET = 2_000;

let failed = false;
const report = (ok, msg) => {
  failed ||= !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
};

for (const [file, budget] of Object.entries(BUDGETS)) {
  const src = readFileSync(file, 'utf8');
  const { code } = await transform(src, { minify: true, loader: 'js' });
  const gz = gzipSync(code).length;
  report(gz <= budget, `${file}: ${gz} B min+gzip (budget ${budget} B)`);
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

process.exit(failed ? 1 : 0);

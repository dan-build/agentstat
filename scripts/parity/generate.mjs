// Writes the parity traces the Rust core (desktop/core) is tested against.
//
//   node scripts/parity/generate.mjs [outDir]   # default: fixtures/parity
//
// Bundles scripts/parity/record.ts with esbuild so traces always come from
// the TypeScript code in this checkout. Generated, not committed.
/* global Buffer, URL, console, process */
import { build } from 'esbuild';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = await build({
  entryPoints: [fileURLToPath(new URL('./record.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
});
const { recordAll } = await import(
  'data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64')
);

const dir = process.argv[2] ?? fileURLToPath(new URL('../../fixtures/parity', import.meta.url));
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
let bytes = 0;
const traces = recordAll();
for (const t of traces) {
  const json = JSON.stringify(t);
  bytes += json.length;
  writeFileSync(join(dir, `${t.set}--${t.name}.json`), json);
}
console.log(`${traces.length} traces, ${(bytes / 1e6).toFixed(1)} MB → ${dir}`);

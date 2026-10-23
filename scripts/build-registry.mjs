// Builds the shadcn registry (registry.json + registry/**) into public/r/:
// one registry-item JSON per item, with the file contents inlined, plus the
// index. `--check` fails instead of writing if public/r is out of date (CI).
//
//   npx shadcn@latest add https://raw.githubusercontent.com/dan-build/agentstat/main/public/r/agent-roster.json
/* global console, process */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const check = process.argv.includes('--check');
// Where the items are served (their cross-references point there). Override
// with REGISTRY_BASE to try them from a local server before they're on main.
const base = process.env.REGISTRY_BASE ?? 'https://raw.githubusercontent.com/dan-build/agentstat/main/public/r';
const registry = JSON.parse(readFileSync('registry.json', 'utf8').replaceAll('{{base}}', base));
const out = new Map();
for (const item of registry.items) {
  // LF whatever the checkout (Windows autocrlf), so the output is the same.
  const files = item.files.map((f) => ({ ...f, content: readFileSync(f.path, 'utf8').replace(/\r\n/g, '\n') }));
  out.set(
    `public/r/${item.name}.json`,
    JSON.stringify({ $schema: 'https://ui.shadcn.com/schema/registry-item.json', ...item, files }, null, 2) + '\n'
  );
}
out.set('public/r/registry.json', JSON.stringify(registry, null, 2) + '\n');

let stale = 0;
for (const [path, text] of out) {
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (current === text) continue;
  stale++;
  if (check) console.log(`FAIL ${path} is out of date — run npm run build:registry`);
  else {
    mkdirSync('public/r', { recursive: true });
    writeFileSync(path, text);
    console.log(`wrote ${path}`);
  }
}
if (check) console.log(stale ? '' : `ok   registry: ${out.size} files up to date`);
process.exit(check && stale ? 1 : 0);

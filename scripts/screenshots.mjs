// Regenerates the still screenshots (docs/screenshot-{light,dark}.png: the
// docs site and the repository's social preview) from the deterministic scene
// in dev/Showcase.tsx. The README's animated demo: scripts/demo-animation.mjs.
//
//   npm run screenshots
//
// Needs a Chromium build (see scripts/lib/chrome.mjs).
import { spawn } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { findChrome } from './lib/chrome.mjs';

const OUT_DIR = resolve('docs');
const WIDTH = 1280;
const HEIGHT = 720;
const SCALE = 2;
// Virtual time the scene runs before capture (see dev/Showcase.tsx).
const BUDGET_MS = 40_000;

function capture(chrome, url, file) {
  return new Promise((done, fail) => {
    const args = [
      '--headless',
      '--hide-scrollbars',
      '--disable-gpu',
      '--force-color-profile=srgb',
      // Headless virtual time runs animation frames less often than data
      // ticks; reduced motion makes values snap to their samples instead of
      // easing, so the capture shows exactly the data.
      '--force-prefers-reduced-motion',
      `--window-size=${WIDTH},${HEIGHT}`,
      `--force-device-scale-factor=${SCALE}`,
      `--virtual-time-budget=${BUDGET_MS}`,
      `--screenshot=${file}`,
      url,
    ];
    const p = spawn(chrome, args, { stdio: 'ignore' });
    p.on('error', fail);
    p.on('exit', (code) => (code === 0 ? done() : fail(new Error(`chrome exited with ${code}`))));
  });
}

const server = await createServer({ server: { port: 5198, strictPort: true, open: false }, logLevel: 'error' });
await server.listen();
try {
  const chrome = findChrome();
  mkdirSync(OUT_DIR, { recursive: true });
  for (const theme of ['light', 'dark']) {
    const file = join(OUT_DIR, `screenshot-${theme}.png`);
    await capture(chrome, `http://localhost:5198/?shot=${theme}`, file);
    console.log(`wrote ${file} (${Math.round(statSync(file).size / 1024)} KB)`);
  }
} finally {
  await server.close();
}

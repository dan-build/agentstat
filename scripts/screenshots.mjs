// Regenerates the README screenshots (docs/screenshot-{light,dark}.png) from
// the deterministic scene in dev/Showcase.tsx.
//
//   npm run screenshots
//
// Needs a Chromium build. Set CHROME_PATH, or have Google Chrome installed, or
// a Playwright Chromium in its default cache.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';

const OUT_DIR = resolve('docs');
const WIDTH = 1280;
const HEIGHT = 720;
const SCALE = 2;
// Virtual time the scene runs before capture (see dev/Showcase.tsx).
const BUDGET_MS = 40_000;

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  const pw = [join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/ms-playwright')];
  for (const dir of pw) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).filter((d) => d.startsWith('chromium_headless_shell')).sort().reverse()) {
      const base = join(dir, entry);
      for (const sub of readdirSync(base)) {
        const bin = join(base, sub, 'headless_shell');
        if (existsSync(bin)) candidates.unshift(bin);
      }
    }
  }
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error('No Chromium found. Set CHROME_PATH.');
  return found;
}

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

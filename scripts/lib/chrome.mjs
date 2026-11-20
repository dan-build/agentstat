// Finds a Chromium for the headless captures (README screenshots and demo).
// Set CHROME_PATH, or have Google Chrome installed, or a Playwright Chromium
// in its default cache.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function findChrome() {
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

// Renders the README's animated demo (docs/demo-{light,dark}.png): the
// scripted scene in dev/Showcase.tsx, from shortly before the coder agent
// goes quiet until the stall marker is up, as an animated PNG.
//
//   npm run demo
//
// Each frame is its own headless capture at an exact virtual time, so every
// run shows the same data and markers (anti-aliasing can differ slightly). Animated PNG rather than GIF: full color
// (no banding in the gradients), shown by GitHub and npm alike, and assembled
// here from the captured PNGs without any image library.
// Needs a Chromium build (see scripts/lib/chrome.mjs).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { createServer } from 'vite';
import { findChrome } from './lib/chrome.mjs';

const WIDTH = 1000;
const HEIGHT = 500;
// Scene seconds: the coder has been quiet since 25 s (in view, still
// "active") and the stall marker goes up at ~38 s. Quarter-second steps
// played at 125 ms each: twice real time, smooth.
const FROM_S = 33;
const TO_S = 42;
const STEP_S = 0.25;
// Playback, with a pause on the last frame to read the marker.
const FRAME_MS = 125;
const HOLD_MS = 3000;
const PARALLEL = 3;
const PORT = 5197;
// A capture that hangs is killed rather than blocking the run.
const CAPTURE_TIMEOUT_MS = 60_000;

function capture(chrome, url, file, budgetMs) {
  return new Promise((done, fail) => {
    const args = [
      '--headless',
      '--hide-scrollbars',
      '--disable-gpu',
      '--force-color-profile=srgb',
      // Values snap to their samples instead of easing (see screenshots.mjs).
      '--force-prefers-reduced-motion',
      `--window-size=${WIDTH},${HEIGHT}`,
      '--force-device-scale-factor=1',
      `--virtual-time-budget=${budgetMs}`,
      `--screenshot=${file}`,
      url,
    ];
    const p = spawn(chrome, args, { stdio: 'ignore' });
    const timer = setTimeout(() => p.kill('SIGKILL'), CAPTURE_TIMEOUT_MS);
    p.on('error', (e) => {
      clearTimeout(timer);
      fail(e);
    });
    p.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) done();
      else fail(new Error(signal ? `chrome killed (${signal}) after ${CAPTURE_TIMEOUT_MS} ms` : `chrome exited with ${code}`));
    });
  });
}

/** The chunks of a PNG file, in order. */
function chunks(buf) {
  const out = [];
  for (let i = 8; i < buf.length; ) {
    const len = buf.readUInt32BE(i);
    out.push({ type: buf.toString('latin1', i + 4, i + 8), data: buf.subarray(i + 8, i + 8 + len) });
    i += 12 + len;
  }
  return out;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0);
  return Buffer.concat([head, data, crc]);
}

/** Frames (PNG files of one size and format) → one animated PNG, looping. */
function apng(files, delays) {
  const parsed = files.map((f) => chunks(readFileSync(f)));
  const ihdr = parsed[0].find((c) => c.type === 'IHDR').data;
  for (const p of parsed) {
    if (!p.find((c) => c.type === 'IHDR').data.equals(ihdr)) throw new Error('frames differ in size or format');
  }
  // Color chunks (sRGB, gAMA, …) from the first frame, before the image data.
  const firstIdat = parsed[0].findIndex((c) => c.type === 'IDAT');
  const ancillary = parsed[0].slice(1, firstIdat).filter((c) => !['acTL', 'fcTL'].includes(c.type));
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(files.length, 0); // frames
  actl.writeUInt32BE(0, 4); // loop forever
  const out = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('acTL', actl)];
  out.push(...ancillary.map((c) => chunk(c.type, c.data)));
  let seq = 0;
  parsed.forEach((p, i) => {
    const fctl = Buffer.alloc(26);
    fctl.writeUInt32BE(seq++, 0);
    fctl.writeUInt32BE(ihdr.readUInt32BE(0), 4);
    fctl.writeUInt32BE(ihdr.readUInt32BE(4), 8);
    // x, y offsets 0; delay as delays[i]/1000 s; dispose none; blend source.
    fctl.writeUInt16BE(delays[i], 20);
    fctl.writeUInt16BE(1000, 22);
    out.push(chunk('fcTL', fctl));
    // The browser compresses for speed; recompress the image data harder.
    const raw = inflateSync(Buffer.concat(p.filter((c) => c.type === 'IDAT').map((c) => c.data)));
    const data = deflateSync(raw, { level: 9, memLevel: 9 });
    if (i === 0) {
      out.push(chunk('IDAT', data));
    } else {
      const head = Buffer.alloc(4);
      head.writeUInt32BE(seq++);
      out.push(chunk('fdAT', Buffer.concat([head, data])));
    }
  });
  out.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(out);
}

const server = await createServer({ server: { port: PORT, strictPort: true, open: false }, logLevel: 'error' });
await server.listen();
const work = mkdtempSync(join(tmpdir(), 'agentstat-demo-'));
try {
  const chrome = findChrome();
  const times = [];
  for (let t = FROM_S; t <= TO_S + 1e-9; t += STEP_S) times.push(Math.round(t * 1000));
  // Warm the dev server's module cache, so the first frame's load doesn't
  // differ from the rest.
  await capture(chrome, `http://localhost:${PORT}/?shot=dark&anim`, join(work, 'warm.png'), 1000);
  for (const theme of ['light', 'dark']) {
    const files = times.map((ms) => join(work, `${theme}-${ms}.png`));
    let next = 0;
    let failed = false;
    // One failed capture stops the other workers (no captures into a
    // folder that is being removed).
    const worker = async () => {
      while (!failed && next < times.length) {
        const i = next++;
        try {
          await capture(chrome, `http://localhost:${PORT}/?shot=${theme}&anim`, files[i], times[i]);
        } catch (e) {
          failed = true;
          throw e;
        }
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    const delays = times.map((_, i) => (i === times.length - 1 ? HOLD_MS : FRAME_MS));
    const file = resolve('docs', `demo-${theme}.png`);
    writeFileSync(file, apng(files, delays));
    console.log(`wrote ${file} (${times.length} frames, ${Math.round(statSync(file).size / 1024)} KB)`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
  await server.close();
}

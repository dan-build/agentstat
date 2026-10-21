// src/color.ts
//
// Color handling for the canvas renderer. Canvas gradients need explicit alpha
// variants of each agent color, and the old approach (string-appending a hex
// alpha to `agent.color`) threw inside the render loop for anything that wasn't
// a 6-digit hex — `'red'`, `#f00`, `rgb()`, `var(--brand)` — which killed the
// animation permanently. Everything here parses once, caches, and degrades to a
// safe fallback instead of throwing.

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

const cache = /*#__PURE__*/ new Map<string, RGBA | null>();

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function parseHex(s: string): RGBA | null {
  const h = s.slice(1);
  if (!/^[0-9a-f]+$/i.test(h)) return null;
  if (h.length === 3 || h.length === 4) {
    const [r, g, b, a = 'f'] = h.split('');
    return {
      r: parseInt(r + r, 16),
      g: parseInt(g + g, 16),
      b: parseInt(b + b, 16),
      a: parseInt(a + a, 16) / 255,
    };
  }
  if (h.length === 6 || h.length === 8) {
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  return null;
}

function parseRgbFn(s: string): RGBA | null {
  const m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (!m) return null;
  // Accept both `rgb(1, 2, 3, 0.5)` and `rgb(1 2 3 / 50%)`.
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const channel = (p: string) =>
    p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p);
  const alpha = (p: string | undefined) =>
    p === undefined ? 1 : p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p);
  const r = channel(parts[0]);
  const g = channel(parts[1]);
  const b = channel(parts[2]);
  const a = alpha(parts[3]);
  if (![r, g, b, a].every(Number.isFinite)) return null;
  return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a: clamp01(a) };
}

// Lazily created 1×1 canvas used to let the browser normalize any CSS color
// (named colors, hsl(), oklch(), color()) to a form we can parse.
let probe: CanvasRenderingContext2D | null | undefined;
function probeContext(): CanvasRenderingContext2D | null {
  if (probe !== undefined) return probe;
  probe = null;
  if (typeof document === 'undefined') return probe;
  try {
    probe = document.createElement('canvas').getContext('2d');
  } catch {
    probe = null;
  }
  return probe;
}

function parseViaCanvas(s: string): RGBA | null {
  const ctx = probeContext();
  if (!ctx) return null;
  // Assigning an invalid color leaves fillStyle unchanged, so use a sentinel
  // to tell "parsed as black" apart from "rejected".
  ctx.fillStyle = '#010203';
  ctx.fillStyle = s;
  const out = String(ctx.fillStyle);
  if (out === '#010203' && s.toLowerCase() !== '#010203') return null;
  if (out.startsWith('#')) return parseHex(out);
  return parseRgbFn(out);
}

/**
 * Parse a CSS color to RGBA. Returns null when the string isn't a color the
 * environment understands. `var(--x)` must be resolved by the caller first
 * (see resolveCssVar) because it depends on the element it's read from.
 */
export function parseColor(input: string | undefined | null): RGBA | null {
  if (!input) return null;
  const s = input.trim();
  if (cache.has(s)) return cache.get(s)!;
  let out: RGBA | null = null;
  if (s.startsWith('#')) out = parseHex(s);
  else if (/^rgba?\(/i.test(s)) out = parseRgbFn(s);
  else if (s.toLowerCase() === 'transparent') out = { r: 0, g: 0, b: 0, a: 0 };
  if (!out) out = parseViaCanvas(s);
  if (cache.size > 512) cache.clear();
  cache.set(s, out);
  return out;
}

/** `rgba(r, g, b, a)` string for the color with its alpha multiplied by `alpha`. */
export function withAlpha(color: RGBA, alpha: number): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${clamp01(color.a * alpha)})`;
}

/** WCAG relative luminance in [0, 1]. */
export function luminance(c: RGBA): number {
  const lin = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG contrast ratio between two opaque colors (1–21). */
export function contrastRatio(a: RGBA, b: RGBA): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** True when a background reads as dark. Unparseable input counts as light. */
export function isDarkColor(input: string | undefined | null): boolean {
  const c = parseColor(input);
  if (!c) return false;
  return luminance(c) < 0.18;
}

/**
 * Resolve `var(--name)` / `var(--name, fallback)` against an element's
 * computed style. Non-var input is returned unchanged.
 */
export function resolveCssVar(value: string, el: Element | null): string {
  const m = /^var\(\s*(--[^,\s)]+)\s*(?:,\s*([^)]*))?\)$/.exec(value.trim());
  if (!m) return value;
  if (el && typeof getComputedStyle === 'function') {
    const v = getComputedStyle(el).getPropertyValue(m[1]).trim();
    if (v) return v;
  }
  return m[2]?.trim() ?? value;
}

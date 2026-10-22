// src/core/colors.ts — resolves agent colors for the canvas.

import { parseColor, resolveCssVar, type RGBA } from '../color';
import type { ThemeMode, ThemeTokens } from '../theme';
import { warnOnce } from './constants';
import type { AgentRecord } from './record';

export type ResolvedColor = { css: string; rgba: RGBA };

/**
 * An agent's own color, else the theme palette by roster position. Canvas
 * can't read `var()`, so variables are resolved against `root`; results are
 * cached until `clear()` (theme or roster change).
 */
export class ColorResolver {
  private cache = new Map<string, ResolvedColor>();

  constructor(private root: () => Element | null) {}

  clear(): void {
    this.cache.clear();
  }

  resolve(rec: AgentRecord, index: number, mode: ThemeMode, t: ThemeTokens): ResolvedColor {
    const key = `${mode}|${index}|${rec.color ?? ''}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const fallback = t.palette[index % t.palette.length];
    let css = rec.color ? resolveCssVar(rec.color, this.root()) : fallback;
    let rgba = parseColor(css);
    if (!rgba) {
      warnOnce(`color:${rec.color}`, `Unrecognized color "${rec.color}" for agent "${rec.id}"; using the palette.`);
      css = fallback;
      rgba = parseColor(fallback) ?? { r: 37, g: 99, b: 235, a: 1 };
    }
    const out = { css, rgba };
    this.cache.set(key, out);
    return out;
  }
}

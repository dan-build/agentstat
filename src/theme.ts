// src/theme.ts
//
// Semantic color + type tokens for AgentStat. Components and the canvas
// renderer only ever reference these roles, never raw values, so a theme can
// repoint a role without touching drawing code.
//
// Every text/background pair below is measured against its theme's plot
// background: text roles clear WCAG 1.4.3 (4.5:1) and series/status colors
// clear 1.4.11 (3:1) for meaningful graphics.

export type ThemeMode = 'light' | 'dark';

export interface ThemeTokens {
  /** Plot background. */
  bg: string;
  /** Elevated overlay surfaces (legend chips, panel, tooltip). */
  surface: string;
  /** Hairline used inside shadow rings and dividers. */
  border: string;
  /** Primary text (values, names). ≥ 15:1. */
  text: string;
  /** Secondary text (labels). ≥ 7:1. */
  textSecondary: string;
  /** Tertiary text (axis ticks, hints). ≥ 4.5:1. */
  textTertiary: string;
  /** Grid lines — structural, intentionally quiet. */
  grid: string;
  /** Reference line default. */
  reference: string;
  /** Keyboard focus ring. ≥ 3:1. */
  focus: string;
  /** Pressed/selected chip fill. */
  selected: string;
  /** Warning status (anomaly warnings). */
  warning: string;
  /** Critical status (anomaly criticals). */
  critical: string;
  /** Default series palette, used when an agent has no color. */
  palette: readonly string[];
  /** Layered shadow for elevated overlays. */
  shadow: string;
}

export const FONT_SANS =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
export const FONT_MONO =
  'ui-monospace, "SF Mono", SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace';

export const LIGHT: ThemeTokens = {
  bg: '#ffffff',
  surface: 'rgba(255, 255, 255, 0.86)',
  border: 'rgba(24, 24, 27, 0.08)',
  text: '#18181b',
  textSecondary: '#52525b',
  textTertiary: '#6b6b73',
  grid: 'rgba(24, 24, 27, 0.06)',
  reference: 'rgba(24, 24, 27, 0.28)',
  focus: '#2563eb',
  selected: 'rgba(24, 24, 27, 0.06)',
  warning: '#b45309',
  critical: '#dc2626',
  // Hue-distinct, ordered so the first pairs stay separable under the common
  // color-vision deficiencies (blue/orange first, then green/magenta).
  palette: ['#2563eb', '#d9480f', '#0f8a5f', '#c2255c', '#7048e8', '#0b7285', '#a16207', '#3f3f46'],
  shadow:
    '0 0 0 1px rgba(24, 24, 27, 0.06), 0 1px 2px rgba(24, 24, 27, 0.04), 0 4px 12px rgba(24, 24, 27, 0.05)',
};

export const DARK: ThemeTokens = {
  bg: '#0b0b0d',
  surface: 'rgba(24, 24, 27, 0.82)',
  border: 'rgba(255, 255, 255, 0.08)',
  text: '#f4f4f5',
  textSecondary: '#a1a1aa',
  textTertiary: '#8b8b94',
  grid: 'rgba(255, 255, 255, 0.06)',
  reference: 'rgba(255, 255, 255, 0.3)',
  focus: '#60a5fa',
  selected: 'rgba(255, 255, 255, 0.08)',
  warning: '#f59e0b',
  critical: '#f87171',
  palette: ['#60a5fa', '#ff8a4c', '#34d399', '#f472b6', '#a78bfa', '#22d3ee', '#facc15', '#d4d4d8'],
  shadow:
    '0 0 0 1px rgba(255, 255, 255, 0.07), 0 1px 2px rgba(0, 0, 0, 0.3), 0 8px 24px rgba(0, 0, 0, 0.35)',
};

export const tokensFor = (mode: ThemeMode): ThemeTokens => (mode === 'dark' ? DARK : LIGHT);

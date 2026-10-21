import { describe, it, expect } from 'vitest';
import { parseColor, withAlpha, isDarkColor, contrastRatio, resolveCssVar } from '../src/color';
import { LIGHT, DARK } from '../src/theme';

describe('parseColor', () => {
  it.each([
    ['#1d4ed8', { r: 29, g: 78, b: 216, a: 1 }],
    ['#f00', { r: 255, g: 0, b: 0, a: 1 }],
    ['#ff000080', { r: 255, g: 0, b: 0, a: 128 / 255 }],
    ['rgb(1, 2, 3)', { r: 1, g: 2, b: 3, a: 1 }],
    ['rgba(1, 2, 3, 0.5)', { r: 1, g: 2, b: 3, a: 0.5 }],
    ['rgb(1 2 3 / 50%)', { r: 1, g: 2, b: 3, a: 0.5 }],
  ])('parses %s', (input, expected) => {
    expect(parseColor(input)).toEqual(expected);
  });

  it('returns null instead of throwing for garbage', () => {
    expect(parseColor('not-a-color')).toBeNull();
    expect(parseColor('#zzzzzz')).toBeNull();
    expect(parseColor('')).toBeNull();
    expect(parseColor(undefined)).toBeNull();
  });
});

describe('withAlpha', () => {
  it('produces an rgba string that multiplies existing alpha', () => {
    expect(withAlpha({ r: 10, g: 20, b: 30, a: 0.5 }, 0.5)).toBe('rgba(10, 20, 30, 0.25)');
  });
});

describe('isDarkColor', () => {
  it('handles non-hex backgrounds correctly', () => {
    expect(isDarkColor('#0a0a0a')).toBe(true);
    expect(isDarkColor('rgb(255, 255, 255)')).toBe(false);
    expect(isDarkColor('#fff')).toBe(false);
    // Unknown input must not flip the UI to dark.
    expect(isDarkColor('whatever')).toBe(false);
  });
});

describe('resolveCssVar', () => {
  it('returns the fallback when the variable is unset', () => {
    expect(resolveCssVar('var(--nope, #123456)', null)).toBe('#123456');
  });
  it('passes non-var input through', () => {
    expect(resolveCssVar('#abc', null)).toBe('#abc');
  });
});

describe('theme tokens meet WCAG contrast on their background', () => {
  for (const [name, t] of [
    ['light', LIGHT],
    ['dark', DARK],
  ] as const) {
    const bg = parseColor(t.bg)!;
    it(`${name}: text roles ≥ 4.5:1`, () => {
      for (const c of [t.text, t.textSecondary, t.textTertiary]) {
        expect(contrastRatio(parseColor(c)!, bg)).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${name}: series, status and focus colors ≥ 3:1`, () => {
      for (const c of [...t.palette, t.warning, t.critical, t.focus]) {
        expect(contrastRatio(parseColor(c)!, bg)).toBeGreaterThanOrEqual(3);
      }
    });
  }
});

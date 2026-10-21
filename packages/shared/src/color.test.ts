import { describe, expect, it } from 'vitest';
import { atLightness, blend, contrast, findLightness, fromOklch, isHex, toOklch } from './color.js';

describe('contrast (WCAG 2.2)', () => {
  it('black on white is 21:1, a colour on itself 1:1', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#2563eb', '#2563eb')).toBeCloseTo(1, 5);
  });

  it('matches the published ratios', () => {
    // #767676 is the lightest grey that passes 4.5:1 on white; #777777 just fails.
    expect(contrast('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#777777', '#ffffff')).toBeLessThan(4.5);
    expect(contrast('#ffffff', '#2563eb')).toBeCloseTo(5.17, 1);
  });
});

describe('OKLCH', () => {
  it('round-trips sRGB colours within one step per channel', () => {
    for (const hex of ['#2563eb', '#166534', '#7c3aed', '#c9a227', '#1c1b19', '#f6f4ef']) {
      const back = fromOklch(toOklch(hex));
      const d = [1, 3, 5].map((i) =>
        Math.abs(parseInt(back.slice(i, i + 2), 16) - parseInt(hex.slice(i, i + 2), 16)),
      );
      expect(Math.max(...d), `${hex} → ${back}`).toBeLessThanOrEqual(1);
    }
  });

  it('keeps the hue when the lightness moves, and stays in gamut', () => {
    const base = toOklch('#2563eb');
    for (const l of [0.2, 0.5, 0.8, 0.97]) {
      const c = atLightness('#2563eb', l);
      expect(isHex(c)).toBe(true);
      expect(toOklch(c).l).toBeCloseTo(l, 1);
      if (toOklch(c).c > 0.02) expect(Math.abs(toOklch(c).h - base.h)).toBeLessThan(6);
    }
  });

  it('finds the nearest lightness that passes a test, or none', () => {
    const dark = findLightness('#ffd400', 0.9, 0.1, (c) => contrast(c, '#ffffff') >= 4.5);
    expect(dark && contrast(dark, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(findLightness('#ffd400', 0.9, 0.85, (c) => contrast(c, '#ffffff') >= 4.5)).toBeNull();
  });
});

it('blend mixes a colour over another', () => {
  expect(blend('#ffffff', '#000000', 0.5)).toBe('#808080');
  expect(blend('#2563eb', '#ffffff', 1)).toBe('#2563eb');
});

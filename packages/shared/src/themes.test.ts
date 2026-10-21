import { describe, expect, it } from 'vitest';
import { contrast, fromOklch, isHex } from './color.js';
import {
  accentCss,
  accentOverrideVars,
  fitAccent,
  THEME_MODES,
  THEME_PRESETS,
  themeCss,
  themeTokens,
  type ThemeMode,
  type ThemePreset,
} from './themes.js';

/*
 * Every text and background pair of every theme, in light and dark, meets WCAG 2.2 AA: 4.5:1 for
 * text, 3:1 for controls and graphics (docs/design.md → Themes). An owner's accent is checked by
 * the same rules, for a spread of colours around the wheel.
 */

type Pair = [fg: string, bg: string, min: number];

const TEXT = 4.5;
const UI = 3;

function pairs(t: Record<string, string>): Pair[] {
  const p: Pair[] = [
    // Body text on every surface it sits on.
    ['foreground', 'background', TEXT],
    ['foreground', 'card', TEXT],
    ['foreground', 'muted', TEXT],
    ['muted-foreground', 'card', TEXT],
    ['muted-foreground', 'background', TEXT],
    ['muted-foreground', 'muted', TEXT],
    // The accent: on its fill, as text, on its soft fill.
    ['primary-foreground', 'primary', TEXT],
    ['primary-foreground', 'primary-hover', TEXT],
    ['primary-ink', 'card', TEXT],
    ['primary-ink', 'background', TEXT],
    ['accent-foreground', 'accent', TEXT],
    ['link', 'card', TEXT],
    // The sidebar.
    ['sidebar-foreground', 'sidebar', TEXT],
    ['sidebar-muted', 'sidebar', TEXT],
    ['sidebar-primary-foreground', 'sidebar-primary', TEXT],
    ['sidebar-accent-foreground', 'sidebar-accent', TEXT],
    // The section board (the blackboard names, now aliases of the sidebar).
    ['board-foreground', 'board', TEXT],
    ['board-muted', 'board', TEXT],
    // The hero: its text on both gradient stops.
    ['hero-foreground', 'hero-from', TEXT],
    ['hero-foreground', 'hero-to', TEXT],
    ['hero-muted', 'hero-from', TEXT],
    ['hero-muted', 'hero-to', TEXT],
    ['hero-accent', 'hero-from', TEXT],
    ['hero-accent', 'hero-to', TEXT],
    // Status text on the card and on its own soft fill.
    ['success', 'card', TEXT],
    ['success', 'success-soft', TEXT],
    ['warning', 'card', TEXT],
    ['warning', 'warning-soft', TEXT],
    ['destructive', 'card', TEXT],
    ['destructive', 'destructive-soft', TEXT],
    ['destructive-foreground', 'destructive', TEXT],
    ['info', 'card', TEXT],
    ['info', 'info-soft', TEXT],
    ['accent-warm-ink', 'card', TEXT],
    // Controls and graphics.
    ['input', 'card', UI],
    ['ring', 'card', UI],
    ['chart-1', 'card', UI],
    ['chart-2', 'card', UI],
    ['chart-3', 'card', UI],
  ];
  // Each ramp step carries its own label colour.
  for (const i of [1, 2, 3, 4, 5]) p.push([`ramp-fg-${i}`, `ramp-${i}`, TEXT]);
  // The strongest step reads as a mark on the card.
  p.push(['ramp-5', 'card', UI]);
  return p.filter(([fg, bg]) => t[fg] !== undefined && t[bg] !== undefined);
}

function failures(t: Record<string, string>): string[] {
  return pairs(t)
    .map(([fg, bg, min]) => ({ fg, bg, min, ratio: contrast(t[fg]!, t[bg]!) }))
    .filter((r) => r.ratio < r.min)
    .map((r) => `${r.fg} ${t[r.fg]} on ${r.bg} ${t[r.bg]}: ${r.ratio.toFixed(2)} < ${r.min}`);
}

const cases = THEME_PRESETS.flatMap((preset) =>
  THEME_MODES.map((mode) => [preset, mode] as [ThemePreset, ThemeMode]),
);

describe('theme contrast (WCAG 2.2 AA)', () => {
  it.each(cases)('%s %s: every text pair 4.5:1, every control and mark 3:1', (preset, mode) => {
    const t = themeTokens(preset, mode);
    expect(Object.values(t).every((v) => isHex(v) || /^\d+ \d+ \d+$/.test(v))).toBe(true);
    expect(failures(t)).toEqual([]);
  });

  it.each(cases)('%s %s: the ramp reads as five ordered tiers of one hue', (preset, mode) => {
    expect(rampProblems(themeTokens(preset, mode))).toEqual([]);
  });

  it.each(cases)(
    '%s %s: the chart series clear the colour-blind and lightness gates',
    (preset, mode) => {
      expect(seriesProblems(themeTokens(preset, mode), mode)).toEqual([]);
    },
  );
});

/*
 * The dataviz validator's gates (the dataviz skill's validate_palette.js), so a palette change is
 * checked without running it: Machado et al. (2009) colour-blind simulation at severity 1,
 * distances in OKLab × 100.
 */
const MACHADO = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
} as const;

const linear = (hex: string) =>
  [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];

function oklab([r, g, b]: [number, number, number]): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function deltaE(a: string, b: string, kind?: keyof typeof MACHADO): number {
  const sim = (hex: string) => {
    const c = linear(hex);
    if (!kind) return c;
    const M = MACHADO[kind];
    return M.map((row) =>
      Math.min(1, Math.max(0, row[0] * c[0] + row[1] * c[1] + row[2] * c[2])),
    ) as [number, number, number];
  };
  const [p, q] = [oklab(sim(a)), oklab(sim(b))];
  return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

const lch = (hex: string) => {
  const [l, a, b] = oklab(linear(hex));
  return { l, c: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
};

/** Categorical: band, chroma floor, adjacent CVD ≥ 8 and normal vision ≥ 15, 3:1 on the card. */
function seriesProblems(t: Record<string, string>, mode: ThemeMode): string[] {
  const band = mode === 'light' ? [0.43, 0.77] : [0.48, 0.67];
  const s = [1, 2, 3, 4, 5].map((i) => t[`chart-${i}`]!);
  const out: string[] = [];
  for (const c of s) {
    const { l, c: chroma } = lch(c);
    if (l < band[0]! || l > band[1]!) out.push(`${c} L ${l.toFixed(3)} outside the band`);
    if (chroma < 0.1) out.push(`${c} reads grey (C ${chroma.toFixed(3)})`);
    if (contrast(c, t['card']!) < 3) out.push(`${c} under 3:1 on the card`);
  }
  for (let i = 0; i < s.length - 1; i++) {
    const [a, b] = [s[i]!, s[i + 1]!];
    const cvd = Math.min(deltaE(a, b, 'protan'), deltaE(a, b, 'deutan'));
    if (cvd < 8) out.push(`${a}↔${b} colour-blind ΔE ${cvd.toFixed(1)} < 8`);
    if (deltaE(a, b) < 15) out.push(`${a}↔${b} ΔE ${deltaE(a, b).toFixed(1)} < 15`);
  }
  return out;
}

/** Ordinal: monotone lightness, steps ≥ 0.06 apart, one hue, the faintest 2:1 on the card. */
function rampProblems(t: Record<string, string>): string[] {
  const r = [1, 2, 3, 4, 5].map((i) => t[`ramp-${i}`]!);
  const ls = r.map((c) => lch(c).l);
  const out: string[] = [];
  const dir = Math.sign(ls[4]! - ls[0]!);
  for (let i = 0; i < 4; i++) {
    const gap = (ls[i + 1]! - ls[i]!) * dir;
    if (gap < 0.06) out.push(`${r[i]}→${r[i + 1]} ΔL ${gap.toFixed(3)} < 0.06`);
  }
  const hues = r.map((c) => lch(c).h);
  let spread = Math.max(...hues) - Math.min(...hues);
  if (spread > 180) spread = 360 - spread;
  if (spread > 40) out.push(`hue spread ${spread.toFixed(0)}° > 40°`);
  if (contrast(r[0]!, t['card']!) < 2) out.push(`faintest ${r[0]} under 2:1 on the card`);
  if (contrast(r[0]!, t['sidebar']!) < 2) out.push(`faintest ${r[0]} under 2:1 on the sidebar`);
  return out;
}

describe("an owner's accent", () => {
  // Twelve hues around the wheel, each light, middle and dark, plus greys and near-black.
  const accents = [
    ...[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].flatMap((h) =>
      [0.45, 0.6, 0.75].map((l) => fromOklch({ l, c: 0.15, h })),
    ),
    '#000000',
    '#6b7280',
    '#ffd400',
  ];

  it.each(THEME_PRESETS)('%s: any accent either fits in both modes or is refused', (preset) => {
    for (const accent of accents) {
      const fit = fitAccent(accent, preset);
      if (!fit.ok) continue;
      const vars = accentOverrideVars(accent, preset)!;
      for (const mode of THEME_MODES) {
        // What the page shows: the preset with the accent's variables laid over it.
        const t = { ...themeTokens(preset, mode), ...vars[mode] };
        expect(t, `${accent} ${mode}`).toEqual(themeTokens(preset, mode, accent));
        expect(failures(t), `${accent} ${mode}`).toEqual([]);
        expect(rampProblems(t), `${accent} ${mode} ramp`).toEqual([]);
        expect(seriesProblems(t, mode), `${accent} ${mode} series`).toEqual([]);
      }
    }
  });

  it('most colours fit (the check nudges lightness rather than refusing)', () => {
    const fits = accents.filter((a) => fitAccent(a, 'SCHOOL').ok).length;
    expect(fits).toBeGreaterThanOrEqual(accents.length - 2);
  });

  it('prints light: the dark variables are for screens only, the light ones cover paper', () => {
    // Black changes primary-foreground in dark only, which must not reach paper.
    const vars = accentOverrideVars('#000000', 'SCHOOL')!;
    expect(Object.keys(vars.dark).some((k) => !(k in vars.light))).toBe(true);
    const css = accentCss(vars);
    const blocks = [
      ...css.matchAll(
        /(@media (?:not )?print\{)?html\[data-theme\]\[data-mode="(\w+)"\]\{([^}]*)\}/g,
      ),
    ];
    expect(blocks.map((b) => [b[1] ?? '', b[2]])).toEqual([
      ['', 'light'],
      ['@media not print{', 'dark'],
      ['@media print{', 'dark'],
    ]);
    expect(blocks[2]![3]).toBe(blocks[0]![3]);
    expect(accentCss(null)).toBe('');
    expect(accentCss({ light: { 'x;}body{': '#000000', ok: 'red' }, dark: {} })).toBe('');
  });

  it('refuses what is not a colour', () => {
    expect(fitAccent('red', 'SCHOOL')).toEqual({ ok: false });
    expect(fitAccent('#12345', 'SCHOOL')).toEqual({ ok: false });
    expect(accentOverrideVars('nope', 'SCHOOL')).toBeNull();
  });

  it('a pale accent is darkened until white text on it passes', () => {
    const fit = fitAccent('#ffd400', 'SCHOOL');
    expect(fit.ok).toBe(true);
    if (fit.ok) expect(contrast(fit.light.primary, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('themeCss', () => {
  const css = themeCss();
  it('one rule per preset and mode, School light also on :root', () => {
    // Eight screen rules, and four print rules (dark pages print light).
    expect(css.match(/\[data-theme="[a-z-]+"\]\[data-mode="(light|dark)"\]\{/g)).toHaveLength(12);
    expect(css.startsWith(':root,[data-theme="school"][data-mode="light"]{')).toBe(true);
    expect(css).toContain('[data-theme="english-medium"][data-mode="dark"]{');
    expect(css).toContain('color-scheme:dark;');
  });

  it('prints light: a dark page uses the light colours of its preset on paper', () => {
    expect(css).toContain('@media print{[data-theme="madrasa"][data-mode="dark"]{');
    expect(css.match(/@media print\{/g)).toHaveLength(4);
  });

  it('stays small (inlined in every page)', () => {
    expect(css.length).toBeLessThan(28_000);
  });
});

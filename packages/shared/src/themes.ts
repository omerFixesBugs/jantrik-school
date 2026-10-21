import {
  atLightness,
  blend,
  contrast,
  findLightness,
  fromOklch,
  isHex,
  toOklch,
  type Hex,
} from './color.js';

/*
 * Institute themes (docs/design.md → Themes): four presets, each in light and dark, as data. An
 * institute gets its type's default (institute_types.default_theme); the owner may pick another
 * preset and an accent colour; each person picks light, dark or system (users.color_scheme).
 *
 * Neutrals are chosen per preset and mode; everything that follows the accent (the button fill,
 * the accent as text, the soft fill, the sequential ramp, the hero gradient) is derived here, so an
 * owner's accent goes through exactly the same checks as the presets' own (themes.test.ts).
 */

export const THEME_PRESETS = ['SCHOOL', 'MADRASA', 'COACHING', 'ENGLISH_MEDIUM'] as const;
export type ThemePreset = (typeof THEME_PRESETS)[number];
export const isThemePreset = (v: unknown): v is ThemePreset =>
  typeof v === 'string' && (THEME_PRESETS as readonly string[]).includes(v);

export const COLOR_SCHEMES = ['LIGHT', 'DARK', 'SYSTEM'] as const;
export type ColorScheme = (typeof COLOR_SCHEMES)[number];
export const isColorScheme = (v: unknown): v is ColorScheme =>
  typeof v === 'string' && (COLOR_SCHEMES as readonly string[]).includes(v);

export type ThemeMode = 'light' | 'dark';
export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark'];

/** The value of `data-theme` on the page: "school", "madrasa", "coaching", "english-medium". */
export const themeSlug = (p: ThemePreset): string => p.toLowerCase().replace('_', '-');

interface Neutrals {
  /** The page ground under the floating cards. */
  background: Hex;
  card: Hex;
  /** Quiet fills: table headers, hovered rows, segmented-control tracks. */
  muted: Hex;
  /** Hairlines. */
  border: Hex;
  /** Control outlines (at least 3:1 on the card). */
  input: Hex;
  foreground: Hex;
  mutedForeground: Hex;
  sidebar: Hex;
  sidebarForeground: Hex;
  sidebarMuted: Hex;
  sidebarBorder: Hex;
  /** The two soft blooms of the canvas gradient (decorative, never behind text alone). */
  bloom: [Hex, Hex];
  /** "r g b" of the shadow tint. */
  shadow: string;
}

interface PresetDef {
  /** The default accent: buttons, the active nav pill, links, the first data series. */
  accent: Hex;
  /** The ramp's own hue when it differs from the accent (English medium: gold). */
  rampAccent?: Hex;
  /** A second, quieter highlight (gold for the madrasa). */
  warm: Hex;
  /** The hero band: a gradient in the accent, or a soft tinted card. */
  hero: 'gradient' | 'soft';
  /** Hue shift (degrees) from the gradient's first stop to its second. */
  heroHueShift: number;
  /** A faint geometric pattern over the hero and sidebar. */
  pattern: 'girih' | null;
  /** Dark cards slightly translucent over the glow. */
  glass: boolean;
  /**
   * Categorical chart series (chart-1…5), used in this order, never cycled. Slot 1 is the theme's
   * own hue; the order clears the dataviz gates (adjacent colour-blind ΔE ≥ 8, normal vision
   * ≥ 15, one lightness band, 3:1 on the card), checked in themes.test.ts. A single-series chart
   * uses primary-ink instead, so it follows an owner's accent.
   */
  series: Record<ThemeMode, [Hex, Hex, Hex, Hex, Hex]>;
  light: Neutrals;
  dark: Neutrals;
}

export const THEMES: Record<ThemePreset, PresetDef> = {
  // Academia, Schoolastica: trustworthy blue to teal on a cool mist.
  SCHOOL: {
    accent: '#2563eb',
    warm: '#f59e0b',
    hero: 'gradient',
    heroHueShift: -70,
    pattern: null,
    glass: false,
    // Blue, orange, aqua, amber, magenta.
    series: {
      light: ['#306ae7', '#c25c19', '#069d78', '#966c13', '#bd5287'],
      dark: ['#2d67e4', '#bf5914', '#02906d', '#aa7907', '#ba4e84'],
    },
    light: {
      background: '#eef3f9',
      card: '#ffffff',
      muted: '#f1f5fa',
      border: '#dde5ef',
      input: '#7b8aa0',
      foreground: '#0e1a2b',
      mutedForeground: '#4b5b71',
      sidebar: '#ffffff',
      sidebarForeground: '#172739',
      sidebarMuted: '#56667c',
      sidebarBorder: '#e3e9f1',
      bloom: ['#cfe0ff', '#c8efe9'],
      shadow: '30 64 120',
    },
    dark: {
      background: '#0a111e',
      card: '#111a2b',
      muted: '#172238',
      border: '#233049',
      input: '#64779a',
      foreground: '#e8eef8',
      mutedForeground: '#a2b0c6',
      sidebar: '#0e1727',
      sidebarForeground: '#dde6f3',
      sidebarMuted: '#93a2ba',
      sidebarBorder: '#1e2a40',
      bloom: ['#1b3a7a', '#0d4a50'],
      shadow: '0 0 0',
    },
  },
  // Donezo: deep green and gold, a faint eight-fold geometric pattern; no living beings.
  MADRASA: {
    accent: '#166534',
    warm: '#c9a227',
    hero: 'gradient',
    heroHueShift: 28,
    pattern: 'girih',
    glass: false,
    // Green, violet, orange, blue, magenta (light) / amber (dark).
    series: {
      light: ['#06642f', '#573c9d', '#843a04', '#0f4ea3', '#8b225b'],
      dark: ['#177d40', '#6d54b7', '#b44f00', '#2a67bd', '#93690d'],
    },
    light: {
      background: '#eef3ef',
      card: '#ffffff',
      muted: '#f1f6f2',
      border: '#dce6df',
      input: '#7a8c7f',
      foreground: '#12241a',
      mutedForeground: '#4c5f53',
      sidebar: '#ffffff',
      sidebarForeground: '#15281d',
      sidebarMuted: '#5a6c60',
      sidebarBorder: '#e0e9e3',
      bloom: ['#cde8d5', '#f2e4b8'],
      shadow: '20 60 40',
    },
    dark: {
      background: '#08120d',
      card: '#0f1c15',
      muted: '#15261d',
      border: '#20372a',
      input: '#5f7a69',
      foreground: '#ebf2ec',
      mutedForeground: '#a5b8ab',
      sidebar: '#0c1711',
      sidebarForeground: '#e0eae2',
      sidebarMuted: '#8fa395',
      sidebarBorder: '#1b2e23',
      bloom: ['#12452a', '#4a3a0e'],
      shadow: '0 0 0',
    },
  },
  // Insighta, Corelytics: vivid purple; designed to look its best in dark (never forced).
  COACHING: {
    accent: '#7c3aed',
    warm: '#ec4899',
    hero: 'gradient',
    heroHueShift: 45,
    pattern: null,
    glass: true,
    // Purple, amber, blue, orange, sky.
    series: {
      light: ['#7549d2', '#8d6300', '#2d6ac1', '#aa4c08', '#0975a2'],
      dark: ['#7a4fd9', '#93690d', '#3370c7', '#b44f00', '#177ba8'],
    },
    light: {
      background: '#f4f2fb',
      card: '#ffffff',
      muted: '#f5f2fd',
      border: '#e5dff6',
      input: '#8a82a6',
      foreground: '#17132a',
      mutedForeground: '#56506e',
      sidebar: '#ffffff',
      sidebarForeground: '#1c1733',
      sidebarMuted: '#635c7e',
      sidebarBorder: '#e8e3f7',
      bloom: ['#e0d4ff', '#ffd3ec'],
      shadow: '70 40 140',
    },
    dark: {
      background: '#07060c',
      card: '#13111b',
      muted: '#1a1725',
      border: '#2a2638',
      input: '#6c6588',
      foreground: '#efedf7',
      mutedForeground: '#aba5c1',
      sidebar: '#0e0c15',
      sidebarForeground: '#e7e4f3',
      sidebarMuted: '#918aaa',
      sidebarBorder: '#211e2d',
      bloom: ['#3a1c78', '#5a1a4e'],
      shadow: '0 0 0',
    },
  },
  // Aivox, Crextio: white and warm white, ink black, one muted gold; minimal and refined.
  ENGLISH_MEDIUM: {
    accent: '#1c1b19',
    rampAccent: '#a8812f',
    warm: '#b08a3e',
    hero: 'soft',
    heroHueShift: 0,
    pattern: null,
    glass: false,
    // Gold (not the ink black, which reads as grey in a chart), magenta, blue, aqua, violet.
    series: {
      light: ['#aa7e14', '#c75b90', '#4885df', '#069d78', '#8972d8'],
      dark: ['#b38308', '#ce6196', '#4e8ce6', '#19a47d', '#8f78df'],
    },
    light: {
      background: '#f6f4ef',
      card: '#ffffff',
      muted: '#f5f2ec',
      border: '#e8e3d9',
      input: '#8b8579',
      foreground: '#1a1916',
      mutedForeground: '#58544b',
      sidebar: '#ffffff',
      sidebarForeground: '#1c1b18',
      sidebarMuted: '#69645a',
      sidebarBorder: '#ece7de',
      bloom: ['#efe5cf', '#e6edf5'],
      shadow: '60 50 30',
    },
    dark: {
      background: '#11100e',
      card: '#1a1916',
      muted: '#22201c',
      border: '#312f29',
      input: '#726d62',
      foreground: '#f2efe8',
      mutedForeground: '#b4aea2',
      sidebar: '#151412',
      sidebarForeground: '#ece8df',
      sidebarMuted: '#9e988b',
      sidebarBorder: '#27251f',
      bloom: ['#3a2e16', '#1e2632'],
      shadow: '0 0 0',
    },
  },
};

/** Status colours carry meaning, never identity: the same in every preset (one set per mode). */
const STATUS: Record<ThemeMode, Record<string, Hex>> = {
  light: {
    success: '#166c3c',
    'success-soft': '#e1f3e7',
    warning: '#8a5100',
    'warning-soft': '#fcefd6',
    destructive: '#b42318',
    'destructive-soft': '#fde7e4',
    info: '#1d5bab',
    'info-soft': '#e2edfb',
  },
  dark: {
    success: '#62d39a',
    'success-soft': '#10301f',
    warning: '#f3bb52',
    'warning-soft': '#36270b',
    destructive: '#ff8f84',
    'destructive-soft': '#3d1512',
    info: '#8dc1ff',
    'info-soft': '#112645',
  },
};

const WHITE = '#ffffff';
const best = (bg: Hex, ...candidates: Hex[]): Hex =>
  candidates.reduce((a, b) => (contrast(b, bg) > contrast(a, bg) ? b : a));

type RampStepKey = `ramp-${1 | 2 | 3 | 4 | 5}` | `ramp-fg-${1 | 2 | 3 | 4 | 5}`;

export type AccentTokens = {
  primary: Hex;
  'primary-foreground': Hex;
  'primary-hover': Hex;
  'primary-soft': Hex;
  /** The accent as text or a thin mark on the card (links, the active label, chart lines). */
  'primary-ink': Hex;
  'hero-from': Hex;
  'hero-to': Hex;
  'hero-foreground': Hex;
  'hero-muted': Hex;
  'hero-accent': Hex;
} & Record<RampStepKey, Hex>;

/**
 * Everything that follows the accent, for one mode; null when the accent cannot meet the
 * contrast floor in that mode (the owner's colour is then refused).
 */
export function accentTokens(
  accent: Hex,
  preset: ThemePreset,
  mode: ThemeMode,
): AccentTokens | null {
  const def = THEMES[preset];
  const n = def[mode];
  const visible = (c: Hex) => contrast(c, n.card) >= 1.5;
  const o = toOklch(accent);

  // The fill: white text on it when the accent allows, else (very dark accents in dark mode)
  // a light fill with dark text, so a button never disappears into the card.
  let fill = findLightness(
    accent,
    Math.min(o.l, 0.62),
    0.2,
    (c) => contrast(c, WHITE) >= 4.5 && visible(c),
  );
  let onFill: Hex = WHITE;
  if (!fill) {
    // A near-neutral accent (ink black) inverts to an off-white fill; a coloured one to the
    // nearest light shade of its hue that dark text reads on.
    const neutral = o.c < 0.03;
    fill = findLightness(
      accent,
      neutral ? 0.93 : 0.62,
      neutral ? 0.6 : 0.95,
      (c) => contrast(c, n.background) >= 4.5 && visible(c),
    );
    onFill = n.background;
    if (!fill) return null;
  }
  const fillL = toOklch(fill).l;
  const hover = atLightness(fill, onFill === WHITE ? Math.max(0.15, fillL - 0.06) : fillL + 0.04);
  if (contrast(hover, onFill) < 4.5) return null;

  const soft =
    mode === 'light'
      ? atLightness(accent, 0.955, 0.3)
      : fromOklch({ l: toOklch(n.card).l + 0.07, c: Math.min(o.c, 0.08), h: o.h });
  const inkOk = (c: Hex) =>
    contrast(c, n.card) >= 4.5 && contrast(c, n.background) >= 4.5 && contrast(c, soft) >= 4.5;
  const ink =
    mode === 'light'
      ? findLightness(accent, Math.min(o.l, 0.6), 0.1, inkOk)
      : findLightness(accent, Math.max(o.l, 0.62), 0.97, inkOk);
  if (!ink) return null;

  // The ramp: five ordered tiers of one hue (the percent bands), from the faintest to the
  // strongest (darker in light mode, brighter in dark mode). Even the faintest tier is a mark,
  // 2:1 on the card and the sidebar (the dataviz ordinal floor), so a low section never fades
  // into the card. Each step carries its own label colour.
  const rampBase = def.rampAccent ?? accent;
  const clears = (c: Hex) => contrast(c, n.card) >= 2.05 && contrast(c, n.sidebar) >= 2.05;
  const faint =
    mode === 'light'
      ? findLightness(rampBase, 0.9, 0.6, clears, 0.75)
      : findLightness(rampBase, 0.3, 0.6, clears, 0.75);
  if (!faint) return null;
  const l1 = toOklch(faint).l;
  const l5 = mode === 'light' ? Math.min(0.38, l1 - 0.34) : Math.max(0.86, l1 + 0.34);
  const toStrong = Math.sign(l5 - l1);
  const ramp: Hex[] = [];
  const rampFg: Hex[] = [];
  let prev: number | null = null;
  for (let i = 0; i < 5; i++) {
    const ideal = l1 + ((l5 - l1) * i) / 4;
    const c = 0.75 + 0.25 * (i / 4);
    // A mid-tone step can sit where neither dark nor light text reaches 4.5:1: move it up to
    // 0.04 either way (the strong side first) until one does, keeping it 0.065 from the tier
    // before, so the tiers stay apart and in order.
    let found: [Hex, Hex] | null = null;
    for (const k of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8, -8]) {
      const l = ideal + toStrong * 0.005 * k;
      if (prev !== null && (l - prev) * toStrong < 0.065) continue;
      const step = atLightness(rampBase, l, c);
      const label = best(step, n.foreground, WHITE, n.background);
      if (contrast(label, step) >= 4.5) {
        found = [step, label];
        prev = l;
        break;
      }
    }
    if (!found) return null;
    ramp.push(found[0]);
    rampFg.push(found[1]);
  }

  // The hero: a gradient in the accent (white text on both stops), or a soft tinted card.
  let heroFrom: Hex;
  let heroTo: Hex;
  let heroFg: Hex;
  let heroMuted: Hex;
  if (def.hero === 'gradient') {
    const start = mode === 'light' ? 0.52 : 0.4;
    const from = findLightness(accent, start, 0.15, (c) => contrast(c, WHITE) >= 5);
    const shifted = fromOklch({
      l: start,
      c: Math.max(o.c, 0.1),
      h: (o.h + def.heroHueShift + 360) % 360,
    });
    const to = findLightness(shifted, start, 0.15, (c) => contrast(c, WHITE) >= 5);
    if (!from || !to) return null;
    heroFrom = from;
    heroTo = to;
    heroFg = WHITE;
    heroMuted = [0.9, 0.92, 0.95, 1]
      .map((a) => blend(WHITE, from, a))
      .find((c) => contrast(c, from) >= 4.5 && contrast(c, to) >= 4.5)!;
  } else {
    heroFrom = mode === 'light' ? atLightness(rampBase, 0.97, 0.25) : n.card;
    heroTo = mode === 'light' ? n.card : n.muted;
    heroFg = n.foreground;
    heroMuted = n.mutedForeground;
  }
  // A highlight on the hero (the warm colour where it reads, else the plain hero text).
  const heroAccentOk = (c: Hex) => contrast(c, heroFrom) >= 4.5 && contrast(c, heroTo) >= 4.5;
  // On a dark hero (any gradient, or the soft hero in dark mode) the warm colour lightens; on a
  // light soft hero it darkens.
  const warmOnHero =
    def.hero === 'gradient' || mode === 'dark'
      ? findLightness(def.warm, 0.75, 0.97, heroAccentOk, 0.9)
      : findLightness(def.warm, 0.55, 0.2, heroAccentOk);

  return {
    primary: fill,
    'primary-foreground': onFill,
    'primary-hover': hover,
    'primary-soft': soft,
    'primary-ink': ink,
    'ramp-1': ramp[0]!,
    'ramp-2': ramp[1]!,
    'ramp-3': ramp[2]!,
    'ramp-4': ramp[3]!,
    'ramp-5': ramp[4]!,
    'ramp-fg-1': rampFg[0]!,
    'ramp-fg-2': rampFg[1]!,
    'ramp-fg-3': rampFg[2]!,
    'ramp-fg-4': rampFg[3]!,
    'ramp-fg-5': rampFg[4]!,
    'hero-from': heroFrom,
    'hero-to': heroTo,
    'hero-foreground': heroFg,
    'hero-muted': heroMuted,
    'hero-accent': warmOnHero ?? heroFg,
  };
}

/** An owner's accent, checked in both modes for the preset. */
export function fitAccent(
  accent: string,
  preset: ThemePreset,
): { ok: true; light: AccentTokens; dark: AccentTokens } | { ok: false } {
  if (!isHex(accent)) return { ok: false };
  const light = accentTokens(accent.toLowerCase(), preset, 'light');
  const dark = accentTokens(accent.toLowerCase(), preset, 'dark');
  return light && dark ? { ok: true, light, dark } : { ok: false };
}

/** Every colour token of a preset in one mode (CSS custom property names without "--"). */
export function themeTokens(
  preset: ThemePreset,
  mode: ThemeMode,
  accent?: Hex | null,
): Record<string, string> {
  const def = THEMES[preset];
  const n = def[mode];
  const a =
    accentTokens(accent ?? def.accent, preset, mode) ?? accentTokens(def.accent, preset, mode)!;
  // An ink-black accent (English medium) would make links read as body text: they take the gold.
  const neutralAccent = toOklch(accent ?? def.accent).c < 0.03;
  const warmInk =
    mode === 'light'
      ? findLightness(
          def.warm,
          0.6,
          0.2,
          (c) => contrast(c, n.card) >= 4.5 && contrast(c, n.background) >= 4.5,
        )!
      : findLightness(
          def.warm,
          0.7,
          0.97,
          (c) => contrast(c, n.card) >= 4.5 && contrast(c, n.background) >= 4.5,
        )!;
  const warmSoft =
    mode === 'light'
      ? atLightness(def.warm, 0.95, 0.35)
      : fromOklch({ ...toOklch(def.warm), l: toOklch(n.card).l + 0.08, c: 0.06 });
  const status = STATUS[mode];
  return {
    background: n.background,
    canvas: n.background,
    card: n.card,
    'card-foreground': n.foreground,
    popover: n.card,
    'popover-foreground': n.foreground,
    foreground: n.foreground,
    muted: n.muted,
    'muted-foreground': n.mutedForeground,
    secondary: n.muted,
    'secondary-foreground': n.foreground,
    border: n.border,
    input: n.input,
    ...a,
    ring: a['primary-ink'],
    link: neutralAccent ? warmInk : a['primary-ink'],
    accent: a['primary-soft'],
    'accent-foreground': a['primary-ink'],
    brand: a.primary,
    'accent-warm': def.warm,
    'accent-warm-soft': warmSoft,
    'accent-warm-ink': warmInk,
    sidebar: n.sidebar,
    'sidebar-foreground': n.sidebarForeground,
    'sidebar-muted': n.sidebarMuted,
    'sidebar-primary': a.primary,
    'sidebar-primary-foreground': a['primary-foreground'],
    'sidebar-accent':
      mode === 'light' ? a['primary-soft'] : blend(a['primary-ink'], n.sidebar, 0.12),
    'sidebar-accent-foreground': n.sidebarForeground,
    'sidebar-border': n.sidebarBorder,
    'sidebar-ring': a['primary-ink'],
    ...status,
    'destructive-foreground': best(status.destructive!, WHITE, n.background),
    'chart-1': def.series[mode][0],
    'chart-2': def.series[mode][1],
    'chart-3': def.series[mode][2],
    'chart-4': def.series[mode][3],
    'chart-5': def.series[mode][4],
    'bloom-1': n.bloom[0],
    'bloom-2': n.bloom[1],
    'shadow-rgb': n.shadow,
    // The blackboard names of design v2, kept as aliases until their last users are rebuilt.
    board: n.sidebar,
    'board-raised': mode === 'light' ? a['primary-soft'] : n.muted,
    'board-deep': n.muted,
    'board-line': n.sidebarBorder,
    'board-foreground': n.sidebarForeground,
    'board-muted': n.sidebarMuted,
    'chalk-yellow': def.warm,
    'chalk-pink': status.destructive!,
    'chalk-sky': status.info!,
    'chalk-mint': status.success!,
    'chalk-orange': status.warning!,
    'chalk-yellow-ink': warmInk,
    'chalk-pink-ink': status.destructive!,
    'chalk-sky-ink': status.info!,
    'chalk-mint-ink': a['primary-ink'],
    'chalk-orange-ink': status.warning!,
  };
}

/**
 * The accent stylesheet the page lays over its preset (the web app's theme.tsx; its head script
 * carries an ES5 copy): each mode's variables (html[data-theme][data-mode] beats the preset rules),
 * the dark ones on screens only, and the light ones again for printing a dark page, so paper always
 * shows the light look. Only variable names and #rrggbb values pass, so a tampered cache cannot
 * inject CSS.
 */
export function accentCss(
  vars: { light: Record<string, string>; dark: Record<string, string> } | null,
): string {
  if (!vars) return '';
  const block = (sel: string, v: Record<string, string>) => {
    let out = '';
    for (const k in v) {
      const value = String(v[k]);
      if (/^[a-z0-9-]+$/.test(k) && /^#[0-9a-f]{6}$/.test(value)) out += `--${k}:${value};`;
    }
    return out ? `${sel}{${out}}` : '';
  };
  const light = block('html[data-theme][data-mode="light"]', vars.light);
  const dark = block('html[data-theme][data-mode="dark"]', vars.dark);
  const paper = block('html[data-theme][data-mode="dark"]', vars.light);
  return (
    light + (dark ? `@media not print{${dark}}` : '') + (paper ? `@media print{${paper}}` : '')
  );
}

/**
 * The stylesheet for every preset and mode: `[data-theme='school'][data-mode='light'] {…}`. Inlined
 * by the root layout (the head script sets both attributes before first paint); School light is
 * also the plain `:root`, for pages before any choice is known.
 */
export function themeCss(): string {
  const out: string[] = [];
  for (const preset of THEME_PRESETS) {
    for (const mode of THEME_MODES) {
      const tokens = themeTokens(preset, mode);
      const body = Object.entries(tokens)
        .map(([k, v]) => `--${k}:${v};`)
        .join('');
      const selector = `[data-theme="${themeSlug(preset)}"][data-mode="${mode}"]`;
      const scheme = `color-scheme:${mode};`;
      out.push(
        `${preset === 'SCHOOL' && mode === 'light' ? `:root,` : ''}${selector}{${body}${scheme}}`,
      );
    }
    // Paper is light: a register printed from dark mode prints in the preset's light colours.
    const light = Object.entries(themeTokens(preset, 'light'))
      .map(([k, v]) => `--${k}:${v};`)
      .join('');
    out.push(
      `@media print{[data-theme="${themeSlug(preset)}"][data-mode="dark"]{${light}color-scheme:light;}}`,
    );
  }
  return out.join('\n');
}

/**
 * An owner's accent as variables laid over the preset (the page's accent style, theme.tsx): exactly
 * the tokens the accent changes, so the page always equals themeTokens(preset, mode, accent).
 * Null when the colour does not fit.
 */
export function accentOverrideVars(
  accent: Hex,
  preset: ThemePreset,
): { light: Record<string, string>; dark: Record<string, string> } | null {
  const own = accent.toLowerCase();
  if (!fitAccent(own, preset).ok) return null;
  const changed = (mode: ThemeMode) => {
    const base = themeTokens(preset, mode);
    return Object.fromEntries(
      Object.entries(themeTokens(preset, mode, own)).filter(([k, v]) => base[k] !== v),
    );
  };
  return { light: changed('light'), dark: changed('dark') };
}

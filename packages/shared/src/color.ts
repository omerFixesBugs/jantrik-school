/*
 * Colour maths for the themes (docs/design.md → Themes): WCAG 2.2 contrast, and OKLCH (a
 * perceptual space) for deriving an accent's shades, so a lighter step looks lighter by the same
 * amount whatever the hue. Pure functions on "#rrggbb" strings.
 */

export type Hex = string;

const HEX = /^#[0-9a-f]{6}$/i;
export const isHex = (v: unknown): v is Hex => typeof v === 'string' && HEX.test(v);

function channels(hex: Hex): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (r: number, g: number, b: number): Hex =>
  `#${[r, g, b]
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number) =>
  255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055);

/** WCAG relative luminance (0 black … 1 white). */
export function relativeLuminance(hex: Hex): number {
  const [r, g, b] = channels(hex).map(toLinear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two colours (1 … 21). */
export function contrast(a: Hex, b: Hex): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `fg` at `alpha` over `bg`, as a solid colour (for text drawn semi-transparent). */
export function blend(fg: Hex, bg: Hex, alpha: number): Hex {
  const f = channels(fg);
  const b = channels(bg);
  return toHex(...(f.map((c, i) => c * alpha + b[i]! * (1 - alpha)) as [number, number, number]));
}

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

export function toOklch(hex: Hex): Oklch {
  const [r, g, b] = channels(hex).map(toLinear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h };
}

function oklchToLinear({ l, c, h }: Oklch): [number, number, number] {
  const A = c * Math.cos((h * Math.PI) / 180);
  const B = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const inGamut = (rgb: number[]) => rgb.every((v) => v >= -0.0005 && v <= 1.0005);

/** An OKLCH colour as hex; chroma is reduced until it fits sRGB (hue and lightness kept). */
export function fromOklch(color: Oklch): Hex {
  let c = color.c;
  let rgb = oklchToLinear({ ...color, c });
  for (let i = 0; i < 40 && !inGamut(rgb); i++) {
    c *= 0.94;
    rgb = oklchToLinear({ ...color, c });
  }
  return toHex(...(rgb.map(fromLinear) as [number, number, number]));
}

/** The same hue and chroma at another lightness (0 … 1). */
export const atLightness = (hex: Hex, l: number, chromaScale = 1): Hex => {
  const o = toOklch(hex);
  return fromOklch({ l, c: o.c * chromaScale, h: o.h });
};

/**
 * The lightness, searched from `from` towards `to`, at which `test` first holds; null when it
 * never does. Lightness moves in small steps so the result stays as close to the start as it can.
 */
export function findLightness(
  hex: Hex,
  from: number,
  to: number,
  test: (candidate: Hex) => boolean,
  chromaScale = 1,
): Hex | null {
  const step = from < to ? 0.005 : -0.005;
  for (let l = from; step > 0 ? l <= to : l >= to; l += step) {
    const candidate = atLightness(hex, l, chromaScale);
    if (test(candidate)) return candidate;
  }
  return null;
}

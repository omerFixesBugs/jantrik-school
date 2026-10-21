import type { Page } from '@playwright/test';

/**
 * Finds rendered text below WCAG 2.2 AA: 4.5:1, or 3:1 for large text (24 px, or 18.66 px bold).
 *
 * The unit test (packages/shared/src/themes.test.ts) checks every token pair of every theme; this
 * checks what a page actually paints, so a component that puts text on the wrong surface (or a
 * literal colour that ignores the theme) is caught too. For each text node and SVG label it takes
 * the text colour and the stack of backgrounds behind it (ancestors, translucent fills blended),
 * scaled by ancestor opacity. Text over a gradient or image is skipped (the hero gradient's stops
 * are covered by the unit test), and so are decoration (aria-hidden) and disabled controls, which
 * WCAG exempts.
 */
export interface ContrastProblem {
  text: string;
  fg: string;
  bg: string;
  ratio: number;
  min: number;
}

/** Runs in the page. Kept self-contained (no closures) so it can be passed to evaluate(). */
export function contrastProblemsInPage(): ContrastProblem[] {
  const problems: ContrastProblem[] = [];
  const short = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 50);

  // Any CSS colour (rgb, oklab from colour-mix, …) to sRGB 0-255 and alpha 0-1, through a canvas.
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const cache = new Map<string, [number, number, number, number]>();
  const rgba = (css: string): [number, number, number, number] => {
    const hit = cache.get(css);
    if (hit) return hit;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    const out: [number, number, number, number] = [d[0]!, d[1]!, d[2]!, d[3]! / 255];
    cache.set(css, out);
    return out;
  };
  const over = (
    top: [number, number, number, number],
    under: [number, number, number],
  ): [number, number, number] => [
    top[0] * top[3] + under[0] * (1 - top[3]),
    top[1] * top[3] + under[1] * (1 - top[3]),
    top[2] * top[3] + under[2] * (1 - top[3]),
  ];
  const lum = ([r, g, b]: [number, number, number]) => {
    const f = (v: number) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const hex = (c: [number, number, number]) =>
    '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

  /** The opaque colour behind an element, or null when a gradient or image is part of it. */
  const backdrop = (el: Element): [number, number, number] | null => {
    const layers: [number, number, number, number][] = [];
    for (let e: Element | null = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage !== 'none') return null;
      const c = rgba(cs.backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 1) break;
    }
    let base: [number, number, number] = [255, 255, 255];
    for (const l of layers.reverse()) base = over(l, base);
    return base;
  };

  const skip = (el: Element): boolean => {
    if (el.closest('[aria-hidden="true"], :disabled, [aria-disabled="true"], [data-disabled]'))
      return true;
    for (let e: Element | null = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') return true;
    }
    const r = el.getBoundingClientRect();
    return r.width <= 1 || r.height <= 1; // sr-only
  };

  const opacity = (el: Element): number => {
    let o = 1;
    for (let e: Element | null = el; e; e = e.parentElement)
      o *= Number(getComputedStyle(e).opacity);
    return o;
  };

  const check = (el: Element, text: string, colour: string) => {
    if (skip(el)) return;
    const bg = backdrop(el);
    if (!bg) return;
    const c = rgba(colour);
    const fg = over([c[0], c[1], c[2], c[3] * opacity(el)], bg);
    const [a, b] = [lum(fg), lum(bg)];
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    const min = large ? 3 : 4.5;
    // A rounding margin: 8-bit colour from the canvas against ratios computed from exact hex.
    if (ratio + 0.02 < min)
      problems.push({
        text: short(text),
        fg: hex(fg),
        bg: hex(bg),
        ratio: Number(ratio.toFixed(2)),
        min,
      });
  };

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set<Element>();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || seen.has(el) || !n.textContent?.trim()) continue;
    if (el.closest('script, style, noscript, template')) continue;
    seen.add(el);
    const svgText = el.closest('svg text');
    if (svgText) check(svgText, n.textContent, getComputedStyle(svgText).fill);
    else check(el, n.textContent, getComputedStyle(el).color);
  }
  const found = new Map<string, ContrastProblem>();
  for (const p of problems) found.set(`${p.text}|${p.fg}|${p.bg}`, p);
  return [...found.values()];
}

/** Contrast problems on the page as it is now (wait for data and fonts first). */
export async function findContrastProblems(page: Page): Promise<ContrastProblem[]> {
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate(contrastProblemsInPage);
}

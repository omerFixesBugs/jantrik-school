import type { Page } from '@playwright/test';

/**
 * Finds text that does not fit: wider than its box (unless intentionally truncated with an
 * ellipsis), clipped, sticking out of the viewport, or drawn on top of other text.
 *
 * Works on text nodes (glyph boxes via Range#getClientRects), not element boxes, so a padded
 * button next to a label is fine but two strings painted over each other are not. Text hidden
 * under an overlay (a dialog, the sticky bar) is skipped: elementFromPoint must hit it, and text in
 * a sticky or fixed layer is only compared with text in the same layer (scrolled content passing
 * under the top bar is covered by it, not drawn over it).
 */
export interface LayoutProblem {
  kind: 'overflow' | 'clipped' | 'offscreen' | 'overlap';
  text: string;
  detail: string;
}

/** Runs in the page. Kept self-contained (no closures) so it can be passed to evaluate(). */
export function layoutProblemsInPage(): LayoutProblem[] {
  const problems: LayoutProblem[] = [];
  const vw = document.documentElement.clientWidth;
  const short = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 60);

  const isVisuallyHidden = (el: Element): boolean => {
    for (let e: Element | null = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0)
        return true;
      if (e.getAttribute('aria-hidden') === 'true') return true; // decoration (alphabet chart)
      const r = e.getBoundingClientRect();
      if (r.width <= 1 && r.height <= 1) return true; // sr-only
      if (cs.clip === 'rect(0px, 0px, 0px, 0px)' || cs.clipPath === 'inset(50%)') return true;
    }
    return false;
  };

  interface Item {
    node: Text;
    el: Element;
    rects: DOMRect[];
    /** The sticky/fixed box the text rides in (the top bar, a sticky footer), or null. */
    layer: Element | null;
  }
  // A sticky or fixed layer covering scrolled content is occlusion by design, not overlap. Sticky
  // table parts (a register's name column, a table header) are not layers: their text is still
  // compared with its neighbours.
  const layerOf = (el: Element): Element | null => {
    for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if ((cs.position === 'sticky' || cs.position === 'fixed') && !cs.display.startsWith('table'))
        return e;
    }
    return null;
  };
  const items: Item[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    const el = node.parentElement;
    if (!el || !node.textContent?.trim()) continue;
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'OPTION'].includes(el.tagName))
      continue;
    if (isVisuallyHidden(el)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
    if (rects.length === 0) continue;
    // Only text that is actually on top at its own position (not under a dialog or sticky bar).
    const top = rects[0]!;
    const hit = document.elementFromPoint(
      Math.min(Math.max(top.left + top.width / 2, 0), vw - 1),
      Math.min(Math.max(top.top + top.height / 2, 0), window.innerHeight - 1),
    );
    const onTop = !!hit && (hit === el || el.contains(hit) || hit.contains(el));
    items.push({ node, el, rects: onTop ? rects : [], layer: layerOf(el) });
  }

  // 1. Overflow / clipping, per element (once).
  const seen = new Set<Element>();
  for (const { el, node, rects } of items) {
    if (rects.length === 0) continue;
    // Inside a horizontal scroller (the month register) text may run past the screen edge.
    let scrolls = false;
    for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
      const ox = getComputedStyle(e).overflowX;
      if (ox === 'auto' || ox === 'scroll') scrolls = true;
    }
    for (const r of scrolls ? [] : rects) {
      if (r.right > vw + 1 || r.left < -1) {
        problems.push({
          kind: 'offscreen',
          text: short(node.textContent!),
          detail: `x ${Math.round(r.left)}–${Math.round(r.right)} of ${vw}`,
        });
        break;
      }
    }
    // Nearest box that clips it: glyphs outside it are cut off.
    for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      const clipsX = cs.overflowX !== 'visible';
      const clipsY = cs.overflowY !== 'visible';
      if (!clipsX && !clipsY) continue;
      if (
        cs.overflowX === 'auto' ||
        cs.overflowX === 'scroll' ||
        cs.overflowY === 'auto' ||
        cs.overflowY === 'scroll'
      )
        break; // scrollable: fine
      const box = e.getBoundingClientRect();
      const truncated = cs.textOverflow === 'ellipsis' || cs.webkitLineClamp !== 'none';
      const out = rects.some(
        (r) =>
          (clipsX && (r.right > box.right + 1 || r.left < box.left - 1)) ||
          (clipsY && (r.bottom > box.bottom + 1 || r.top < box.top - 1)),
      );
      if (out && !truncated && !seen.has(e)) {
        seen.add(e);
        problems.push({
          kind: 'clipped',
          text: short(node.textContent!),
          detail: `cut by <${e.tagName.toLowerCase()} class="${(e.getAttribute('class') ?? '').slice(0, 60)}">`,
        });
      }
      break;
    }
    // Visible overflow: content wider than its own box, spilling onto neighbours.
    const cs = getComputedStyle(el);
    if (
      !seen.has(el) &&
      cs.overflowX === 'visible' &&
      el.scrollWidth > el.clientWidth + 1 &&
      el.clientWidth > 0 &&
      cs.display !== 'inline'
    ) {
      seen.add(el);
      problems.push({
        kind: 'overflow',
        text: short(node.textContent!),
        detail: `scrollWidth ${el.scrollWidth} > ${el.clientWidth}`,
      });
    }
  }

  // 2. Glyphs of different text nodes painted on top of each other.
  const visible = items.filter((i) => i.rects.length > 0);
  for (let a = 0; a < visible.length; a++) {
    for (let b = a + 1; b < visible.length; b++) {
      const A = visible[a]!;
      const B = visible[b]!;
      if (A.layer !== B.layer) continue;
      for (const ra of A.rects) {
        const hit = B.rects.find((rb) => {
          const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
          const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
          // Bangla glyph boxes have generous line boxes; require real overlap.
          return w > 2 && h > Math.min(ra.height, rb.height) * 0.35;
        });
        if (hit) {
          problems.push({
            kind: 'overlap',
            text: `${short(A.node.textContent!)} ↔ ${short(B.node.textContent!)}`,
            detail: `at ${Math.round(hit.left)},${Math.round(hit.top)}`,
          });
          break;
        }
      }
    }
  }
  return problems;
}

/**
 * Layout problems on the whole page, not just the first screen: checks, scrolls one screen
 * down, checks again, to the end, then puts the scroll back where it was (so a test can go on).
 */
export async function findLayoutProblems(page: Page): Promise<LayoutProblem[]> {
  // Measure the real faces, not the fallback shown while they load (font-display: swap).
  await page.evaluate(() => document.fonts.ready);
  const start = await page.evaluate(() => window.scrollY);
  const found = new Map<string, LayoutProblem>();
  for (let step = 0; step < 30; step++) {
    for (const p of await page.evaluate(layoutProblemsInPage)) found.set(`${p.kind}|${p.text}`, p);
    const moved = await page.evaluate(() => {
      const before = window.scrollY;
      window.scrollBy(0, Math.max(200, window.innerHeight * 0.8));
      return window.scrollY !== before;
    });
    if (!moved) break;
    await page.waitForTimeout(50);
  }
  await page.evaluate((y) => window.scrollTo(0, y), start);
  return [...found.values()];
}

export interface SmallTarget {
  text: string;
  size: string;
}

/** Runs in the page: interactive elements smaller than 44 × 44 px (the phone rule). */
export function smallTargetsInPage(): SmallTarget[] {
  const out: SmallTarget[] = [];
  const sel =
    'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=checkbox], [role=switch], [role=radio], [role=menuitem], [role=option]';
  for (const el of document.querySelectorAll<HTMLElement>(sel)) {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (el.closest('[aria-hidden="true"], [inert]')) continue;
    let r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue; // sr-only (a skip link until focused), collapsed
    // Text links inside a sentence are exempt (WCAG 2.5.8), not links standing on their own.
    if (el.tagName === 'A' && cs.display === 'inline') {
      const around = el.parentElement?.textContent?.trim().length ?? 0;
      if (around > (el.textContent?.trim().length ?? 0)) continue;
    }
    // A checkbox or radio takes its label (only a real label) as part of its target.
    if (el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type)) {
      const label =
        el.closest('label') ?? (el.id ? document.querySelector(`label[for="${el.id}"]`) : null);
      if (label) {
        const l = label.getBoundingClientRect();
        r = new DOMRect(
          Math.min(r.left, l.left),
          Math.min(r.top, l.top),
          Math.max(r.right, l.right) - Math.min(r.left, l.left),
          Math.max(r.bottom, l.bottom) - Math.min(r.top, l.top),
        );
      }
    }
    if (r.width + 0.5 < 44 || r.height + 0.5 < 44) {
      const text = (
        el.getAttribute('aria-label') ??
        el.textContent ??
        el.getAttribute('name') ??
        el.tagName
      )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 50);
      out.push({
        text: text || el.tagName.toLowerCase(),
        size: `${Math.round(r.width)}×${Math.round(r.height)}`,
      });
    }
  }
  return out;
}

export function findSmallTargets(page: Page): Promise<SmallTarget[]> {
  return page.evaluate(smallTargetsInPage);
}

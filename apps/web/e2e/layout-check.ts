import type { Page } from '@playwright/test';

/**
 * Finds text that does not fit: wider than its box (unless intentionally truncated with an
 * ellipsis), clipped, sticking out of the viewport, or drawn on top of other text.
 *
 * Works on text nodes (glyph boxes via Range#getClientRects), not element boxes, so a padded
 * button next to a label is fine but two strings painted over each other are not. Text hidden
 * under an overlay (a dialog, the sticky bar) is skipped: elementFromPoint must hit it.
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
  }
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
    items.push({ node, el, rects: onTop ? rects : [] });
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

export function findLayoutProblems(page: Page): Promise<LayoutProblem[]> {
  return page.evaluate(layoutProblemsInPage);
}

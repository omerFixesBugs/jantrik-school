import { expect, test, type Page } from '@playwright/test';
import { DEMO, passwordLogin } from './helpers';

// Bangla numerals must be unmistakable (docs/PRODUCT.md, principle 1). v1's body face, Hind
// Siliguri, drew ১ wrongly at weights 400–600 ("২১" read as "২৬") and had no tabular figures.
// These checks fail on any face that does either, on the screens that are mostly numbers.

const BODY_FACE = 'Noto Sans Bengali';
const DIGITS = '০১২৩৪৫৬৭৮৯';

/** Every element whose own text has a Bangla digit, and the fonts Chromium drew it with. */
async function digitFonts(page: Page): Promise<{ text: string; fonts: string[] }[]> {
  await page.evaluate(() => document.fonts.ready);
  // One probe per element (an element may hold several digit text nodes, e.g. `{a}/{b}`).
  const texts = await page.evaluate(() => {
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || el.hasAttribute('data-digit-probe') || !/[০-৯]/.test(n.textContent ?? ''))
        continue;
      const box = el.getBoundingClientRect();
      if (box.width < 1 || box.height < 1 || getComputedStyle(el).visibility === 'hidden') continue;
      el.setAttribute('data-digit-probe', String(out.length));
      out.push((el.textContent ?? '').trim().slice(0, 40));
    }
    return out;
  });
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const result: { text: string; fonts: string[] }[] = [];
    for (let i = 0; i < texts.length; i++) {
      const { nodeId } = await cdp.send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: `[data-digit-probe="${i}"]`,
      });
      if (!nodeId) continue; // re-rendered away since the walk
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
      result.push({ text: texts[i]!, fonts: fonts.map((f) => f.familyName) });
    }
    return result;
  } finally {
    await cdp.detach().catch(() => undefined);
    await page.evaluate(() =>
      document
        .querySelectorAll('[data-digit-probe]')
        .forEach((el) => el.removeAttribute('data-digit-probe')),
    );
  }
}

async function expectBodyFaceDigits(page: Page, where: string) {
  await page.waitForLoadState('networkidle');
  const found = await digitFonts(page);
  expect(found.length, `${where}: no Bangla digits on the page`).toBeGreaterThan(0);
  const wrong = found.filter((f) => f.fonts.some((name) => name !== BODY_FACE));
  expect(wrong, `${where}: digits drawn by another font`).toEqual([]);
}

test('Bangla digits are drawn by the body face on the number-heavy screens', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId('module-card-attendance')).toBeVisible();
  await expectBodyFaceDigits(page, 'dashboard');

  await page.goto('/attendance/register');
  await expect(page.getByTestId('register-list').or(page.getByRole('table')).first()).toBeVisible();
  await expectBodyFaceDigits(page, 'register');

  await page.goto('/students/new');
  await expect(page.locator('#st-birth-reg')).toBeVisible();
  await expectBodyFaceDigits(page, 'admission form');
});

test('every text style has one width per digit, and ১ is drawn whole', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/login');
  await page.evaluate(() => document.fonts.ready);
  const report = await page.evaluate(async (digits) => {
    // The styles numbers appear in: body, label, emphasis, KPI value, a number in a heading.
    const styles = ['', 'font-medium', 'font-semibold', 'text-3xl font-semibold font-numeric'];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const widths: Record<string, number[]> = {};
    for (const cls of styles) {
      widths[cls || 'body'] = [];
      for (const d of digits) {
        const span = document.createElement('span');
        span.className = cls;
        span.style.whiteSpace = 'pre';
        span.textContent = d.repeat(10);
        host.appendChild(span);
        widths[cls || 'body']!.push(span.getBoundingClientRect().width / 10);
        span.remove();
      }
    }
    // Ink height of ১ against ৬ in the body face, at each weight the UI uses.
    const family = getComputedStyle(document.body).fontFamily;
    // Load the real face only: next/font's "… Fallback" face is local("Arial"), which a Linux
    // runner doesn't have, and a failed face makes fonts.load() reject.
    const face = family.split(',')[0]!.trim();
    const shapes: Record<number, { one: number; six: number; same: boolean }> = {};
    for (const weight of [400, 500, 600]) {
      await document.fonts.load(`${weight} 100px ${face}`, '১৬');
      const ctx = document.createElement('canvas').getContext('2d')!;
      ctx.font = `${weight} 100px ${family}`;
      const ink = (s: string) => {
        const m = ctx.measureText(s);
        return m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
      };
      const draw = (s: string) => {
        const c = document.createElement('canvas');
        c.width = 120;
        c.height = 140;
        const g = c.getContext('2d')!;
        g.font = ctx.font;
        g.fillText(s, 10, 110);
        return c.toDataURL();
      };
      shapes[weight] = { one: ink('১'), six: ink('৬'), same: draw('১') === draw('৬') };
    }
    host.remove();
    return { widths, shapes };
  }, DIGITS);

  for (const [style, ws] of Object.entries(report.widths)) {
    const spread = Math.max(...ws) - Math.min(...ws);
    expect(spread, `${style}: digit widths ${ws.map((w) => w.toFixed(1)).join(', ')}`).toBeLessThan(
      0.5,
    );
  }
  for (const [weight, s] of Object.entries(report.shapes)) {
    expect(s.same, `weight ${weight}: ১ and ৬ drawn the same`).toBe(false);
    // A whole ১ stands at least as tall as ৬ (Noto: 1.07×); Hind's broken one was 0.69–0.86×.
    expect(s.one / s.six, `weight ${weight}: ১ is ${s.one}px tall, ৬ ${s.six}px`).toBeGreaterThan(
      0.98,
    );
  }
});

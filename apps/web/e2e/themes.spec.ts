import { expect, test, type Browser, type Page, type Response } from '@playwright/test';
import {
  accentOverrideVars,
  themeTokens,
  type ColorScheme,
  type StudentsPage,
  type ThemePreset,
} from '@jantrik/shared';
import { ACCENT_STYLE_ID, THEME_LAST_KEY } from '../src/lib/theme-script';
import {
  api,
  API_URL,
  apiLogin,
  DEMO,
  logout,
  otpLoginWithBanglaDigits,
  passwordLogin,
} from './helpers';
import { findContrastProblems } from './contrast-check';
import { findLayoutProblems } from './layout-check';

// Themes (docs/design.md → Themes): the institute's preset (its type's default, or the owner's
// choice) and each person's Light / Dark / System, kept on their account. Nobody is put in dark
// by default; every screen must hold up in dark for those who choose it, and the screens used
// outdoors on phones (taking attendance, the guardian's) must be excellent in light.

const html = (page: Page) => page.locator('html');

/** Soft: a sweep reports every screen's problems in one run, not just the first screen's. */
async function expectReadable(page: Page, where: string) {
  await page.waitForLoadState('networkidle');
  const contrast = await findContrastProblems(page);
  expect
    .soft(contrast, `${where}: text under AA: ${JSON.stringify(contrast, null, 1)}`)
    .toEqual([]);
  const layout = await findLayoutProblems(page);
  expect.soft(layout, `${where}: ${JSON.stringify(layout, null, 1)}`).toEqual([]);
}

/** Waits as long as a 429 asks (300 requests a minute per person), as a person would. */
async function waitOut(seconds: number) {
  test.info().setTimeout(test.info().timeout + (seconds + 1) * 1000);
  await new Promise((r) => setTimeout(r, (seconds + 1) * 1000));
}

/**
 * Opens a screen (a URL, or a reload when none) and lets it settle. A sweep opens many screens
 * quickly: if the API answered "too many requests" meanwhile, wait that out and open it again,
 * so the checks never judge an error screen.
 */
async function openScreen(page: Page, url?: string) {
  let wait = 0;
  const on = (r: Response) => {
    if (r.status() === 429) wait = Math.max(wait, Number(r.headers()['retry-after'] ?? 60));
  };
  page.on('response', on);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      wait = 0;
      await (url ? page.goto(url) : page.reload());
      await page.waitForLoadState('networkidle');
      if (!wait) return;
      await waitOut(wait);
    }
  } finally {
    page.off('response', on);
  }
}

/** Sets the institute's preset as its owner would (PUT /settings/appearance). */
async function setPreset(token: string, preset: ThemePreset | null, accent: string | null = null) {
  const put = () =>
    fetch(`${API_URL}/settings/appearance`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset, accent }),
    });
  let res = await put();
  if (res.status === 429) {
    await waitOut(Number(res.headers.get('Retry-After') ?? 60));
    res = await put();
  }
  expect(res.status, `PUT /settings/appearance → ${res.status}`).toBe(200);
}

/** A person's light/dark choice through the API (PATCH /me/preferences answers 204). */
async function setScheme(identifier: string, colorScheme: ColorScheme) {
  const token = await apiLogin(identifier);
  const res = await fetch(`${API_URL}/me/preferences`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ colorScheme }),
  });
  expect(res.status).toBe(204);
}

/** A colour variable as the page resolves it. */
const cssVar = (page: Page, name: string) =>
  page.evaluate(
    (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    `--${name}`,
  );

async function newPage(browser: Browser, colorScheme: 'light' | 'dark', mobile = false) {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    locale: 'bn-BD',
    timezoneId: 'Asia/Dhaka',
    colorScheme,
    reducedMotion: 'reduce',
    ...(mobile
      ? { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true }
      : { viewport: { width: 1366, height: 900 } }),
  });
  return context.newPage();
}

test('everyone starts on System: the device picks light or dark, the institute type the preset', async ({
  browser,
}) => {
  const shapla = await newPage(browser, 'dark');
  await passwordLogin(shapla, DEMO.shaplaOwner);
  await expect(shapla).toHaveURL(/\/dashboard$/);
  await expect(html(shapla)).toHaveAttribute('data-theme', 'school');
  await expect(html(shapla)).toHaveAttribute('data-mode', 'dark');
  // System follows the device live.
  await shapla.emulateMedia({ colorScheme: 'light' });
  await expect(html(shapla)).toHaveAttribute('data-mode', 'light');
  await shapla.context().close();

  // A coaching centre gets the Coaching preset, designed for dark but never forced into it.
  const alo = await newPage(browser, 'light');
  await passwordLogin(alo, DEMO.aloOwner);
  await expect(alo).toHaveURL(/\/dashboard$/);
  await expect(html(alo)).toHaveAttribute('data-theme', 'coaching');
  await expect(html(alo)).toHaveAttribute('data-mode', 'light');
  await expectReadable(alo, 'coaching light dashboard');
  await alo.context().close();
});

test('the light/dark choice is kept on the account and paints first on the next load', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  // What the first frame of each load shows, then every value data-mode takes. (Init scripts run
  // before the <html> element exists, so watch the document.)
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { modes: string[] }).modes = seen;
    const mode = () => document.documentElement?.dataset['mode'] ?? 'none';
    requestAnimationFrame(() => seen.unshift(`frame:${mode()}`));
    new MutationObserver(() => seen.push(mode())).observe(document, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-mode'],
    });
  });
  const modes = () => page.evaluate(() => (window as unknown as { modes: string[] }).modes);
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page).toHaveURL(/\/dashboard$/);
  try {
    await page.getByTestId('user-menu').click();
    await page.getByTestId('scheme-dark').click();
    await expect(html(page)).toHaveAttribute('data-mode', 'dark');

    // No flash: the next load is dark from its first paint.
    await page.reload();
    await expect(page.getByTestId('module-card-attendance')).toBeVisible();
    const seen = await modes();
    expect(seen).toEqual(['frame:dark', ...seen.slice(1).map(() => 'dark')]);

    // Kept on the account, not in this browser: with the browser's memory wiped (a new device),
    // the server's choice still wins over the device's light.
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.getByTestId('module-card-attendance')).toBeVisible();
    await expect(html(page)).toHaveAttribute('data-mode', 'dark');

    // The top bar's one-tap toggle goes back to light (and is kept the same way).
    const saved = page.waitForResponse(
      (r) => r.url().endsWith('/me/preferences') && r.request().method() === 'PATCH',
    );
    await page.getByTestId('scheme-toggle').click();
    await saved;
    await expect(html(page)).toHaveAttribute('data-mode', 'light');
  } finally {
    // Through the API, so a broken page cannot leave the shared demo owner in dark.
    await setScheme(DEMO.shaplaOwner, 'SYSTEM');
  }
});

test("an owner's accent reaches the page, prints light, and a reset takes it off at once", async ({
  page,
}) => {
  const owner = await apiLogin(DEMO.shaplaOwner);
  const accent = '#b45309';
  const vars = accentOverrideVars(accent, 'SCHOOL')!;
  await page.emulateMedia({ colorScheme: 'light' });
  await setPreset(owner, null, accent);
  try {
    await passwordLogin(page, DEMO.shaplaOwner);
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect.poll(() => cssVar(page, 'primary-ink')).toBe(vars.light['primary-ink']);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => cssVar(page, 'primary-ink')).toBe(vars.dark['primary-ink']);
    // Paper is light: a dark page prints in the light colours, the accent's included.
    await page.emulateMedia({ media: 'print' });
    await expect.poll(() => cssVar(page, 'primary-ink')).toBe(vars.light['primary-ink']);
    // Every variable the accent sets, also those it changes in dark only.
    const paper = { ...themeTokens('SCHOOL', 'light'), ...vars.light };
    for (const name of Object.keys(vars.dark)) {
      await expect.poll(() => cssVar(page, name), name).toBe(paper[name]);
    }
    await expect.poll(() => cssVar(page, 'card')).toBe(themeTokens('SCHOOL', 'light')['card']);
    await page.emulateMedia({ media: 'screen', colorScheme: 'light' });

    // Reset from another device: this browser paints its cached accent first, then the
    // institute's real look takes it off.
    await setPreset(owner, null);
    await page.reload();
    await expect(page.getByTestId('module-card-attendance')).toBeVisible();
    await expect
      .poll(() => cssVar(page, 'primary-ink'))
      .toBe(themeTokens('SCHOOL', 'light')['primary-ink']);
  } finally {
    await setPreset(owner, null);
  }
});

test('the platform panel keeps its own look, whatever this browser last showed', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/login');
  await page.evaluate(
    ([key, a]) => localStorage.setItem(key!, JSON.stringify({ t: 'coaching', s: 'DARK', a })),
    [THEME_LAST_KEY, accentOverrideVars('#b45309', 'COACHING')] as const,
  );
  await page.goto('/platform/login');
  await expect(html(page)).toHaveAttribute('data-theme', 'school');
  await expect(html(page)).toHaveAttribute('data-mode', 'light');
  await expect(page.locator(`#${ACCENT_STYLE_ID}`)).toHaveCount(0);
});

test('signing out leaves the next person the default look', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await passwordLogin(page, DEMO.aloOwner);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(html(page)).toHaveAttribute('data-theme', 'coaching');
  try {
    await page.getByTestId('user-menu').click();
    const saved = page.waitForResponse(
      (r) => r.url().endsWith('/me/preferences') && r.request().method() === 'PATCH',
    );
    await page.getByTestId('scheme-dark').click();
    await saved;
    await expect(html(page)).toHaveAttribute('data-mode', 'dark');
    // A radio item leaves the menu open.
    await page.keyboard.press('Escape');

    await logout(page);
    await expect(page).toHaveURL(/\/login/);
    await expect(html(page)).toHaveAttribute('data-theme', 'school');
    await expect(html(page)).toHaveAttribute('data-mode', 'light');
    // And on the next load (the cache was reset too).
    await page.reload();
    await expect(html(page)).toHaveAttribute('data-mode', 'light');
    await expect(html(page)).toHaveAttribute('data-theme', 'school');
  } finally {
    await setScheme(DEMO.aloOwner, 'SYSTEM');
  }
});

test('every screen holds up in dark', async ({ browser }) => {
  test.setTimeout(150_000);
  // School at Shapla, Coaching at Alo (its type's default, and long batch names): one person per
  // preset, which also keeps each inside the API's per-person request limit.
  for (const [identifier, theme] of [
    [DEMO.shaplaOwner, 'school'],
    [DEMO.aloOwner, 'coaching'],
  ] as const) {
    const token = await apiLogin(identifier);
    const student = (await api<StudentsPage>(token, '/students?pageSize=1')).items[0]!.id;
    const page = await newPage(browser, 'dark');
    await passwordLogin(page, identifier);
    await expect(page).toHaveURL(/\/dashboard$/);
    for (const screen of [
      '/dashboard',
      '/students',
      `/students/${student}`,
      '/students/new',
      '/students/import',
      '/attendance',
      '/attendance/today',
      '/attendance/register',
      '/attendance/settings',
      `/attendance/students/${student}`,
      '/staff',
      '/setup',
      '/setup/classes',
      '/setup/student-code',
      '/fees',
      '/exams',
      '/exams/setup',
    ]) {
      await openScreen(page, screen);
      await expect(html(page)).toHaveAttribute('data-theme', theme);
      await expect(html(page)).toHaveAttribute('data-mode', 'dark');
      await expect(page.getByRole('main')).toBeVisible();
      await expectReadable(page, `${theme} dark ${screen}`);
    }
    await page.context().close();
  }
});

test.describe('outdoors, on a phone, in light', () => {
  test.use({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });

  test('taking attendance and the guardian view, in every preset', async ({ page, browser }) => {
    test.setTimeout(150_000);
    const owner = await apiLogin(DEMO.shaplaOwner);
    await page.emulateMedia({ colorScheme: 'light' });
    await passwordLogin(page, DEMO.shaplaTeacher);
    await expect(page).toHaveURL(/\/dashboard$/);
    const guardian = await newPage(browser, 'light', true);
    await otpLoginWithBanglaDigits(guardian, DEMO.shaplaGuardian2);
    await expect(guardian.getByTestId('children')).toBeVisible();
    try {
      for (const preset of ['SCHOOL', 'MADRASA', 'COACHING', 'ENGLISH_MEDIUM'] as const) {
        await setPreset(owner, preset);
        await openScreen(page, '/attendance');
        await expect(html(page)).toHaveAttribute(
          'data-theme',
          preset.toLowerCase().replace('_', '-'),
        );
        await expect(html(page)).toHaveAttribute('data-mode', 'light');
        await expect(page.getByTestId('register-list')).toBeVisible();
        await expectReadable(page, `${preset} light register`);

        await openScreen(guardian);
        await expect(guardian.getByTestId('children')).toBeVisible();
        await expect(html(guardian)).toHaveAttribute('data-mode', 'light');
        await expectReadable(guardian, `${preset} light guardian`);
      }
    } finally {
      await setPreset(owner, null);
      await guardian.context().close();
    }
  });
});

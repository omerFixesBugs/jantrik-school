import { expect, test, type Page } from '@playwright/test';
import { DEMO, totpNow } from './helpers';
import { findLayoutProblems } from './layout-check';

async function expectClean(page: Page, where: string) {
  await page.waitForLoadState('networkidle');
  const problems = await findLayoutProblems(page);
  expect(problems, `${where}: ${JSON.stringify(problems, null, 1)}`).toEqual([]);
}

// Step 8, part 1: the platform area for Jantrik's own staff. Password, then an authenticator app
// (set up with a QR code on the first sign-in), 10 backup codes shown once, its own shell.
test.describe.serial('platform sign-in', () => {
  let secret = '';

  const contextOptions = (baseURL: string | undefined) => ({
    baseURL,
    locale: 'bn-BD',
    timezoneId: 'Asia/Dhaka',
  });

  test('first sign-in at 360 px (Bangla): password, QR enrolment, backup codes, overview', async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      ...contextOptions(baseURL),
      viewport: { width: 360, height: 780 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    // Without a session, the platform area sends you to its own login.
    await page.goto('/platform');
    await expect(page).toHaveURL(/\/platform\/login$/);
    await expectClean(page, 'platform login');

    await page.getByLabel('মোবাইল নম্বর বা ইমেইল').fill(DEMO.platformAdmin);
    await page.getByLabel('পাসওয়ার্ড', { exact: true }).fill(DEMO.password);
    await page.getByRole('button', { name: 'পরবর্তী' }).tap();
    await expect(page.getByTestId('platform-qr')).toBeVisible();
    secret = (await page.getByTestId('platform-secret').innerText()).replace(/\s/g, '');
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    await expectClean(page, 'platform enrolment');

    await page.getByLabel('৬ অঙ্কের কোড').pressSequentially(totpNow(secret));
    const codes = page.getByTestId('platform-backup-codes');
    await expect(codes).toBeVisible(); // the full code signs in by itself
    await expect(codes.getByRole('listitem')).toHaveCount(10);
    await expectClean(page, 'platform backup codes');
    await expect(page.getByTestId('platform-continue')).toBeDisabled();
    await page.getByTestId('platform-backup-saved').check();
    await page.getByTestId('platform-continue').tap();

    await expect(page).toHaveURL(/\/platform$/);
    await expect(page.getByTestId('platform-me')).toContainText('থেকে চালু');
    await expect(page.getByTestId('platform-audit-list')).toContainText('লগইন');
    await expectClean(page, 'platform overview 360');
    await page.getByTestId('platform-logout').tap();
    await expect(page).toHaveURL(/\/platform\/login$/);
    await page.goto('/platform');
    await expect(page).toHaveURL(/\/platform\/login$/);
    await context.close();
  });

  test('later sign-ins at 1440 px (English): just the app code; the activity log', async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      ...contextOptions(baseURL),
      viewport: { width: 1440, height: 900 },
    });
    await context.addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: baseURL! }]);
    const page = await context.newPage();
    await page.goto('/platform/login');
    await page.getByLabel('Mobile number or email').fill(DEMO.platformAdmin);
    await page.getByLabel('Password', { exact: true }).fill(DEMO.password);
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('heading', { name: 'Verification code' })).toBeVisible();
    await expect(page.getByTestId('platform-qr')).toHaveCount(0);
    await expectClean(page, 'platform code 1440');
    // The next time step: the first sign-in already used the current one (codes work once).
    await page.getByLabel('6-digit code').pressSequentially(totpNow(secret, 1));
    await expect(page).toHaveURL(/\/platform$/);
    await expect(page.getByTestId('platform-me')).toContainText('On since');
    await expectClean(page, 'platform overview 1440');

    await page.getByRole('link', { name: 'Activity log' }).click();
    await expect(page).toHaveURL(/\/platform\/audit$/);
    const log = page.getByTestId('platform-audit-list');
    await expect(log).toContainText('Signed in');
    await expect(log).toContainText('Signed out');
    await expectClean(page, 'platform audit 1440');
    await context.close();
  });
});

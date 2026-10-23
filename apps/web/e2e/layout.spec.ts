import { expect, test, type Page } from '@playwright/test';
import { API_URL, DEMO, otpLoginWithBanglaDigits, otpPhoneInput, passwordLogin } from './helpers';
import { findLayoutProblems, findSmallTargets } from './layout-check';

// Long Bangla strings must wrap or truncate with "…", never clip or overlap: checked on a small
// Android phone (360 px), and the busiest screens again at 320 px (a phone with larger text).
test.use({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });

async function expectClean(page: Page, where: string) {
  await page.waitForLoadState('networkidle');
  const problems = await findLayoutProblems(page);
  expect(problems, `${where}: ${JSON.stringify(problems, null, 1)}`).toEqual([]);
  // A phone (touch): every control at least 44 × 44 px (docs/design.md → Density).
  const small = await findSmallTargets(page);
  expect(small, `${where}: targets under 44 px: ${JSON.stringify(small, null, 1)}`).toEqual([]);
}

async function english(page: Page) {
  await page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: page.url() }]);
  await page.reload();
}

test('login: both tabs and the code step, bn and en', async ({ page }) => {
  await page.goto('/login');
  await expectClean(page, 'login otp bn');
  await page.getByRole('tab', { name: 'পাসওয়ার্ড' }).tap();
  await expectClean(page, 'login password bn');

  await page.route(`${API_URL}/auth/otp/request`, (r) =>
    r.fulfill({ status: 202, contentType: 'application/json', body: '{"expiresIn":300}' }),
  );
  await page.getByRole('tab', { name: 'ওটিপি কোড' }).tap();
  await otpPhoneInput(page).fill('01711000001');
  await page.getByRole('button', { name: 'কোড পাঠান' }).tap();
  await expect(page.getByTestId('resend-countdown')).toBeVisible();
  await expectClean(page, 'login code step bn');

  await page.goto('/login');
  await english(page);
  await expectClean(page, 'login otp en');
});

test('staff screens: dashboard, drawer, students, attendance picker', async ({ page }) => {
  // About twenty screens, each scrolled through and checked: past the default 30 s since the
  // fee pages and the exams card (it ran at 31–32 s).
  test.setTimeout(60_000);
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page.getByTestId('module-card-attendance')).toBeVisible();
  await expectClean(page, 'dashboard bn');

  await page.getByRole('button', { name: 'মেনু খুলুন' }).tap();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectClean(page, 'drawer bn');
  await page.keyboard.press('Escape');

  await page.goto('/students');
  await expect(page.getByTestId('students-cards')).toBeVisible();
  await expectClean(page, 'students bn');

  await page.goto('/attendance');
  await expect(page.getByTestId('section-list')).toBeVisible();
  await expectClean(page, 'attendance picker bn');

  await page.goto('/attendance/today');
  await expect(page.getByTestId('today-section').first()).toBeVisible();
  await expectClean(page, 'today report bn');
  await page.goto('/attendance/register');
  await expect(page.getByTestId('register-table')).toBeVisible();
  await expectClean(page, 'month register bn');
  await page.goto('/attendance/settings');
  await expect(page.getByTestId('settings-teachers')).toBeVisible();
  await expectClean(page, 'settings bn');

  // Fees (step 9).
  await page.goto('/fees');
  await expect(page.getByTestId('fees-search')).toBeVisible();
  await expectClean(page, 'fee counter bn');
  await page.goto('/fees/closing');
  await expect(page.getByTestId('fees-closing')).toBeVisible();
  await expectClean(page, 'fee closing bn');
  await page.goto('/fees/submissions');
  await expect(page.getByTestId('fees-submissions')).toBeVisible();
  await expectClean(page, 'fee transfers bn');
  await page.goto('/fees/reports');
  await expect(page.getByTestId('fees-reports')).toBeVisible();
  await expectClean(page, 'fee reports bn');
  await page.goto('/fees/reminders');
  await expect(page.getByTestId('fees-reminders')).toBeVisible();
  await expectClean(page, 'fee reminders bn');
  for (const tab of ['general', 'heads', 'amounts', 'siblings', 'numbers']) {
    await page.goto(tab === 'general' ? '/fees/setup' : `/fees/setup/${tab}`);
    await expect(page.getByTestId('fees-setup')).toBeVisible();
    await expectClean(page, `fee setup ${tab} bn`);
  }

  await page.goto('/dashboard');
  await english(page);
  await expect(page.getByTestId('module-card-attendance')).toBeVisible();
  await expectClean(page, 'dashboard en');
  await page.setViewportSize({ width: 320, height: 780 });
  await expectClean(page, 'dashboard en 320');
  // Back to Bangla for the shared demo user's later tests.
  await page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'bn', url: page.url() }]);
});

test('register: draft, submitted, more-than-half dialog, conflict dialog', async ({ page }) => {
  await passwordLogin(page, DEMO.shaplaTeacher);
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto('/attendance');
  const rows = page.getByTestId('register-list').getByRole('button');
  await expect(rows).toHaveCount(27);

  await page.getByRole('button', { name: 'সবাই উপস্থিত' }).tap();
  await rows.nth(0).tap();
  await expectClean(page, 'register draft');
  await page.getByTestId('register-submit').tap();
  await expect(page.getByTestId('sync-state')).toHaveAttribute('data-sync', 'saved');
  await expectClean(page, 'register submitted');
  await page.setViewportSize({ width: 320, height: 780 });
  await expectClean(page, 'register submitted 320');
  await page.setViewportSize({ width: 360, height: 780 });

  for (let i = 1; i < 15; i++) await rows.nth(i).tap();
  await page.getByTestId('register-submit').tap();
  await expect(page.getByTestId('absent-confirm')).toBeVisible();
  await expectClean(page, 'more-than-half dialog');
  await page.getByRole('button', { name: 'ফিরে দেখি' }).tap();

  // A conflict with a long name, answered by the browser (no data changes).
  await page.route(`${API_URL}/attendance/sessions`, (route) =>
    route.request().method() !== 'PUT'
      ? route.continue()
      : route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            statusCode: 409,
            code: 'VERSION_CONFLICT',
            message: 'x',
            session: {
              id: '0199f000-0000-7000-8000-000000000001',
              version: 99,
              submittedAt: new Date().toISOString(),
              updatedBy: {
                id: '0199f000-0000-7000-8000-000000000002',
                name: 'Mohammad Abdur Rahman Chowdhury',
                nameBn: 'মোহাম্মদ আব্দুর রহমান চৌধুরী',
              },
              records: [],
            },
          }),
        }),
  );
  await page.getByTestId('register-submit').tap();
  await page.getByTestId('absent-confirm').getByRole('button', { name: 'হ্যাঁ, জমা দিন' }).tap();
  await expect(page.getByTestId('conflict-dialog')).toBeVisible();
  await expectClean(page, 'conflict dialog');
});

test('guardian dashboard', async ({ page }) => {
  await otpLoginWithBanglaDigits(page, DEMO.shaplaGuardian2);
  await expect(page.getByTestId('children')).toBeVisible();
  await expectClean(page, 'guardian dashboard');
});

test('exam screens: list, an exam, a locked sheet, setup, results, guardian results', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto('/exams');
  await page.getByTestId('exam-card').first().click();
  await expect(page.getByTestId('sheets-grid')).toBeVisible();
  const exam = page.url().replace(/\?.*$/, '');
  await expectClean(page, 'exam sheets bn');
  for (const tab of ['setup', 'students', 'results']) {
    await page.goto(`${exam}?tab=${tab}`);
    await expect(page.getByTestId('exam-tabs')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectClean(page, `exam ${tab} bn`);
  }
  // A locked sheet, as the office sees it (read-only rows, correction actions).
  await page.goto(exam);
  await page.getByTestId('grid-cell').first().click();
  await expect(page.getByTestId('sheet-row').first()).toBeVisible();
  await expectClean(page, 'locked sheet bn');
  for (const tab of ['marks', 'teachers', 'choices', 'rooms', 'grading']) {
    await page.goto(`/exams/setup?tab=${tab}`);
    await expect(page.getByTestId('exams-setup-tabs')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectClean(page, `exams setup ${tab} bn`);
  }
  await page.goto('/exams');
  await english(page);
  await expectClean(page, 'exams en');
});

test('guardian results: the list and a report card', async ({ page }) => {
  await otpLoginWithBanglaDigits(page, DEMO.shaplaGuardian3);
  await page.getByTestId('child-results-open').first().click();
  await page.getByTestId('child-result').first().click();
  await expect(page.getByTestId('report-card')).toBeVisible();
  await expectClean(page, 'guardian report card bn');
});

test.describe('desktop', () => {
  test.use({ viewport: { width: 1366, height: 900 }, isMobile: false, hasTouch: false });

  test('dashboard and students list at 1366 and 1920 px, bn and en', async ({ page }) => {
    test.setTimeout(90_000);
    await passwordLogin(page, DEMO.shaplaOwner);
    await expect(page).toHaveURL(/\/dashboard$/);
    try {
      for (const lang of ['bn', 'en']) {
        await page.context().addCookies([{ name: 'NEXT_LOCALE', value: lang, url: page.url() }]);
        for (const width of [1366, 1920]) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto('/dashboard');
          await expect(page.getByTestId('attendance-trend')).toBeVisible();
          await page.waitForLoadState('networkidle');
          const dashboard = await findLayoutProblems(page);
          expect(dashboard, `dashboard ${width} ${lang}: ${JSON.stringify(dashboard)}`).toEqual([]);
          await page.goto('/students');
          await expect(page.getByTestId('students-table')).toBeVisible();
          await page.waitForLoadState('networkidle');
          const students = await findLayoutProblems(page);
          expect(students, `students ${width} ${lang}: ${JSON.stringify(students)}`).toEqual([]);
        }
        // The narrowest width with a side peek: the list shares the screen with it.
        await page.setViewportSize({ width: 1280, height: 900 });
        await page
          .getByTestId('students-table')
          .locator('tbody tr')
          .first()
          .getByRole('cell')
          .nth(1)
          .click();
        await expect(page.getByTestId('student-peek')).toBeVisible();
        const peek = await findLayoutProblems(page);
        expect(peek, `students with the peek 1280 ${lang}: ${JSON.stringify(peek)}`).toEqual([]);
      }
    } finally {
      await page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'bn', url: page.url() }]);
    }
  });
});

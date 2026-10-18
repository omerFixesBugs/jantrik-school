import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { DEMO, otpLoginWithBanglaDigits, passwordLogin } from './helpers';
import { findLayoutProblems } from './layout-check';

// Phase 3 screens on a small Android phone and on a desktop. The seed has about 30 working days
// of past attendance for every section (today is left to take live).

const SIZES = [
  { name: 'phone 360', viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true },
  {
    name: 'desktop 1440',
    viewport: { width: 1440, height: 900 },
    isMobile: false,
    hasTouch: false,
  },
];

async function expectClean(page: Page, where: string) {
  await page.waitForLoadState('networkidle');
  const problems = await findLayoutProblems(page);
  expect(problems, `${where}: ${JSON.stringify(problems, null, 1)}`).toEqual([]);
}

/** Day of the month in Dhaka (the seed's history starts the day before today). */
const dhakaDay = () =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric' }).format());

for (const size of SIZES) {
  test.describe(size.name, () => {
    test.use({ viewport: size.viewport, isMobile: size.isMobile, hasTouch: size.hasTouch });

    test('monthly register: students × days, totals, CSV, print-ready', async ({ page }) => {
      await passwordLogin(page, DEMO.shaplaTeacher);
      await expect(page).toHaveURL(/\/dashboard$/);
      await page.goto('/attendance/register');
      const table = page.getByTestId('register-table');
      await expect(table).toBeVisible();
      // Class 6 ক: the full demo class (rolls 1–27).
      await expect(table.locator('tbody tr')).toHaveCount(27);
      // Earlier this month has seeded registers; on the 1st or 2nd, look at last month.
      if (dhakaDay() <= 2) await page.getByRole('button', { name: 'আগের মাস' }).click();
      await expect(page.getByTestId('register-report')).toContainText(/দিন হাজিরা নেওয়া হয়েছে/);
      await expect(table.locator('tbody td span', { hasText: 'উ' }).first()).toBeVisible();
      await expectClean(page, `register ${size.name}`);

      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByTestId('register-csv').click(),
      ]);
      expect(download.suggestedFilename()).toMatch(/\.csv$/);
      const bytes = fs.readFileSync((await download.path())!);
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM for Excel
      const csv = bytes.toString('utf8');
      expect(csv.split('\r\n')[0]).toMatch(/^﻿রোল,আইডি,নাম,/);
      expect(csv).toContain('তাসনিম রহমান');
      expect(csv).not.toMatch(/[০-৯]/); // numbers stay ASCII

      // A student's name opens their attendance % for the month.
      await table.locator('tbody tr').first().getByRole('link').click();
      await expect(page).toHaveURL(/\/attendance\/students\/.+\?from=/);
      await expect(page.getByTestId('student-percent')).toContainText('%');
      await expectClean(page, `student report ${size.name}`);
    });

    test('settings: template preview with SMS count, holidays, section teachers', async ({
      page,
    }) => {
      await passwordLogin(page, DEMO.shaplaOwner);
      await expect(page).toHaveURL(/\/dashboard$/);
      await page.goto('/attendance/settings');
      await expect(page.getByTestId('settings-sms')).toBeVisible();
      await expect(page.getByTestId('settings-holidays')).toContainText('বিজয় দিবস');
      await expect(page.getByTestId('section-teachers').first()).toBeVisible();

      // SMS off by default: the editor is there but disabled until it is turned on.
      const template = page.getByTestId('sms-template');
      await expect(template).toBeDisabled();
      await page.getByRole('switch', { name: 'অনুপস্থিত হলে অভিভাবককে SMS পাঠান' }).check();
      await template.fill('{student} আজ স্কুলে আসেনি। {institute}');
      await expect(page.getByTestId('sms-preview')).toContainText(
        'আরিফ হোসেন আজ স্কুলে আসেনি। শাপলা উচ্চ বিদ্যালয়',
      );
      await expect(page.getByTestId('sms-length')).toContainText('১টি SMS');
      await template.fill('{student} {roll}');
      await expect(page.getByTestId('settings-sms').getByRole('alert')).toContainText(
        'অজানা শব্দ: {roll}',
      );
      await expect(page.getByTestId('settings-save')).toBeDisabled();
      await expectClean(page, `settings ${size.name}`);
      // Nothing saved: reload shows SMS still off.
      await page.reload();
      await expect(page.getByTestId('sms-template')).toBeDisabled();
    });
  });
}

test('settings are saved and audited (edit window)', async ({ page }) => {
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto('/attendance/settings');
  const days = page.getByLabel('শিক্ষকেরা কত দিন আগের হাজিরা বদলাতে পারবেন');
  await days.fill('2');
  await page.getByTestId('settings-save').click();
  await expect(page.getByText('সংরক্ষণ হয়েছে')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('শিক্ষকেরা কত দিন আগের হাজিরা বদলাতে পারবেন')).toHaveValue('2');
  await page.getByLabel('শিক্ষকেরা কত দিন আগের হাজিরা বদলাতে পারবেন').fill('0');
  await page.getByTestId('settings-save').click();
  await expect(page.getByText('সংরক্ষণ হয়েছে')).toBeVisible();
});

// One guardian login (OTP resend cooldown per phone), checked on a phone and then on a desktop.
test.describe('guardian calendar', () => {
  test.use({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });

  test('a month calendar per child, phone and desktop', async ({ page }) => {
    await otpLoginWithBanglaDigits(page, DEMO.shaplaGuardian);
    const calendars = page.getByTestId('child-calendar');
    await expect(calendars).toHaveCount(2);
    const first = calendars.first();
    if (dhakaDay() <= 2) await first.getByRole('button', { name: 'আগের মাস' }).click();
    await expect(first.getByTestId('child-percent')).toContainText(/এই মাসে .+% উপস্থিত/);
    // Fridays are the weekly day off: greyed, never a status.
    await expect(first.getByRole('listitem', { name: /: ছুটির দিন/ }).first()).toBeVisible();
    await expectClean(page, 'guardian calendar 360');
    await page.setViewportSize({ width: 1440, height: 900 });
    await expectClean(page, 'guardian calendar 1440');
    await first.getByRole('button', { name: 'আগের মাস' }).click();
    await expect(first.getByTestId('child-percent')).toBeVisible();
  });
});

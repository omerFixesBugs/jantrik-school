import { expect, test } from '@playwright/test';
import type { SmsDailyStatus } from '@jantrik/shared';
import { DEMO, otpLoginWithBanglaDigits, passwordLogin } from './helpers';
import { findLayoutProblems } from './layout-check';

test('staff dashboard: Bangla date, student total, getting-started steps', async ({ page }) => {
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page).toHaveURL(/\/dashboard$/);

  // users.name_bn in the Bangla UI.
  await expect(page.getByRole('heading', { level: 2, name: /আব্দুল করিম/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /মোট শিক্ষার্থী/ })).toContainText('৩০'); // Bangla digits
  // The seed has a month of past attendance, so only "turn on absent SMS" is left (off by
  // default); it opens the SMS settings.
  const steps = page.getByTestId('getting-started');
  await expect(steps).toContainText('শুরু করার ধাপ');
  await expect(steps).toContainText('৬টির মধ্যে ৫টি সম্পন্ন');
  await expect(steps).toContainText('অনুপস্থিতির SMS চালু করুন');
  await expect(steps.getByRole('link', { name: 'খুলুন' })).toHaveAttribute(
    'href',
    '/attendance/settings#settings-sms',
  );
  await page.getByTestId('quick-attendance').click();
  await expect(page).toHaveURL(/\/attendance$/);
});

test('held SMS: the confirm dialog shows the messages and total SMS segments', async ({ page }) => {
  // Only the numbers matter here, so the status is stubbed (no real SMS are held or sent).
  await page.route('**/attendance/sms/today', async (route) => {
    const status: SmsDailyStatus = {
      date: '2026-10-19',
      cap: 60,
      used: 60,
      held: 3,
      heldSegments: 5,
    };
    await route.fulfill({ json: status });
  });
  await page.setViewportSize({ width: 360, height: 780 });
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page).toHaveURL(/\/dashboard$/);
  const held = page.getByTestId('held-sms');
  await expect(held).toContainText('আজ ৩টি SMS পাঠানো হয়নি');
  await held.getByRole('button', { name: 'আটকে থাকা SMS পাঠান' }).click();
  const dialog = page.getByTestId('held-confirm');
  await expect(dialog.getByRole('heading')).toHaveText('৩টি বার্তা এখন পাঠাবেন?');
  await expect(dialog.getByTestId('held-confirm-count')).toHaveText('৩টি');
  await expect(dialog.getByTestId('held-confirm-segments')).toHaveText('৫টি SMS');
  expect(await findLayoutProblems(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'এখন না' }).click();
  await expect(dialog).toBeHidden();
});

test('guardian dashboard shows only their own children', async ({ page }) => {
  // Habibur Rahman: father of Tasnim and Tahmid (siblings) at Shapla school.
  await otpLoginWithBanglaDigits(page, DEMO.shaplaGuardian);
  await expect(page).toHaveURL(/\/dashboard$/);

  const children = page.getByTestId('children');
  // One card per child (each card also lists the days of its attendance calendar).
  await expect(children.locator(':scope > li')).toHaveCount(2);
  await expect(children).toContainText('তাসনিম রহমান');
  await expect(children).toContainText('তাহমিদ রহমান');
  await expect(children).toContainText('SHS-2026-0001'); // IDs stay ASCII
  await expect(children).not.toContainText('অর্পিতা দাস'); // another family's child

  // Guardians get no staff pages.
  const nav = page.getByRole('navigation', { name: 'নেভিগেশন' });
  await expect(nav.getByRole('link', { name: 'শিক্ষার্থী তালিকা' })).toHaveCount(0);
  await expect(page.getByTestId('module-card-attendance')).toHaveCount(0);
});

import { expect, test } from '@playwright/test';
import { DEMO, otpLoginWithBanglaDigits, passwordLogin } from './helpers';

test('staff dashboard: Bangla date, student total, getting-started steps', async ({ page }) => {
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page).toHaveURL(/\/dashboard$/);

  // users.name_bn in the Bangla UI.
  await expect(page.getByRole('heading', { level: 2, name: /আব্দুল করিম/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /মোট শিক্ষার্থী/ })).toContainText('৩০'); // Bangla digits
  // The last step ticks itself once any attendance exists; then the whole list goes away.
  // attendance.spec may have run first in this run (the e2e DB is reset per run, so "taken
  // today" here means "ever taken"): read which case it is from the attendance card.
  const card = page.getByTestId('module-card-attendance');
  await expect(card).toContainText(/\/|এখনো কোনো হাজিরা নেওয়া হয়নি/);
  const taken = (await card.textContent())!.includes('/');
  const steps = page.getByTestId('getting-started');
  if (taken) {
    await expect(steps).toBeHidden();
  } else {
    await expect(steps).toContainText('শুরু করার ধাপ');
    await expect(steps).toContainText('৫টির মধ্যে ৪টি সম্পন্ন'); // only "first attendance" left
  }
  await page.getByTestId('quick-attendance').click();
  await expect(page).toHaveURL(/\/attendance$/);
});

test('guardian dashboard shows only their own children', async ({ page }) => {
  // Habibur Rahman: father of Tasnim and Tahmid (siblings) at Shapla school.
  await otpLoginWithBanglaDigits(page, DEMO.shaplaGuardian);
  await expect(page).toHaveURL(/\/dashboard$/);

  const children = page.getByTestId('children');
  await expect(children.getByRole('listitem')).toHaveCount(2);
  await expect(children).toContainText('তাসনিম রহমান');
  await expect(children).toContainText('তাহমিদ রহমান');
  await expect(children).toContainText('SHS-2026-0001'); // IDs stay ASCII
  await expect(children).not.toContainText('অর্পিতা দাস'); // another family's child

  // Guardians get no staff pages.
  const nav = page.getByRole('navigation', { name: 'নেভিগেশন' });
  await expect(nav.getByRole('link', { name: 'শিক্ষার্থী তালিকা' })).toHaveCount(0);
  await expect(page.getByTestId('module-card-attendance')).toHaveCount(0);
});

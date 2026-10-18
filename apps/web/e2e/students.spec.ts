import { expect, test, type Page } from '@playwright/test';
import { DEMO, passwordLogin } from './helpers';
import { findLayoutProblems } from './layout-check';

async function expectClean(page: Page, where: string) {
  await page.waitForLoadState('networkidle');
  const problems = await findLayoutProblems(page);
  expect(problems, `${where}: ${JSON.stringify(problems, null, 1)}`).toEqual([]);
}

test.use({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });

test('admission with Bangla digits → profile → deactivate', async ({ page }) => {
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto('/students');
  await page.getByTestId('admit-student').tap();
  const form = page.getByTestId('admission-form');
  await expect(form).toBeVisible();

  // Nothing filled in: the form says what is missing.
  await page.getByTestId('admit').tap();
  await expect(form).toContainText('বাংলা বা ইংরেজিতে একটি নাম লিখুন');
  await expect(form).toContainText('সঠিক মোবাইল নম্বর লিখুন');
  await expectClean(page, 'admission errors');

  await page.locator('#st-name-bn').fill('নুসরাত জাহান');
  await page.locator('#st-name-en').fill('Nusrat Jahan');
  await page.locator('#st-gender').selectOption('FEMALE');
  await page.locator('#enrol-class').selectOption({ label: 'নবম শ্রেণি' });
  await page.locator('#enrol-section').selectOption({ index: 1 });
  await page.locator('#enrol-roll').fill('৩৩');
  const guardian = page.getByTestId('guardian-row').first();
  await guardian.getByLabel(/^মোবাইল নম্বর/).fill('০১৮১১০০০৯৯৯');
  await guardian.getByLabel('নাম (বাংলায়)').fill('জাহানারা বেগম');
  await guardian.getByLabel('সম্পর্ক').selectOption('MOTHER');
  // A wrong birth registration number is caught before sending.
  await page.locator('#st-birth-reg').fill('১২৩');
  await page.getByTestId('admit').tap();
  await expect(form).toContainText('জন্ম নিবন্ধন নম্বর ১৭ অঙ্কের হয়');
  await page.locator('#st-birth-reg').fill('২০১১ ২৬৯২ ৫১২৩ ৪৫৬৭ ১');
  await page.getByTestId('admit').tap();

  // Profile.
  const profile = page.getByTestId('student-profile');
  await expect(profile).toContainText('নুসরাত জাহান');
  await expect(page.getByTestId('student-code')).toHaveText(/^SHS-2026-\d{4}$/);
  await expect(page.getByTestId('profile-details-list')).toContainText('20112692512345671');
  await expect(page.getByTestId('profile-guardians-list')).toContainText('01811-000999');
  await expect(page.getByTestId('profile-guardians-list')).toContainText('অ্যাপে লগইন করতে পারেন');
  await expect(page.getByTestId('enrolment-row').first()).toContainText('রোল: 33');
  await expectClean(page, 'profile');

  // Deactivate: read-only afterwards.
  await page.getByTestId('deactivate').tap();
  await page.getByTestId('confirm-dialog').getByRole('button', { name: 'নিষ্ক্রিয় করুন' }).tap();
  await expect(profile).toContainText('তারিখে নিষ্ক্রিয় করা হয়েছে');
  await expect(page.getByTestId('edit-student')).toHaveCount(0);
  await expect(page.getByTestId('enrolment-row').first()).not.toContainText('রোল');
});

test('teachers see the list and profiles, but no admission', async ({ page }) => {
  await passwordLogin(page, DEMO.shaplaTeacher);
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto('/students');
  await expect(page.getByTestId('students-cards')).toBeVisible();
  await expect(page.getByTestId('admit-student')).toHaveCount(0);
  await page.getByTestId('students-cards').getByRole('link').first().tap();
  await expect(page.getByTestId('student-profile')).toBeVisible();
  await expect(page.getByTestId('edit-student')).toHaveCount(0);
});

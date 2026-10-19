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

test('a sibling: the known guardian phone shows the existing guardian to pick', async ({
  page,
}) => {
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page).toHaveURL(/\/dashboard$/);
  const admit = async (
    nameBn: string,
    fill: (g: ReturnType<Page['getByTestId']>) => Promise<void>,
  ) => {
    await page.goto('/students/new');
    await page.locator('#st-name-bn').fill(nameBn);
    await page.locator('#enrol-class').selectOption({ label: 'নবম শ্রেণি' });
    await fill(page.getByTestId('guardian-row').first());
  };

  // The first child brings a new guardian.
  await admit('রুমানা আক্তার', async (g) => {
    await g.getByLabel(/^মোবাইল নম্বর/).fill('০১৮১১০০০৮৮৮');
    await g.getByLabel('নাম (বাংলায়)').fill('রহিমা খাতুন');
    await expect(g.getByTestId('guardian-matches')).toHaveCount(0);
  });
  await page.getByTestId('admit').tap();
  await expect(page.getByTestId('student-profile')).toContainText('রুমানা আক্তার');

  // The sibling: the same phone lists her (with the child) to pick, or add a new guardian.
  await admit('রায়হান আহমেদ', async (g) => {
    await g.getByLabel(/^মোবাইল নম্বর/).fill('01811000888');
    const matches = g.getByTestId('guardian-matches');
    await expect(matches).toContainText('রহিমা খাতুন');
    await expect(matches).toContainText('অভিভাবক: রুমানা আক্তার (নবম শ্রেণি)');
    await expect(g.getByTestId('guardian-match-new')).toBeVisible();
  });
  await page.getByTestId('admit').tap();
  await expect(page.getByTestId('admission-form')).toContainText(
    'আগের একজনকে বেছে নিন, অথবা নতুন অভিভাবক হিসেবে যোগ করুন',
  );
  await expectClean(page, 'guardian choice');
  const guardian = page.getByTestId('guardian-row').first();
  await guardian.getByTestId('guardian-match').first().tap();
  await expect(guardian.getByLabel('নাম (বাংলায়)')).toHaveCount(0); // her stored names are kept
  await page.getByTestId('admit').tap();
  await expect(page.getByTestId('student-profile')).toContainText('রায়হান আহমেদ');
  await expect(page.getByTestId('profile-guardians-list')).toContainText('রহিমা খাতুন');
  await expect(page.getByTestId('profile-guardians-list')).toContainText('01811-000888');
});

test('teachers: full profile for their own section, basics for others; no admission', async ({
  page,
}) => {
  // Nasrin Akter teaches Class 6 ক: Tasnim (SHS-2026-0001) is hers; SHS-2026-0002 is in Class 9.
  await passwordLogin(page, DEMO.shaplaTeacher);
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto('/students');
  await expect(page.getByTestId('students-cards')).toBeVisible();
  await expect(page.getByTestId('admit-student')).toHaveCount(0);

  const open = async (code: string) => {
    await page.goto('/students');
    await page.getByRole('searchbox').fill(code);
    const card = page.getByTestId('students-cards').getByRole('listitem').filter({ hasText: code });
    await card.getByRole('link').first().tap();
    await expect(page.getByTestId('student-profile')).toBeVisible();
  };

  await open('SHS-2026-0001');
  await expect(page.getByTestId('profile-guardians-list')).toContainText('01811-000101');
  await expect(page.getByTestId('basic-access')).toHaveCount(0);
  await expect(page.getByTestId('edit-student')).toHaveCount(0);

  await open('SHS-2026-0002');
  await expect(page.getByTestId('basic-access')).toBeVisible();
  await expect(page.getByTestId('profile-guardians-list')).toHaveCount(0);
  await expectClean(page, 'basic profile');
});

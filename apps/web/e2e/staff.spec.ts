import { expect, test, type Page } from '@playwright/test';
import { DEMO, otpLoginWithBanglaDigits, passwordLogin } from './helpers';
import { findLayoutProblems } from './layout-check';

async function expectClean(page: Page, where: string) {
  await page.waitForLoadState('networkidle');
  const problems = await findLayoutProblems(page);
  expect(problems, `${where}: ${JSON.stringify(problems, null, 1)}`).toEqual([]);
}

test.use({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });

test('invite a teacher by phone; they accept after logging in; sections; deactivate', async ({
  page,
}) => {
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto('/staff');
  const list = page.getByTestId('staff-list');
  await expect(list).toContainText('আব্দুল করিম');
  // Yourself: no actions menu.
  const me = page.getByTestId('staff-card').filter({ hasText: '(আপনি)' });
  await expect(me.getByRole('button')).toHaveCount(0);
  await expectClean(page, 'staff list');

  await page.getByTestId('add-staff').tap();
  const dialog = page.getByTestId('add-staff-dialog');
  await expect(dialog.getByTestId('otp-note')).toContainText('গ্রহণ করলে তবেই প্রবেশ করতে পারবেন');
  await dialog.getByLabel(/^মোবাইল নম্বর/).fill('০১৭১১০০০৮৮৮'); // Bangla keyboard
  await dialog.getByLabel(/^নাম \(ইংরেজিতে\)/).fill('Rafiq Islam');
  await dialog.getByLabel('নাম (বাংলায়)').fill('রফিক ইসলাম');
  await expectClean(page, 'add staff dialog');
  await dialog.getByRole('button', { name: 'যোগ করুন' }).tap();
  const card = page.getByTestId('staff-card').filter({ hasText: 'রফিক ইসলাম' });
  await expect(card).toContainText('01711-000888');
  await expect(card.getByTestId('invite-status')).toHaveText('আমন্ত্রিত, উত্তরের অপেক্ষায়');
  await expectClean(page, 'staff list with an invitation');

  // Rafiq logs in with OTP, sees the invitation and accepts it.
  await page.context().clearCookies();
  await otpLoginWithBanglaDigits(page, '01711000888');
  await expect(page).toHaveURL(/\/select-institute$/);
  const invitation = page.getByTestId('invitation');
  await expect(invitation).toContainText('শাপলা উচ্চ বিদ্যালয় আপনাকে শিক্ষক হিসেবে যুক্ত করেছে।');
  await expectClean(page, 'invitation');
  await invitation.getByTestId('invitation-accept').tap();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId('institute-name')).toHaveText(DEMO.shaplaName);

  // Back as the owner: sections, then deactivate.
  await page.context().clearCookies();
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto('/staff');
  await expect(card.getByTestId('invite-status')).toHaveCount(0);
  await card.getByRole('button', { name: 'রফিক ইসলাম: আরও কাজ' }).tap();
  await page.getByRole('menuitem', { name: 'শাখা দিন' }).tap();
  const sections = page.getByTestId('sections-dialog');
  await sections.getByRole('checkbox', { name: 'ষষ্ঠ শ্রেণি খ' }).check();
  await sections.getByRole('button', { name: 'সংরক্ষণ করুন' }).tap();
  await expect(card).toContainText('ষষ্ঠ শ্রেণি খ');

  await card.getByRole('button', { name: 'রফিক ইসলাম: আরও কাজ' }).tap();
  await page.getByRole('menuitem', { name: 'নিষ্ক্রিয় করুন' }).tap();
  await page.getByTestId('confirm-dialog').getByRole('button', { name: 'নিষ্ক্রিয় করুন' }).tap();
  await expect(card).toContainText('নিষ্ক্রিয়');
  await expectClean(page, 'staff list after');
});

test('cancel an invitation sent to a wrong number', async ({ page }) => {
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto('/staff');
  await page.getByTestId('add-staff').tap();
  const dialog = page.getByTestId('add-staff-dialog');
  await dialog.getByLabel(/^মোবাইল নম্বর/).fill('01711000777');
  await dialog.getByLabel(/^নাম \(ইংরেজিতে\)/).fill('Wrong Number');
  await dialog.getByRole('button', { name: 'যোগ করুন' }).tap();
  const card = page.getByTestId('staff-card').filter({ hasText: 'Wrong Number' });
  await card.getByRole('button', { name: 'Wrong Number: আরও কাজ' }).tap();
  await page.getByRole('menuitem', { name: 'আমন্ত্রণ বাতিল করুন' }).tap();
  await page
    .getByTestId('confirm-dialog')
    .getByRole('button', { name: 'আমন্ত্রণ বাতিল করুন' })
    .tap();
  await expect(card).toHaveCount(0);
});

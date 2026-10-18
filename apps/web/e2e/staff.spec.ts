import { expect, test, type Page } from '@playwright/test';
import { DEMO, passwordLogin } from './helpers';
import { findLayoutProblems } from './layout-check';

async function expectClean(page: Page, where: string) {
  await page.waitForLoadState('networkidle');
  const problems = await findLayoutProblems(page);
  expect(problems, `${where}: ${JSON.stringify(problems, null, 1)}`).toEqual([]);
}

test.use({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });

test('add a teacher by phone, give a section, deactivate; owners and self are protected', async ({
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
  await expect(dialog.getByTestId('otp-note')).toContainText('ওটিপি দিয়ে লগইন করতে পারবেন');
  await dialog.getByLabel(/^মোবাইল নম্বর/).fill('০১৭১১০০০৮৮৮'); // Bangla keyboard
  await dialog.getByLabel(/^নাম \(ইংরেজিতে\)/).fill('Rafiq Islam');
  await dialog.getByLabel('নাম (বাংলায়)').fill('রফিক ইসলাম');
  await expectClean(page, 'add staff dialog');
  await dialog.getByRole('button', { name: 'যোগ করুন' }).tap();
  const card = page.getByTestId('staff-card').filter({ hasText: 'রফিক ইসলাম' });
  await expect(card).toContainText('01711-000888');
  await expect(card).toContainText('শিক্ষক');

  // Sections.
  await card.getByRole('button', { name: 'রফিক ইসলাম: আরও কাজ' }).tap();
  await page.getByRole('menuitem', { name: 'শাখা দিন' }).tap();
  const sections = page.getByTestId('sections-dialog');
  await sections.getByRole('checkbox', { name: 'ষষ্ঠ শ্রেণি খ' }).check();
  await sections.getByRole('button', { name: 'সংরক্ষণ করুন' }).tap();
  await expect(card).toContainText('ষষ্ঠ শ্রেণি খ');

  // Deactivate.
  await card.getByRole('button', { name: 'রফিক ইসলাম: আরও কাজ' }).tap();
  await page.getByRole('menuitem', { name: 'নিষ্ক্রিয় করুন' }).tap();
  await page.getByTestId('confirm-dialog').getByRole('button', { name: 'নিষ্ক্রিয় করুন' }).tap();
  await expect(card).toContainText('নিষ্ক্রিয়');
  await expectClean(page, 'staff list after');
});

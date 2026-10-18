import { expect, test, type Page } from '@playwright/test';
import type { SetupLabel } from '@jantrik/shared';
import { DEMO, api, apiLogin, passwordLogin } from './helpers';
import { findLayoutProblems } from './layout-check';

async function expectClean(page: Page, where: string) {
  await page.waitForLoadState('networkidle');
  const problems = await findLayoutProblems(page);
  expect(problems, `${where}: ${JSON.stringify(problems, null, 1)}`).toEqual([]);
}

// Labels are tenant-wide: put them back so later specs see the seeded words.
test.afterAll(async () => {
  const token = await apiLogin(DEMO.shaplaOwner);
  const labels = await api<SetupLabel[]>(token, '/setup/labels');
  await api(token, '/setup/labels', {
    method: 'PUT',
    json: { labels: labels.map((l) => ({ key: l.key, bn: l.defaultBn, en: l.defaultEn })) },
  });
});

test.describe('institute setup on a phone', () => {
  test.use({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });

  test('shift, section with that shift, subject; in-use rows offer deactivate only', async ({
    page,
  }) => {
    await passwordLogin(page, DEMO.shaplaOwner);
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.getByRole('button', { name: 'মেনু খুলুন' }).tap();
    await page.getByRole('link', { name: 'প্রতিষ্ঠান সেটআপ' }).tap();
    await expect(page.getByTestId('year-list')).toContainText('চলতি');
    await expectClean(page, 'years');

    // A shift typed with Bangla digits.
    await page.getByRole('link', { name: 'শিফট', exact: true }).tap();
    await page.getByTestId('add-shift').tap();
    const shift = page.getByTestId('shift-dialog');
    await shift.getByLabel('নাম (বাংলায়)').fill('সান্ধ্য');
    await shift.getByLabel('নাম (ইংরেজিতে)').fill('Evening');
    await shift.getByLabel('শুরুর সময়').fill('17:00');
    await shift.getByLabel('শেষের সময়').fill('20:00');
    await shift.getByRole('button', { name: 'সংরক্ষণ করুন' }).tap();
    await expect(page.getByTestId('shift-list')).toContainText('সান্ধ্য');
    await expect(page.getByTestId('shift-list')).toContainText('বিকাল ৫:০০');
    await expectClean(page, 'shifts');

    // A section in Class 7 using it.
    await page.getByRole('link', { name: 'শ্রেণি ও শাখা' }).tap();
    const class7 = page.getByTestId('class-row').filter({ hasText: 'সপ্তম শ্রেণি' });
    await class7.getByRole('button', { name: 'শাখা', exact: true }).tap();
    const section = page.getByTestId('section-dialog');
    await section.getByLabel(/^নাম/).fill('গ');
    await section.getByLabel('শিফট', { exact: true }).selectOption({ label: 'সান্ধ্য' });
    await section.getByLabel('আসন সংখ্যা').fill('৪০');
    await section.getByRole('button', { name: 'সংরক্ষণ করুন' }).tap();
    await expect(class7.getByTestId('section-row')).toContainText('আসন ৪০');
    await expect(class7.getByTestId('section-row')).toContainText('সান্ধ্য');
    await expectClean(page, 'classes');

    // Class 6 has students: delete is disabled, deactivate is offered.
    const class6 = page.getByTestId('class-row').filter({ hasText: 'ষষ্ঠ শ্রেণি' });
    await class6.getByRole('button', { name: 'ষষ্ঠ শ্রেণি: আরও কাজ' }).tap();
    await expect(page.getByRole('menuitem', { name: /মুছে ফেলুন/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(
      page.getByRole('menuitem', { name: 'নিষ্ক্রিয় করুন', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');

    // An optional subject in a group.
    await page.getByRole('link', { name: 'বিষয়', exact: true }).tap();
    await page.getByLabel('শ্রেণি', { exact: true }).selectOption({ label: 'নবম শ্রেণি' });
    await page.getByTestId('add-subject').tap();
    const subject = page.getByTestId('subject-dialog');
    await subject.getByLabel('নাম (বাংলায়)').fill('কৃষিশিক্ষা');
    await subject.getByLabel('নাম (ইংরেজিতে)').fill('Agriculture');
    await subject.getByLabel('কোড').fill('agri');
    await subject.getByLabel('বিভাগ', { exact: true }).selectOption({ label: 'বিজ্ঞান' });
    await subject.getByLabel('ঐচ্ছিক বিষয় (৪র্থ বিষয়)').check();
    await subject.getByRole('button', { name: 'সংরক্ষণ করুন' }).tap();
    const row = page
      .getByTestId('subject-list')
      .getByRole('listitem')
      .filter({ hasText: 'কৃষিশিক্ষা' });
    await expect(row).toContainText('AGRI');
    await expect(row).toContainText('ঐচ্ছিক');
    await expectClean(page, 'subjects');
  });
});

test('labels: rename Section to Batch with a live preview; the app uses it', async ({ page }) => {
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto('/setup/labels');
  const section = page.getByTestId('label-section');
  await section.getByLabel('শাখা / ব্যাচ (বাংলা)').fill('ব্যাচ');
  await section.getByLabel('শাখা / ব্যাচ (ইংরেজি)').fill('Batch');
  await expect(page.getByTestId('labels-preview')).toContainText('ব্যাচ: ক');
  await expect(page.getByTestId('labels-preview')).toContainText('Batch: A');
  await page.getByTestId('labels-save').click();
  await expect(page.getByText('সংরক্ষণ হয়েছে')).toBeVisible();
  // The tabs use the new word at once.
  await expect(page.getByRole('link', { name: 'শ্রেণি ও ব্যাচ' })).toBeVisible();
  await expectClean(page, 'labels 1440');
});

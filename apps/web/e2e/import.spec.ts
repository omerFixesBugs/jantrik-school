import { expect, test, type Page } from '@playwright/test';
import { templateHeader, toCsv } from '@jantrik/shared';
import { DEMO, passwordLogin } from './helpers';
import { findLayoutProblems } from './layout-check';

async function expectClean(page: Page, where: string) {
  await page.waitForLoadState('networkidle');
  const problems = await findLayoutProblems(page);
  expect(problems, `${where}: ${JSON.stringify(problems, null, 1)}`).toEqual([]);
}

test.use({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });

test('import a CSV: auto-matched columns, preview with errors, run, result', async ({ page }) => {
  const csv = toCsv([
    ['nameBn', 'nameEn', 'classLevel', 'guardianPhone', 'guardianNameBn'].map((f) =>
      templateHeader(f as Parameters<typeof templateHeader>[0]),
    ),
    ['ইমপোর্ট এক', 'Import One', 'অষ্টম শ্রেণি', '০১৯৯৯০০০০০১', 'অভিভাবক এক'],
    ['ইমপোর্ট দুই', 'Import Two', 'Class 8', '1999000002', 'অভিভাবক দুই'],
    ['', '', 'Class 99', '123', ''],
  ]);
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto('/students');
  await page.getByTestId('import-students').tap();
  await expect(page.getByTestId('import-page')).toBeVisible();
  await expectClean(page, 'import start');

  await page.getByTestId('import-file').setInputFiles({
    name: 'students.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  await page.getByTestId('import-upload-button').tap();
  const counts = page.getByTestId('import-counts');
  await expect(counts).toContainText('যোগ হবে: ২');
  await expect(counts).toContainText('ত্রুটি: ১');
  const errorRow = page.getByTestId('import-row').first();
  await expect(errorRow).toContainText('সারি ৪');
  await expect(errorRow).toContainText('নাম নেই');
  await expect(errorRow).toContainText('সঠিক মোবাইল নম্বর নয় (123)');
  await expectClean(page, 'import preview');

  await page.getByTestId('import-run').tap();
  await page.getByTestId('confirm-dialog').getByRole('button', { name: 'হ্যাঁ, যোগ করুন' }).tap();
  await expect(page.getByTestId('import-done')).toBeVisible({ timeout: 20_000 });
  await expect(counts).toContainText('যোগ হয়েছে: ২');
  await expect(page.getByTestId('report-bn')).toBeVisible();
  await expectClean(page, 'import done');

  // The students are in the list.
  await page.goto('/students');
  await page.getByRole('searchbox').fill('Import One');
  await expect(page.getByTestId('students-cards')).toContainText('ইমপোর্ট এক');
});

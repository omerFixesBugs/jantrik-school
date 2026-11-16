import { expect, test, type Page } from '@playwright/test';
import { DEMO, passwordLogin } from './helpers';
import { findLayoutProblems } from './layout-check';

async function expectClean(page: Page, where: string) {
  await page.waitForLoadState('networkidle');
  const problems = await findLayoutProblems(page);
  expect(problems, `${where}: ${JSON.stringify(problems, null, 1)}`).toEqual([]);
}

test.use({ viewport: { width: 1366, height: 900 } });

// The new year is made and class 6 promoted into it, but the current year is never switched:
// the specs after this one live in 2026.
test('new year: create it, copy terms, promote class 6, apply, number the rolls, the switch check (P5)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto('/setup');
  await page.getByTestId('new-year-wizard').click();
  await expect(page).toHaveURL(/\/setup\/new-year$/);

  // 1. The year, sections copied.
  await page.getByTestId('create-next-year').click();
  const dialog = page.getByTestId('year-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#year-copy')).toBeChecked();
  await dialog.locator('button[type="submit"]').click();
  await expect(dialog).toHaveCount(0);

  // 2. Fees: the terms, one year later.
  const fees = page.getByTestId('new-year-fees');
  await expect(fees).toBeVisible();
  await page.getByTestId('copy-terms').click();
  await expect(fees.getByRole('status')).toBeVisible();
  await expectClean(page, 'wizard');

  // 3. Class 6's run.
  await page
    .getByTestId('promotion-classes')
    .getByRole('listitem')
    .filter({ hasText: 'ষষ্ঠ শ্রেণি' })
    .getByRole('button')
    .click();
  const run = page.getByTestId('promotion-run');
  await expect(run).toBeVisible();
  await expect(page.getByTestId('run-row').first()).toBeVisible();

  // The grid on a phone: each row stacks, nothing overflows.
  await page.setViewportSize({ width: 390, height: 844 });
  await expectClean(page, 'run grid at 390 px');
  await page.setViewportSize({ width: 1366, height: 900 });

  // One student repeats.
  const first = page.getByTestId('run-row').first();
  await first.locator('select[id^="decision-"]').selectOption('REPEAT');
  await page.getByTestId('save-rows').click();
  await expect(page.getByTestId('save-rows')).toBeDisabled();
  await expect(first.locator('select[id^="decision-"]')).toHaveValue('REPEAT');

  // Apply: in the background, then done.
  await page.getByTestId('apply-run').click();
  await expect(page.getByTestId('run-applied')).toBeVisible({ timeout: 30_000 });

  // 4. Rolls of class 7 in the new year; one typed by hand in Bangla digits.
  await page.goto('/setup/new-year');
  await page.locator('#rolls-class').selectOption({ label: 'সপ্তম শ্রেণি' });
  const preview = page.getByTestId('rolls-preview');
  await expect(preview).toBeVisible();
  await preview.getByTestId('rolls-row').first().locator('input').fill('১২');
  await page.getByTestId('save-rolls').click();
  // Saved as ASCII, and kept from now on.
  await expect(page.getByTestId('save-rolls')).toHaveCount(0);
  await expect(preview).toContainText('12');

  // 5. The switch check names what is not done; the switch waits for the tick.
  await expect(page.getByTestId('switch-warnings')).toBeVisible();
  await expect(page.getByTestId('switch-year')).toBeDisabled();
  await page.locator('#switch-understand').check();
  await expect(page.getByTestId('switch-year')).toBeEnabled();
});

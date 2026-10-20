import { expect, test } from '@playwright/test';
import { DEMO, passwordLogin } from './helpers';

// Two densities from one system (docs/design.md → Density): compact for office roles at a desk,
// comfortable for teachers and phones; the person can switch, and the choice is kept.

test('an owner at a desk gets compact; switching to comfortable is kept after a reload', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page).toHaveURL(/\/dashboard$/);
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-density', 'compact');

  await page.goto('/students');
  const row = page.getByTestId('students-table').locator('tbody tr').first();
  await expect(row).toBeVisible();
  const compactHeight = (await row.boundingBox())!.height;

  await page.getByTestId('user-menu').click();
  await page.getByTestId('density-comfortable').click();
  await expect(html).toHaveAttribute('data-density', 'comfortable');
  await expect.poll(async () => (await row.boundingBox())!.height).toBeGreaterThan(compactHeight);

  await page.reload();
  await expect(html).toHaveAttribute('data-density', 'comfortable');
  await page.getByTestId('user-menu').click();
  await page.getByTestId('density-compact').click();
  await expect(html).toHaveAttribute('data-density', 'compact');
});

test('a teacher gets comfortable, even at a desk', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await passwordLogin(page, DEMO.shaplaTeacher);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.locator('html')).toHaveAttribute('data-density', 'comfortable');
});

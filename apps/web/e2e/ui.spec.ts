import { expect, test } from '@playwright/test';
import { DEMO, passwordLogin } from './helpers';

test('language toggle switches to English and is remembered for the user', async ({ page }) => {
  await passwordLogin(page, DEMO.shaplaTeacher);
  await expect(page.getByRole('link', { name: 'শিক্ষার্থী তালিকা' })).toBeVisible();

  await page.getByTestId('language-toggle').click();
  await expect(page.getByRole('link', { name: 'Student list' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByTestId('academic-year')).toContainText('2026'); // ASCII in English

  await page.reload();
  await expect(page.getByRole('link', { name: 'Student list' })).toBeVisible();

  // Back to Bangla so the shared demo user stays in its default language.
  await page.getByTestId('language-toggle').click();
  await expect(page.getByRole('link', { name: 'শিক্ষার্থী তালিকা' })).toBeVisible();
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('the sidebar is a drawer and students show as cards', async ({ page }) => {
    await passwordLogin(page, DEMO.aloOwner);
    await expect(page).toHaveURL(/\/dashboard$/);

    await page.getByRole('button', { name: 'মেনু খুলুন' }).click();
    await page.getByRole('dialog').getByRole('link', { name: 'শিক্ষার্থী তালিকা' }).click();
    await expect(page).toHaveURL(/\/students$/);
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByTestId('students-cards')).toContainText('ALO-26-001');
    await expect(page.getByTestId('students-table')).toBeHidden();
  });
});

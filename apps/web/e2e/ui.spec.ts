import { expect, test } from '@playwright/test';
import { DEMO, passwordLogin } from './helpers';

test('language toggle switches to English and is remembered for the user', async ({ page }) => {
  await passwordLogin(page, DEMO.shaplaTeacher);
  await expect(page).toHaveURL(/\/dashboard$/);
  const html = page.locator('html');
  // The language is saved on the shared demo user; a run that failed midway may have left it
  // in English. Start from Bangla either way.
  if ((await html.getAttribute('lang')) === 'en') {
    await page.getByTestId('language-toggle').click();
    await expect(html).toHaveAttribute('lang', 'bn');
  }
  await expect(page.getByRole('link', { name: 'শিক্ষার্থী তালিকা' })).toBeVisible();
  const greeting = page.getByRole('heading', { level: 2, name: /,/ });
  await expect(greeting).toContainText('নাসরিন আক্তার'); // name_bn in Bangla

  try {
    await page.getByTestId('language-toggle').click();
    await expect(page.getByRole('link', { name: 'Student list' })).toBeVisible();
    await expect(html).toHaveAttribute('lang', 'en');
    await expect(greeting).toContainText('Nasrin Akter'); // name in English
    await expect(page.getByTestId('academic-year')).toContainText('2026'); // ASCII in English
    // Tenant labels are lowercased mid-sentence in English ("Class" → "class").
    await expect(page.getByRole('link', { name: /^Total students/ })).toContainText(
      'Across every class',
    );

    await page.reload();
    await expect(page.getByRole('link', { name: 'Student list' })).toBeVisible();
  } finally {
    // Back to Bangla so the shared demo user stays in its default language.
    if ((await html.getAttribute('lang')) === 'en') {
      await page.getByTestId('language-toggle').click();
    }
  }
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

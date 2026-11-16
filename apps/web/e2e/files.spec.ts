import { expect, test } from '@playwright/test';
import { DEMO, passwordLogin } from './helpers';

// Sprint 1 P2 (docs/files.md): the institute profile with its logo, and a student's photo. The
// images reach the page through the bearer token as blob: URLs.

/** A 1 × 1 PNG: the server re-encodes it like any upload. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

test.describe('files', () => {
  test.beforeEach(async ({ page }) => {
    await passwordLogin(page, DEMO.shaplaOwner);
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('the owner fills the institute profile and adds a logo', async ({ page }) => {
    await page.goto('/setup/profile');
    const form = page.getByTestId('institute-profile-form');
    // A new profile starts with the registered name (fields by id: "নাম (বাংলা)" is also part of
    // the head's "প্রধানের নাম (বাংলা)").
    await expect(form.locator('#profile-nameBn')).toHaveValue(DEMO.shaplaName);
    await form.locator('#profile-eiin').fill('১০৮১২৩');
    await form.locator('#profile-establishedYear').fill('১৯৬৫');
    await form.getByTestId('profile-save').click();
    await expect(page.getByText('সংরক্ষণ হয়েছে').first()).toBeVisible();
    await page.reload();
    await expect(page.locator('#profile-eiin')).toHaveValue('108123');
    await expect(page.locator('#profile-establishedYear')).toHaveValue('1965');

    const logo = page.getByTestId('image-logo');
    await logo
      .getByTestId('image-logo-choose-input')
      .setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
    await expect(logo.locator('img[src^="blob:"]')).toBeVisible();
    await expect(page.getByTestId('storage-used')).toBeVisible();

    // Removed again, so the demo institute stays as seeded for the other specs.
    await logo.getByTestId('image-logo-remove').click();
    await page.getByTestId('confirm-dialog').getByRole('button', { name: 'সরান' }).click();
    await expect(logo.locator('img')).toHaveCount(0);
  });

  test("an admin adds a student's photo and sees it on the student's page", async ({ page }) => {
    await page.goto('/students');
    // A student's own page (not /students/new or /students/import).
    const student = page.locator('a[href^="/students/0"]').first();
    await expect(student).toBeVisible();
    const href = (await student.getAttribute('href'))!;
    expect(href).toMatch(/^\/students\/[0-9a-f]{8}-[0-9a-f-]{27}$/);
    await page.goto(href);
    const profile = page.getByTestId('student-profile');
    await expect(profile).toBeVisible();

    await page.getByTestId('student-photo-button').click();
    const dialog = page.getByTestId('photo-dialog');
    await dialog
      .getByTestId('photo-choose-input')
      .setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: PNG });
    await expect(dialog.getByTestId('photo-preview')).toBeVisible();
    await dialog.getByTestId('photo-upload').click();
    await expect(dialog).toBeHidden();
    await expect(profile.locator('img[src^="blob:"]').first()).toBeVisible();

    // And removed again (the button now reads "change photo").
    await page.getByTestId('student-photo-button').click();
    await page.getByTestId('photo-dialog').getByTestId('photo-remove').click();
    await expect(page.getByTestId('photo-dialog')).toBeHidden();
    await expect(profile.locator('img[src^="blob:"]')).toHaveCount(0);
  });
});

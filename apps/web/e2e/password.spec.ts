import { expect, test } from '@playwright/test';
import { toBanglaDigits } from '@jantrik/shared';
import { DEMO, logout, otpLoginWithBanglaDigits, passwordLogin, readOtp } from './helpers';

// Sprint 1 P1: staff set their own password from the user menu, after a code sent to their
// phone; guardians stay on codes. Bangla, on a phone.

/** Bangla words and digits: long enough, not common, no phone number, no institute name. */
const NEW_PASSWORD = 'নদীর ধারে বাড়ি 2026';

test.use({ viewport: { width: 390, height: 844 } });

test.describe('staff set their own password', () => {
  test('a teacher signs in with a code, sets a password from the menu and signs in with it; another tab stays signed in', async ({
    page,
    context,
  }) => {
    await otpLoginWithBanglaDigits(page, DEMO.aloTeacher);
    await expect(page).toHaveURL(/\/dashboard/);
    const loginCode = await readOtp(DEMO.aloTeacher);

    // Another tab of this browser: the same session, so it must stay signed in.
    const other = await context.newPage();
    await other.goto('/dashboard');
    await expect(other.getByTestId('user-menu')).toBeVisible();

    await page.getByTestId('user-menu').click();
    await page.getByRole('menuitem', { name: 'পাসওয়ার্ড' }).click();
    await expect(page).toHaveURL(/\/account\/password$/);
    await expect(page.getByRole('heading', { level: 1, name: 'পাসওয়ার্ড' })).toBeVisible();
    await expect(page.getByTestId('password-status')).toContainText('পাসওয়ার্ড সেট করা আছে');

    await page.getByRole('button', { name: 'কোড পাঠান' }).click();
    // The phone, mostly hidden: 01511000002 → 015•••••002 (ASCII digits, as phone numbers are).
    await expect(page.getByTestId('code-sent')).toContainText('015•••••002');
    const code = await readOtp(DEMO.aloTeacher, loginCode);
    await page.getByLabel('যাচাই কোড').pressSequentially(toBanglaDigits(code));

    // The rules, live.
    const password = page.getByLabel('নতুন পাসওয়ার্ড', { exact: true });
    const rule = (name: string) => page.getByTestId(`password-rule-${name}`);
    await password.fill('ছোট');
    await expect(rule('length')).toHaveAttribute('data-ok', 'false');
    await password.fill(`pass ${toBanglaDigits(DEMO.aloTeacher)}`);
    await expect(rule('length')).toHaveAttribute('data-ok', 'true');
    await expect(rule('phone')).toHaveAttribute('data-ok', 'false');
    await password.fill('আলো কোচিং সেন্টার ২০২৬');
    await expect(rule('institute')).toHaveAttribute('data-ok', 'false');
    await password.fill(NEW_PASSWORD);
    for (const name of ['length', 'phone', 'institute']) {
      await expect(rule(name)).toHaveAttribute('data-ok', 'true');
    }

    const confirm = page.getByLabel('পাসওয়ার্ড আবার লিখুন');
    await confirm.fill('অন্য কিছু ১২৩৪৫৬');
    await expect(page.getByText('দুটি পাসওয়ার্ড মিলছে না')).toBeVisible();
    await confirm.fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'পাসওয়ার্ড সেট করুন' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'পাসওয়ার্ড সেট হয়েছে' }),
    ).toBeVisible();
    await expect(page.getByTestId('password-status')).toContainText('শেষ পরিবর্তন');

    // The other tab is still signed in after a reload.
    await other.reload();
    await expect(other.getByTestId('user-menu')).toBeVisible();
    await expect(other).toHaveURL(/\/dashboard/);
    await other.close();

    await logout(page);
    await passwordLogin(page, DEMO.aloTeacher, NEW_PASSWORD);
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('a guardian has no password item, and the page is not available to them', async ({
    page,
  }) => {
    await otpLoginWithBanglaDigits(page, DEMO.arpitaGuardian);
    await expect(page).toHaveURL(/\/dashboard/);
    await page.getByTestId('user-menu').click();
    await expect(page.getByTestId('logout')).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'পাসওয়ার্ড' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.goto('/account/password');
    await expect(page.getByText('দেখা যাচ্ছে না')).toBeVisible();
    await expect(page.getByRole('button', { name: 'কোড পাঠান' })).toHaveCount(0);
  });

  test('the login page tells staff how to get a password', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('tab', { name: 'পাসওয়ার্ড' }).click();
    await expect(
      page.getByText('পাসওয়ার্ড নেই? কোড দিয়ে ঢুকে মেনু থেকে পাসওয়ার্ড সেট করুন।'),
    ).toBeVisible();
  });
});

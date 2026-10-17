import { expect, test } from '@playwright/test';
import { DEMO, logout, otpLoginWithBanglaDigits, passwordLogin } from './helpers';

test('password login → dashboard → only own students → search → logout', async ({ page }) => {
  await passwordLogin(page, DEMO.shaplaOwner);

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId('institute-name')).toHaveText(DEMO.shaplaName);
  await expect(page.getByTestId('academic-year')).toContainText('২০২৬'); // Bangla digits for dates
  for (const card of ['attendance', 'fees', 'exams']) {
    await expect(page.getByTestId(`module-card-${card}`)).toBeVisible();
  }

  await page.getByRole('link', { name: 'শিক্ষার্থী তালিকা' }).click();
  await expect(page).toHaveURL(/\/students$/);
  const table = page.getByTestId('students-table');
  await expect(table.getByRole('row')).toHaveCount(5); // header + 4 shapla students
  await expect(table).toContainText('SHS-2026-0001'); // IDs stay ASCII in the Bangla UI
  await expect(table).not.toContainText('ALO-26'); // never the coaching centre's students

  await page.getByRole('searchbox').fill('তাসনিম');
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table).toContainText('তাসনিম রহমান');
  await expect(table).toContainText('01811-000101'); // guardian phone, ASCII

  await logout(page);
  await expect(page).toHaveURL(/\/login/);
  await page.goto('/students');
  await expect(page).toHaveURL(/\/login\?next=%2Fstudents/);
});

test('OTP login with a Bangla keyboard; a coaching centre sees "Batch" labels', async ({
  page,
}) => {
  await otpLoginWithBanglaDigits(page, DEMO.aloOwner);

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId('institute-name')).toHaveText(DEMO.aloName);
  const nav = page.getByRole('navigation', { name: 'নেভিগেশন' });
  await expect(nav.getByRole('link', { name: 'কোর্স ও ব্যাচ' })).toBeVisible();
  await expect(page.getByTestId('academic-year')).toContainText('সেশন');

  await nav.getByRole('link', { name: 'শিক্ষার্থী তালিকা' }).click();
  await expect(page.getByTestId('section-filter')).toHaveAccessibleName('ব্যাচ');
  await expect(page.getByTestId('class-filter')).toHaveAccessibleName('কোর্স');
  await expect(page.getByTestId('students-table')).toContainText('ALO-26-001');
  await expect(page.getByTestId('students-table')).not.toContainText('SHS-2026');
});

test('a user in two institutes chooses one', async ({ page }) => {
  await passwordLogin(page, DEMO.sharedTeacher);

  await expect(page).toHaveURL(/\/select-institute$/);
  await expect(page.getByRole('button', { name: DEMO.aloName })).toBeVisible();
  await page.getByRole('button', { name: DEMO.shaplaName }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId('institute-name')).toHaveText(DEMO.shaplaName);
});

test('wrong password shows the generic Bangla error', async ({ page }) => {
  await passwordLogin(page, DEMO.aloOwner, 'not-the-password');
  // (Next.js' route announcer is also role=alert, so match by text)
  await expect(
    page.getByRole('alert').filter({ hasText: 'ফোন নম্বর, কোড বা পাসওয়ার্ড সঠিক নয়।' }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test('too many attempts: Bangla countdown, button disabled', async ({ page }) => {
  // A number with no account: the per-identifier limit (5 / 15 min) applies all the same.
  await passwordLogin(page, '01399999990', 'wrong');
  const submit = page.getByRole('button', { name: 'লগইন', exact: true });
  for (let i = 0; i < 4; i++) {
    await expect(submit).toBeEnabled();
    await submit.click();
  }
  await expect(submit).toBeEnabled();
  await submit.click(); // 6th attempt → 429
  const limited = page.getByRole('alert').filter({ hasText: 'অনেকবার চেষ্টা করা হয়েছে' });
  await expect(limited).toBeVisible();
  await expect(limited).toContainText('সেকেন্ড পরে আবার চেষ্টা করুন');
  await expect(submit).toBeDisabled();
});

import { expect, test, type Page } from '@playwright/test';
import { addMonths, todayIn, toBanglaDigits } from '@jantrik/shared';
import { DEMO, otpLoginWithBanglaDigits, totpNow } from './helpers';
import { findLayoutProblems } from './layout-check';

/** The owner the platform invites (not a seeded person). */
const OWNER_PHONE = '01711000777';
const NEW_INSTITUTE = 'নতুন আলো বিদ্যালয়';

async function expectClean(page: Page, where: string) {
  await page.waitForLoadState('networkidle');
  const problems = await findLayoutProblems(page);
  expect(problems, `${where}: ${JSON.stringify(problems, null, 1)}`).toEqual([]);
}

// Step 8, part 1: the platform area for Jantrik's own staff. Password, then an authenticator app
// (set up with a QR code on the first sign-in), 10 backup codes shown once, its own shell.
test.describe.serial('platform sign-in', () => {
  // Sign-in plus the institute flows (and an owner's OTP sign-in): longer than one screen.
  test.describe.configure({ timeout: 120_000 });
  let secret = '';
  let institutePath = '';

  const contextOptions = (baseURL: string | undefined) => ({
    baseURL,
    locale: 'bn-BD',
    timezoneId: 'Asia/Dhaka',
  });

  test('first sign-in at 360 px (Bangla): password, QR enrolment, backup codes, overview', async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      ...contextOptions(baseURL),
      viewport: { width: 360, height: 780 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    // Without a session, the platform area sends you to its own login.
    await page.goto('/platform');
    await expect(page).toHaveURL(/\/platform\/login$/);
    await expectClean(page, 'platform login');

    await page.getByLabel('মোবাইল নম্বর বা ইমেইল').fill(DEMO.platformAdmin);
    await page.getByLabel('পাসওয়ার্ড', { exact: true }).fill(DEMO.password);
    await page.getByRole('button', { name: 'পরবর্তী' }).tap();
    await expect(page.getByTestId('platform-qr')).toBeVisible();
    secret = (await page.getByTestId('platform-secret').innerText()).replace(/\s/g, '');
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    await expectClean(page, 'platform enrolment');

    await page.getByLabel('৬ অঙ্কের কোড').pressSequentially(totpNow(secret));
    const codes = page.getByTestId('platform-backup-codes');
    await expect(codes).toBeVisible(); // the full code signs in by itself
    await expect(codes.getByRole('listitem')).toHaveCount(10);
    await expectClean(page, 'platform backup codes');
    await expect(page.getByTestId('platform-continue')).toBeDisabled();
    await page.getByTestId('platform-backup-saved').check();
    await page.getByTestId('platform-continue').tap();

    await expect(page).toHaveURL(/\/platform$/);
    await expect(page.getByTestId('platform-me')).toContainText('থেকে চালু');
    await expect(page.getByTestId('platform-audit-list')).toContainText('লগইন');
    await expectClean(page, 'platform overview 360');

    // Part 2 at 360 px: institutes as cards, then add one; its owner is invited.
    await page.getByRole('link', { name: 'প্রতিষ্ঠান', exact: true }).tap();
    await expect(page).toHaveURL(/\/platform\/institutes$/);
    await expect(page.getByTestId('institute-cards')).toContainText(DEMO.shaplaName);
    await expectClean(page, 'platform institutes 360');
    await page.getByTestId('add-institute').tap();
    await expect(page).toHaveURL(/\/platform\/institutes\/new$/);
    await expectClean(page, 'new institute 360');
    await page.getByTestId('institute-name').fill(NEW_INSTITUTE);
    await page.getByTestId('institute-slug').fill(`notun-alo-${Date.now().toString(36)}`);
    await page.getByRole('combobox', { name: 'ধরন', exact: true }).selectOption('NCTB_SCHOOL_BN');
    await page.getByTestId('owner-name').fill('Nasima Akter');
    await page.getByLabel('বাংলায় নাম (ঐচ্ছিক)').fill('নাসিমা আক্তার');
    await page.getByTestId('owner-phone').fill(toBanglaDigits(OWNER_PHONE)); // Bangla keyboard
    await page.getByLabel('মূল অংশ, প্রতি শিক্ষার্থী মাসে').fill('10');
    await page.getByTestId('create-institute').tap();
    await expect(page).toHaveURL(/\/platform\/institutes\/[0-9a-f-]{36}$/);
    institutePath = new URL(page.url()).pathname;
    const owner = page.getByTestId('owner-row');
    await expect(owner).toContainText('নাসিমা আক্তার');
    await expect(owner.getByTestId('owner-status')).toHaveText('আমন্ত্রিত');
    await expectClean(page, 'institute detail 360');

    await page.getByTestId('platform-logout').tap();
    await expect(page).toHaveURL(/\/platform\/login$/);
    await page.goto('/platform');
    await expect(page).toHaveURL(/\/platform\/login$/);
    await context.close();
  });

  test('later sign-ins at 1440 px (English): just the app code; the activity log', async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      ...contextOptions(baseURL),
      viewport: { width: 1440, height: 900 },
    });
    await context.addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: baseURL! }]);
    const page = await context.newPage();
    await page.goto('/platform/login');
    await page.getByLabel('Mobile number or email').fill(DEMO.platformAdmin);
    await page.getByLabel('Password', { exact: true }).fill(DEMO.password);
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('heading', { name: 'Verification code' })).toBeVisible();
    await expect(page.getByTestId('platform-qr')).toHaveCount(0);
    await expectClean(page, 'platform code 1440');
    // The next time step: the first sign-in already used the current one (codes work once).
    await page.getByLabel('6-digit code').pressSequentially(totpNow(secret, 1));
    await expect(page).toHaveURL(/\/platform$/);
    await expect(page.getByTestId('platform-me')).toContainText('On since');
    await expectClean(page, 'platform overview 1440');

    await page.getByRole('link', { name: 'Activity log' }).click();
    await expect(page).toHaveURL(/\/platform\/audit$/);
    const log = page.getByTestId('platform-audit-list');
    await expect(log).toContainText('Signed in');
    await expect(log).toContainText('Signed out');
    await expect(log).toContainText('Institute added');
    await expectClean(page, 'platform audit 1440');

    // Part 2 at 1440 px: the institutes table and the new institute's page.
    await page.getByRole('link', { name: 'Institutes', exact: true }).click();
    await expect(page.getByTestId('institute-table')).toContainText(NEW_INSTITUTE);
    await expectClean(page, 'platform institutes 1440');
    await page.goto(institutePath);
    await expect(page.getByTestId('owner-row')).toContainText('Nasima Akter');
    await expectClean(page, 'institute detail 1440');

    // The owner signs in with an OTP (360 px, Bangla), accepts and is in.
    const ownerContext = await browser.newContext({
      ...contextOptions(baseURL),
      viewport: { width: 360, height: 780 },
      isMobile: true,
      hasTouch: true,
    });
    const ownerPage = await ownerContext.newPage();
    await otpLoginWithBanglaDigits(ownerPage, OWNER_PHONE);
    await expect(ownerPage).toHaveURL(/\/select-institute$/);
    const invitation = ownerPage.getByTestId('invitation');
    await expect(invitation).toContainText(
      `${NEW_INSTITUTE} আপনাকে প্রতিষ্ঠান প্রধান হিসেবে যুক্ত করেছে।`,
    );
    await invitation.getByTestId('invitation-accept').tap();
    await expect(ownerPage).toHaveURL(/\/dashboard$/);
    await expect(ownerPage.getByTestId('institute-name')).toHaveText(NEW_INSTITUTE);
    await page.reload();
    await expect(page.getByTestId('owner-row').getByTestId('owner-status')).toHaveText('Owner');

    // Suspended by the platform: the owner is out at the next request; reactivated: back in.
    await page.getByTestId('suspend-institute').click();
    const dialog = page.getByTestId('status-dialog');
    await dialog.getByTestId('status-reason').fill('Invoice unpaid');
    await expectClean(page, 'suspend dialog 1440');
    await dialog.getByRole('button', { name: 'Suspend' }).click();
    await expect(page.getByTestId('institute-suspended')).toBeVisible();
    await expectClean(page, 'suspended institute 1440');
    // The owner's next request is refused: back to the picker, the institute marked unavailable.
    await ownerPage.reload();
    await expect(ownerPage).toHaveURL(/\/select-institute$/);
    await expect(ownerPage.getByText('সাময়িকভাবে বন্ধ')).toBeVisible();
    await expect(ownerPage.getByRole('button', { name: new RegExp(NEW_INSTITUTE) })).toBeDisabled();
    await expectClean(ownerPage, 'owner while suspended');
    await page.getByTestId('reactivate-institute').click();
    await dialog.getByTestId('status-reason').fill('Paid in cash');
    await dialog.getByRole('button', { name: 'Reactivate' }).click();
    await expect(page.getByTestId('institute-suspended')).toHaveCount(0);
    await ownerPage.reload();
    await expect(ownerPage).toHaveURL(/\/dashboard$/);
    await expect(ownerPage.getByTestId('institute-name')).toHaveText(NEW_INSTITUTE);

    // Part 3: the trial ends (activate), a flat plan billed from two months ago, that month's
    // invoice issued 30 days ago: overdue. A part payment; the owner sees a gentle notice.
    const billedMonth = addMonths(todayIn('Asia/Dhaka').slice(0, 7), -2);
    const issued = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    await page.getByTestId('activate-institute').click();
    await dialog.getByTestId('status-reason').fill('Trial over');
    await dialog.getByRole('button', { name: 'Activate' }).click();
    await expect(page.getByTestId('activate-institute')).toHaveCount(0);
    await page.getByTestId('edit-plan').click();
    const planDialog = page.getByTestId('plan-dialog');
    await planDialog.getByLabel('Flat price', { exact: true }).check();
    await planDialog.getByLabel('Flat price a month').fill('500');
    await planDialog
      .getByRole('combobox', { name: 'First month invoiced' })
      .selectOption(`${billedMonth}-01`);
    await expectClean(page, 'plan dialog 1440');
    await planDialog.getByRole('button', { name: 'Save plan' }).click();
    await expect(planDialog).toHaveCount(0);

    await page.getByRole('link', { name: 'Billing', exact: true }).click();
    await expect(page).toHaveURL(/\/platform\/billing$/);
    await page.locator('#generate-month').selectOption(billedMonth);
    await page.locator('#generate-issued').fill(issued);
    await page.getByTestId('generate').click();
    await expect(page.getByTestId('generate-result')).toContainText('issued');
    await page.getByTestId('filter-overdue').check();
    const row = page
      .getByTestId('invoice-table')
      .getByRole('row', { name: new RegExp(NEW_INSTITUTE) });
    await expect(row).toContainText('Overdue');
    await expectClean(page, 'billing 1440');
    await row.getByRole('button', { name: 'Open' }).click();
    const invoice = page.getByTestId('invoice-dialog');
    await expect(invoice.getByTestId('invoice-lines')).toContainText('৳500');
    await invoice.getByTestId('record-payment').click();
    await invoice.getByTestId('payment-amount').fill('200');
    await invoice.getByRole('button', { name: 'Save payment' }).click();
    await expect(invoice.getByTestId('invoice-payments')).toContainText('৳200');
    await expectClean(page, 'invoice dialog 1440');
    await page.keyboard.press('Escape');

    // The owner's dashboard (360 px, Bangla): still ৳300 overdue.
    await ownerPage.reload();
    const notice = ownerPage.getByTestId('billing-notice');
    await expect(notice).toContainText('৩০০');
    await expectClean(ownerPage, 'owner billing notice 360');

    // Part 4 at 1440 px: the SMS rate (৳0.25 from now on), then the month's usage.
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL(/\/platform\/settings$/);
    await page.getByTestId('sms-cost').fill('0.25');
    await page.getByTestId('save-sms-cost').click();
    await expect(page.getByTestId('settings-updated')).toContainText('Last changed by');
    await expectClean(page, 'settings 1440');
    await page.getByRole('link', { name: 'Usage', exact: true }).click();
    await expect(page.getByTestId('usage-total')).toContainText('৳0.25');
    await expect(page.getByTestId('usage-table')).toContainText(NEW_INSTITUTE);
    await expectClean(page, 'usage 1440');

    // The billing page at 360 px in Bangla (same admin session).
    await page.setViewportSize({ width: 360, height: 780 });
    await context.addCookies([{ name: 'NEXT_LOCALE', value: 'bn', url: baseURL! }]);
    await page.goto('/platform/billing');
    await expect(page.getByTestId('invoice-cards')).toContainText(NEW_INSTITUTE);
    await expectClean(page, 'billing 360 bn');
    await page.goto('/platform/usage');
    await expect(page.getByTestId('usage-cards')).toContainText(NEW_INSTITUTE);
    await expectClean(page, 'usage 360 bn');
    await page.goto('/platform/settings');
    await expect(page.getByTestId('sms-cost')).toHaveValue('0.25');
    await expectClean(page, 'settings 360 bn');
    await ownerContext.close();
    await context.close();
  });
});

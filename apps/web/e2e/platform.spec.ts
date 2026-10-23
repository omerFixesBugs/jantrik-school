import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { addDays, addMonths, todayIn, toBanglaDigits } from '@jantrik/shared';
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
  test.describe.configure({ timeout: 150_000 });
  let secret = '';
  let institutePath = '';
  /** The new owner's signed-in browser state, for the rest of the setup wizard (part 5). */
  let ownerState: Awaited<ReturnType<BrowserContext['storageState']>> | undefined;

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

    // The owner signs in with an OTP (360 px, Bangla), accepts and lands in the setup wizard.
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
    await expect(ownerPage).toHaveURL(/\/setup\/welcome$/);
    await expect(ownerPage.getByTestId('institute-name')).toHaveText(NEW_INSTITUTE);

    // Part 5: step 1, the academic year made from the platform's dates: right, next.
    await expect(ownerPage.getByTestId('setup-wizard')).toContainText(
      `${NEW_INSTITUTE} সাজিয়ে নিন`,
    );
    await expect(ownerPage.getByTestId('wizard-step-year')).toContainText('ধাপ ১ / ৬');
    await expect(ownerPage.getByTestId('wizard-year-name')).toBeVisible();
    await expectClean(ownerPage, 'wizard year 360');
    await ownerPage.getByTestId('wizard-done').tap();
    // Step 2: the template's classes; a section for the first one, then next.
    await expect(ownerPage).toHaveURL(/\/setup\/welcome\?step=classes$/);
    const firstClass = ownerPage.getByTestId('wizard-class').first();
    await expect(firstClass).toContainText('কোনো শাখা নেই');
    await expectClean(ownerPage, 'wizard classes 360');
    await firstClass.getByRole('button').tap();
    const sectionDialog = ownerPage.getByTestId('section-dialog');
    await sectionDialog.locator('#section-name').fill('ক');
    await expectClean(ownerPage, 'wizard section dialog 360');
    await sectionDialog.getByRole('button', { name: 'সংরক্ষণ করুন' }).tap();
    await expect(sectionDialog).toHaveCount(0);
    await expect(firstClass).not.toContainText('কোনো শাখা নেই');
    await expect(firstClass.getByText('ক', { exact: true })).toBeVisible();
    await ownerPage.getByTestId('wizard-done').tap();
    await expect(ownerPage.getByTestId('wizard-step-shifts')).toBeVisible();
    await expect(ownerPage.getByTestId('wizard-nav-classes')).toHaveAccessibleName(/হয়েছে/);
    // Later: the dashboard offers to continue where it stopped.
    await ownerPage.getByTestId('wizard-later').tap();
    await expect(ownerPage).toHaveURL(/\/dashboard$/);
    await expect(ownerPage.getByTestId('continue-setup')).toHaveText(/সেটআপ চালিয়ে যান/);
    await expectClean(ownerPage, 'dashboard continue setup 360');
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
    const issued = addDays(todayIn('Asia/Dhaka'), -30);
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
    ownerState = await ownerContext.storageState();
    await ownerContext.close();
    await context.close();
  });

  test('the new owner finishes the setup wizard at 1440 px (English)', async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      ...contextOptions(baseURL),
      viewport: { width: 1440, height: 900 },
      storageState: ownerState,
    });
    await context.addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: baseURL! }]);
    const page = await context.newPage();
    await page.goto('/dashboard');
    await expect(page.getByTestId('institute-name')).toHaveText(NEW_INSTITUTE);
    await expectClean(page, 'dashboard continue setup 1440');
    await page.getByTestId('continue-setup').click();
    // Back at the first open step; the steps so far are marked.
    await expect(page).toHaveURL(/\/setup\/welcome\?step=shifts$/);
    await expect(page.getByTestId('wizard-nav-year')).toHaveAccessibleName(/\(done\)/);
    await expect(page.getByTestId('wizard-step-shifts')).toContainText('Step 3 of 6');
    await expectClean(page, 'wizard shifts 1440');

    // Step 3: a morning shift.
    await page.getByTestId('wizard-add-shift').click();
    const shiftDialog = page.getByTestId('shift-dialog');
    await shiftDialog.locator('#shift-bn').fill('প্রভাতি');
    await shiftDialog.locator('#shift-en').fill('Morning');
    await shiftDialog.locator('#shift-start').fill('07:00');
    await shiftDialog.locator('#shift-end').fill('12:00');
    await shiftDialog.getByRole('button', { name: 'Save' }).click();
    await expect(shiftDialog).toHaveCount(0);
    await expect(page.getByTestId('wizard-shifts')).toContainText('Morning');
    await page.getByTestId('wizard-done').click();

    // Step 4: a teacher, invited by phone.
    await expect(page.getByTestId('wizard-step-teachers')).toBeVisible();
    await page.getByTestId('wizard-add-staff').click();
    const staffDialog = page.getByTestId('add-staff-dialog');
    await staffDialog.locator('#staff-phone').fill('01711000778');
    await staffDialog.locator('#staff-name').fill('Rafiq Hasan');
    await staffDialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(staffDialog).toHaveCount(0);
    const staff = page.getByTestId('wizard-staff');
    await expect(staff).toContainText('Rafiq Hasan');
    await expect(staff).toContainText('Invited, waiting for an answer');
    await expectClean(page, 'wizard teachers 1440');
    await page.getByTestId('wizard-done').click();

    // Step 5: the import page keeps a way back to the wizard; this step is skipped.
    await expect(page.getByTestId('wizard-step-students')).toContainText('Added so far: 0');
    await page.getByTestId('wizard-import').click();
    await expect(page).toHaveURL(/\/students\/import\?from=setup$/);
    await expect(page.getByTestId('import-page')).toBeVisible();
    await page.getByTestId('back-to-setup').click();
    await expect(page).toHaveURL(/\/setup\/welcome\?step=students$/);
    await page.getByTestId('wizard-skip').click();

    // Step 6: attendance every period, absent SMS on; finishing saves both.
    await expect(page.getByTestId('wizard-step-attendance')).toBeVisible();
    await page.getByRole('radio', { name: 'Every period or class' }).check();
    await page
      .getByRole('switch', { name: 'Send guardians an SMS when a student is absent' })
      .check();
    await expectClean(page, 'wizard attendance 1440');
    await page.getByTestId('wizard-done').click();
    await expect(page.getByTestId('wizard-finished')).toContainText('All set');
    await expectClean(page, 'wizard finished 1440');
    await page.getByRole('link', { name: 'Go to the dashboard' }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByTestId('billing-notice')).toBeVisible();
    await expect(page.getByTestId('continue-setup')).toHaveCount(0);
    // Finished: the wizard's page goes to the dashboard; the settings were saved.
    await page.goto('/setup/welcome');
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto('/attendance/settings');
    await expect(page.getByRole('radio', { name: 'Every period or class' })).toBeChecked();
    await expect(
      page.getByRole('switch', { name: 'Send guardians an SMS when a student is absent' }),
    ).toBeChecked();
    await context.close();
  });
});

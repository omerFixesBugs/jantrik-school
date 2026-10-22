import { toBanglaDigits } from '@jantrik/shared';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { findLayoutProblems } from './layout-check';
import { DEMO, otpLoginWithBanglaDigits, passwordLogin } from './helpers';

// A guardian pays by bKash to the institute's own number and sends the TrxID; the accountant
// checks it and verifies it (step 9, phase D). Phones: 360 px.
const PHONE = { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true };
test.use(PHONE);

const ACCOUNTANT = '01711000004';

async function useLanguage(page: Page, lang: 'bn' | 'en') {
  await page.context().addCookies([{ name: 'NEXT_LOCALE', value: lang, url: page.url() }]);
  await page.reload();
}

async function phoneOf(browser: Browser, baseURL: string | undefined): Promise<Page> {
  const context = await browser.newContext({
    ...PHONE,
    baseURL,
    locale: 'bn-BD',
    timezoneId: 'Asia/Dhaka',
  });
  return context.newPage();
}

// bn: the father of Tasnim and Tahmid pays for Tahmid; en: Tasnim's mother pays for Tasnim
// (two guardians, so the specs do not share one OTP cooldown).
const CASES = [
  { lang: 'bn', guardian: DEMO.shaplaGuardian, child: 'SHS-2026-0002', amount: '১০০' },
  { lang: 'en', guardian: DEMO.shaplaGuardian2, child: 'SHS-2026-0001', amount: '100' },
] as const;

for (const c of CASES) {
  test(`${c.lang}: a guardian submits a TrxID, the accountant verifies it`, async ({
    page,
    browser,
    baseURL,
  }) => {
    test.slow();
    // A TrxID nobody has used (6–20 letters and digits), typed in lower case with a space.
    const trx = `E2E${Date.now().toString(36).toUpperCase()}`;

    await otpLoginWithBanglaDigits(page, c.guardian);
    await expect(page).toHaveURL(/\/dashboard$/);
    await useLanguage(page, c.lang);
    const card = page.getByTestId('children').locator('li').filter({ hasText: c.child });
    await card.getByTestId('child-fees-open').click();

    const fees = page.getByTestId('child-fees');
    await expect(fees.getByTestId('child-due').first()).toBeVisible();
    expect(await findLayoutProblems(page)).toEqual([]);

    await page.getByTestId('child-pay-open').click();
    await page.getByTestId('pay-next').click();
    await page.getByTestId('pay-account').first().check();
    await page.getByTestId('pay-amount').fill(c.amount);
    await page.getByTestId('pay-trx').fill(`${trx.slice(0, 4).toLowerCase()} ${trx.slice(4)}`);
    await page.getByTestId('pay-sender').fill(toBanglaDigits('01811222333'));
    await page.getByTestId('pay-submit').click();
    await expect(page.getByTestId('pay-success')).toBeVisible();

    const mine = page.locator(`[data-testid="child-submission"][data-trx="${trx}"]`);
    await page.reload();
    await expect(mine).toHaveAttribute('data-status', 'PENDING');

    // The accountant checks it in the institute's bKash app, then verifies it.
    const accountant = await phoneOf(browser, baseURL);
    await passwordLogin(accountant, ACCOUNTANT);
    await expect(accountant).toHaveURL(/\/dashboard$/);
    await useLanguage(accountant, c.lang);
    await accountant.goto('/fees/submissions');
    const submission = accountant.locator(`[data-testid="submission"][data-trx="${trx}"]`);
    await expect(submission).toHaveAttribute('data-status', 'PENDING');
    expect(await findLayoutProblems(accountant)).toEqual([]);
    await submission.getByTestId('submission-verify').click();
    await accountant.getByTestId('submission-verify-confirm').click();
    // Verified, it leaves the waiting list and shows among the verified ones.
    await expect(
      accountant.locator(`[data-testid="submission"][data-trx="${trx}"][data-status="PENDING"]`),
    ).toHaveCount(0);
    await accountant.goto('/fees/submissions?status=VERIFIED');
    await expect(
      accountant.locator(`[data-testid="submission"][data-trx="${trx}"]`),
    ).toHaveAttribute('data-status', 'VERIFIED');
    await accountant.context().close();

    // The guardian sees it verified, with its receipt.
    await page.reload();
    await expect(mine).toHaveAttribute('data-status', 'VERIFIED');
    const receipt = page.getByTestId('child-receipt').first();
    await expect(receipt).toHaveAttribute('data-receipt-number', /^\d{4}-\d{6}$/);
    await receipt.click();
    await expect(page.getByTestId('receipt')).toContainText(trx);
    expect(await findLayoutProblems(page)).toEqual([]);
    await page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'bn', url: page.url() }]);
  });
}

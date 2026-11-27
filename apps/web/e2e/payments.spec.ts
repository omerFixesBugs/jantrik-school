import { expect, test } from '@playwright/test';
import { DEMO, api, apiLogin, otpLoginWithBanglaDigits, passwordLogin } from './helpers';
import { findLayoutProblems } from './layout-check';

// Online payments (sprint 1 P7a, docs/payments.md). The fake SSLCommerz stands in for the
// sandbox (playwright.config.ts starts it on 127.0.0.1:4090 and points the API at it): nothing
// here reaches SSLCommerz.

/** The fake's store (apps/api/scripts/fake-sslcommerz.ts). */
const FAKE_STORE = { id: 'jantrikfake01', password: 'jantrikfake01@ssl' };
const ADMIN = '01711000003';
const ACCOUNT = '/fees/online-payments/account';

test.describe('online payments setup (P7a1)', () => {
  test('the owner saves the store, tests it, turns it on, and gets the IPN address', async ({
    page,
  }) => {
    test.slow();
    const ownerToken = await apiLogin(DEMO.shaplaOwner);
    try {
      await passwordLogin(page, DEMO.shaplaOwner);
      await expect(page).toHaveURL(/\/dashboard$/);
      await page.goto('/fees/setup/online-payments');
      await expect(page.getByTestId('fees-setup-tab-online')).toHaveAttribute(
        'aria-current',
        'page',
      );
      // Not set up yet (or, on a retry, set up and off).
      await expect(page.getByTestId('fees-online-state')).toHaveText(
        /চালু করা হয়নি|সাজানো আছে, বন্ধ/,
      );

      // Write-only: the fields are empty again once saved, and only the hint is shown.
      await page.getByTestId('fees-online-store-id').fill(FAKE_STORE.id);
      await page.getByTestId('fees-online-store-password').fill(FAKE_STORE.password);
      await page.getByTestId('fees-online-save').click();
      await expect(page.getByTestId('fees-online-hint')).toHaveText('••••ke01');
      await expect(page.getByTestId('fees-online-store-id')).toHaveValue('');
      await expect(page.getByTestId('fees-online-store-password')).toHaveValue('');
      await expect(page.getByTestId('fees-online-state')).toHaveText('সাজানো আছে, বন্ধ');
      // New credentials are untested: not yet on.
      await expect(page.getByTestId('fees-online-enable')).toBeDisabled();
      await expect(page.locator('body')).not.toContainText(FAKE_STORE.password);

      // The test runs on the server; the page waits for its result.
      await page.getByTestId('fees-online-test').click();
      await expect(page.getByTestId('fees-online-test-result')).toHaveText('সংযোগ ঠিক আছে', {
        timeout: 20_000,
      });
      await page.getByTestId('fees-online-enable').click();
      await expect(page.getByTestId('fees-online-state')).toHaveText('চালু');
      await expect(page.getByTestId('fees-online-ipn-url')).toHaveValue(
        /^http:\/\/localhost:4000\/public\/payments\/sslcommerz\/shapla-school\/ipn$/,
      );

      // bn at 1366 and 390 px: nothing clipped or overlapping.
      for (const width of [1366, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForLoadState('networkidle');
        expect(await findLayoutProblems(page), `${width} px`).toEqual([]);
        await page.screenshot({
          path: test.info().outputPath(`online-payments-bn-${width}.png`),
          fullPage: true,
        });
      }
    } finally {
      // Later specs start from an account that is off.
      await api(ownerToken, `${ACCOUNT}/disable`, { method: 'POST' });
    }
  });

  test('an admin has no online payments tab, and the page says who sets it up', async ({
    page,
  }) => {
    await passwordLogin(page, ADMIN);
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto('/fees/setup/numbers');
    await expect(page.getByTestId('fees-setup-tab-numbers')).toBeVisible();
    await expect(page.getByTestId('fees-setup-tab-online')).toHaveCount(0);
    await page.goto('/fees/setup/online-payments');
    await expect(page.getByTestId('fees-online-owner-only')).toBeVisible();
    await expect(page.getByTestId('fees-online-store-id')).toHaveCount(0);
  });
});

// ─────────────────────────── P7a2: checkout to receipt ───────────────────────────

const ACCOUNTANT = '01711000004';
/** Tasnim's father: both his children owe tuition in the seed. */
const CHILD = 'SHS-2026-0002';

/** The owner's account on (the fake's store), as the owner does it; off again afterwards. */
async function onlinePaymentsOn(): Promise<string> {
  const token = await apiLogin(DEMO.shaplaOwner);
  await api(token, ACCOUNT, {
    method: 'PUT',
    json: { storeId: FAKE_STORE.id, storePassword: FAKE_STORE.password },
  });
  const { requestedAt } = await api<{ requestedAt: string }>(token, `${ACCOUNT}/test`, {
    method: 'POST',
  });
  await expect
    .poll(
      async () => {
        const view = await api<{ lastTest: { at: string; result: string } | null }>(token, ACCOUNT);
        return view.lastTest && view.lastTest.at >= requestedAt ? view.lastTest.result : null;
      },
      { timeout: 20_000 },
    )
    .toBe('OK');
  await api(token, `${ACCOUNT}/enable`, { method: 'POST' });
  return token;
}

test.describe('online payments: a guardian pays (P7a2)', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('bn: two dues, the total in Bangla digits, paid on the gateway, back to "paid" and the receipt', async ({
    page,
  }) => {
    test.slow();
    const owner = await onlinePaymentsOn();
    try {
      await otpLoginWithBanglaDigits(page, DEMO.shaplaGuardian);
      await expect(page).toHaveURL(/\/dashboard$/);
      const card = page.getByTestId('children').locator('li').filter({ hasText: CHILD });
      await card.getByTestId('child-fees-open').click();
      await expect(page.getByTestId('child-online-open')).toBeVisible();
      await page.getByTestId('child-online-open').click();
      const sheet = page.getByTestId('online-pay-sheet');
      await expect(sheet).toBeVisible();
      // Two dues ticked, the total in Bangla digits; no amount field anywhere.
      const boxes = sheet.getByTestId('online-due');
      expect(await boxes.count()).toBeGreaterThanOrEqual(2);
      for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).setChecked(i < 2);
      await expect(sheet.getByTestId('online-total')).toHaveText(/^৳\s?[০-৯,.]+$/);
      await expect(sheet.locator('input[inputmode="decimal"]')).toHaveCount(0);
      expect(await findLayoutProblems(page)).toEqual([]);
      await page.screenshot({ path: test.info().outputPath('online-sheet-bn-390.png') });

      // On to the (fake) gateway, pay, and back to the payment's page.
      await sheet.getByTestId('online-continue').click();
      await expect(page).toHaveURL(/127\.0\.0\.1:4090\/pay\//, { timeout: 20_000 });
      await page.getByRole('button', { name: 'Pay' }).click();
      await expect(page).toHaveURL(/\/children\/[^/]+\/fees\/pay\/[^/?]+\?from=gateway$/, {
        timeout: 20_000,
      });
      await expect(page.getByTestId('online-payment-state')).toHaveAttribute('data-state', 'PAID', {
        timeout: 30_000,
      });
      await expect(page.getByTestId('online-payment-amount')).toHaveText(/[০-৯]/);
      await expect(page.getByTestId('online-receipt-number')).toHaveText(/^\d{4}-\d{6}$/);
      expect(await findLayoutProblems(page)).toEqual([]);
      await page.screenshot({ path: test.info().outputPath('online-paid-bn-390.png') });

      await page.getByTestId('online-view-receipt').click();
      const receipt = page.getByTestId('receipt');
      await expect(receipt).toBeVisible();
      await expect(receipt.getByTestId('receipt-method')).toContainText('অনলাইনে (SSLCommerz)');
      await expect(receipt.getByTestId('receipt-total')).toHaveText(/[০-৯]/);
      await expect(receipt.getByTestId('receipt-bank-tran-id')).toHaveText(
        /^[A-Za-z0-9._-]{6,80}$/,
      );
      await expect(receipt.getByTestId('receipt-paid-online')).toBeVisible();
      for (const width of [1366, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await findLayoutProblems(page), `${width} px`).toEqual([]);
        await page.screenshot({
          path: test.info().outputPath(`online-receipt-bn-${width}.png`),
          fullPage: true,
        });
      }
    } finally {
      await api(owner, `${ACCOUNT}/disable`, { method: 'POST' });
    }
  });

  test('bn: cancelled on the gateway → "not paid", start again; the counter sees a payment in progress', async ({
    page,
    browser,
    baseURL,
  }) => {
    test.slow();
    const owner = await onlinePaymentsOn();
    try {
      await otpLoginWithBanglaDigits(page, DEMO.shaplaGuardian);
      const card = page.getByTestId('children').locator('li').filter({ hasText: CHILD });
      await card.getByTestId('child-fees-open').click();
      await page.getByTestId('child-online-open').click();
      await page.getByTestId('online-continue').click();
      await expect(page).toHaveURL(/127\.0\.0\.1:4090\/pay\//, { timeout: 20_000 });

      // While the guardian is on the gateway, the accountant's counter shows the badge.
      const counter = await browser.newPage({ baseURL });
      await passwordLogin(counter, ACCOUNTANT);
      await counter.goto('/fees');
      await counter.getByTestId('fees-search').fill(CHILD);
      await counter.locator(`[data-testid="fees-hit"][data-code="${CHILD}"]`).click();
      await expect(counter.getByTestId('fees-due-online-pending').first()).toBeVisible();
      await counter.screenshot({ path: test.info().outputPath('counter-online-pending-1366.png') });
      await counter.close();

      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByTestId('online-payment-state')).toHaveAttribute(
        'data-state',
        'NOT_PAID',
        { timeout: 30_000 },
      );
      await page.screenshot({ path: test.info().outputPath('online-not-paid-bn-390.png') });
      await page.getByTestId('online-start-again').click();
      await expect(page.getByTestId('online-pay-sheet')).toBeVisible();
    } finally {
      await api(owner, `${ACCOUNT}/disable`, { method: 'POST' });
    }
  });
});

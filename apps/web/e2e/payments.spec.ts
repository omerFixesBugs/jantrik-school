import { expect, test } from '@playwright/test';
import { DEMO, api, apiLogin, passwordLogin } from './helpers';
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

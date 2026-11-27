import { expect, test, type Page } from '@playwright/test';
import { API_URL, DEMO, api, apiLogin, otpLoginWithBanglaDigits, passwordLogin } from './helpers';
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

/**
 * The payer's own "start again" on any payment of theirs still in progress (a failed attempt may
 * leave one at the gateway): later specs sign in as this guardian. Best effort, never failing.
 */
async function abandonLeftOver(token: string): Promise<void> {
  const call = (path: string, method = 'GET') =>
    fetch(`${API_URL}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
  const children = (await (await call('/me/children')).json()) as { id: string }[];
  for (const child of Array.isArray(children) ? children : []) {
    const res = await call(`/me/children/${child.id}/fees`);
    if (!res.ok) continue;
    const fees = (await res.json()) as {
      online?: { inProgress: { intentId: string; mine: boolean } | null };
    };
    const open = fees.online?.inProgress;
    if (open?.mine) {
      await call(`/me/children/${child.id}/fees/online-payments/${open.intentId}/abandon`, 'POST');
    }
  }
}

test.describe('online payments: a guardian pays (P7a2)', () => {
  // One guardian sign-in for both tests, on one page. A phone may have 5 codes in 15 minutes
  // (counted even when the 1-minute cooldown refuses one), and the demo guardian also signs in on
  // the dashboard, fees-mobile and reports specs: two sign-ins here, the second inside the
  // first's minute, spent the last three, and the guardian calendar (reports.spec) then waited
  // out the window, 7.9 minutes (P7a2-x33).
  test.describe.configure({ mode: 'serial' });

  /** The guardian's page, signed in once (beforeAll) and shared by both tests. */
  let shared: Page | undefined;
  let owner: string | undefined;
  /** The page's own access token, from its calls to the API (the clean-up's). */
  let guardianToken: string | undefined;

  test.beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(90_000);
    owner = await onlinePaymentsOn();
    const context = await browser.newContext({
      baseURL: testInfo.project.use.baseURL,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      locale: 'bn-BD',
      timezoneId: 'Asia/Dhaka',
      reducedMotion: 'reduce',
    });
    // Every action and navigation fails within 30 s rather than waiting out the whole test (an
    // element that never appears, a login cut off by the next navigation).
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(30_000);
    const page = await context.newPage();
    shared = page;
    page.on('request', (request) => {
      const auth = request.headers()['authorization'];
      if (request.url().startsWith(API_URL) && auth?.startsWith('Bearer ')) {
        guardianToken = auth.slice('Bearer '.length);
      }
    });
    await otpLoginWithBanglaDigits(page, DEMO.shaplaGuardian);
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });
  });

  test.afterAll(async () => {
    try {
      // No payment left in progress for the specs after this one.
      if (guardianToken) await abandonLeftOver(guardianToken).catch(() => undefined);
    } finally {
      await shared?.context().close();
      if (owner) await api(owner, `${ACCOUNT}/disable`, { method: 'POST' });
    }
  });

  test('bn: two dues, the total in Bangla digits, paid on the gateway, back to "paid" and the receipt', async () => {
    test.slow();
    const page = shared!;
    await page.goto('/dashboard');
    const card = page.getByTestId('children').locator('li').filter({ hasText: CHILD });
    await card.getByTestId('child-fees-open').click();
    // A payment an earlier attempt left at the gateway is given up first (its payer's own
    // "start again" offers the sheet anew).
    const open = page.getByTestId('child-online-open');
    const leftOver = page.getByTestId('child-online-continue');
    await expect(open.or(leftOver)).toBeVisible({ timeout: 30_000 });
    if (await leftOver.isVisible()) {
      if (guardianToken) await abandonLeftOver(guardianToken);
      await page.reload();
    }
    await expect(open).toBeVisible();
    await open.click();
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
    await expect(receipt.getByTestId('receipt-bank-tran-id')).toHaveText(/^[A-Za-z0-9._-]{6,80}$/);
    await expect(receipt.getByTestId('receipt-paid-online')).toBeVisible();
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await findLayoutProblems(page), `${width} px`).toEqual([]);
      await page.screenshot({
        path: test.info().outputPath(`online-receipt-bn-${width}.png`),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test('bn: cancelled on the gateway → "not paid", start again; the counter sees a payment in progress', async ({
    browser,
    baseURL,
  }) => {
    test.slow();
    const page = shared!;
    await page.goto('/dashboard');
    const card = page.getByTestId('children').locator('li').filter({ hasText: CHILD });
    await card.getByTestId('child-fees-open').click();
    // A payment an earlier attempt of this test left at the gateway (a retry) is continued:
    // its page sends the payer straight back to the gateway, as a new one would.
    const open = page.getByTestId('child-online-open');
    const leftOver = page.getByTestId('child-online-continue');
    await expect(open.or(leftOver)).toBeVisible({ timeout: 30_000 });
    if (await leftOver.isVisible()) {
      await leftOver.click();
    } else {
      await open.click();
      await page.getByTestId('online-continue').click();
    }
    await expect(page).toHaveURL(/127\.0\.0\.1:4090\/pay\//, { timeout: 30_000 });

    // While the guardian is on the gateway, the accountant's counter shows the badge. The
    // login must finish before the next navigation, or it is cut off and /fees never opens.
    const counter = await browser.newPage({ baseURL });
    try {
      await passwordLogin(counter, ACCOUNTANT);
      await expect(counter).toHaveURL(/\/dashboard$/, { timeout: 30_000 });
      await counter.goto('/fees');
      await counter.getByTestId('fees-search').fill(CHILD, { timeout: 30_000 });
      await counter
        .locator(`[data-testid="fees-hit"][data-code="${CHILD}"]`)
        .click({ timeout: 30_000 });
      await expect(counter.getByTestId('fees-due-online-pending').first()).toBeVisible({
        timeout: 30_000,
      });
      await counter.screenshot({
        path: test.info().outputPath('counter-online-pending-1366.png'),
      });
    } finally {
      await counter.close();
    }

    // Cancel on the gateway: the fake lists a CANCELLED attempt, so the return closes it.
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page).toHaveURL(/\/children\/[^/]+\/fees\/pay\/[^/?]+\?from=gateway$/, {
      timeout: 30_000,
    });
    await expect(page.getByTestId('online-payment-state')).toHaveAttribute(
      'data-state',
      'NOT_PAID',
      { timeout: 30_000 },
    );
    await page.screenshot({ path: test.info().outputPath('online-not-paid-bn-390.png') });
    await page.getByTestId('online-start-again').click();
    await expect(page.getByTestId('online-pay-sheet')).toBeVisible({ timeout: 30_000 });
  });
});

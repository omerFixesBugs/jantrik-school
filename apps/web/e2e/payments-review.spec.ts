import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DEMO, api, apiLogin, otpLoginWithBanglaDigits, passwordLogin } from './helpers';
import { findLayoutProblems } from './layout-check';

// The review queue for online payments (sprint 1 P7b, docs/payments.md → The review queue). The
// fake SSLCommerz stands in for the sandbox (playwright.config.ts starts it on 127.0.0.1:4090):
// nothing here reaches SSLCommerz. Bangla, at 1366 and 390 px.

const FAKE_STORE = { id: 'jantrikfake01', password: 'jantrikfake01@ssl' };
const ACCOUNT = '/fees/online-payments/account';
const ADMIN = '01711000003';
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

/** The guardian ticks only the oldest due owed, goes to the fake gateway, and waits there. */
async function toGateway(page: Page) {
  const card = page.getByTestId('children').locator('li').filter({ hasText: CHILD });
  await card.getByTestId('child-fees-open').click();
  await page.getByTestId('child-online-open').click();
  const sheet = page.getByTestId('online-pay-sheet');
  await expect(sheet).toBeVisible();
  const boxes = sheet.getByTestId('online-due');
  for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).setChecked(i === 0);
  await sheet.getByTestId('online-continue').click();
  await expect(page).toHaveURL(/127\.0\.0\.1:4090\/pay\//, { timeout: 20_000 });
}

/** Back from the gateway, the guardian's page settles on a state. */
async function settlesOn(page: Page, state: string) {
  await expect(page).toHaveURL(/\/children\/[^/]+\/fees\/pay\/[^/?]+\?from=gateway$/, {
    timeout: 20_000,
  });
  await expect(page.getByTestId('online-payment-state')).toHaveAttribute('data-state', state, {
    timeout: 30_000,
  });
}

test.describe('online payments: the review queue (P7b)', () => {
  test('bn: paid at the counter while paying online → the admin applies it ahead; a risky one after a note; the accountant only sees', async ({
    page,
    browser,
    baseURL,
  }) => {
    test.slow();
    const owner = await onlinePaymentsOn();
    try {
      // The guardian, on a phone, starts paying the oldest due.
      await page.setViewportSize({ width: 390, height: 844 });
      await otpLoginWithBanglaDigits(page, DEMO.shaplaGuardian);
      await expect(page).toHaveURL(/\/dashboard$/);
      await toGateway(page);

      // Meanwhile the accountant takes that due in cash (the counter sees it in progress).
      const accountant = await apiLogin(ACCOUNTANT);
      const [hit] = await api<{ id: string }[]>(accountant, `/fees/students?q=${CHILD}`);
      const ledger = await api<{
        dues: { id: string; onlinePending: boolean; balance: { total: number } }[];
      }>(accountant, `/fees/students/${hit!.id}/ledger`);
      const due = ledger.dues.find((d) => d.onlinePending)!;
      await api(accountant, '/fees/payments', {
        method: 'POST',
        json: {
          studentId: hit!.id,
          dueIds: [due.id],
          amountPaisa: due.balance.total,
          expectedOutstandingPaisa: due.balance.total,
          clientRequestId: randomUUID(),
        },
      });

      // The guardian pays on the gateway: SSLCommerz confirms it, but the due was paid another
      // way, so the school checks it (no receipt yet).
      await page.getByRole('button', { name: 'Pay' }).click();
      await settlesOn(page, 'CHECKING');
      const paymentUrl = page.url();

      // The admin sees why, and applies the money to what the child owes next (or ahead).
      const admin = await browser.newPage({ baseURL, viewport: { width: 1366, height: 900 } });
      await passwordLogin(admin, ADMIN);
      await admin.goto('/fees/online-payments/review');
      const item = admin.getByTestId('review-intent').first();
      await expect(item.locator('[data-reason="DUES_CHANGED"]')).toBeVisible();
      await expect(admin.getByTestId('fees-tab-online-count')).toHaveText(/[০-৯]/);
      expect(await findLayoutProblems(admin), '1366 px').toEqual([]);
      await admin.screenshot({
        path: test.info().outputPath('review-bn-1366.png'),
        fullPage: true,
      });
      await item.getByTestId('review-apply').click();
      const dialog = admin.getByTestId('review-apply-dialog');
      await expect(dialog).toBeVisible();
      const picks = dialog.getByTestId('review-apply-pick');
      await expect(picks.first()).toBeVisible();
      // Untick the defaults, then tick the first due (or month ahead) offered.
      for (let i = 0; i < (await picks.count()); i++) await picks.nth(i).setChecked(false);
      await picks.first().setChecked(true);
      await dialog.getByTestId('review-note').fill('নগদেও নেওয়া হয়েছে: পরের মাসে জমা');
      if (await dialog.getByTestId('review-apply-remainder').isVisible()) {
        await dialog.getByLabel(/রেফারেন্স/).fill('SSL-RF-0001');
      }
      await admin.screenshot({ path: test.info().outputPath('review-apply-bn-1366.png') });
      await dialog.getByTestId('review-apply-confirm').click();
      await expect(dialog).toBeHidden({ timeout: 20_000 });

      // The guardian's page shows the receipt.
      await page.goto(paymentUrl);
      await expect(page.getByTestId('online-payment-state')).toHaveAttribute('data-state', 'PAID', {
        timeout: 30_000,
      });
      await expect(page.getByTestId('online-receipt-number')).toHaveText(/^\d{4}-\d{6}$/);

      // A payment SSLCommerz calls risky: applied after a note.
      await page.goto('/dashboard');
      await toGateway(page);
      await page.getByRole('button', { name: 'Risky' }).click();
      await settlesOn(page, 'CHECKING');
      await admin.goto('/fees/online-payments/review');
      const risky = admin
        .getByTestId('review-intent')
        .filter({ has: admin.locator('[data-reason="HIGH_RISK"]') })
        .first();
      await expect(risky).toBeVisible();
      await admin.setViewportSize({ width: 390, height: 844 });
      expect(await findLayoutProblems(admin), '390 px').toEqual([]);
      await admin.screenshot({
        path: test.info().outputPath('review-bn-390.png'),
        fullPage: true,
      });
      await admin.setViewportSize({ width: 1366, height: 900 });
      await risky.getByTestId('review-apply').click();
      const riskyDialog = admin.getByTestId('review-apply-dialog');
      await riskyDialog.getByTestId('review-apply-confirm').click();
      // A note is required.
      await expect(riskyDialog.getByRole('alert')).toBeVisible();
      await riskyDialog.getByTestId('review-note').fill('অভিভাবকের সঙ্গে ফোনে নিশ্চিত হয়েছি');
      if (await riskyDialog.getByTestId('review-apply-remainder').isVisible()) {
        await riskyDialog.getByLabel(/রেফারেন্স/).fill('SSL-RF-0002');
      }
      await riskyDialog.getByTestId('review-apply-confirm').click();
      await expect(riskyDialog).toBeHidden({ timeout: 20_000 });

      // The daily closing shows the online line, apart from cash in hand.
      await admin.goto('/fees/closing');
      await expect(admin.getByTestId('fees-closing-online')).toBeVisible();
      await expect(admin.getByTestId('fees-closing-online-net')).toHaveText(/[০-৯]/);
      for (const width of [1366, 390]) {
        await admin.setViewportSize({ width, height: 900 });
        expect(await findLayoutProblems(admin), `closing ${width} px`).toEqual([]);
        await admin.screenshot({
          path: test.info().outputPath(`closing-online-bn-${width}.png`),
          fullPage: true,
        });
      }
      await admin.close();

      // The accountant sees the queue (and the list) without the decisions.
      const counter = await browser.newPage({ baseURL, viewport: { width: 1366, height: 900 } });
      await passwordLogin(counter, ACCOUNTANT);
      await counter.goto('/fees/online-payments');
      await expect(counter.getByTestId('online-table')).toBeVisible();
      expect(await findLayoutProblems(counter), 'list 1366 px').toEqual([]);
      await counter.screenshot({ path: test.info().outputPath('online-list-bn-1366.png') });
      await counter.goto('/fees/online-payments/review');
      await expect(
        counter.getByTestId('online-review').or(counter.getByTestId('review-empty')),
      ).toBeVisible();
      await expect(counter.getByTestId('review-apply')).toHaveCount(0);
      await expect(counter.getByTestId('review-refund')).toHaveCount(0);
      await counter.close();
    } finally {
      await api(owner, `${ACCOUNT}/disable`, { method: 'POST' });
    }
  });
});

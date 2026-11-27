import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { API_URL, DEMO, api, apiLogin, otpLoginWithBanglaDigits, passwordLogin } from './helpers';
import { findLayoutProblems } from './layout-check';

// The review queue for online payments (sprint 1 P7b, docs/payments.md → The review queue). The
// fake SSLCommerz stands in for the sandbox (playwright.config.ts starts it on 127.0.0.1:4090):
// nothing here reaches SSLCommerz. Bangla, at 1366 and 390 px.
//
// - Its own child and guardian (Rakib, SHS-2026-0104, whom no other spec pays for): the flow takes
//   a due at the counter and applies money, so sharing Tahmid with payments.spec used up the dues
//   that spec needs (P7b-x33).
// - One sign-in per person for the whole file, on pages its tests share (serial), as
//   payments.spec does (P7a2-x33): a phone may have 5 sign-in codes in 15 minutes, counted even
//   when the 1-minute cooldown refuses one. Across both payment specs no phone signs in more than
//   4 times: the owner 4 (by password; here once, through the API), the admin 2, the accountant 2
//   (here once; the counter's calls use its page's own token), Rakib's father once (only here).
// - A staff sign-in is awaited (the dashboard) before the next navigation, which would cut it off
//   (P7a2-x29). Every action, navigation and wait fails within 30 s.
// - At the end, any payment left in progress is given up with the guardian page's own token.

const FAKE_STORE = { id: 'jantrikfake01', password: 'jantrikfake01@ssl' };
const ACCOUNT = '/fees/online-payments/account';
const ADMIN = '01711000003';
const ACCOUNTANT = '01711000004';
/** Rakib (6 ক, roll 4): tuition owed from August in the seed; his father is DEMO.rakibGuardian. */
const CHILD = 'SHS-2026-0104';
const WAIT = { timeout: 30_000 };

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
    .poll(async () => {
      const view = await api<{ lastTest: { at: string; result: string } | null }>(token, ACCOUNT);
      return view.lastTest && view.lastTest.at >= requestedAt ? view.lastTest.result : null;
    }, WAIT)
    .toBe('OK');
  await api(token, `${ACCOUNT}/enable`, { method: 'POST' });
  return token;
}

/** One person's page (a context of its own), Bangla, bounded at 30 s, keeping its API token. */
interface Person {
  context: BrowserContext;
  page: Page;
  signed: { token: string | undefined };
}

async function personPage(
  browser: Browser,
  baseURL: string | undefined,
  viewport: { width: number; height: number },
): Promise<Person> {
  const context = await browser.newContext({
    baseURL,
    viewport,
    locale: 'bn-BD',
    timezoneId: 'Asia/Dhaka',
    reducedMotion: 'reduce',
  });
  context.setDefaultTimeout(30_000);
  context.setDefaultNavigationTimeout(30_000);
  const page = await context.newPage();
  const signed: Person['signed'] = { token: undefined };
  page.on('request', (request) => {
    const auth = request.headers()['authorization'];
    if (request.url().startsWith(API_URL) && auth?.startsWith('Bearer ')) {
      signed.token = auth.slice('Bearer '.length);
    }
  });
  return { context, page, signed };
}

/** The token a signed-in page uses for the API (from its own calls). */
async function tokenOf(person: Person): Promise<string> {
  await expect.poll(() => person.signed.token, WAIT).toBeTruthy();
  return person.signed.token!;
}

/**
 * The payer's own "start again" on any payment of theirs still in progress (a failed attempt may
 * leave one at the gateway). Best effort, never failing.
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

/**
 * The guardian ticks only the oldest due owed, goes to the fake gateway, and waits there. A payment
 * an earlier attempt of this file left at the gateway (a retry) is continued instead.
 */
async function toGateway(page: Page) {
  await page.goto('/dashboard');
  const card = page.getByTestId('children').locator('li').filter({ hasText: CHILD });
  await card.getByTestId('child-fees-open').click();
  const open = page.getByTestId('child-online-open');
  const leftOver = page.getByTestId('child-online-continue');
  await expect(open.or(leftOver)).toBeVisible(WAIT);
  if (await leftOver.isVisible()) {
    await leftOver.click();
  } else {
    await open.click();
    const sheet = page.getByTestId('online-pay-sheet');
    await expect(sheet).toBeVisible(WAIT);
    const boxes = sheet.getByTestId('online-due');
    await expect(boxes.first()).toBeVisible(WAIT);
    for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).setChecked(i === 0);
    await sheet.getByTestId('online-continue').click();
  }
  await expect(page).toHaveURL(/127\.0\.0\.1:4090\/pay\//, WAIT);
}

/** The intent's id from its payment page's address. */
const intentOf = (url: string) => /\/fees\/pay\/([^/?]+)/.exec(url)![1]!;

/** Back from the gateway, the guardian's page settles on a state. */
async function settlesOn(page: Page, state: string) {
  await expect(page).toHaveURL(/\/children\/[^/]+\/fees\/pay\/[^/?]+\?from=gateway$/, WAIT);
  await expect(page.getByTestId('online-payment-state')).toHaveAttribute('data-state', state, WAIT);
}

test.describe('online payments: the review queue (P7b)', () => {
  test.describe.configure({ mode: 'serial' });

  let owner: string | undefined;
  /** Each person signed in once (beforeAll), their page shared by the tests. */
  let guardian: Person | undefined;
  let admin: Person | undefined;
  let accountant: Person | undefined;

  test.beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(150_000);
    const baseURL = testInfo.project.use.baseURL;
    owner = await onlinePaymentsOn();
    // The guardian, on a phone.
    guardian = await personPage(browser, baseURL, { width: 390, height: 844 });
    await otpLoginWithBanglaDigits(guardian.page, DEMO.rakibGuardian);
    await expect(guardian.page).toHaveURL(/\/dashboard$/, WAIT);
    // The admin and the accountant, at 1366 px.
    admin = await personPage(browser, baseURL, { width: 1366, height: 900 });
    await passwordLogin(admin.page, ADMIN);
    await expect(admin.page).toHaveURL(/\/dashboard$/, WAIT);
    accountant = await personPage(browser, baseURL, { width: 1366, height: 900 });
    await passwordLogin(accountant.page, ACCOUNTANT);
    await expect(accountant.page).toHaveURL(/\/dashboard$/, WAIT);
  });

  test.afterAll(async () => {
    try {
      // No payment left in progress (a failed attempt may leave one at the gateway).
      if (guardian?.signed.token) {
        await abandonLeftOver(guardian.signed.token).catch(() => undefined);
      }
    } finally {
      for (const person of [guardian, admin, accountant]) await person?.context.close();
      if (owner) await api(owner, `${ACCOUNT}/disable`, { method: 'POST' });
    }
  });

  test('bn: paid at the counter while paying online → the admin applies it ahead; a risky one after a note', async () => {
    test.slow();
    const page = guardian!.page;
    // The guardian starts paying the oldest due.
    await toGateway(page);

    // Meanwhile the accountant takes that due in cash (the counter sees it in progress), with
    // their own signed-in page's token.
    const counter = await tokenOf(accountant!);
    const hits = await api<{ id: string; studentCode: string }[]>(
      counter,
      `/fees/students?q=${CHILD}`,
    );
    const hit = hits.find((h) => h.studentCode === CHILD);
    const ledger = await api<{
      dues: { id: string; onlinePending: boolean; balance: { total: number } }[];
    }>(counter, `/fees/students/${hit!.id}/ledger`);
    const due = ledger.dues.find((d) => d.onlinePending);
    expect(due, 'the counter sees the due being paid online').toBeTruthy();
    await api(counter, '/fees/payments', {
      method: 'POST',
      json: {
        studentId: hit!.id,
        dueIds: [due!.id],
        amountPaisa: due!.balance.total,
        expectedOutstandingPaisa: due!.balance.total,
        clientRequestId: randomUUID(),
      },
    });

    // The guardian pays on the gateway: SSLCommerz confirms it, but the due was paid another
    // way, so the school checks it (no receipt yet).
    await page.getByRole('button', { name: 'Pay' }).click();
    await settlesOn(page, 'CHECKING');
    const paymentUrl = page.url();

    // The admin sees why, and applies the money to a month ahead (the child's own dues stay for
    // the rest of the file, and for a retry).
    const review = admin!.page;
    await review.setViewportSize({ width: 1366, height: 900 });
    await review.goto('/fees/online-payments/review');
    const item = review.locator(
      `[data-testid="review-intent"][data-intent-id="${intentOf(paymentUrl)}"]`,
    );
    await expect(item.locator('[data-reason="DUES_CHANGED"]')).toBeVisible(WAIT);
    await expect(review.getByTestId('fees-tab-online-count')).toHaveText(/[০-৯]/, WAIT);
    expect(await findLayoutProblems(review), '1366 px').toEqual([]);
    await review.screenshot({
      path: test.info().outputPath('review-bn-1366.png'),
      fullPage: true,
    });
    await item.getByTestId('review-apply').click();
    const dialog = review.getByTestId('review-apply-dialog');
    await expect(dialog).toBeVisible(WAIT);
    const picks = dialog.getByTestId('review-apply-pick');
    await expect(picks.first()).toBeVisible(WAIT);
    // Untick the defaults, then tick the last period offered (a month ahead).
    for (let i = 0; i < (await picks.count()); i++) await picks.nth(i).setChecked(false);
    await picks.last().setChecked(true);
    await dialog.getByTestId('review-note').fill('নগদেও নেওয়া হয়েছে: পরের মাসে জমা');
    if (await dialog.getByTestId('review-apply-remainder').isVisible()) {
      await dialog.getByLabel(/রেফারেন্স/).fill('SSL-RF-0001');
    }
    await review.screenshot({ path: test.info().outputPath('review-apply-bn-1366.png') });
    await dialog.getByTestId('review-apply-confirm').click();
    await expect(dialog).toBeHidden(WAIT);

    // The guardian's page shows the receipt.
    await page.goto(paymentUrl);
    await expect(page.getByTestId('online-payment-state')).toHaveAttribute(
      'data-state',
      'PAID',
      WAIT,
    );
    await expect(page.getByTestId('online-receipt-number')).toHaveText(/^\d{4}-\d{6}$/, WAIT);

    // A payment SSLCommerz calls risky: applied after a note.
    await toGateway(page);
    await page.getByRole('button', { name: 'Risky' }).click();
    await settlesOn(page, 'CHECKING');
    await review.goto('/fees/online-payments/review');
    const risky = review.locator(
      `[data-testid="review-intent"][data-intent-id="${intentOf(page.url())}"]`,
    );
    await expect(risky.locator('[data-reason="HIGH_RISK"]')).toBeVisible(WAIT);
    await review.setViewportSize({ width: 390, height: 844 });
    expect(await findLayoutProblems(review), '390 px').toEqual([]);
    await review.screenshot({
      path: test.info().outputPath('review-bn-390.png'),
      fullPage: true,
    });
    await review.setViewportSize({ width: 1366, height: 900 });
    await risky.getByTestId('review-apply').click();
    const riskyDialog = review.getByTestId('review-apply-dialog');
    await expect(riskyDialog.getByTestId('review-apply-pick').first()).toBeVisible(WAIT);
    await riskyDialog.getByTestId('review-apply-confirm').click();
    // A note is required.
    await expect(riskyDialog.getByRole('alert')).toBeVisible(WAIT);
    await riskyDialog.getByTestId('review-note').fill('অভিভাবকের সঙ্গে ফোনে নিশ্চিত হয়েছি');
    if (await riskyDialog.getByTestId('review-apply-remainder').isVisible()) {
      await riskyDialog.getByLabel(/রেফারেন্স/).fill('SSL-RF-0002');
    }
    await riskyDialog.getByTestId('review-apply-confirm').click();
    await expect(riskyDialog).toBeHidden(WAIT);
  });

  test('bn: the closing shows the online line; the accountant sees the list and the queue without the decisions', async () => {
    // The daily closing shows the online line, apart from cash in hand.
    const closing = admin!.page;
    await closing.goto('/fees/closing');
    await expect(closing.getByTestId('fees-closing-online')).toBeVisible(WAIT);
    await expect(closing.getByTestId('fees-closing-online-net')).toHaveText(/[০-৯]/, WAIT);
    for (const width of [1366, 390]) {
      await closing.setViewportSize({ width, height: 900 });
      expect(await findLayoutProblems(closing), `closing ${width} px`).toEqual([]);
      await closing.screenshot({
        path: test.info().outputPath(`closing-online-bn-${width}.png`),
        fullPage: true,
      });
    }

    // The accountant sees the queue (and the list) without the decisions.
    const page = accountant!.page;
    await page.goto('/fees/online-payments');
    await expect(page.getByTestId('online-table')).toBeVisible(WAIT);
    expect(await findLayoutProblems(page), 'list 1366 px').toEqual([]);
    await page.screenshot({ path: test.info().outputPath('online-list-bn-1366.png') });
    await page.goto('/fees/online-payments/review');
    await expect(
      page.getByTestId('online-review').or(page.getByTestId('review-empty')),
    ).toBeVisible(WAIT);
    await expect(page.getByTestId('review-apply')).toHaveCount(0, WAIT);
    await expect(page.getByTestId('review-refund')).toHaveCount(0, WAIT);
  });
});

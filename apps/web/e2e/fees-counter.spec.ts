import { toBanglaDigits } from '@jantrik/shared';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { findLayoutProblems } from './layout-check';
import { passwordLogin } from './helpers';

// The fee counter is used on phones: 360 px, touch (step 9).
const PHONE = { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true };
test.use(PHONE);

const ACCOUNTANT = '01711000004';
const ADMIN = '01711000003';

async function useLanguage(page: Page, lang: 'bn' | 'en') {
  await page.context().addCookies([{ name: 'NEXT_LOCALE', value: lang, url: page.url() }]);
  await page.reload();
}

/** A second person on their own phone (the admin who voids). */
async function phoneOf(browser: Browser, baseURL: string | undefined): Promise<Page> {
  const context = await browser.newContext({
    ...PHONE,
    baseURL,
    locale: 'bn-BD',
    timezoneId: 'Asia/Dhaka',
  });
  return context.newPage();
}

// bn: Tasnim, found by her father's phone typed with Bangla digits (seen masked by the
// accountant). en: Arpita, found by her student ID.
const CASES = [
  { lang: 'bn', code: 'SHS-2026-0001', query: toBanglaDigits('01811000101'), amount: '৫০০' },
  { lang: 'en', code: 'SHS-2026-0003', query: 'SHS-2026-0003', amount: '500' },
] as const;

for (const c of CASES) {
  test(`${c.lang}: collect cash for two months, print the receipt, an admin voids it`, async ({
    page,
    browser,
    baseURL,
  }) => {
    test.slow();
    await passwordLogin(page, ACCOUNTANT);
    await expect(page).toHaveURL(/\/dashboard$/);
    await useLanguage(page, c.lang);

    await page.goto('/fees');
    await page.getByTestId('fees-search').fill(c.query);
    const hit = page.locator(`[data-testid="fees-hit"][data-code="${c.code}"]`);
    await expect(hit).toBeVisible();
    if (c.lang === 'bn') await expect(hit).toContainText('018•••••101'); // masked for the accountant
    expect(await findLayoutProblems(page)).toEqual([]);
    await hit.click();

    const ledger = page.getByTestId('fees-ledger');
    await expect(ledger).toBeVisible();
    // Choose exactly the first two months that are owed.
    const dues = ledger.locator('[data-testid="fees-due"][data-status="OPEN"]');
    await expect(dues.first()).toBeVisible();
    const boxes = dues.locator('input[type="checkbox"]');
    const count = await boxes.count();
    expect(count).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < count; i++) await boxes.nth(i).setChecked(i < 2);
    await expect(page.getByTestId('fees-collect-bar')).toBeVisible();
    expect(await findLayoutProblems(page)).toEqual([]);

    // A partial payment.
    await page.getByTestId('fees-collect-open').click();
    await page.getByTestId('fees-amount').fill(c.amount);
    await page.getByTestId('fees-collect-confirm').click();

    await expect(page).toHaveURL(/\/fees\/receipts\//);
    const receipt = page.getByTestId('receipt');
    await expect(receipt).toBeVisible();
    // The receipt number stays ASCII (an identifier), even in bn.
    await expect(page.getByTestId('receipt-number')).toHaveText(/^\d{4}-\d{6}$/);
    await expect(page.getByTestId('receipt-total')).toContainText(c.amount);
    expect(await findLayoutProblems(page)).toEqual([]);
    const receiptUrl = page.url();

    // Printing shows only the receipt, on one A5 page.
    await page.getByTestId('receipt-paper-a5').click();
    await page.emulateMedia({ media: 'print' });
    await expect(receipt).toBeVisible();
    await expect(page.getByTestId('fees-tabs')).toBeHidden();
    const pdf = await page.pdf({ preferCSSPageSize: true });
    expect(pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g)?.length).toBe(1);
    await page.emulateMedia({ media: 'screen' });

    // The accountant cannot void; an admin can, with a reason.
    await expect(page.getByTestId('receipt-void-open')).toHaveCount(0);
    const admin = await phoneOf(browser, baseURL);
    await passwordLogin(admin, ADMIN);
    await expect(admin).toHaveURL(/\/dashboard$/);
    await useLanguage(admin, c.lang);
    await admin.goto(receiptUrl);
    await admin.getByTestId('receipt-void-open').click();
    await admin
      .getByTestId('void-reason')
      .fill(c.lang === 'bn' ? 'ভুল ছাত্রের নামে' : 'Wrong student');
    await admin.getByTestId('void-confirm').click();
    await expect(admin.getByTestId('receipt')).toHaveAttribute('data-status', 'VOID');
    await expect(admin.getByTestId('receipt-void')).toBeVisible();
    await admin.context().close();

    await page.reload();
    await expect(page.getByTestId('receipt')).toHaveAttribute('data-status', 'VOID');
    await page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'bn', url: page.url() }]);
  });
}

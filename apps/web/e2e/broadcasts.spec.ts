import { expect, test, type Page } from '@playwright/test';
import { DEMO, passwordLogin } from './helpers';
import { findLayoutProblems } from './layout-check';

// SMS broadcasts (sprint 1 P6b), in Bangla: the owner composes a Bangla broadcast to staff (the
// counter shows the segments, 3 at most), and previews it (recipients, cost in Bangla digits, the
// limit left). It does not send: CI runs at any hour and a send inside Dhaka's quiet hours is
// refused by design (P6-b7). Sending, the cap and the job are covered by the API tests.

async function expectClean(page: Page, where: string) {
  await page.waitForLoadState('networkidle');
  const problems = await findLayoutProblems(page);
  expect(problems, `${where}: ${JSON.stringify(problems, null, 1)}`).toEqual([]);
}

for (const width of [1366, 390]) {
  test(`compose and preview a Bangla broadcast (${width} px)`, async ({ browser }) => {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      ...(width < 500 ? { isMobile: true, hasTouch: true } : {}),
    });
    await passwordLogin(page, DEMO.shaplaOwner);
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto('/broadcasts/new');
    const body = page.getByLabel('বার্তা', { exact: false }).first();
    // The composer starts with the institute's name.
    await expect(body).toHaveValue(new RegExp(`^${DEMO.shaplaName}: `));
    await body.fill('আগামীকাল বিকেল ৩টায় শিক্ষক সভা। সবাই সময়মতো উপস্থিত থাকবেন। অভিভাবক সভার তারিখ পরে জানানো হবে।');
    await expect(page.getByTestId('broadcast-counter')).toContainText('২টি এসএমএস');
    await page.getByLabel('কাকে পাঠাবেন').selectOption('STAFF');
    await page.getByTestId('broadcast-preview').click();
    const panel = page.getByTestId('broadcast-preview-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('broadcast-preview-cost')).toContainText('৳');
    await expect(page.getByTestId('broadcast-preview-recipients')).toHaveText(/^[০-৯]+$/);
    await expectClean(page, `broadcast preview (${width})`);
    // Too long: more than 3 SMS is refused before preview.
    await body.fill('ক'.repeat(202));
    await expect(page.getByTestId('broadcast-counter')).toContainText('৪টি এসএমএস');
    await expect(page.getByTestId('broadcast-preview')).toBeDisabled();
    await page.close();
  });
}

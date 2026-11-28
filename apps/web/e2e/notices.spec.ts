import { expect, test, type Page } from '@playwright/test';
import { DEMO, passwordLogin } from './helpers';
import { findLayoutProblems } from './layout-check';

// Notices (sprint 1 P6a), in Bangla: the owner writes a staff notice and publishes it; the teacher
// sees the unread badge, opens the notice, and the badge goes. Who sees what for guardians (class
// and section targets) is covered by the API tests (apps/api/test/notices.e2e-spec.ts); this spec
// keeps to staff logins so it spends no guardian OTP budget.

async function expectClean(page: Page, where: string) {
  await page.waitForLoadState('networkidle');
  const problems = await findLayoutProblems(page);
  expect(problems, `${where}: ${JSON.stringify(problems, null, 1)}`).toEqual([]);
}

const TITLE = `শিক্ষক সভা ${Date.now().toString().slice(-5)}`;

test('the owner publishes a staff notice; the teacher reads it and the badge goes', async ({
  browser,
}) => {
  const owner = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  await passwordLogin(owner, DEMO.shaplaOwner);
  await expect(owner).toHaveURL(/\/dashboard$/);
  await owner.goto('/notices/manage/new');
  await owner.getByLabel('শিরোনাম').fill(TITLE);
  await owner
    .getByLabel('বিস্তারিত')
    .fill('আগামীকাল বিকেল ৩টায় শিক্ষক সভা।\nসবাই উপস্থিত থাকবেন।');
  await owner.getByLabel('কারা দেখবে').selectOption('STAFF');
  // A staff notice takes no class targets: the picker is not offered.
  await expect(owner.getByText('নির্দিষ্ট শ্রেণি বা শাখা')).toHaveCount(0);
  await owner.getByTestId('notice-save').click();
  await expect(owner).toHaveURL(/\/notices\/manage$/);
  const row = owner.getByTestId('notice-manage-row').filter({ hasText: TITLE });
  await expect(row).toContainText('খসড়া');
  await row.getByTestId('notice-publish').click();
  await owner.getByTestId('notice-publish-confirm').click();
  await expect(row).toContainText('প্রকাশিত');
  await expectClean(owner, 'manage (1366)');
  await owner.close();

  const teacher = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await passwordLogin(teacher, DEMO.shaplaTeacher);
  await expect(teacher).toHaveURL(/\/dashboard$/);
  await teacher.goto('/notices');
  const card = teacher.getByTestId('notice-card').filter({ hasText: TITLE });
  await expect(card).toBeVisible();
  await expect(card.getByRole('img', { name: 'নতুন' })).toBeVisible();
  await expectClean(teacher, 'board (390)');
  await card.click();
  await expect(teacher.getByTestId('notice-body')).toContainText('সবাই উপস্থিত থাকবেন।');
  await teacher.goto('/notices');
  await expect(
    teacher
      .getByTestId('notice-card')
      .filter({ hasText: TITLE })
      .getByRole('img', { name: 'নতুন' }),
  ).toHaveCount(0);
  await teacher.close();
});

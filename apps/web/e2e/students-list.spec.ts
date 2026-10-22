import { expect, test, type Page } from '@playwright/test';
import { DEMO, passwordLogin } from './helpers';

// The students list (docs/design.md → Principles 6 and 7): the office's order (class, section,
// roll), sortable headers, the view in the URL so Back returns to it, the person's own columns and
// saved views, and a side peek beside the list on a wide screen.

test.use({ viewport: { width: 1366, height: 800 } });

const table = (page: Page) => page.getByTestId('students-table');
const rows = (page: Page) => table(page).locator('tbody tr');
const header = (page: Page, name: string) =>
  table(page).getByRole('columnheader', { name, exact: true });

async function openList(page: Page) {
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto('/students');
  await expect(rows(page).first()).toBeVisible();
}

test('class, section and roll order; headers sort; Back returns to the same view', async ({
  page,
}) => {
  await openList(page);
  // Class 6 ক by roll first: roll 1, then 2.
  await expect(header(page, 'শ্রেণি · শাখা')).toHaveAttribute('aria-sort', 'ascending');
  await expect(rows(page).nth(0).getByRole('cell').nth(3)).toHaveText('1');
  await expect(rows(page).nth(1).getByRole('cell').nth(3)).toHaveText('2');

  await header(page, 'নাম').getByRole('button').click();
  await expect(page).toHaveURL(/[?&]sort=name/);
  await expect(header(page, 'নাম')).toHaveAttribute('aria-sort', 'ascending');
  await header(page, 'নাম').getByRole('button').click();
  await expect(page).toHaveURL(/[?&]dir=desc/);
  await expect(header(page, 'নাম')).toHaveAttribute('aria-sort', 'descending');

  await page.getByRole('searchbox').fill('তাসনিম');
  await expect(page).toHaveURL(/[?&]q=/);
  await expect(rows(page)).toHaveCount(1);
  await rows(page).getByRole('link', { name: 'তাসনিম রহমান' }).click();
  await expect(page).toHaveURL(/\/students\/[0-9a-f-]{36}$/);
  await page.goBack();
  await expect(page.getByRole('searchbox')).toHaveValue('তাসনিম');
  await expect(rows(page)).toHaveCount(1);
  await expect(header(page, 'নাম')).toHaveAttribute('aria-sort', 'descending');

  // The sidebar's link is the whole list again: the box follows the address.
  await page.getByRole('link', { name: 'শিক্ষার্থী তালিকা' }).click();
  await expect(page).toHaveURL(/\/students$/);
  await expect(page.getByRole('searchbox')).toHaveValue('');
  await expect(rows(page).nth(1)).toBeVisible();
});

test('columns and saved views are the person’s own, and kept', async ({ page }) => {
  await openList(page);
  await expect(header(page, 'অভিভাবক')).toBeVisible();
  await page.getByTestId('column-chooser').click();
  await page.getByRole('menuitemcheckbox', { name: 'অভিভাবক' }).click();
  await page.keyboard.press('Escape');
  await expect(header(page, 'অভিভাবক')).toHaveCount(0);

  // A filter worth keeping becomes a tab.
  await page.getByTestId('class-filter').click();
  await page.getByRole('option', { name: 'ষষ্ঠ শ্রেণি' }).click();
  await expect(page).toHaveURL(/[?&]class=/);
  await page.getByTestId('save-view').click();
  await page.getByLabel('দৃশ্যের নাম').fill('ষষ্ঠ');
  await page.getByRole('button', { name: 'রাখুন', exact: true }).click();
  const views = page.getByTestId('saved-views');
  const sixth = views.getByRole('button', { name: 'ষষ্ঠ', exact: true });
  await expect(sixth).toHaveAttribute('aria-current', 'true');
  await views.getByRole('button', { name: 'সব', exact: true }).click();
  await expect(page).not.toHaveURL(/[?&]class=/);
  await expect(sixth).not.toHaveAttribute('aria-current');

  // Both are still there after a reload.
  await page.reload();
  await expect(rows(page).first()).toBeVisible();
  await expect(header(page, 'অভিভাবক')).toHaveCount(0);
  await sixth.click();
  await expect(page).toHaveURL(/[?&]class=/);
  await expect(sixth).toHaveAttribute('aria-current', 'true');
});

test('a row opens the side peek beside the list; Esc closes it; narrower, the page', async ({
  page,
}) => {
  await openList(page);
  const peek = page.getByTestId('student-peek');
  // A click anywhere in the row but its links (here: the ID).
  await rows(page).nth(0).getByRole('cell').nth(1).click();
  await expect(peek).toBeVisible();
  await expect(peek.getByRole('heading', { level: 2 })).toBeFocused();
  await expect(peek.getByTestId('peek-open')).toHaveAttribute(
    'href',
    /^\/students\/[0-9a-f-]{36}$/,
  );
  await expect(rows(page).nth(0)).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Escape');
  await expect(peek).toBeHidden();
  // Focus goes back to the row that opened it.
  await expect(rows(page).nth(0)).toBeFocused();

  // The keyboard: a row takes focus, Space opens it.
  await rows(page).nth(1).focus();
  await page.keyboard.press('Space');
  await expect(peek).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(rows(page).nth(1)).toBeFocused();

  // Typing a search closes the peek (a new view) and the box keeps the keyboard.
  await rows(page).nth(0).getByRole('cell').nth(1).click();
  await expect(peek).toBeVisible();
  const box = page.getByRole('searchbox');
  await box.click();
  await box.pressSequentially('রহ');
  await expect(page).toHaveURL(/[?&]q=/);
  await expect(peek).toBeHidden();
  await expect(box).toBeFocused();
  await box.pressSequentially('িম');
  await expect(box).toHaveValue('রহিম');
  await box.clear();
  await expect(page).not.toHaveURL(/[?&]q=/);

  // Below 1280 px there is no room beside the list: the row opens the student's page.
  await page.setViewportSize({ width: 1100, height: 800 });
  await rows(page).nth(0).getByRole('cell').nth(1).click();
  await expect(page).toHaveURL(/\/students\/[0-9a-f-]{36}$/);
});

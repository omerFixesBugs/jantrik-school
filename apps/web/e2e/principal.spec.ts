import { expect, test, type Page } from '@playwright/test';
import { accentOverrideVars, themeTokens, type ThemePreset } from '@jantrik/shared';
import { API_URL, apiLogin, DEMO, passwordLogin } from './helpers';
import { findLayoutProblems } from './layout-check';

// The principal's dashboard, the students list and the owner's appearance settings (design
// v2.1, R3; docs/design.md → Dashboards, Themes).

test.use({ viewport: { width: 1366, height: 900 } });

const cssVar = (page: Page, name: string) =>
  page.evaluate(
    (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    `--${name}`,
  );

async function setPreset(preset: ThemePreset | null, accent: string | null = null) {
  const token = await apiLogin(DEMO.shaplaOwner);
  const res = await fetch(`${API_URL}/settings/appearance`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ preset, accent }),
  });
  expect(res.status).toBe(200);
}

test('the day in one line, what needs the principal first, and where the year stands', async ({
  page,
}) => {
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page).toHaveURL(/\/dashboard$/);

  // Today, from real data: registers in, present, whom to call (the seed has a long absence).
  const insight = page.getByTestId('dashboard-insight');
  await expect(insight).toContainText('হাজিরা এসেছে');
  await expect(insight).toContainText('উপস্থিত');
  await expect(page.getByTestId('kpi-absent')).toContainText('টানা');

  // What needs attention, most urgent first: the long absence, then registers still to come.
  const attention = page.getByTestId('attention');
  await expect(attention.getByTestId('attention-longAbsence')).toBeVisible();
  await expect(attention.getByTestId('attention-longAbsence')).toHaveAttribute(
    'href',
    '/attendance/today',
  );

  // The board's week: each section's present % over the last 7 days.
  const board = page.getByTestId('today-board');
  await board.getByTestId('board-period').getByRole('radio', { name: 'সপ্তাহ' }).click();
  await expect(board.getByRole('heading')).toHaveText('এই সপ্তাহ, শাখা অনুযায়ী');
  await expect(board.getByTestId('board-section').first()).toContainText('%');

  // The trend against the period before and the target; the week view too.
  const trend = page.getByTestId('attendance-trend');
  await trend.scrollIntoViewIfNeeded();
  await expect(trend).toContainText('লক্ষ্য ৯০%');
  await trend.getByTestId('trend-period').getByRole('radio', { name: 'সপ্তাহ' }).click();
  await expect(trend.getByRole('heading')).toHaveText('উপস্থিতি, গত ৭ দিন');
  await expect(trend).toContainText('তার আগের ৭ দিন');

  // Who the students are, and the year with its usual exams.
  const byClass = page.getByTestId('students-by-class');
  await byClass.scrollIntoViewIfNeeded();
  await expect(byClass).toContainText('ষষ্ঠ শ্রেণি');
  const year = page.getByTestId('term-timeline');
  await year.scrollIntoViewIfNeeded();
  await expect(year).toContainText('অর্ধবার্ষিক পরীক্ষা');
  await expect(year).toContainText('সাধারণত জুন');
  await expect(year.getByRole('progressbar')).toHaveAttribute('aria-valuenow', /^\d+$/);

  await page.evaluate(() => window.scrollTo(0, 0));
  const problems = await findLayoutProblems(page);
  expect(problems, JSON.stringify(problems, null, 1)).toEqual([]);
});

test('the students list: summary, a quiet status column, and a peek that says something', async ({
  page,
}) => {
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto('/students');
  await expect(page.getByTestId('students-summary')).toContainText('সক্রিয়');
  const table = page.getByTestId('students-table');
  await expect(table).toBeVisible();
  // Every student on the page is active: no column of "active".
  await expect(table.getByRole('columnheader', { name: 'অবস্থা' })).toHaveCount(0);

  await table.locator('tbody tr').first().getByRole('cell').nth(1).click();
  const peek = page.getByTestId('student-peek');
  await expect(peek).toBeVisible();
  await expect(peek.getByTestId('peek-attendance')).toContainText('এই মাসে উপস্থিতি');
  await expect(peek).toContainText('যোগ করা হয়েছে');
});

test('the owner sets the look: a preset, an accent checked live, and back to the default', async ({
  page,
}) => {
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page).toHaveURL(/\/dashboard$/);
  const html = page.locator('html');
  try {
    await page.goto('/setup/appearance');
    await page.getByTestId('preset-madrasa').click();
    await page.getByTestId('appearance-save').click();
    await expect(html).toHaveAttribute('data-theme', 'madrasa');

    // A colour of the owner's: checked against both modes before it can be saved.
    await page.getByTestId('accent-hex').fill('#b45309');
    await expect(page.getByTestId('accent-check')).toContainText('দুই রঙেই পড়া যায়');
    await page.getByTestId('appearance-save').click();
    const vars = accentOverrideVars('#b45309', 'MADRASA')!;
    await expect.poll(() => cssVar(page, 'primary-ink')).toBe(vars.light['primary-ink']);

    await page.getByTestId('appearance-reset').click();
    await expect(html).toHaveAttribute('data-theme', 'school');
    await expect
      .poll(() => cssVar(page, 'primary-ink'))
      .toBe(themeTokens('SCHOOL', 'light')['primary-ink']);
  } finally {
    await setPreset(null);
  }
});

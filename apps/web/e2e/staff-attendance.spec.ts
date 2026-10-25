import fs from 'node:fs';
import {
  addDays,
  formatMonth,
  formatTime,
  formatWallClock,
  type StaffDayReport,
} from '@jantrik/shared';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { E2E_TODAY } from '../playwright.config';
import { api, apiLogin, passwordLogin } from './helpers';
import { findLayoutProblems, findSmallTargets } from './layout-check';

// Step 11: staff attendance, as Shapla's admin. The seed has the month before E2E_TODAY as the
// devices would have recorded it (packages/db/src/seed/demo-devices.ts); today's own state follows
// the real clock (not yet, absent), so only the seeded days are checked.

const ADMIN = '01711000003';

// The seed's special days, counted back from E2E_TODAY (Wednesday 21 October; Fridays are off).
/** Shahana punched nothing (Saturday 17 October); the desk test enters it as a leave. */
const SHAHANA_ABSENT = addDays(E2E_TODAY, -4);
/** Nasrin left at 15:41. */
const NASRIN_EARLY = addDays(E2E_TODAY, -3);
/** Sharmin's sick leave, entered by hand. */
const SHARMIN_LEAVE = addDays(E2E_TODAY, -9);
/** Rafiqul left at 15:34. */
const RAFIQUL_EARLY = addDays(E2E_TODAY, -14);
const LEAVE_REASON = 'পারিবারিক কাজে ছুটি';

async function expectClean(page: Page, where: string) {
  await page.waitForLoadState('networkidle');
  const problems = await findLayoutProblems(page);
  expect(problems, `${where}: ${JSON.stringify(problems, null, 1)}`).toEqual([]);
  const small = await findSmallTargets(page);
  expect(small, `${where}: targets under 44 px: ${JSON.stringify(small, null, 1)}`).toEqual([]);
}

const dayRow = (page: Page, name: string) =>
  page.getByTestId('staff-day-row').filter({ hasText: name });

/** Nasrin's seeded day: present by the device, in and out as the API has them. */
async function expectDeviceDay(page: Page, report: StaffDayReport) {
  const nasrin = report.people.find((p) => p.nameBn === 'নাসরিন আক্তার')!;
  const row = dayRow(page, 'নাসরিন আক্তার');
  await expect(row).toContainText('উপস্থিত');
  await expect(row).toContainText(formatTime(nasrin.day!.inAt!, 'bn'));
  await expect(row).toContainText(formatTime(nasrin.day!.outAt!, 'bn'));
  await expect(row).toContainText('ডিভাইস');
}

/** A seeded day's code in the month grid: the person's row, the day's column. */
const cell = (grid: Locator, name: string, date: string) =>
  grid
    .getByTestId('staff-month-row')
    .filter({ hasText: name })
    .locator('td')
    .nth(Number(date.slice(8)) - 1)
    .locator('span');

/** The month the suite lives in, with the seed's late and early days and its leave. */
async function expectSeededMonth(page: Page) {
  await expect(page.getByTestId('staff-month-label')).toHaveText(
    formatMonth(E2E_TODAY.slice(0, 7), 'bn'),
  );
  const grid = page.getByTestId('staff-month-table');
  // October: the name, 31 days (5 Fridays off), the five totals and the two minute totals.
  await expect(grid.locator('thead th')).toHaveCount(1 + 31 + 7);
  await expect(grid.locator('thead th.register-off')).toHaveCount(5);
  // An early leave reads "early", or "late and early" on a day that also started late.
  await expect(cell(grid, 'নাসরিন আক্তার', NASRIN_EARLY)).toHaveAttribute('title', /আগে প্রস্থান/);
  await expect(cell(grid, 'রফিকুল ইসলাম', RAFIQUL_EARLY)).toHaveAttribute('title', /আগে প্রস্থান/);
  await expect(cell(grid, 'শারমিন সুলতানা', SHARMIN_LEAVE)).toHaveText('ছু');
  // About one seeded day in eight starts late.
  await expect(grid.locator('td span[title^="দেরি"]').first()).toBeVisible();
  return grid;
}

test.describe('at a desk', () => {
  test.use({ viewport: { width: 1366, height: 900 } });

  test('the day, a leave entered by hand, the month grid, print and both CSVs', async ({
    page,
  }) => {
    test.slow();
    const seeded = await api<StaffDayReport>(
      await apiLogin(ADMIN),
      `/staff-attendance/day?date=${SHAHANA_ABSENT}`,
    );
    await passwordLogin(page, ADMIN);
    await expect(page).toHaveURL(/\/dashboard$/);

    // ── The day ──
    await page.goto(`/attendance/staff?date=${SHAHANA_ABSENT}`);
    await expect(page.getByTestId('staff-day')).toContainText(
      `অফিস ${formatWallClock(seeded.officeHours.start, 'bn')} – ${formatWallClock(seeded.officeHours.end, 'bn')}`,
    );
    const summary = page.getByTestId('staff-summary').getByRole('listitem');
    await expect(summary.filter({ hasText: /^উপস্থিত/ })).toHaveText('উপস্থিত ৩');
    await expect(summary.filter({ hasText: /^অনুপস্থিত/ })).toHaveText('অনুপস্থিত ১');
    await expectDeviceDay(page, seeded);
    // The punches behind it, from the staff room's device.
    const nasrin = dayRow(page, 'নাসরিন আক্তার');
    await nasrin.getByRole('button', { name: 'পাঞ্চ দেখুন (২)' }).click();
    const punches = nasrin.getByTestId('staff-punches').getByRole('listitem');
    await expect(punches).toHaveCount(2);
    await expect(punches.first()).toContainText('শিক্ষকদের কক্ষ');
    // The owner's attendance is not kept unless switched on.
    await expect(dayRow(page, 'আব্দুল করিম')).toContainText(
      'প্রতিষ্ঠান প্রধানের হাজিরা স্বাভাবিক নিয়মে রাখা হয় না',
    );

    // ── Shahana's absent day entered as a leave, with a reason ──
    const shahana = dayRow(page, 'শাহানা পারভীন');
    await expect(shahana).toContainText('অনুপস্থিত');
    await shahana.getByTestId('staff-enter').click();
    const dialog = page.getByTestId('staff-entry-dialog');
    await expect(dialog.getByTestId('staff-entry-current')).toContainText('অনুপস্থিত');
    await dialog.getByTestId('staff-entry-status').getByRole('radio', { name: 'ছুটি' }).click();
    // Not without a reason.
    await dialog.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(dialog).toContainText('কারণ অন্তত ৩ অক্ষরে লিখুন।');
    await dialog.getByTestId('staff-entry-reason').fill(LEAVE_REASON);
    await dialog.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();
    await expect(dialog).toBeHidden();
    await expect(shahana).toContainText(`কারণ: ${LEAVE_REASON}`);
    await expect(shahana).toContainText('রফিকুল ইসলাম লিখেছেন');
    await expect(summary.filter({ hasText: /^ছুটি/ })).toHaveText('ছুটি ১');
    await expect(summary.filter({ hasText: /^অনুপস্থিত/ })).toHaveText('অনুপস্থিত ০');

    // ── The month ──
    await page.getByTestId('staff-view').getByRole('radio', { name: 'মাস' }).click();
    await expect(page).toHaveURL(/view=month/);
    const grid = await expectSeededMonth(page);
    await expect(cell(grid, 'শাহানা পারভীন', SHAHANA_ABSENT)).toHaveText('ছু');
    // A person's days open beside the grid.
    await grid.getByRole('button', { name: 'নাসরিন আক্তার-এর এই মাস' }).click();
    const peek = page.getByTestId('staff-month-peek');
    await expect(peek).toContainText('লেখা দিনগুলো');
    await expect(peek.getByTestId('staff-peek-days')).toContainText('আগে গেছেন');
    await page.keyboard.press('Escape');
    await expect(peek).toBeHidden();

    // ── Print: the grid alone, on one A4 landscape page ──
    // Chromium never adds pages sideways (a page too wide is shrunk or cut), so the page count
    // alone cannot tell: the 31 days and the totals must fit the paper's width too, measured in
    // print media at A4 landscape's printable width (297 − 2 × 10 mm margins, globals.css).
    await page.setViewportSize({ width: Math.round((277 / 25.4) * 96), height: 718 });
    await page.emulateMedia({ media: 'print' });
    await expect(page.getByTestId('staff-print')).toBeHidden();
    const widths = await page.evaluate(() => ({
      area: document.querySelector('[data-testid="staff-month"]')!.getBoundingClientRect().width,
      grid: document
        .querySelector('[data-testid="staff-month-table"] table')!
        .getBoundingClientRect().width,
    }));
    expect(
      widths.grid,
      `the grid is ${Math.round(widths.grid)} px wide on a ${Math.round(widths.area)} px wide A4 landscape page`,
    ).toBeLessThanOrEqual(widths.area + 1);
    const pdf = (await page.pdf({ preferCSSPageSize: true })).toString('latin1');
    // Exactly one page: the app shell, hidden but still laid out, must not add a blank second one.
    expect(pdf.match(/\/Type\s*\/Page[^s]/g)?.length, 'pages in the PDF').toBe(1);
    // A4 landscape: 842 × 595 pt.
    expect(pdf).toMatch(/\/MediaBox\s*\[\s*0\s+0\s+(841|842)(\.\d+)?\s+(594|595)(\.\d+)?\s*\]/);
    await page.emulateMedia({ media: 'screen' });
    await page.setViewportSize({ width: 1366, height: 900 });

    // ── The two CSVs: a BOM for Excel, ASCII digits, CRLF line ends ──
    const csvLines = async (kind: 'grid' | 'days') => {
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByTestId(`staff-csv-${kind}`).click(),
      ]);
      expect(download.suggestedFilename()).toMatch(/\.csv$/);
      const bytes = fs.readFileSync((await download.path())!);
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const csv = bytes.toString('utf8');
      expect(csv).not.toMatch(/[০-৯]/);
      expect(csv).toMatch(/\r\n$/);
      expect(csv.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
      return csv.slice(1).split('\r\n');
    };
    // The grid: a row per person, a column per day.
    const gridCsv = await csvLines('grid');
    expect(gridCsv[0]).toMatch(/^নাম,1,2,3,/);
    const shahanaCells = gridCsv.find((l) => l.startsWith('শাহানা পারভীন,'))!.split(',');
    expect(shahanaCells[Number(SHAHANA_ABSENT.slice(8))]).toBe('ছু');
    // By day: a row per recorded day, with local times and the reason.
    const daysCsv = await csvLines('days');
    expect(daysCsv[0]).toBe(
      'তারিখ,নাম,অবস্থা,প্রবেশ,প্রস্থান,দেরি (মিনিট),আগে প্রস্থান (মিনিট),উৎস,কারণ',
    );
    expect(daysCsv).toContain(`${SHAHANA_ABSENT},শাহানা পারভীন,ছুটি,,,0,0,হাতে,${LEAVE_REASON}`);
    expect(daysCsv).toContain(`${SHARMIN_LEAVE},শারমিন সুলতানা,ছুটি,,,0,0,হাতে,অসুস্থতার ছুটি`);
    expect(daysCsv.find((l) => l.startsWith(`${NASRIN_EARLY},নাসরিন আক্তার,উপস্থিত,`))).toContain(
      ',15:41,',
    );
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('the day, the entry dialog, the month and a person’s month fit 390 px, with 44 px targets', async ({
    page,
  }) => {
    const seeded = await api<StaffDayReport>(
      await apiLogin(ADMIN),
      `/staff-attendance/day?date=${SHAHANA_ABSENT}`,
    );
    await passwordLogin(page, ADMIN);
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto(`/attendance/staff?date=${SHAHANA_ABSENT}`);
    await expectDeviceDay(page, seeded);
    await expectClean(page, 'staff day 390');
    // The entry dialog, closed without saving.
    await dayRow(page, 'নাসরিন আক্তার').getByTestId('staff-enter').tap();
    const dialog = page.getByTestId('staff-entry-dialog');
    await expect(dialog).toBeVisible();
    await expectClean(page, 'staff entry 390');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await page.getByTestId('staff-view').getByRole('radio', { name: 'মাস' }).tap();
    await expectSeededMonth(page);
    await expectClean(page, 'staff month 390');
    // A person's month opens as a sheet on a phone.
    await page.getByRole('button', { name: 'নাসরিন আক্তার-এর এই মাস' }).tap();
    await expect(page.getByTestId('staff-month-sheet')).toContainText('লেখা দিনগুলো');
    await expectClean(page, 'staff person month 390');
  });
});

import { expect, test } from '@playwright/test';
import {
  addDays,
  dateToDb,
  formatDate,
  formatDayMonth,
  todayIn,
  type AttendanceTodayReport,
  type AttendanceTrendReport,
  type MeContext,
  type SmsDailyStatus,
} from '@jantrik/shared';
import { E2E_TODAY } from '../playwright.config';
import { DEMO, api, apiLogin, otpLoginWithBanglaDigits, passwordLogin } from './helpers';
import { findLayoutProblems } from './layout-check';

test('the suite lives on its fixed day: the specs, the API and the dashboard agree', async ({
  page,
}) => {
  expect(todayIn('Asia/Dhaka')).toBe(E2E_TODAY);
  const me = await api<MeContext>(await apiLogin(DEMO.shaplaOwner), '/me/context');
  expect(me.today).toBe(E2E_TODAY);
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page).toHaveURL(/\/dashboard$/);
  // The date line is the server's, never the device's.
  await expect(page.getByText(formatDate(dateToDb(E2E_TODAY), 'bn', 'full')).first()).toBeVisible();
});

test('staff dashboard: Bangla date, student total, getting-started steps', async ({ page }) => {
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page).toHaveURL(/\/dashboard$/);

  // users.name_bn in the Bangla UI.
  await expect(page.getByRole('heading', { level: 2, name: /আব্দুল করিম/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /মোট শিক্ষার্থী/ })).toContainText('৩০'); // Bangla digits
  // The seed has a month of past attendance, so only "turn on absent SMS" is left (off by
  // default); it opens the SMS settings.
  const steps = page.getByTestId('getting-started');
  await expect(steps).toContainText('শুরু করার ধাপ');
  await expect(steps).toContainText('৬টির মধ্যে ৫টি সম্পন্ন');
  await expect(steps).toContainText('অনুপস্থিতির SMS চালু করুন');
  await expect(steps.getByRole('link', { name: 'খুলুন' })).toHaveAttribute(
    'href',
    '/attendance/settings#settings-sms',
  );
  await page.getByTestId('quick-attendance').click();
  await expect(page).toHaveURL(/\/attendance$/);
});

test('owner dashboard: the section board, absentees and the last 30 days', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await passwordLogin(page, DEMO.shaplaOwner);
  const board = page.getByTestId('today-board');
  const tiles = board.getByTestId('board-section');
  await expect(tiles.first()).toBeVisible();
  // A tile opens that section's register for today.
  await expect(tiles.first()).toHaveAttribute('href', /^\/attendance\?section=[0-9a-f-]{36}/);
  await expect(page.getByTestId('kpi-registers')).toContainText('/');

  // The trend, also as a table: every one of the 30 days, today last.
  const trend = page.getByTestId('attendance-trend');
  await expect(trend.getByRole('heading')).toHaveText('উপস্থিতি, গত ৩০ দিন');
  await trend.getByRole('button', { name: 'টেবিলে দেখুন' }).click();
  const days = trend.getByRole('table').locator('tbody tr');
  await expect(days).toHaveCount(30);
  const today = todayIn('Asia/Dhaka');
  await expect(days.last()).toContainText(formatDayMonth(today, 'bn'));

  // Choosing a class narrows the trend to it.
  const sixth = board.getByRole('button', { name: 'ষষ্ঠ শ্রেণি', exact: true });
  await sixth.click();
  await expect(sixth).toHaveAttribute('aria-pressed', 'true');
  await expect(trend.getByRole('heading')).toHaveText('ষষ্ঠ শ্রেণি: উপস্থিতি, গত ৩০ দিন');
  await board.getByRole('button', { name: 'সব শ্রেণি' }).click();
  await expect(sixth).toHaveAttribute('aria-pressed', 'false');
});

test('owner dashboard before any attendance: what will appear, never made-up numbers', async ({
  page,
}) => {
  // A new institute's reads, stubbed: no sections taken, no days.
  const today = todayIn('Asia/Dhaka');
  const counts = { present: 0, absent: 0, late: 0, leave: 0 };
  const report: AttendanceTodayReport = {
    today,
    mode: 'DAILY',
    nonWorkingDay: null,
    leaveCountsAsAbsent: false,
    sections: [],
    totals: { sectionsTotal: 0, sectionsTaken: 0, counts, percent: null },
  };
  const days = Array.from({ length: 30 }, (_, i) => ({
    date: addDays(today, i - 29),
    counts: null,
    percent: null,
    nonWorkingDay: null,
    sectionsTaken: 0,
  }));
  const trend: AttendanceTrendReport = {
    today,
    from: days[0]!.date,
    to: today,
    leaveCountsAsAbsent: false,
    days,
    sections: [],
  };
  await page.route('**/attendance/reports/today', (r) => r.fulfill({ json: report }));
  await page.route('**/attendance/reports/trend?*', (r) => r.fulfill({ json: trend }));
  await page.setViewportSize({ width: 1366, height: 900 });
  await passwordLogin(page, DEMO.shaplaOwner);

  await expect(page.getByTestId('today-board')).toContainText('এখনো কোনো শাখা নেই।');
  await expect(page.getByTestId('today-absentees')).toContainText(
    'হাজিরা নেওয়া হলে এখানে দেখাবে।',
  );
  const present = page.getByTestId('module-card-attendance');
  await expect(present).toContainText('আজ এখনো কোনো হাজিরা নেওয়া হয়নি');
  await expect(present).toContainText('—');
  await expect(page.getByTestId('kpi-absent')).toContainText('—');
  // Every day says why it has no value, in the table too.
  const chart = page.getByTestId('attendance-trend');
  await chart.getByRole('button', { name: 'টেবিলে দেখুন' }).click();
  await expect(chart.getByRole('table')).toContainText('হাজিরা নেওয়া হয়নি');
});

test('held SMS: the confirm dialog shows the messages and total SMS segments', async ({ page }) => {
  // Only the numbers matter here, so the status is stubbed (no real SMS are held or sent).
  await page.route('**/attendance/sms/today', async (route) => {
    const status: SmsDailyStatus = {
      date: '2026-10-19',
      cap: 60,
      used: 60,
      held: 3,
      heldSegments: 5,
    };
    await route.fulfill({ json: status });
  });
  await page.setViewportSize({ width: 360, height: 780 });
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page).toHaveURL(/\/dashboard$/);
  const held = page.getByTestId('held-sms');
  await expect(held).toContainText('আজ ৩টি SMS পাঠানো হয়নি');
  await held.getByRole('button', { name: 'আটকে থাকা SMS পাঠান' }).click();
  const dialog = page.getByTestId('held-confirm');
  await expect(dialog.getByRole('heading')).toHaveText('৩টি বার্তা এখন পাঠাবেন?');
  await expect(dialog.getByTestId('held-confirm-count')).toHaveText('৩টি');
  await expect(dialog.getByTestId('held-confirm-segments')).toHaveText('৫টি SMS');
  expect(await findLayoutProblems(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'এখন না' }).click();
  await expect(dialog).toBeHidden();
});

test('guardian dashboard shows only their own children', async ({ page }) => {
  // Habibur Rahman: father of Tasnim and Tahmid (siblings) at Shapla school.
  await otpLoginWithBanglaDigits(page, DEMO.shaplaGuardian);
  await expect(page).toHaveURL(/\/dashboard$/);

  const children = page.getByTestId('children');
  // One card per child (each card also lists the days of its attendance calendar).
  await expect(children.locator(':scope > li')).toHaveCount(2);
  await expect(children).toContainText('তাসনিম রহমান');
  await expect(children).toContainText('তাহমিদ রহমান');
  await expect(children).toContainText('SHS-2026-0001'); // IDs stay ASCII
  await expect(children).not.toContainText('অর্পিতা দাস'); // another family's child

  // Guardians get no staff pages.
  const nav = page.getByRole('navigation', { name: 'নেভিগেশন' });
  await expect(nav.getByRole('link', { name: 'শিক্ষার্থী তালিকা' })).toHaveCount(0);
  await expect(page.getByTestId('module-card-attendance')).toHaveCount(0);
});

import { expect, test, type Page } from '@playwright/test';
import type { AttendanceSettings, AttendanceSheet, MySectionsResponse } from '@jantrik/shared';
import { API_URL, DEMO, api, apiOtpLogin, passwordLogin } from './helpers';

// Phone first: the most used screen in the product.
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

let ownerToken: string;
/** Nasrin Akter (teacher) takes Class 6 ক: 27 students, roll 1 = তাসনিম রহমান. */
let sectionId: string;
/** The tenant's settings before this suite, put back afterwards for the specs that follow. */
let original: AttendanceSettings;

const putSettings = (s: AttendanceSettings, weeklyOffDays: number[]) =>
  api(ownerToken, '/attendance/settings', {
    method: 'PUT',
    json: {
      mode: s.mode,
      weeklyOffDays,
      editWindowDays: s.editWindowDays,
      leaveCountsAsAbsent: s.leaveCountsAsAbsent,
      absentSmsEnabled: s.absentSmsEnabled,
      absentSmsTemplate: s.absentSmsTemplate,
      absentSmsDelayMinutes: s.absentSmsDelayMinutes,
      dailySmsCap: s.dailySmsCap,
    },
  });

test.beforeAll(async () => {
  ownerToken = await apiOtpLogin(DEMO.shaplaOwner);
  // Weekly off days would make this suite fail on Fridays: switch them off for the e2e tenant.
  original = await api<AttendanceSettings>(ownerToken, '/attendance/settings');
  await putSettings(original, []);
  const mine = await api<MySectionsResponse>(ownerToken, '/attendance/my-sections');
  sectionId = mine.sections.find((x) => x.classLevel.nameEn === 'Class 6' && x.name === 'ক')!.id;
});

// Later specs (the guardian calendar) expect the seeded Friday off day.
test.afterAll(async () => {
  await putSettings(original, original.weeklyOffDays);
});

const register = (page: Page) => page.getByTestId('register-list');
const student = (page: Page, name: string) =>
  register(page).getByRole('button', { name: new RegExp(name) });
const syncState = (page: Page) => page.getByTestId('sync-state');
const serverSheet = () =>
  api<AttendanceSheet>(ownerToken, `/attendance/sessions?sectionId=${sectionId}`);

async function openRegister(page: Page) {
  await passwordLogin(page, DEMO.shaplaTeacher);
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto('/attendance');
  // A teacher with one section goes straight to it.
  await expect(page.getByTestId('register-title')).toHaveText('ষষ্ঠ শ্রেণি, ক');
  await expect(register(page).getByRole('button')).toHaveCount(27);
}

test('a teacher takes attendance on a phone; more than half absent asks first; the dashboard shows it', async ({
  page,
}) => {
  await openRegister(page);
  await page.getByRole('button', { name: 'সবাই উপস্থিত' }).click();
  await expect(syncState(page)).toHaveAttribute('data-sync', 'local');
  await expect(syncState(page)).toHaveText('এই ফোনে রাখা আছে, এখনো পাঠানো হয়নি');

  // Tap cycles: present → absent → late.
  await student(page, 'তাসনিম রহমান').click();
  await expect(student(page, 'তাসনিম রহমান')).toHaveAttribute('data-status', 'ABSENT');
  await student(page, 'আরিফ হোসেন').click();
  await student(page, 'আরিফ হোসেন').click();
  await expect(student(page, 'আরিফ হোসেন')).toHaveAttribute('data-status', 'LATE');
  await expect(page.getByTestId('register-counts')).toContainText('২৫');

  await page.getByTestId('register-submit').click();
  await expect(syncState(page)).toHaveAttribute('data-sync', 'saved');
  await expect(syncState(page)).toContainText('জমা হয়েছে');

  // What the server has, and what a reload shows.
  const sheet = await serverSheet();
  const tasnim = sheet.students.find((s) => s.nameBn === 'তাসনিম রহমান')!;
  expect(sheet.session?.records.find((r) => r.studentId === tasnim.id)?.status).toBe('ABSENT');
  await page.reload();
  await expect(student(page, 'তাসনিম রহমান')).toHaveAttribute('data-status', 'ABSENT');
  await expect(syncState(page)).toHaveAttribute('data-sync', 'saved');

  // More than half absent asks before sending (same login: password attempts are limited).
  await page.getByRole('button', { name: 'সবাই উপস্থিত' }).click();
  const rows = register(page).getByRole('button');
  for (let i = 0; i < 14; i++) await rows.nth(i).click(); // 14 of 27 absent
  await page.getByTestId('register-submit').click();
  const dialog = page.getByTestId('absent-confirm');
  await expect(dialog).toContainText('১৪ জন অনুপস্থিত?');
  await dialog.getByRole('button', { name: 'ফিরে দেখি' }).click();
  await expect(dialog).toBeHidden();
  await expect(syncState(page)).toHaveAttribute('data-sync', 'local'); // nothing was sent

  await page.getByTestId('register-submit').click();
  await page.getByTestId('absent-confirm').getByRole('button', { name: 'হ্যাঁ, জমা দিন' }).click();
  await expect(syncState(page)).toHaveAttribute('data-sync', 'saved');
  const afterConfirm = await serverSheet();
  expect(afterConfirm.session?.records.filter((r) => r.status === 'ABSENT')).toHaveLength(14);

  // A normal day again: one absent. The dashboard card shows it.
  await page.getByRole('button', { name: 'সবাই উপস্থিত' }).click();
  await student(page, 'তাসনিম রহমান').click();
  await page.getByTestId('register-submit').click();
  await expect(syncState(page)).toHaveAttribute('data-sync', 'saved');
  await page.goto('/dashboard');
  const card = page.getByTestId('module-card-attendance');
  await expect(card).toContainText('২৬ / ২৭');
  await expect(card).toContainText('৯৬% উপস্থিত');
});

test('bad internet: the work is kept on the phone, survives a reload, and sends itself', async ({
  page,
}) => {
  test.setTimeout(90_000); // includes waiting for the app's own retries
  await openRegister(page);
  await page.getByRole('button', { name: 'সবাই উপস্থিত' }).click();

  // The submit can't reach the server.
  await page.route(`${API_URL}/attendance/sessions`, (route) =>
    route.request().method() === 'PUT' ? route.abort('internetdisconnected') : route.continue(),
  );
  await student(page, 'সুমাইয়া আক্তার').click(); // → absent
  await page.getByTestId('register-submit').click();
  await expect(syncState(page)).toHaveAttribute('data-sync', 'retrying');
  await expect(syncState(page)).toContainText('পাঠানো যায়নি');
  const stored = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith('jantrik.att:')),
  );
  expect(stored).toHaveLength(1);
  const registerUrl = page.url();

  // Elsewhere in the app, the unsent work is not forgotten.
  await page.goto('/dashboard');
  await expect(page.getByTestId('unsent-banner')).toContainText('১টি হাজিরা এখনো পাঠানো হয়নি');

  // Reopen the register while the API is unreachable: not signed out, the unsent work counted.
  await page.unroute(`${API_URL}/attendance/sessions`);
  await page.route(`${API_URL}/**`, (route) => route.abort('internetdisconnected'));
  await page.goto(registerUrl);
  await expect(page.getByTestId('connection-screen')).toBeVisible();
  await expect(page.getByTestId('connection-drafts')).toContainText('১টি হাজিরা জমা বাকি');

  // The connection comes back (phones fire "online"): the app recovers and the pending
  // submit goes out by itself, without the teacher doing anything.
  await page.unroute(`${API_URL}/**`);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(syncState(page)).toHaveAttribute('data-sync', 'saved', { timeout: 30_000 });
  await expect(student(page, 'সুমাইয়া আক্তার')).toHaveAttribute('data-status', 'ABSENT');

  const sheet = await serverSheet();
  const sumaiya = sheet.students.find((s) => s.nameBn === 'সুমাইয়া আক্তার')!;
  expect(sheet.session?.records.find((r) => r.studentId === sumaiya.id)?.status).toBe('ABSENT');
  // Confirmed by the server: the draft is gone from the phone.
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((k) => k.startsWith('jantrik.att:')),
    ),
  ).toEqual([]);
});

test('someone else changed it: only the differing students, keep mine or theirs', async ({
  page,
}) => {
  await openRegister(page);
  await page.getByRole('button', { name: 'সবাই উপস্থিত' }).click();
  await page.getByTestId('register-submit').click();
  await expect(syncState(page)).toHaveAttribute('data-sync', 'saved');

  // The head teacher marks রাকিব হাসান absent from the office.
  const sheet = await serverSheet();
  const rakib = sheet.students.find((s) => s.nameBn === 'রাকিব হাসান')!;
  await api(ownerToken, '/attendance/sessions', {
    method: 'PUT',
    json: {
      sectionId,
      date: sheet.date,
      periodNo: 0,
      submissionId: crypto.randomUUID(),
      baseVersion: sheet.session!.version,
      records: sheet.students.map((s) => ({
        studentId: s.id,
        status: s.id === rakib.id ? 'ABSENT' : 'PRESENT',
      })),
    },
  });

  // The teacher, still on the old copy, marks তাসনিম রহমান late and submits.
  await student(page, 'তাসনিম রহমান').click();
  await student(page, 'তাসনিম রহমান').click();
  await page.getByTestId('register-submit').click();
  const dialog = page.getByTestId('conflict-dialog');
  await expect(dialog).toContainText('আব্দুল করিম এই হাজিরা');
  await expect(dialog.getByRole('listitem')).toHaveCount(2); // only the two that differ
  await expect(dialog).toContainText('তাসনিম রহমান');
  await expect(dialog).toContainText('রাকিব হাসান');

  await dialog.getByRole('button', { name: 'আমারটা রাখুন' }).click();
  await expect(syncState(page)).toHaveAttribute('data-sync', 'saved');
  const after = await serverSheet();
  const status = (name: string) =>
    after.session?.records.find(
      (r) => r.studentId === after.students.find((s) => s.nameBn === name)!.id,
    )?.status;
  expect(status('তাসনিম রহমান')).toBe('LATE');
  expect(status('রাকিব হাসান')).toBe('PRESENT'); // mine kept
});

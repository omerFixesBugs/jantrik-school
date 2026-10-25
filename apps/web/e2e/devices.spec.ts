import { ZkDeviceSimulator } from '@jantrik/device-sim';
import {
  DEVICE_ONLINE_WINDOW_MS,
  defaultStudentDeviceId,
  formatCount,
  formatTime,
  toBanglaDigits,
  type DeviceList,
  type DevicePeopleList,
  type DeviceSyncResult,
} from '@jantrik/shared';
import { expect, test, type Page } from '@playwright/test';
import { api, apiLogin, DEMO, passwordLogin } from './helpers';
import { findLayoutProblems, findSmallTargets } from './layout-check';

// Step 11: the owner sets people's device IDs, adds a ZKTeco device and watches it work, while
// @jantrik/device-sim plays the device against the e2e receiver. The tests run in order and share
// the device: IDs first, then the device and its people, its feed and addresses, the phone, and
// last the device going quiet.
//
// Later specs see the demo as seeded: the three students whose IDs change get their demo IDs back
// before the device is added, and the device (a serial of its own per run) is switched off at the
// end.
//
// Punches carry the device's own clock (now), not E2E_TODAY: a device keeps nothing dated before
// the day it was added (`interpretPunch`), and this one is added on the real date, after
// E2E_TODAY. A day other than the suite's today changes no register or staff day; the feed shows
// every punch all the same.

test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1366, height: 900 } });

/** The e2e API's receiver (INGEST_PORT in playwright.config.ts), over IPv4: one fixed address. */
const RECEIVER = 'http://127.0.0.1:4280';
/** Its own per run (a retry too): 6 to 32 capitals and digits. */
const SERIAL = `E2E${Date.now().toString(36).toUpperCase()}`;
const DEVICE_NAME = `পেছনের ফটক ${SERIAL.slice(-4)}`;
/** A second address the device seems to call from (a documentation range, RFC 5737). */
const NEW_IP = '203.0.113.7';
/** A device ID nobody has. */
const UNKNOWN_ID = '987654';

// 6 ক, rolls 25 to 27: the people test moves only their IDs, and gives them back.
const PRIYANKA = { name: 'প্রিয়াঙ্কা রায়', code: 'SHS-2026-0125' };
const FAHIM = { name: 'ফাহিম মুনতাসির', code: 'SHS-2026-0126' };
const UMME = { name: 'উম্মে হাবিবা', code: 'SHS-2026-0127' };
/** A student's demo ID: the digits of their code. */
const demoId = (s: { code: string }) => defaultStudentDeviceId(s.code)!;

/** Plays the device from the moment it is added. */
let device: ZkDeviceSimulator;
/** When the receiver last heard from the device: it stays online for 2 minutes after. */
let lastContact = 0;

const deviceRow = (page: Page) =>
  page.getByTestId('devices-table').getByRole('row', { name: DEVICE_NAME });

async function expectClean(page: Page, where: string) {
  await page.waitForLoadState('networkidle');
  const problems = await findLayoutProblems(page);
  expect(problems, `${where}: ${JSON.stringify(problems, null, 1)}`).toEqual([]);
  const small = await findSmallTargets(page);
  expect(small, `${where}: targets under 44 px: ${JSON.stringify(small, null, 1)}`).toEqual([]);
}

/** Fahim, Umme and Priyanka get their demo IDs back (cleared first: two of them swapped). */
async function restoreDemoIds(token: string) {
  const { people } = await api<DevicePeopleList>(token, '/attendance/device-people?kind=STUDENT');
  const moved = [PRIYANKA, FAHIM, UMME].flatMap((s) => {
    const p = people.find((row) => row.kind === 'STUDENT' && row.studentCode === s.code);
    return p && p.deviceUserId !== demoId(s) ? [{ id: p.id, current: p.deviceUserId, s }] : [];
  });
  const put = (studentId: string, deviceUserId: string | null) =>
    api(token, '/attendance/device-people', { method: 'PUT', json: { studentId, deviceUserId } });
  for (const m of moved) if (m.current) await put(m.id, null);
  for (const m of moved) await put(m.id, demoId(m.s));
}

test('device IDs: one set by hand, a CSV with one bad row, default IDs and a collision', async ({
  page,
}) => {
  const owner = await apiLogin(DEMO.shaplaOwner);
  try {
    await passwordLogin(page, DEMO.shaplaOwner);
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto('/attendance/devices/people');
    const table = page.getByTestId('people-table');
    const row = (s: { name: string }) => table.getByRole('row', { name: s.name });
    await expect(row(FAHIM)).toContainText(demoId(FAHIM));

    // By hand, typed on a Bangla keyboard; Enter saves.
    await row(FAHIM).getByTestId('device-id-edit').click();
    const input = row(FAHIM).getByTestId('device-id-input');
    await input.fill(toBanglaDigits('777001'));
    await input.press('Enter');
    await expect(row(FAHIM).getByTestId('device-id-form')).toHaveCount(0);
    await expect(row(FAHIM)).toContainText('777001');

    // A CSV: Fahim's ID cleared, his old number to Umme, Priyanka's cleared, and a student code
    // nobody has. The preview shows the bad row and why; the apply writes the other three.
    await page.getByTestId('people-csv').click();
    await page.getByTestId('csv-upload').click();
    const upload = page.getByTestId('csv-import');
    await upload.getByTestId('csv-file').setInputFiles({
      name: 'device-ids.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(
        [
          'student_code,staff_phone,device_id',
          `${FAHIM.code},,`,
          `${UMME.code},,${demoId(FAHIM)}`,
          `${PRIYANKA.code},,`,
          'SHS-2026-9999,,777003',
          '',
        ].join('\r\n'),
      ),
    });
    await upload.getByTestId('csv-check').click();
    const preview = upload.getByTestId('csv-preview');
    await expect(preview).toContainText('৩টি বদলাবে');
    await expect(preview).toContainText('১টি ভুল');
    const lines = preview.getByTestId('csv-preview-table').locator('tbody tr');
    await expect(lines).toHaveCount(4);
    await expect(lines.first()).toContainText('এই কোডের কোনো শিক্ষার্থী নেই');
    await upload.getByTestId('csv-apply').click();
    await expect(upload).toBeHidden();
    await expect(page.getByText('৩ জনের আইডি বদলানো হলো; ১টি ভুল সারি বাদ পড়েছে')).toBeVisible();
    await expect(row(UMME)).toContainText(demoId(FAHIM));
    // Priyanka is offered her default; Fahim's is Umme's now, so he is offered none.
    await expect(row(PRIYANKA)).toContainText(`প্রস্তাবিত ${demoId(PRIYANKA)}`);
    await expect(row(FAHIM)).toContainText('আইডি নেই');

    // Default IDs: a dry run first (who gets which, who cannot and why), then the same for real.
    await page.getByTestId('defaults-open').click();
    const defaults = page.getByTestId('defaults-dialog');
    await expect(defaults.getByTestId('defaults-count')).toHaveText(
      '১ জন আইডি পাবেন (১ জন শিক্ষার্থী, ০ জন কর্মী)।',
    );
    await expect(defaults).toContainText(PRIYANKA.name);
    await expect(defaults).toContainText(demoId(PRIYANKA));
    await expect(defaults.getByTestId('defaults-conflicts')).toContainText(
      `${FAHIM.name} (${FAHIM.code}): আইডি ${demoId(FAHIM)} আগে থেকেই ${UMME.name}-এর`,
    );
    await defaults.getByTestId('defaults-apply').click();
    await expect(defaults).toBeHidden();
    await expect(row(PRIYANKA)).not.toContainText('প্রস্তাবিত');
    await expect(row(PRIYANKA)).toContainText(demoId(PRIYANKA));

    // The collision: Fahim wants the number Umme holds. "Set an ID" shows him alone, editing.
    const collision = page.getByTestId('collision');
    await expect(collision).toHaveCount(1);
    await expect(collision).toContainText(demoId(FAHIM));
    await expect(collision).toContainText(`এখন আছে: ${UMME.name} (${UMME.code})`);
    await expect(collision).toContainText(FAHIM.name);
    await collision.getByTestId('collision-set').click();
    await expect(table.locator('tbody tr')).toHaveCount(1);
    const fahimId = row(FAHIM).getByTestId('device-id-input');
    await expect(fahimId).toBeVisible();
    await fahimId.fill(demoId(UMME));
    await fahimId.press('Enter');
    await expect(row(FAHIM).getByTestId('device-id-form')).toHaveCount(0);
    await expect(row(FAHIM)).toContainText(demoId(UMME));
    await expect(collision).toHaveCount(0);
  } finally {
    await restoreDemoIds(owner);
  }
});

test('a new device: the Bangla setup guide, its first call, and everyone sent to it', async ({
  page,
}) => {
  const owner = await apiLogin(DEMO.shaplaOwner);
  const { setup } = await api<DeviceList>(owner, '/attendance/devices');
  expect(setup.port).toBe(4280);
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto('/attendance/devices');
  await expect(page.getByTestId('devices-table')).toBeVisible();

  await page.getByTestId('device-add').click();
  const form = page.getByTestId('device-form');
  // Typed as read off the sticker; kept in capitals.
  await form.getByTestId('device-serial').fill(SERIAL.toLowerCase());
  await form.getByTestId('device-name').fill(DEVICE_NAME);
  await form.getByRole('button', { name: 'যোগ করুন', exact: true }).click();

  // The guide opens on it: the server and port to type into the device, and a waiting line.
  const guide = page.getByTestId('setup-guide');
  await expect(guide).toContainText(`সেটআপ নির্দেশিকা: ${DEVICE_NAME}`);
  await expect(guide.getByTestId('guide-host')).toHaveText(setup.host);
  await expect(guide.getByTestId('guide-port')).toHaveText('4280');
  await expect(guide.getByTestId('guide-serial')).toHaveText(SERIAL);
  await expect(guide).toContainText(`Server Address-এ লিখুন ${setup.host}, আর Server Port-এ 4280।`);
  const status = guide.getByTestId('guide-status');
  await expect(status).toHaveAttribute('data-state', 'waiting');
  await expect(status).toContainText('মেশিনের অপেক্ষায়…');

  // The device calls in; the guide notices by itself (it asks every 5 s while it waits) and shows
  // the address, trusted automatically as the device's first.
  device = new ZkDeviceSimulator({ baseUrl: RECEIVER, sn: SERIAL });
  expect((await device.handshake()).status).toBe(200);
  await expect(status).toHaveAttribute('data-state', 'connected', { timeout: 15_000 });
  await expect(status).toContainText('যুক্ত হয়েছে');
  await expect(status).toContainText('মেশিনটি 127.0.0.1 ঠিকানা থেকে যুক্ত হয়েছে।');
  await expect(status).toContainText('প্রথম যোগাযোগে নিজে থেকে বিশ্বাস করা হয়েছে');
  await page.keyboard.press('Escape');
  await expect(guide).toBeHidden();
  const row = deviceRow(page);
  await expect(row).toContainText('অনলাইন');

  // "Send people to this device": one command per person with an ID.
  await row.getByTestId('device-actions').click();
  const synced = page.waitForResponse(
    (r) => r.url().endsWith('/sync') && r.request().method() === 'POST',
  );
  await page.getByTestId('device-sync').click();
  const { queued } = (await (await synced).json()) as DeviceSyncResult;
  // The 30 demo students and the staff.
  expect(queued).toBeGreaterThan(30);
  await expect(
    page.getByText(`${DEVICE_NAME}-এ ${formatCount(queued, 'bn')} জনকে পাঠানো হচ্ছে`),
  ).toBeVisible();

  // The device's next calls take them (20 a call), add each and confirm; its last call says how
  // many people it holds.
  for (let call = 0; call < 10; call++) {
    if ((await device.poll(true)).commands.length === 0) break;
  }
  expect(device.users.size).toBe(queued);
  // The device shows names in English.
  expect([...device.users.values()]).toContain('Rakib Hasan');
  await page.reload();
  // Columns: device, serial, state, last call, last punch, people on it, commands waiting.
  await expect(row.getByRole('cell').nth(5)).toHaveText(formatCount(queued, 'bn'));
  await expect(row.getByRole('cell').nth(6)).toHaveText('—');
});

test('the live feed: names within seconds, an unknown ID; a punch from a second address flagged, rejected, its address trusted', async ({
  page,
}) => {
  const owner = await apiLogin(DEMO.shaplaOwner);
  const { people } = await api<DevicePeopleList>(owner, '/attendance/device-people');
  const idOf = (nameBn: string) => people.find((p) => p.nameBn === nameBn)!.deviceUserId!;
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto('/attendance/devices');
  const feed = page.getByTestId('feed-table');
  await expect(feed).toBeVisible();
  const rows = feed.locator('tbody tr').filter({ hasText: DEVICE_NAME });

  // A student, a teacher and an ID nobody has punch in.
  for (const id of [idOf('রাকিব হাসান'), idOf('নাসরিন আক্তার'), UNKNOWN_ID]) {
    expect((await device.punch(id)).body).toBe('OK: 1');
  }
  // The feed asks every 5 s: each shows with a name and the class, or "staff".
  await expect(rows.filter({ hasText: 'রাকিব হাসান' })).toContainText('ষষ্ঠ শ্রেণি, ক', {
    timeout: 15_000,
  });
  await expect(rows.filter({ hasText: 'নাসরিন আক্তার' })).toContainText('কর্মী');
  // The unknown ID is called out, and leads to the people screen, which says what to do.
  const unknown = rows.getByTestId('feed-unknown');
  await expect(unknown).toHaveText(`অচেনা আইডি ${UNKNOWN_ID}`);
  await unknown.click();
  await expect(page).toHaveURL(new RegExp(`/attendance/devices/people\\?unknown=${UNKNOWN_ID}$`));
  await expect(page.getByTestId('unknown-id')).toContainText(
    `আইডি ${UNKNOWN_ID} দিয়ে মেশিনে পাঞ্চ এসেছে, কিন্তু আইডিটি কারও নামে নেই।`,
  );

  // A punch from another address: flagged in the feed.
  await page.goto('/attendance/devices');
  const elsewhere = new ZkDeviceSimulator({ baseUrl: RECEIVER, sn: SERIAL, forwardedFor: NEW_IP });
  expect((await elsewhere.punch(idOf('নাফিসা ইসলাম'))).body).toBe('OK: 1');
  // The device's last call: the last test waits for it to go offline from here.
  lastContact = Date.now();
  const flagged = rows.filter({ hasText: 'নাফিসা ইসলাম' });
  await expect(flagged).toContainText('নতুন IP', { timeout: 15_000 });

  // Rejected after a confirm: it stops counting and says so.
  await flagged.getByTestId('review-reject').click();
  const confirm = page.getByTestId('confirm-dialog');
  await expect(confirm).toContainText('এই পাঞ্চ বাতিল করবেন?');
  await confirm.getByRole('button', { name: 'পাঞ্চটি বাতিল করুন' }).click();
  await expect(confirm).toBeHidden();
  await expect(flagged.getByTestId('review-actions')).toHaveCount(0);
  await expect(flagged).toContainText('বাতিল');

  // The alert names the address (the alerts are asked again after a review, else every 30 s);
  // trusting it, after a confirm, clears it.
  const alert = page.getByTestId('device-alert').filter({ hasText: NEW_IP });
  await expect(alert).toHaveAttribute('data-kind', 'NEW_IP', { timeout: 35_000 });
  await expect(alert).toContainText(`${DEVICE_NAME}: নতুন IP ${NEW_IP} থেকে ১টি পাঞ্চ`);
  await alert.getByTestId('alert-trust').click();
  await expect(confirm).toContainText(`${NEW_IP} ঠিকানাটি বিশ্বাস করবেন?`);
  await confirm.getByRole('button', { name: 'বিশ্বাস করুন', exact: true }).click();
  await expect(page.getByText(`${NEW_IP} বিশ্বাস করা হলো`)).toBeVisible();
  await expect(alert).toHaveCount(0);

  // Both addresses trusted now: the first by itself, the second by the owner.
  await deviceRow(page).getByTestId('device-actions').click();
  await page.getByTestId('device-addresses-open').click();
  const addresses = page.getByTestId('device-addresses').getByTestId('device-address');
  await expect(addresses).toHaveCount(2);
  await expect(addresses.filter({ hasText: '127.0.0.1' })).toContainText(
    'প্রথম যোগাযোগে নিজে থেকে বিশ্বাস করা হয়েছে',
  );
  await expect(addresses.filter({ hasText: NEW_IP })).toContainText('আব্দুল করিম বিশ্বাস করেছেন');
  await page.keyboard.press('Escape');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('the devices screen, the setup guide and the people screen fit 390 px, with 44 px targets', async ({
    page,
  }) => {
    await passwordLogin(page, DEMO.shaplaOwner);
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto('/attendance/devices');
    const card = page.getByTestId('device-card').filter({ hasText: SERIAL });
    await expect(card).toBeVisible();
    await expect(page.getByTestId('feed-cards')).toBeVisible();
    await expectClean(page, 'devices 390');

    await card.getByTestId('device-actions').tap();
    await page.getByRole('menuitem', { name: 'সেটআপ নির্দেশিকা' }).tap();
    await expect(page.getByTestId('setup-guide').getByTestId('guide-status')).toBeVisible();
    await expectClean(page, 'setup guide 390');
    await page.keyboard.press('Escape');

    await page.goto('/attendance/devices/people');
    await expect(page.getByTestId('people-cards')).toBeVisible();
    await expectClean(page, 'device people 390');
  });
});

test('the device goes quiet: offline two minutes after its last call, then switched off', async ({
  page,
}) => {
  test.setTimeout(DEVICE_ONLINE_WINDOW_MS + 90_000);
  const owner = await apiLogin(DEMO.shaplaOwner);
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page).toHaveURL(/\/dashboard$/);
  // Online lasts 2 minutes from the last call (made at the end of the feed test).
  await page.waitForTimeout(
    Math.max(0, lastContact + DEVICE_ONLINE_WINDOW_MS + 5_000 - Date.now()),
  );
  await page.goto('/attendance/devices');
  const row = deviceRow(page);
  await expect(row).toContainText('অফলাইন');

  // The guide says so too, with when it was last heard from.
  const { lastSeenAt } = (await api<DeviceList>(owner, '/attendance/devices')).devices.find(
    (d) => d.serialNo === SERIAL,
  )!;
  await row.getByTestId('device-actions').click();
  await page.getByRole('menuitem', { name: 'সেটআপ নির্দেশিকা' }).click();
  const status = page.getByTestId('setup-guide').getByTestId('guide-status');
  await expect(status).toHaveAttribute('data-state', 'offline');
  await expect(status).toContainText('এখন অফলাইন');
  await expect(status).toContainText('শেষ যোগাযোগ');
  await expect(status).toContainText(formatTime(lastSeenAt!, 'bn'));
  await page.keyboard.press('Escape');

  // Switched off, after a confirm: the specs after this one see only the demo's devices on.
  await row.getByTestId('device-actions').click();
  await page.getByRole('menuitem', { name: 'বন্ধ করুন' }).click();
  await page.getByTestId('confirm-dialog').getByRole('button', { name: 'বন্ধ করুন' }).click();
  await expect(page.getByText(`${DEVICE_NAME} বন্ধ করা হলো`)).toBeVisible();
  await expect(row).toContainText('বন্ধ');
});

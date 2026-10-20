import { expect, test, type Page } from '@playwright/test';
import { normalizeBdPhone, toAsciiDigits, toBanglaDigits } from '@jantrik/shared';
import { Redis } from 'ioredis';
import { E2E_REDIS_URL } from '../playwright.config';

/** Seeded demo users (packages/db/src/seed/demo.ts). */
export const DEMO = {
  password: 'Jantrik@2026',
  shaplaOwner: '01711000001',
  shaplaTeacher: '01711000002',
  aloOwner: '01511000001',
  sharedTeacher: '01911000999',
  shaplaName: 'শাপলা উচ্চ বিদ্যালয়',
  aloName: 'আলো কোচিং সেন্টার',
  // Guardian (OTP only) of two Shapla students.
  shaplaGuardian: '01811000101',
  // Tasnim's mother (OTP only): a second guardian, so specs don't share one OTP cooldown.
  shaplaGuardian2: '01811000102',
};

export const API_URL = process.env['E2E_API_URL'] ?? 'http://localhost:4000';

/** Latest OTP the API "sent" to a phone (SMS_PROVIDER=outbox → Redis list). */
export async function readOtp(phone: string, previous?: string): Promise<string> {
  const e164 = normalizeBdPhone(phone)!;
  const redis = new Redis(E2E_REDIS_URL);
  try {
    let code: string | undefined;
    await expect
      .poll(
        async () => {
          const last = await redis.lindex(`sms:outbox:${e164}`, -1);
          code = last ? /\b(\d{6})\b/.exec(last)?.[1] : undefined;
          return code && code !== previous ? code : undefined;
        },
        { timeout: 10_000 },
      )
      .toBeTruthy();
    return code!;
  } finally {
    await redis.quit();
  }
}

export async function passwordLogin(page: Page, identifier: string, password = DEMO.password) {
  await page.goto('/login');
  await page.getByRole('tab', { name: 'পাসওয়ার্ড' }).click();
  await page.getByLabel('মোবাইল নম্বর বা ইমেইল').fill(identifier);
  // (the tab panel is also labelled "পাসওয়ার্ড", so target the input by role)
  await page.getByRole('textbox', { name: 'পাসওয়ার্ড', exact: true }).fill(password);
  await page.getByRole('button', { name: 'লগইন', exact: true }).click();
}

/**
 * The phone input of the OTP tab. Scoped to that tab panel and matched exactly: right after a
 * tab switch the password panel ("মোবাইল নম্বর বা ইমেইল") can still be mounted for a moment, which
 * a slow CI runner hits (strict-mode violation).
 */
export const otpPhoneInput = (page: Page) =>
  page.getByRole('tabpanel', { name: 'ওটিপি কোড' }).getByLabel('মোবাইল নম্বর', { exact: true });

/** OTP login typed entirely with a Bangla keyboard (Bangla digits). */
export async function otpLoginWithBanglaDigits(page: Page, phone: string) {
  await page.goto('/login');
  await otpPhoneInput(page).fill(toBanglaDigits(phone));
  await page.getByRole('button', { name: 'কোড পাঠান' }).click();
  // Specs share the demo guardian, so its resend cooldown may still be running: wait it out once,
  // as a person would, rather than touching the rate-limit state.
  const sent = page.getByTestId('resend-countdown');
  const limited = page.getByRole('alert').filter({ hasText: 'অনেকবার চেষ্টা করা হয়েছে' });
  await expect(sent.or(limited)).toBeVisible();
  if (await limited.isVisible()) {
    const seconds = Number(toAsciiDigits(await limited.innerText()).match(/\d+/)?.[0] ?? 60);
    test.info().setTimeout(test.info().timeout + (seconds + 1) * 1000);
    await page.waitForTimeout((seconds + 1) * 1000);
    await page.goto('/login');
    await otpPhoneInput(page).fill(toBanglaDigits(phone));
    await page.getByRole('button', { name: 'কোড পাঠান' }).click();
  }
  await expect(sent).toBeVisible();
  const code = await readOtp(phone);
  await page.getByLabel('যাচাই কোড').pressSequentially(toBanglaDigits(code));
  await page.getByRole('button', { name: 'লগইন', exact: true }).click();
}

export async function logout(page: Page) {
  await page.getByTestId('user-menu').click();
  await page.getByTestId('logout').click();
}

/** Access token straight from the API (for API-level checks). */
export async function apiLogin(identifier: string, password = DEMO.password): Promise<string> {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password, client: 'mobile' }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

/** The latest 6-digit code in a phone's SMS outbox, if any (to tell a new OTP from an old one). */
async function lastOtp(phone: string): Promise<string | undefined> {
  const redis = new Redis(E2E_REDIS_URL);
  try {
    const last = await redis.lindex(`sms:outbox:${normalizeBdPhone(phone)!}`, -1);
    return last ? /\b(\d{6})\b/.exec(last)?.[1] : undefined;
  } finally {
    await redis.quit();
  }
}

/**
 * Access token via OTP (test SMS outbox), for API-level setup. Doesn't use up the account's
 * password attempts (5 per 15 minutes), which the UI login tests need.
 */
export async function apiOtpLogin(phone: string): Promise<string> {
  const previous = await lastOtp(phone);
  const request = () =>
    fetch(`${API_URL}/auth/otp/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
  let req = await request();
  if (req.status === 429) {
    // One OTP per phone per minute: after a failed test Playwright re-runs beforeAll in a new
    // worker, which can land inside that minute. Wait it out once.
    const wait = Number(req.headers.get('Retry-After') ?? 60);
    await new Promise((r) => setTimeout(r, (Math.min(wait, 65) + 1) * 1000));
    req = await request();
  }
  expect(req.status).toBe(202);
  const code = await readOtp(phone, previous);
  const res = await fetch(`${API_URL}/auth/otp/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code, client: 'mobile' }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

/** Authenticated JSON call straight to the API. */
export async function api<T>(
  token: string,
  path: string,
  init: { method?: string; json?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  expect(res.ok, `${init.method ?? 'GET'} ${path} → ${res.status}`).toBe(true);
  return (await res.json()) as T;
}

import { expect, type Page } from '@playwright/test';
import { normalizeBdPhone, toBanglaDigits } from '@jantrik/shared';
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

/** OTP login typed entirely with a Bangla keyboard (Bangla digits). */
export async function otpLoginWithBanglaDigits(page: Page, phone: string) {
  await page.goto('/login');
  await page.getByLabel('মোবাইল নম্বর').fill(toBanglaDigits(phone));
  await page.getByRole('button', { name: 'কোড পাঠান' }).click();
  await expect(page.getByTestId('resend-countdown')).toBeVisible();
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

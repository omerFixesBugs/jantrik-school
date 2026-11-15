import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RateLimiter } from '../redis/rate-limiter.service.js';
import { REDIS } from '../redis/redis.constants.js';
import { SmsService } from '../sms/sms.service.js';
import { findUserForLogin, type LoginUser } from './login-lookup.js';

export const OTP_TTL_SEC = 5 * 60;
export const OTP_MAX_ATTEMPTS = 5;

/**
 * What a code is for. A login code signs in; a password code (sprint 1 P1) lets a signed-in staff
 * member set their password. Each has its own key, so neither can be used for the other.
 */
export type OtpPurpose = 'login' | 'password';

const codeKey = (phone: string, purpose: OtpPurpose) =>
  purpose === 'login' ? `otp:${phone}` : `otp:password:${phone}`;
const attemptsKey = (phone: string, purpose: OtpPurpose) => `${codeKey(phone, purpose)}:attempts`;
/** One code per purpose per cooldown; the 15-minute and daily SMS caps are the phone's, shared. */
const cooldownKey = (phone: string, purpose: OtpPurpose) =>
  purpose === 'login' ? `otp-phone-cooldown:${phone}` : `otp-password-cooldown:${phone}`;

const SMS_TEXT: Record<OtpPurpose, Record<'bn' | 'en', (code: string) => string>> = {
  login: {
    bn: (code) => `আপনার জান্ত্রিক কোড: ${code}। ৫ মিনিটের মধ্যে ব্যবহার করুন। কাউকে জানাবেন না।`,
    en: (code) => `Your Jantrik code is ${code}. It expires in 5 minutes. Do not share it.`,
  },
  password: {
    bn: (code) =>
      `আপনার জান্ত্রিক পাসওয়ার্ড সেট করার কোড: ${code}। ৫ মিনিটের মধ্যে ব্যবহার করুন। কাউকে জানাবেন না।`,
    en: (code) =>
      `Your Jantrik code to set your password is ${code}. It expires in 5 minutes. Do not share it.`,
  },
};

/**
 * Phone OTP. Codes live only in Redis as HMAC-SHA256(OTP_PEPPER, phone:code) — a plain hash of
 * a 6-digit code could be reversed offline in seconds.
 */
@Injectable()
export class OtpService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly prisma: PrismaService,
    private readonly limiter: RateLimiter,
    private readonly sms: SmsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Send a code if the phone belongs to a user. The rate limits are applied BEFORE the lookup
   * and the caller always gets the same response, so this cannot be used to discover accounts.
   * Login and password codes share the phone's SMS caps (each has its own cooldown).
   */
  async request(phone: string, ip: string, purpose: OtpPurpose = 'login'): Promise<void> {
    const cfg = (key: keyof Env) => this.config.get(key, { infer: true }) as number;
    await this.limiter.consume(
      { key: `otp-ip:${ip}`, limit: cfg('OTP_REQUEST_PER_IP_PER_HOUR'), windowSec: 3600 },
      {
        key: cooldownKey(phone, purpose),
        limit: 1,
        windowSec: cfg('OTP_PER_PHONE_COOLDOWN_SEC'),
      },
      { key: `otp-phone-15m:${phone}`, limit: cfg('OTP_PER_PHONE_PER_15MIN'), windowSec: 900 },
      // SMS costs money: hard daily cap per phone.
      { key: `otp-phone-day:${phone}`, limit: cfg('OTP_PER_PHONE_PER_DAY'), windowSec: 86_400 },
    );

    const user = await findUserForLogin(this.prisma.client, { phone });
    if (!user) return; // same response, no SMS

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.redis
      .multi()
      .set(codeKey(phone, purpose), this.hmac(phone, code, purpose), 'EX', OTP_TTL_SEC)
      .del(attemptsKey(phone, purpose))
      .exec();
    await this.sms.send(phone, SMS_TEXT[purpose][user.locale](code));
  }

  /** The user for a correct code, or undefined. Every failure looks the same to the caller. */
  async verify(
    phone: string,
    code: string,
    ip: string,
    purpose: OtpPurpose = 'login',
  ): Promise<LoginUser | undefined> {
    await this.limiter.consume({
      key: `login-ip:${ip}`,
      limit: this.config.get('LOGIN_PER_IP_PER_15MIN', { infer: true }),
      windowSec: 900,
    });

    const stored = await this.redis.get(codeKey(phone, purpose));
    if (!stored) return undefined;

    // Count the attempt first (atomic), so parallel guesses cannot exceed the limit.
    const attempts = await this.redis.incr(attemptsKey(phone, purpose));
    if (attempts === 1) await this.redis.expire(attemptsKey(phone, purpose), OTP_TTL_SEC);
    if (attempts > OTP_MAX_ATTEMPTS) {
      await this.burn(phone, purpose);
      return undefined;
    }

    const expected = Buffer.from(stored, 'hex');
    const actual = Buffer.from(this.hmac(phone, code, purpose), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      if (attempts >= OTP_MAX_ATTEMPTS) await this.burn(phone, purpose);
      return undefined;
    }

    await this.burn(phone, purpose); // single use
    return findUserForLogin(this.prisma.client, { phone });
  }

  private burn(phone: string, purpose: OtpPurpose): Promise<unknown> {
    return this.redis.del(codeKey(phone, purpose), attemptsKey(phone, purpose));
  }

  /** The purpose is part of the MAC (the login code keeps its original input). */
  private hmac(phone: string, code: string, purpose: OtpPurpose): string {
    const input = purpose === 'login' ? `${phone}:${code}` : `${purpose}:${phone}:${code}`;
    return createHmac('sha256', this.config.get('OTP_PEPPER', { infer: true }))
      .update(input)
      .digest('hex');
  }
}

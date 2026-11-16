import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Env } from '../../config/env.js';
import { RateLimiter } from '../../redis/rate-limiter.service.js';
import { REDIS } from '../../redis/redis.constants.js';

export const ADMISSION_SMS_QUEUE = 'admission-sms';
export const ADMISSION_OTP_JOB = 'otp';
export const ADMISSION_SUBMITTED_JOB = 'submitted';

/** The code job: as the login code's, the code travels in the job (removed when done). */
export interface AdmissionOtpJob {
  tenantId: string;
  phone: string;
  code: string;
  locale: 'bn' | 'en';
}

/** The "received" job: ids only; the worker reads the application in its institute's context. */
export interface AdmissionSubmittedJob {
  tenantId: string;
  applicationId: string;
  slug: string;
}

export const ADMISSION_OTP_TTL_SEC = 5 * 60;
export const ADMISSION_OTP_MAX_ATTEMPTS = 5;

const codeKey = (tenantId: string, phone: string) => `otp:admission:${tenantId}:${phone}`;
const attemptsKey = (tenantId: string, phone: string) =>
  `otp:admission:attempts:${tenantId}:${phone}`;

/**
 * The applicant's phone code (sprint 1 P3b). Codes live only in Redis as
 * HMAC-SHA256(OTP_PEPPER, "admission:<institute>:<phone>:<code>"), 5 minutes, 5 attempts, single
 * use even under races (the delete wins), like the login code; but any valid Bangladeshi mobile may
 * get one (applicants have no account). Limits (review focus 1): per phone one a minute and five a
 * day, per address 20 an hour, and per institute ADMISSION_OTP_PER_TENANT_PER_DAY a day whatever
 * the phones and addresses. The caller checks Turnstile first, so a refused token uses no counter.
 */
@Injectable()
export class AdmissionOtpService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly limiter: RateLimiter,
    private readonly config: ConfigService<Env, true>,
    @InjectQueue(ADMISSION_SMS_QUEUE) private readonly queue: Queue<AdmissionOtpJob>,
  ) {}

  async request(input: {
    tenantId: string;
    phone: string;
    ip: string;
    today: string;
    locale: 'bn' | 'en';
  }): Promise<void> {
    const { tenantId, phone } = input;
    await this.limiter.consume(
      { key: `adm-otp-ip:${input.ip}`, limit: 20, windowSec: 3600 },
      { key: `adm-otp-phone-1m:${tenantId}:${phone}`, limit: 1, windowSec: 60 },
      { key: `adm-otp-phone-day:${phone}`, limit: 5, windowSec: 86_400 },
      {
        key: `adm-otp-tenant:${tenantId}:${input.today}`,
        limit: this.config.get('ADMISSION_OTP_PER_TENANT_PER_DAY', { infer: true }),
        windowSec: 86_400,
      },
    );
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.redis
      .multi()
      .set(codeKey(tenantId, phone), this.hmac(tenantId, phone, code), 'EX', ADMISSION_OTP_TTL_SEC)
      .del(attemptsKey(tenantId, phone))
      .exec();
    await this.queue.add(
      ADMISSION_OTP_JOB,
      { tenantId, phone, code, locale: input.locale },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  /** True once for a correct code; every failure looks the same. */
  async verify(input: { tenantId: string; phone: string; code: string; ip: string }) {
    const { tenantId, phone } = input;
    await this.limiter.consume({ key: `adm-verify-ip:${input.ip}`, limit: 30, windowSec: 900 });
    const stored = await this.redis.get(codeKey(tenantId, phone));
    if (!stored) return false;
    const attempts = await this.redis.incr(attemptsKey(tenantId, phone));
    if (attempts === 1) await this.redis.expire(attemptsKey(tenantId, phone), ADMISSION_OTP_TTL_SEC);
    if (attempts > ADMISSION_OTP_MAX_ATTEMPTS) {
      await this.redis.del(codeKey(tenantId, phone), attemptsKey(tenantId, phone));
      return false;
    }
    const expected = Buffer.from(stored, 'hex');
    const actual = Buffer.from(this.hmac(tenantId, phone, input.code), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      if (attempts >= ADMISSION_OTP_MAX_ATTEMPTS) {
        await this.redis.del(codeKey(tenantId, phone), attemptsKey(tenantId, phone));
      }
      return false;
    }
    if ((await this.redis.del(codeKey(tenantId, phone))) !== 1) return false;
    await this.redis.del(attemptsKey(tenantId, phone));
    return true;
  }

  private hmac(tenantId: string, phone: string, code: string): string {
    return createHmac('sha256', this.config.get('OTP_PEPPER', { infer: true }))
      .update(`admission:${tenantId}:${phone}:${code}`)
      .digest('hex');
  }
}

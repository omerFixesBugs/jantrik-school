import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import { CLS_RES, ClsService } from 'nestjs-cls';
import { REDIS } from './redis.constants.js';

export interface RateLimitRule {
  /** Bucket name + identity, e.g. `otp-phone-day:+88017...`. */
  key: string;
  limit: number;
  windowSec: number;
}

/**
 * Fixed-window rate limiter in Redis. Counters are shared by every API instance.
 */
@Injectable()
export class RateLimiter {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly cls: ClsService,
  ) {}

  /** Count one hit; returns whether it is within the limit and seconds until the window resets. */
  async hit(rule: RateLimitRule): Promise<{ allowed: boolean; retryAfter: number }> {
    const key = `rl:${rule.key}`;
    const results = await this.redis
      .multi()
      .set(key, 0, 'EX', rule.windowSec, 'NX')
      .incr(key)
      .ttl(key)
      .exec();
    const count = Number(results?.[1]?.[1] ?? 0);
    const ttl = Number(results?.[2]?.[1] ?? rule.windowSec);
    return { allowed: count <= rule.limit, retryAfter: Math.max(ttl, 1) };
  }

  /** Count one hit on every rule; throw 429 (with Retry-After) if any is exceeded. */
  async consume(...rules: RateLimitRule[]): Promise<void> {
    let retryAfter = 0;
    for (const rule of rules) {
      const result = await this.hit(rule);
      if (!result.allowed) retryAfter = Math.max(retryAfter, result.retryAfter);
    }
    if (retryAfter > 0) {
      const res = this.cls.isActive() ? this.cls.get<Response | undefined>(CLS_RES) : undefined;
      res?.setHeader('Retry-After', String(retryAfter));
      throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}

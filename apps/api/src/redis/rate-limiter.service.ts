import { HttpException, HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
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

/** KEYS: the counters; ARGV: limit, window per key. 0 when counted, else seconds to wait. */
const CONSUME_IF_ALLOWED = `
for i, key in ipairs(KEYS) do
  local n = tonumber(redis.call('GET', key) or '0')
  if n >= tonumber(ARGV[(i - 1) * 2 + 1]) then
    local ttl = redis.call('TTL', key)
    if ttl < 1 then ttl = tonumber(ARGV[(i - 1) * 2 + 2]) end
    return ttl
  end
end
for i, key in ipairs(KEYS) do
  redis.call('SET', key, 0, 'EX', ARGV[(i - 1) * 2 + 2], 'NX')
  redis.call('INCR', key)
end
return 0`;

/**
 * Fixed-window rate limiter in Redis. Counters are shared by every API instance. The device
 * receiver (src/ingest) has no request context (CLS) and uses `hit` and `peek` only.
 */
@Injectable()
export class RateLimiter {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Optional() private readonly cls?: ClsService,
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

  /** A counter's hits so far and seconds until its window resets, without counting one. */
  async peek(key: string): Promise<{ count: number; retryAfter: number }> {
    const results = await this.redis.multi().get(`rl:${key}`).ttl(`rl:${key}`).exec();
    const count = Number(results?.[0]?.[1] ?? 0);
    const ttl = Number(results?.[1]?.[1] ?? 0);
    return { count, retryAfter: Math.max(ttl, 1) };
  }

  /** Forget a counter (e.g. failed password attempts after a successful login). */
  async reset(key: string): Promise<void> {
    await this.redis.del(`rl:${key}`);
  }

  /**
   * Counts one hit on every rule only when all of them still have room, atomically (one Lua
   * script); otherwise counts nothing and throws 429. For shared budgets a refused request must
   * not spend (an institute's daily admission codes, review of P3b, M1).
   */
  async consumeIfAllowed(...rules: RateLimitRule[]): Promise<void> {
    const retryAfter = await this.consumeAll(rules);
    if (retryAfter > 0) {
      const res = this.cls?.isActive() ? this.cls.get<Response | undefined>(CLS_RES) : undefined;
      res?.setHeader('Retry-After', String(retryAfter));
      throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /**
   * consumeIfAllowed that answers instead of throwing: true when every rule had room (one hit
   * counted on each), false when any was full (nothing counted, no Retry-After set). For a caller
   * whose answer must not show that a budget is spent (the admission status page, review round 2).
   */
  async tryConsume(...rules: RateLimitRule[]): Promise<boolean> {
    return (await this.consumeAll(rules)) === 0;
  }

  /** The all-or-nothing script: 0 when counted, else the seconds until the fullest rule resets. */
  private async consumeAll(rules: RateLimitRule[]): Promise<number> {
    const keys = rules.map((r) => `rl:${r.key}`);
    const args = rules.flatMap((r) => [String(r.limit), String(r.windowSec)]);
    return Number(await this.redis.eval(CONSUME_IF_ALLOWED, keys.length, ...keys, ...args));
  }

  /** Count one hit on every rule; throw 429 (with Retry-After) if any is exceeded. */
  async consume(...rules: RateLimitRule[]): Promise<void> {
    let retryAfter = 0;
    for (const rule of rules) {
      const result = await this.hit(rule);
      if (!result.allowed) retryAfter = Math.max(retryAfter, result.retryAfter);
    }
    if (retryAfter > 0) {
      const res = this.cls?.isActive() ? this.cls.get<Response | undefined>(CLS_RES) : undefined;
      res?.setHeader('Retry-After', String(retryAfter));
      throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}

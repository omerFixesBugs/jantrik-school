import { HttpException } from '@nestjs/common';
import { apiError } from '../common/api-error.js';

/** A Redis call that takes longer than this counts as Redis unavailable. */
export const REDIS_CALL_TIMEOUT_MS = 2_000;

/**
 * Runs a step that needs Redis. If Redis fails, or does not answer within `ms`, the request gets
 * 503 `code` (try again) instead of hanging until ioredis gives up and then failing with a 500.
 * An HttpException the step throws itself (e.g. a rate limit's 429) passes through unchanged.
 */
export async function withRedisDeadline<T>(
  op: () => Promise<T>,
  ms: number,
  code: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Redis did not answer in time')), ms);
  });
  try {
    return await Promise.race([op(), timeout]);
  } catch (error) {
    if (error instanceof HttpException) throw error;
    throw apiError(503, code, 'A required service is unavailable, try again shortly');
  } finally {
    clearTimeout(timer);
  }
}

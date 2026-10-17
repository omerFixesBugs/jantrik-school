import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

/** Sends one SMS. The real Bangladeshi gateway implementation comes later. */
export interface SmsProvider {
  send(to: string, text: string): Promise<void>;
}

export const SMS_PROVIDER = Symbol('SMS_PROVIDER');

/**
 * Development only: prints messages (including OTP codes) to the API log. This is the ONLY
 * place an OTP may be logged; it refuses to run in production.
 */
export class ConsoleSmsProvider implements SmsProvider {
  private readonly logger = new Logger('DevSms');

  constructor(nodeEnv: string) {
    if (nodeEnv === 'production') {
      throw new Error('ConsoleSmsProvider must not be used in production');
    }
  }

  async send(to: string, text: string): Promise<void> {
    this.logger.log(`[dev SMS to ${to}] ${text}`);
  }
}

/** Tests only: keeps messages in memory so tests can read the OTP. */
export class MemorySmsProvider implements SmsProvider {
  readonly messages: { to: string; text: string }[] = [];

  constructor(nodeEnv: string) {
    if (nodeEnv !== 'test') {
      throw new Error('MemorySmsProvider is for tests only');
    }
  }

  async send(to: string, text: string): Promise<void> {
    this.messages.push({ to, text });
  }

  sentTo(to: string): string[] {
    return this.messages.filter((m) => m.to === to).map((m) => m.text);
  }
}

/**
 * End-to-end tests only: pushes each message to the Redis list `sms:outbox:<phone>` (1 h TTL),
 * where Playwright reads the OTP. Refuses to run in production.
 */
export class RedisOutboxSmsProvider implements SmsProvider {
  constructor(
    private readonly redis: Pick<Redis, 'rpush' | 'expire'>,
    nodeEnv: string,
  ) {
    if (nodeEnv === 'production') {
      throw new Error('RedisOutboxSmsProvider must not be used in production');
    }
  }

  async send(to: string, text: string): Promise<void> {
    const key = `sms:outbox:${to}`;
    await this.redis.rpush(key, text);
    await this.redis.expire(key, 3600);
  }
}

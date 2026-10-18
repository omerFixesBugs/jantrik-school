import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.constants.js';
import {
  ConsoleSmsProvider,
  MemorySmsProvider,
  RedisOutboxSmsProvider,
  SMS_PROVIDER,
} from './sms.providers.js';
import { SMS_QUEUE, SmsProcessor, SmsService } from './sms.service.js';
import { TenantSmsService } from './tenant-sms.service.js';

@Global()
@Module({
  imports: [BullModule.registerQueue({ name: SMS_QUEUE })],
  providers: [
    {
      provide: SMS_PROVIDER,
      inject: [ConfigService, REDIS],
      useFactory: (config: ConfigService<Env, true>, redis: Redis) => {
        const nodeEnv = config.get('NODE_ENV', { infer: true });
        switch (config.get('SMS_PROVIDER', { infer: true })) {
          case 'memory':
            return new MemorySmsProvider(nodeEnv);
          case 'outbox':
            return new RedisOutboxSmsProvider(redis, nodeEnv);
          default:
            return new ConsoleSmsProvider(nodeEnv);
        }
      },
    },
    SmsService,
    TenantSmsService,
    SmsProcessor,
  ],
  exports: [SmsService, TenantSmsService, SMS_PROVIDER],
})
export class SmsModule {}

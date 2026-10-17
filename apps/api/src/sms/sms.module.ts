import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { ConsoleSmsProvider, MemorySmsProvider, SMS_PROVIDER } from './sms.providers.js';
import { SMS_QUEUE, SmsProcessor, SmsService } from './sms.service.js';

@Global()
@Module({
  imports: [BullModule.registerQueue({ name: SMS_QUEUE })],
  providers: [
    {
      provide: SMS_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const nodeEnv = config.get('NODE_ENV', { infer: true });
        return config.get('SMS_PROVIDER', { infer: true }) === 'memory'
          ? new MemorySmsProvider(nodeEnv)
          : new ConsoleSmsProvider(nodeEnv);
      },
    },
    SmsService,
    SmsProcessor,
  ],
  exports: [SmsService, SMS_PROVIDER],
})
export class SmsModule {}

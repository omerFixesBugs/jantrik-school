import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Clock } from '../common/clock.js';
import { validateEnv, type Env } from '../config/env.js';
import { DEVICES_QUEUE } from '../devices/devices.constants.js';
import { RedisModule } from '../redis/redis.module.js';
import { IngestController } from './ingest.controller.js';
import { IngestPrismaService } from './ingest-prisma.service.js';
import { IngestService } from './ingest.service.js';

/**
 * The root module of the device receiver, a Nest application of its own (own port, own database
 * login, see ingest.bootstrap.ts). Deliberately small: no login, no institute context, no CORS or
 * cookies. It only queues jobs; the API's worker processes them.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Single root .env for the monorepo (cwd is apps/api when run via pnpm/turbo).
      envFilePath: ['../../.env'],
      validate: validateEnv,
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        connection: { url: config.get('REDIS_URL', { infer: true }) },
        prefix: config.get('QUEUE_PREFIX', { infer: true }),
      }),
    }),
    BullModule.registerQueue({ name: DEVICES_QUEUE }),
    RedisModule,
  ],
  controllers: [IngestController],
  providers: [IngestPrismaService, Clock, IngestService],
})
export class IngestAppModule {}

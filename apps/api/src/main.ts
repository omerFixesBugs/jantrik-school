import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import type { Env } from './config/env.js';
import { startIngestApp } from './ingest/ingest.bootstrap.js';

async function bootstrap() {
  // No request-body logging anywhere: bodies carry OTPs, passwords and refresh tokens.
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  await app.listen(config.get('API_PORT', { infer: true }));
  // The device receiver: here in development, its own process in production (ingest-main.ts).
  if (config.get('INGEST_IN_PROCESS', { infer: true })) await startIngestApp();
}
await bootstrap();

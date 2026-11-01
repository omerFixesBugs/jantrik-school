import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import type { Env } from './config/env.js';

/**
 * Starts the API on API_PORT and, with INGEST_IN_PROCESS (development), the device receiver next
 * to it. The receiver's code is loaded only then: its module validates the receiver's own
 * environment as soon as it is imported, and a production API is given none of it (no
 * DATABASE_INGEST_URL; the receiver runs as `ingest-main.js`).
 */
export async function startApi(): Promise<{
  api: NestExpressApplication;
  receiver: NestExpressApplication | null;
}> {
  // No request-body logging anywhere: bodies carry OTPs, passwords and refresh tokens.
  const api = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(api);
  const config = api.get<ConfigService<Env, true>>(ConfigService);
  await api.listen(config.get('API_PORT', { infer: true }));
  if (!config.get('INGEST_IN_PROCESS', { infer: true })) return { api, receiver: null };
  const { startIngestApp } = await import('./ingest/ingest.bootstrap.js');
  return { api, receiver: await startIngestApp() };
}

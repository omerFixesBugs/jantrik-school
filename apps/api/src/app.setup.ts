import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { parseTrustProxy, type Env } from './config/env.js';

/** HTTP hardening shared by main.ts and the e2e tests. */
export function configureApp(app: INestApplication): void {
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const express = app as NestExpressApplication;

  express.set('trust proxy', parseTrustProxy(config.get('TRUST_PROXY', { infer: true })));
  express.disable('x-powered-by');
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: config.get('CORS_ORIGINS', { infer: true }),
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Jantrik-Client'],
  });
  app.enableShutdownHooks();
}

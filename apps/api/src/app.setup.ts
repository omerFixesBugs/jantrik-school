import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { isAllowedOrigin } from './config/dev-lan.js';
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
    // The CORS_ORIGINS allowlist; in development with DEV_LAN also http://<private IP>:3000.
    // No Origin header (curl, server-to-server): no CORS headers, as with a plain allowlist.
    origin: (origin: string | undefined, done: (err: Error | null, allow?: boolean) => void) =>
      done(
        null,
        !!origin &&
          isAllowedOrigin(origin, {
            NODE_ENV: config.get('NODE_ENV', { infer: true }),
            DEV_LAN: config.get('DEV_LAN', { infer: true }),
            CORS_ORIGINS: config.get('CORS_ORIGINS', { infer: true }),
          }),
      ),
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Jantrik-Client', 'X-Jantrik-Tenant'],
    // Lets the web app show a countdown for 429 responses.
    exposedHeaders: ['Retry-After'],
  });
  app.enableShutdownHooks();
}

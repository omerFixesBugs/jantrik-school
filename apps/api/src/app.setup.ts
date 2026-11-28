import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { isAllowedOrigin } from './config/dev-lan.js';
import { parseTrustProxy, type Env } from './config/env.js';
import { signalBodyReader } from './payments/public/signal-body.js';

/** HTTP hardening shared by main.ts and the e2e tests. */
export function configureApp(app: INestApplication): void {
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const express = app as NestExpressApplication;

  express.set('trust proxy', parseTrustProxy(config.get('TRUST_PROXY', { infer: true })));
  express.disable('x-powered-by');
  app.use(helmet());
  app.use(cookieParser());
  // The gateway's return and IPN bodies (sprint 1 P7a2): read here, before the app's own
  // parsers, as a flat form of at most 16 KB (docs/payments.md → Signals).
  app.use('/public/payments', signalBodyReader);
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
    // X-Admission-Token: the public admission form's proved phone (docs/admission.md).
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Jantrik-Client',
      'X-Jantrik-Tenant',
      'X-Admission-Token',
    ],
    // Lets the web app show a countdown for 429 responses.
    exposedHeaders: ['Retry-After'],
    // Every call from the web app is preflighted (another origin, Authorization or
    // X-Jantrik-Client); browsers may reuse the answer for 2 h (Chrome's ceiling) instead of 5 s.
    // A narrower CORS_ORIGINS reaches tabs that already cached an answer up to 2 h later
    // (docs/plans/step-12-auth.md, part B).
    maxAge: 7200,
  });
  app.enableShutdownHooks();
}

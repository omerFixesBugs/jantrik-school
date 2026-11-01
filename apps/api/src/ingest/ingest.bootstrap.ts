import {
  Catch,
  Logger,
  NotFoundException,
  type ArgumentsHost,
  type ExceptionFilter,
  type INestApplication,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Server } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import { parseTrustProxy } from '../config/env.js';
import type { IngestEnv } from '../config/ingest-env.js';
import { reply } from './ingest.controller.js';
import { errorLabel, ingestRefusalStatus } from './ingest-prisma.service.js';
import { IngestAppModule } from './ingest.module.js';

/**
 * Every error ends here: an unknown route is `404 Not Found`, input an ingest function refused is
 * `400`/`413 ERROR`, anything else `500 ERROR`. Only the error's name and codes are logged, never
 * its message, the body, the query string or the headers.
 */
@Catch()
export class IngestErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('DeviceReceiver');

  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    let status: number;
    let text = 'ERROR';
    if (error instanceof NotFoundException) {
      status = 404;
      text = 'Not Found';
    } else {
      status = ingestRefusalStatus(error) ?? 500;
      if (status === 500) this.logger.error(errorLabel(error));
    }
    if (res.headersSent) {
      res.socket?.destroy();
      return;
    }
    reply(res, status, text);
  }
}

/**
 * Limits of a server open to the internet without a login. A request's headers must arrive within
 * 10 s and the whole request within 30 s (Node checks every 30 s, so a cut can take up to a minute):
 * a full 512 KB upload needs about 17 KB/s, and storing the largest upload (10 000 lines) takes
 * about 2 s after it arrived, which this timeout does not count. An idle connection closes after
 * 5 s. At most 1000 connections at once: a device polls every 30 s, briefly, on one connection.
 */
export const INGEST_SERVER_LIMITS = {
  requestTimeout: 30_000,
  headersTimeout: 10_000,
  keepAliveTimeout: 5_000,
  maxConnections: 1000,
} as const;

/** HTTP settings of the receiver, shared by createIngestApp and the e2e tests. */
export function configureIngestApp(app: INestApplication): void {
  const config = app.get<ConfigService<IngestEnv, true>>(ConfigService);
  const express = app as NestExpressApplication;
  express.set('trust proxy', parseTrustProxy(config.get('INGEST_TRUST_PROXY', { infer: true })));
  express.disable('x-powered-by');
  express.set('etag', false);
  Object.assign(app.getHttpServer() as Server, INGEST_SERVER_LIMITS);
  // Only GET and POST reach the routes. Express would answer HEAD with a GET route without
  // sending its body, so a HEAD on getrequest would mark commands sent that never left.
  express.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' || req.method === 'POST') return next();
    reply(res, 404, 'Not Found');
  });
  app.useGlobalFilters(new IngestErrorFilter());
  app.enableShutdownHooks();
}

/** The receiver as its own Nest application. Bodies are read by the controller, within limits. */
export async function createIngestApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(IngestAppModule, {
    bodyParser: false,
  });
  configureIngestApp(app);
  return app;
}

/**
 * Creates the receiver and listens on INGEST_PORT (ingest-main.ts, or api.bootstrap.ts in
 * development). Importing this file validates the receiver's environment: only import it where the
 * receiver runs.
 */
export async function startIngestApp(): Promise<NestExpressApplication> {
  const app = await createIngestApp();
  const port = app
    .get<ConfigService<IngestEnv, true>>(ConfigService)
    .get('INGEST_PORT', { infer: true });
  await app.listen(port);
  new Logger('DeviceReceiver').log(`device receiver listening on ${port}`);
  return app;
}

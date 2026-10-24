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
import type { Response } from 'express';
import { parseTrustProxy, type Env } from '../config/env.js';
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

/** HTTP settings of the receiver, shared by createIngestApp and the e2e tests. */
export function configureIngestApp(app: INestApplication): void {
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const express = app as NestExpressApplication;
  express.set('trust proxy', parseTrustProxy(config.get('INGEST_TRUST_PROXY', { infer: true })));
  express.disable('x-powered-by');
  express.set('etag', false);
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

/** Creates the receiver and listens on INGEST_PORT (ingest-main.ts, or main.ts in development). */
export async function startIngestApp(): Promise<NestExpressApplication> {
  const app = await createIngestApp();
  const port = app.get<ConfigService<Env, true>>(ConfigService).get('INGEST_PORT', { infer: true });
  await app.listen(port);
  new Logger('DeviceReceiver').log(`device receiver listening on ${port}`);
  return app;
}

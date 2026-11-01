import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Prisma } from '@jantrik/db';
import type { Response } from 'express';
import { apiError } from './api-error.js';

/** Seconds a client waits before retrying a request answered BUSY. */
export const BUSY_RETRY_AFTER_SEC = 2;

/**
 * A lock wait that ran out: Postgres `55P03` ("canceling statement due to lock timeout"). Only the
 * device punch lock sets a lock_timeout (5 s, for the rest of its transaction). A transaction
 * that ran past its own time limit (P2028) is not this: it stays an error and is logged.
 */
export function isLockTimeout(
  error: Prisma.PrismaClientKnownRequestError | Prisma.PrismaClientUnknownRequestError,
): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = error.meta as
      { code?: unknown; driverAdapterError?: { cause?: { code?: unknown } } } | undefined;
    if (meta?.code === '55P03' || meta?.driverAdapterError?.cause?.code === '55P03') return true;
  }
  return /\b55P03\b|lock timeout/.test(error.message);
}

/**
 * Constraint violations that slipped past a service's own checks (usually a race between two
 * requests) become 409s instead of 500s. Services still check first: a violation aborts the
 * request's transaction, so nothing else in it can run. A lock wait that ran out (`isLockTimeout`)
 * is 409 BUSY with Retry-After: nothing was changed, the client tries again.
 */
@Catch(Prisma.PrismaClientKnownRequestError, Prisma.PrismaClientUnknownRequestError)
export class PrismaErrorFilter extends BaseExceptionFilter implements ExceptionFilter {
  override catch(
    error: Prisma.PrismaClientKnownRequestError | Prisma.PrismaClientUnknownRequestError,
    host: ArgumentsHost,
  ): void {
    if (isLockTimeout(error)) {
      host
        .switchToHttp()
        .getResponse<Response>()
        .setHeader('Retry-After', String(BUSY_RETRY_AFTER_SEC));
      return super.catch(apiError(409, 'BUSY', 'Busy right now; try again in a moment'), host);
    }
    if (error instanceof Prisma.PrismaClientUnknownRequestError) return super.catch(error, host);
    if (error.code === 'P2002') {
      return super.catch(
        new HttpException({ statusCode: 409, code: 'DUPLICATE', message: 'Already exists' }, 409),
        host,
      );
    }
    if (error.code === 'P2003') {
      return super.catch(
        new HttpException(
          {
            statusCode: 409,
            // A foreign key failed: the row is still referenced (delete), or a referenced row
            // does not exist in this institute (create/update). Services check both first.
            code: 'REFERENCE_CONFLICT',
            message: 'A referenced record is missing or still in use',
          },
          409,
        ),
        host,
      );
    }
    return super.catch(error, host);
  }
}

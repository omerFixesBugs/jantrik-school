import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Prisma } from '@jantrik/db';

/**
 * Constraint violations that slipped past a service's own checks (usually a race between two
 * requests) become 409s instead of 500s. Services still check first: a violation aborts the
 * request's transaction, so nothing else in it can run.
 */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaErrorFilter extends BaseExceptionFilter implements ExceptionFilter {
  override catch(error: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost): void {
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

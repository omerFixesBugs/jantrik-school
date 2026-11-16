import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { OWN_TRANSACTION, USER_SCOPED } from '../common/decorators.js';
import { RequestContext } from '../common/request-context.js';
import { RequestTransaction } from './request-transaction.service.js';

/**
 * Runs every authenticated request inside one RLS transaction (RequestTransaction):
 *   withContext({ tenantId: tid, userId: sub }) → handler → commit → afterCommit callbacks.
 * A thrown error rolls the transaction back and drops the afterCommit callbacks.
 * Services reach the transaction through `Db.tx`.
 *
 * Except a route marked `@OwnTransaction()` (uploads): it gets no transaction here, so reading
 * its body and decoding the image hold no database connection; its handler opens the same
 * transaction itself with `RequestTransaction.run` afterwards (docs/auth.md → Request pipeline).
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(
    private readonly transaction: RequestTransaction,
    private readonly context: RequestContext,
    private readonly reflector: Reflector,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.context.principal) return next.handle(); // public route: no request transaction
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(OWN_TRANSACTION, targets)) return next.handle();
    const userScoped = this.reflector.getAllAndOverride<boolean>(USER_SCOPED, targets);
    return from(
      this.transaction.around(() => lastValueFrom(next.handle(), { defaultValue: undefined }), {
        userScoped,
      }),
    );
  }
}

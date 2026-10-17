import {
  ForbiddenException,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { withContext, type TenantTx } from '@jantrik/db';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { USER_SCOPED } from '../common/decorators.js';
import { RequestContext } from '../common/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';

const REQUEST_TX_TIMEOUT_MS = 15_000;

/**
 * Runs every authenticated request inside one RLS transaction:
 *   withContext({ tenantId: tid, userId: sub }) → handler → commit → afterCommit callbacks.
 * A thrown error rolls the transaction back and drops the afterCommit callbacks.
 * Services reach the transaction through `Db.tx`.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: RequestContext,
    private readonly reflector: Reflector,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const principal = this.context.principal;
    if (!principal) return next.handle(); // public route: no request transaction
    const userScoped = this.reflector.getAllAndOverride<boolean>(USER_SCOPED, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    const tenantId = userScoped ? null : (principal.tenantId ?? null);
    return from(this.run(principal.userId, tenantId, next));
  }

  private async run(userId: string, tenantId: string | null, next: CallHandler): Promise<unknown> {
    let committed: (() => unknown)[] = [];
    const result = await withContext(
      this.prisma.client,
      { tenantId, userId },
      async (tx) => {
        if (tenantId) await assertTenantAccess(tx);
        this.context.beginTransaction(tx);
        try {
          const value = await lastValueFrom(next.handle(), { defaultValue: undefined });
          committed = this.context.endTransaction();
          return value;
        } catch (error) {
          this.context.endTransaction(); // rollback: drop side effects
          throw error;
        }
      },
      { timeout: REQUEST_TX_TIMEOUT_MS, maxWait: 5_000 },
    );
    await this.context.runAfterCommit(committed);
    return result;
  }
}

/**
 * Re-checked on every tenant request (not just at switch-tenant), so suspending a tenant or
 * removing a membership takes effect immediately rather than when the access token expires.
 */
async function assertTenantAccess(tx: TenantTx): Promise<void> {
  const [row] = await tx.$queryRaw<{ status: string; member: boolean }[]>`
    SELECT t.status::text AS status,
           EXISTS (SELECT 1 FROM memberships m
                   WHERE m.user_id = app_current_user_id() AND m.status = 'ACTIVE') AS member
    FROM tenants t`;
  if (!row || !['ACTIVE', 'TRIAL'].includes(row.status) || !row.member) {
    throw new ForbiddenException('No access to this tenant');
  }
}

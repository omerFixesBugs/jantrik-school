import { ForbiddenException, Injectable } from '@nestjs/common';
import { withContext, type TenantTx } from '@jantrik/db';
import { RequestContext } from '../common/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';

export const REQUEST_TX_TIMEOUT_MS = 15_000;

/**
 * The authenticated request's RLS transaction (docs/auth.md → Request pipeline):
 *   withContext({ tenantId, userId }) → the tenant re-check → fn → commit → afterCommit callbacks.
 * A thrown error rolls the transaction back and drops the afterCommit callbacks. Services reach
 * the transaction through `Db.tx`.
 *
 * TenantContextInterceptor runs every authenticated route inside it. A route marked
 * `@OwnTransaction()` (uploads) runs without one and calls `run` itself once its slow part is
 * done (reading the body, decoding the image), so no database connection waits on a client.
 */
@Injectable()
export class RequestTransaction {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: RequestContext,
  ) {}

  async run<T>(fn: () => Promise<T>, opts: { userScoped?: boolean } = {}): Promise<T> {
    const principal = this.context.requirePrincipal();
    const tenantId = opts.userScoped ? null : (principal.tenantId ?? null);
    let committed: (() => unknown)[] = [];
    const result = await withContext(
      this.prisma.client,
      { tenantId, userId: principal.userId },
      async (tx) => {
        if (tenantId) await assertTenantAccess(tx);
        this.context.beginTransaction(tx);
        try {
          const value = await fn();
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

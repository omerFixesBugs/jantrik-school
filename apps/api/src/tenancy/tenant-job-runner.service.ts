import { Injectable } from '@nestjs/common';
import { withContext } from '@jantrik/db';
import { ClsService } from 'nestjs-cls';
import type { JantrikClsStore } from '../common/request-context.js';
import { RequestContext } from '../common/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';

const JOB_TX_TIMEOUT_MS = 15_000;

/**
 * Runs background work (queue jobs) for one tenant exactly like a request: inside one RLS
 * transaction for that tenant, with `Db.tx` and `RequestContext.afterCommit` working as usual,
 * so services need no job-specific code.
 *
 * The tenant id must come from a job we enqueued ourselves (e.g. `{ tenantId, smsLogId }`),
 * never from user input. Without an actor there is no user in the context:
 * `app_current_user_id()` is NULL.
 */
@Injectable()
export class TenantJobRunner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: RequestContext,
    private readonly cls: ClsService<JantrikClsStore>,
  ) {}

  /**
   * `actorUserId`: work done on behalf of a person (e.g. the admin who started an import). It
   * becomes the principal, so audit entries name them; it must come from our own records (the
   * import row), and the caller must check that person still has the right role.
   */
  run<T>(tenantId: string, fn: () => Promise<T>, opts: { actorUserId?: string } = {}): Promise<T> {
    return this.cls.run(async () => {
      if (opts.actorUserId) {
        this.context.setPrincipal({ userId: opts.actorUserId, sessionId: 'job', tenantId });
      }
      let committed: (() => unknown)[] = [];
      const result = await withContext(
        this.prisma.client,
        { tenantId, userId: opts.actorUserId ?? null },
        async (tx) => {
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
        { timeout: JOB_TX_TIMEOUT_MS, maxWait: 5_000 },
      );
      await this.context.runAfterCommit(committed);
      return result;
    });
  }
}

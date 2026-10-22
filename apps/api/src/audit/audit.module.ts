import { Global, Injectable, InternalServerErrorException, Module } from '@nestjs/common';
import type { Prisma } from '@jantrik/db';
import { RequestContext } from '../common/request-context.js';
import { Db } from '../tenancy/db.service.js';

export interface AuditEntry {
  /** Table-like name of what changed, e.g. 'attendance_session'. */
  entity: string;
  entityId: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  oldValues?: Prisma.InputJsonValue;
  newValues?: Prisma.InputJsonValue;
}

/**
 * Writes audit_logs (CLAUDE.md rule 6: every create/update/delete on marks, fees, payments and
 * attendance). It writes through the request transaction, so an audit row commits or rolls back
 * together with the change it describes. The actor is the authenticated caller; a background job
 * run without a person (TenantJobRunner with no actor) writes no actor.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    const principal = this.context.principal;
    let tenantId: string;
    try {
      tenantId = this.context.requireTenantId();
    } catch {
      throw new InternalServerErrorException('Audit entries need a selected tenant');
    }
    await this.db.tx.auditLog.create({
      data: {
        tenantId,
        actorUserId: principal?.userId ?? null,
        entity: entry.entity,
        entityId: entry.entityId,
        action: entry.action,
        oldValues: entry.oldValues,
        newValues: entry.newValues,
      },
      select: { id: true },
    });
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}

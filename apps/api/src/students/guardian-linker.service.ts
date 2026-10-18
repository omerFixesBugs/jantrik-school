import { Injectable } from '@nestjs/common';
import { findOrCreateUser, type GuardianRelation } from '@jantrik/db';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { RequestContext } from '../common/request-context.js';
import { Db } from '../tenancy/db.service.js';
import { TenantAccessService } from '../tenancy/tenant-access.service.js';

export interface GuardianFields {
  /** E.164 */
  phone: string;
  nameBn: string | null;
  nameEn: string | null;
  occupation: string | null;
}

/**
 * Guardians are people of this tenant, found by phone and shared between siblings. A guardian
 * found by phone keeps their stored names (the oldest record wins when several share a phone).
 * Each gets a login, as the demo seed does: a user (find-or-create by phone) and a GUARDIAN
 * membership, so they can sign in with OTP. No SMS is sent here.
 */
@Injectable()
export class GuardianLinker {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly access: TenantAccessService,
    private readonly audit: AuditService,
  ) {}

  /** The guardian id for this phone, creating the guardian (and their login) if new. */
  async findOrCreate(g: GuardianFields): Promise<{ id: string; created: boolean }> {
    const tx = this.db.tx;
    const tenantId = this.context.requirePrincipal().tenantId!;
    const existing = await tx.guardian.findFirst({
      where: { phone: g.phone },
      orderBy: { createdAt: 'asc' },
      select: { id: true, userId: true },
    });
    if (existing) {
      const userId = existing.userId ?? (await this.ensureLogin(g));
      if (!existing.userId) {
        await tx.guardian.update({ where: { id: existing.id }, data: { userId } });
      } else {
        await this.ensureMembership(userId);
      }
      return { id: existing.id, created: false };
    }
    if (!g.nameBn && !g.nameEn) {
      throw apiError(422, 'GUARDIAN_NAME_REQUIRED', 'A new guardian needs a name', {
        field: 'guardians',
        phone: g.phone,
      });
    }
    const userId = await this.ensureLogin(g);
    const created = await tx.guardian.create({
      data: {
        tenantId,
        userId,
        phone: g.phone,
        nameBn: g.nameBn,
        nameEn: g.nameEn,
        occupation: g.occupation,
      },
      select: { id: true },
    });
    return { id: created.id, created: true };
  }

  /** Link a guardian to a student; a new primary replaces the old one (one primary per student). */
  async link(
    studentId: string,
    guardianId: string,
    relation: GuardianRelation,
    isPrimary: boolean,
  ): Promise<string> {
    const tx = this.db.tx;
    const tenantId = this.context.requirePrincipal().tenantId!;
    if (isPrimary) {
      await tx.studentGuardian.updateMany({
        where: { studentId, isPrimary: true },
        data: { isPrimary: false },
      });
    }
    const row = await tx.studentGuardian.create({
      data: { tenantId, studentId, guardianId, relation, isPrimary },
      select: { id: true },
    });
    return row.id;
  }

  private async ensureLogin(g: GuardianFields): Promise<string> {
    const userId = await findOrCreateUser(
      this.db.tx,
      g.phone,
      g.nameEn ?? g.nameBn ?? g.phone,
      g.nameBn,
    );
    await this.ensureMembership(userId);
    return userId;
  }

  private async ensureMembership(userId: string): Promise<void> {
    const tx = this.db.tx;
    const tenantId = this.context.requirePrincipal().tenantId!;
    const has = await tx.membership.findFirst({
      where: { userId, role: 'GUARDIAN' },
      select: { id: true },
    });
    if (has) return;
    await tx.membership.create({ data: { tenantId, userId, role: 'GUARDIAN' } });
    // A role grant leaves a trail, like staff changes do.
    await this.audit.record({
      entity: 'membership',
      entityId: userId,
      action: 'CREATE',
      newValues: { roles: ['GUARDIAN'], status: 'ACTIVE', via: 'guardian' },
    });
    await this.access.invalidateRolesAfterCommit(tenantId, userId);
  }
}

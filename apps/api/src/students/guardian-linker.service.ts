import { Injectable } from '@nestjs/common';
import { findOrCreateUser, type GuardianRelation } from '@jantrik/db';
import { isGeneratedGuardianName, type GuardianMatch } from '@jantrik/shared';
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
  /** Link this guardian of the institute (it must have this phone). */
  guardianId?: string | null;
  /** Add a new guardian although others here have this phone. */
  createNew?: boolean;
}

/**
 * Guardians are people of this tenant, shared between siblings. A phone that guardians here
 * already have is never linked silently (decision #6): the admin picks one of them (`guardianId`)
 * or adds a new guardian (`createNew`); without a choice: 409 GUARDIAN_CHOICE_REQUIRED. A linked
 * guardian keeps their stored names. Each gets a login, as the demo seed does: a user
 * (find-or-create by phone, so guardians on one phone share it) and a GUARDIAN membership, so
 * they can sign in with OTP. No SMS is sent here.
 */
@Injectable()
export class GuardianLinker {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly access: TenantAccessService,
    private readonly audit: AuditService,
  ) {}

  /** This institute's guardians with the phone (oldest first), for the admin to pick from. */
  async matches(phone: string): Promise<GuardianMatch[]> {
    const rows = await this.db.tx.guardian.findMany({
      where: { phone },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 20,
      select: {
        id: true,
        nameBn: true,
        nameEn: true,
        students: {
          where: { student: { deletedAt: null } },
          orderBy: { createdAt: 'asc' },
          take: 5,
          select: {
            student: {
              select: {
                nameBn: true,
                nameEn: true,
                enrolments: {
                  where: { academicYear: { isCurrent: true } },
                  take: 1,
                  select: { classLevel: { select: { nameBn: true, nameEn: true } } },
                },
              },
            },
          },
        },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      nameBn: r.nameBn,
      nameEn: r.nameEn,
      children: r.students.map(({ student }) => ({
        nameBn: student.nameBn,
        nameEn: student.nameEn,
        classLevel: student.enrolments[0]?.classLevel ?? null,
      })),
    }));
  }

  /** The guardian to link: the chosen one, or a new guardian (and their login). */
  async findOrCreate(g: GuardianFields): Promise<{ id: string; created: boolean }> {
    const tx = this.db.tx;
    const tenantId = this.context.requirePrincipal().tenantId!;
    if (g.guardianId) {
      const chosen = await tx.guardian.findFirst({
        where: { id: g.guardianId },
        select: { id: true, userId: true, phone: true, nameBn: true, nameEn: true },
      });
      if (!chosen || chosen.phone !== g.phone) {
        throw apiError(422, 'GUARDIAN_MISMATCH', 'That guardian does not have this phone', {
          field: 'guardians',
          phone: g.phone,
        });
      }
      if (chosen.userId) await this.ensureMembership(chosen.userId);
      else {
        // A login for a known guardian takes the names this institute stored for them.
        const userId = await this.ensureLogin({
          phone: chosen.phone,
          nameBn: chosen.nameBn,
          nameEn: chosen.nameEn,
          occupation: null,
        });
        await tx.guardian.update({ where: { id: chosen.id }, data: { userId } });
      }
      return { id: chosen.id, created: false };
    }
    if (!g.createNew && (await tx.guardian.count({ where: { phone: g.phone } })) > 0) {
      throw apiError(
        409,
        'GUARDIAN_CHOICE_REQUIRED',
        'Guardians here have this phone: pick one of them or add a new guardian',
        { field: 'guardians', phone: g.phone },
      );
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

  /**
   * The person's login: found by phone, or created with the typed names (never the phone number
   * as a name). An existing person's own names are never changed.
   */
  private async ensureLogin(g: GuardianFields): Promise<string> {
    // A name made from the student's ("Guardian of …") never becomes the person's own name.
    const own = isGeneratedGuardianName(g) ? { nameBn: null, nameEn: null } : g;
    const userId = await findOrCreateUser(
      this.db.tx,
      g.phone,
      own.nameEn ?? own.nameBn ?? 'Guardian',
      own.nameBn,
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

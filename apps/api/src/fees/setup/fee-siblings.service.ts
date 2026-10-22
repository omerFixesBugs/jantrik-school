import { Injectable, NotFoundException } from '@nestjs/common';
import { maskPhone, siblingRanks, type FeeSiblingsView } from '@jantrik/shared';
import { AuditService } from '../../audit/audit.module.js';
import { apiError } from '../../common/api-error.js';
import { RequestContext } from '../../common/request-context.js';
import { Db } from '../../tenancy/db.service.js';

const studentSelect = {
  id: true,
  studentCode: true,
  nameBn: true,
  nameEn: true,
  createdAt: true,
} as const;

/**
 * Confirmed families (docs/fees.md → Siblings). Students who share a guardian's phone are only
 * suggested: guardians often give a relative's phone, so the sibling discount applies only to a
 * family an OWNER/ADMIN confirmed. Members are removed (with a reason), never deleted.
 */
@Injectable()
export class FeeSiblingsService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
  ) {}

  /** One family writer per tenant at a time (merging families must not race). */
  private lock() {
    return this.db.tx
      .$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('fees-siblings:' || app_current_tenant_id()::text, 0))`;
  }

  async view(): Promise<FeeSiblingsView> {
    const tx = this.db.tx;
    const year = await tx.academicYear.findFirst({
      where: { isCurrent: true },
      select: { id: true },
    });
    const members = await tx.feeSiblingMember.findMany({
      where: { removedAt: null },
      select: { groupId: true, studentId: true },
    });
    const enrolled = year
      ? await tx.student.findMany({
          where: {
            deletedAt: null,
            status: 'ACTIVE',
            enrolments: { some: { academicYearId: year.id } },
          },
          select: {
            ...studentSelect,
            enrolments: {
              where: { academicYearId: year.id },
              select: {
                classLevel: { select: { id: true, nameBn: true, nameEn: true, sortOrder: true } },
              },
            },
            guardians: {
              select: { guardian: { select: { phone: true, nameBn: true, nameEn: true } } },
            },
          },
        })
      : [];
    // Family members who are not active this year still show in their family.
    const missing = members
      .map((m) => m.studentId)
      .filter((id) => !enrolled.some((s) => s.id === id));
    const others = missing.length
      ? await tx.student.findMany({ where: { id: { in: missing } }, select: studentSelect })
      : [];
    const byId = new Map<
      string,
      (typeof enrolled)[number] | ((typeof others)[number] & { enrolments: never[] })
    >();
    for (const s of enrolled) byId.set(s.id, s);
    for (const s of others) byId.set(s.id, { ...s, enrolments: [] });
    const ref = (id: string) => {
      const s = byId.get(id)!;
      const classLevel = s.enrolments[0]?.classLevel ?? null;
      return {
        student: {
          id: s.id,
          studentCode: s.studentCode,
          nameBn: s.nameBn,
          nameEn: s.nameEn,
          classLevel: classLevel
            ? { id: classLevel.id, nameBn: classLevel.nameBn, nameEn: classLevel.nameEn }
            : null,
        },
        classSortOrder: classLevel?.sortOrder ?? -1,
        admittedAt: s.createdAt,
      };
    };

    const groups = new Map<string, string[]>();
    for (const m of members) groups.set(m.groupId, [...(groups.get(m.groupId) ?? []), m.studentId]);
    const groupOf = new Map(members.map((m) => [m.studentId, m.groupId]));
    const families = [...groups.entries()]
      .filter(([, ids]) => ids.length >= 2)
      .map(([groupId, ids]) => {
        const refs = ids.map(ref);
        const ranks = siblingRanks(
          refs.map((r) => ({
            studentId: r.student.id,
            classSortOrder: r.classSortOrder,
            admittedAt: r.admittedAt,
          })),
        );
        return {
          groupId,
          members: refs
            .map((r) => ({ ...r.student, rank: ranks.get(r.student.id)! }))
            .sort((a, b) => a.rank - b.rank),
        };
      });

    const byPhone = new Map<string, { name: string | null; ids: Set<string> }>();
    for (const s of enrolled) {
      for (const { guardian } of s.guardians) {
        const entry = byPhone.get(guardian.phone) ?? {
          name: guardian.nameBn ?? guardian.nameEn,
          ids: new Set<string>(),
        };
        entry.ids.add(s.id);
        byPhone.set(guardian.phone, entry);
      }
    }
    const suggestions = [...byPhone.entries()]
      .filter(([, e]) => e.ids.size >= 2)
      .filter(([, e]) => {
        const families = new Set([...e.ids].map((id) => groupOf.get(id) ?? `none:${id}`));
        return families.size > 1;
      })
      .map(([phone, e]) => ({
        guardianName: e.name,
        phoneMasked: maskPhone(phone),
        students: [...e.ids].map((id) => ref(id).student),
      }));
    return { families, suggestions };
  }

  /** Confirm students as one family; those already in a family bring the others into it. */
  async confirm(studentIds: string[]): Promise<{ groupId: string; added: string[] }> {
    const tx = this.db.tx;
    await this.lock();
    const found = await tx.student.count({ where: { id: { in: studentIds }, deletedAt: null } });
    if (found !== studentIds.length) throw new NotFoundException('Student not found');
    const current = await tx.feeSiblingMember.findMany({
      where: { studentId: { in: studentIds }, removedAt: null },
      select: { groupId: true, studentId: true },
    });
    const groupIds = [...new Set(current.map((m) => m.groupId))];
    if (groupIds.length > 1) {
      throw apiError(409, 'DIFFERENT_FAMILIES', 'These students are in different families', {
        groupIds,
      });
    }
    const userId = this.context.requirePrincipal().userId;
    const tenantId = this.context.requireTenantId();
    const groupId =
      groupIds[0] ??
      (await tx.feeSiblingGroup.create({ data: { tenantId, createdById: userId } })).id;
    const inGroup = new Set(current.map((m) => m.studentId));
    const added = studentIds.filter((id) => !inGroup.has(id));
    if (added.length > 0) {
      await tx.feeSiblingMember.createMany({
        data: added.map((studentId) => ({ tenantId, groupId, studentId, addedById: userId })),
      });
    }
    await this.audit.record({
      entity: 'fee_sibling_group',
      entityId: groupId,
      action: groupIds[0] ? 'UPDATE' : 'CREATE',
      newValues: { added },
    });
    return { groupId, added };
  }

  async remove(groupId: string, studentId: string, reason: string): Promise<void> {
    const tx = this.db.tx;
    await this.lock();
    const member = await tx.feeSiblingMember.findFirst({
      where: { groupId, studentId, removedAt: null },
      select: { id: true },
    });
    if (!member) throw new NotFoundException('Not in this family');
    await tx.feeSiblingMember.update({
      where: { id: member.id },
      data: {
        removedAt: new Date(),
        removedById: this.context.requirePrincipal().userId,
        removedReason: reason,
      },
    });
    await this.audit.record({
      entity: 'fee_sibling_group',
      entityId: groupId,
      action: 'UPDATE',
      newValues: { removed: studentId, reason },
    });
  }
}

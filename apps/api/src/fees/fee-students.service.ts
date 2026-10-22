import { Injectable } from '@nestjs/common';
import { searchStudentIds } from '@jantrik/db';
import { maskPhone, normalizeBdPhone, type FeeStudentHit } from '@jantrik/shared';
import { RequestContext } from '../common/request-context.js';
import { phoneDigits } from '../students/students.module.js';
import { Db } from '../tenancy/db.service.js';
import { TenantAccessService } from '../tenancy/tenant-access.service.js';

/**
 * Finding a student at the fee counter (OWNER/ADMIN/ACCOUNTANT): by name, student ID or a
 * guardian's phone. Decision #19 (updated in step 9): the accountant may search by a whole
 * phone number and sees it masked, so they learn nothing they did not type. Part of a number is
 * no phone search for them: guessing digit by digit against masked results would reveal the
 * hidden digits. OWNER/ADMIN may search by part and see phones in full.
 */
@Injectable()
export class FeeStudentsService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly access: TenantAccessService,
  ) {}

  /** Does the caller see guardian phones in full (OWNER/ADMIN)? */
  async seesPhones(): Promise<boolean> {
    const p = this.context.requirePrincipal();
    const roles = await this.access.getRoles(p.tenantId!, p.userId);
    return roles.includes('OWNER') || roles.includes('ADMIN');
  }

  async search(q: string): Promise<FeeStudentHit[]> {
    const tx = this.db.tx;
    const full = await this.seesPhones();
    const phone = full || normalizeBdPhone(q) ? phoneDigits(q) : null;
    const ids = await searchStudentIds(tx, { term: q, phone, limit: 20 });
    if (ids.length === 0) return [];
    return this.load(ids, full);
  }

  /** One student as the counter shows them, or null (deleted, or another institute's). */
  async hit(studentId: string): Promise<FeeStudentHit | null> {
    const [student] = await this.load([studentId], await this.seesPhones());
    return student ?? null;
  }

  private async load(ids: string[], full: boolean): Promise<FeeStudentHit[]> {
    const tx = this.db.tx;
    const year = await tx.academicYear.findFirst({
      where: { isCurrent: true },
      select: { id: true },
    });
    const rows = await tx.student.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: {
        id: true,
        studentCode: true,
        nameBn: true,
        nameEn: true,
        status: true,
        enrolments: {
          where: { academicYearId: year?.id ?? '00000000-0000-0000-0000-000000000000' },
          select: {
            roll: true,
            classLevel: { select: { id: true, nameBn: true, nameEn: true } },
            section: { select: { id: true, name: true } },
          },
        },
        guardians: {
          where: { isPrimary: true },
          select: { guardian: { select: { nameBn: true, nameEn: true, phone: true } } },
        },
      },
      orderBy: [{ studentCode: 'asc' }],
    });
    return rows.map((s) => {
      const e = s.enrolments[0];
      const g = s.guardians[0]?.guardian;
      return {
        id: s.id,
        studentCode: s.studentCode,
        nameBn: s.nameBn,
        nameEn: s.nameEn,
        status: s.status,
        enrolment: e ? { classLevel: e.classLevel, section: e.section, roll: e.roll } : null,
        guardian: g
          ? { nameBn: g.nameBn, nameEn: g.nameEn, phone: full ? g.phone : maskPhone(g.phone) }
          : null,
      };
    });
  }
}

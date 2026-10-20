import { Injectable } from '@nestjs/common';
import { RequestContext } from '../common/request-context.js';
import { Db } from '../tenancy/db.service.js';
import { TenantAccessService } from '../tenancy/tenant-access.service.js';

/**
 * Least privilege for student data (applies everywhere student data leaves the API).
 * OWNER/ADMIN see everything. Anyone else who may read students (a TEACHER) sees the basics of
 * every student (name, code, class/section, roll, status) and the full record (date of birth,
 * birth registration no., addresses, parents' names, guardians incl. phones) only for students
 * of the current-year sections they are assigned to (section_teachers).
 */
export interface StudentScope {
  full: boolean;
  /** Current-year sections the caller teaches (when not full). */
  sectionIds: Set<string>;
}

@Injectable()
export class StudentAccess {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly access: TenantAccessService,
  ) {}

  /** The caller's scope (roles come from the cache; one query for their sections). */
  async scope(): Promise<StudentScope> {
    const p = this.context.requirePrincipal();
    const roles = await this.access.getRoles(p.tenantId!, p.userId);
    if (roles.includes('OWNER') || roles.includes('ADMIN'))
      return { full: true, sectionIds: new Set() };
    const rows = await this.db.tx.sectionTeacher.findMany({
      where: {
        userId: p.userId,
        // A deactivated section no longer grants access.
        section: { isActive: true, academicYear: { isCurrent: true } },
      },
      select: { sectionId: true },
    });
    return { full: false, sectionIds: new Set(rows.map((r) => r.sectionId)) };
  }

  /** May the caller see this student's full record? (`sectionId`: their current-year section.) */
  static sees(scope: StudentScope, sectionId: string | null | undefined): boolean {
    return scope.full || (!!sectionId && scope.sectionIds.has(sectionId));
  }
}

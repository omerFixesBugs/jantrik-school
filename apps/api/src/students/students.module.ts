import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { searchStudentIds } from '@jantrik/db';
import {
  normalizeBdPhone,
  studentsQuerySchema,
  type StudentFilters,
  type StudentListItem,
  type StudentsPage,
} from '@jantrik/shared';
import { RequireModule, Roles } from '../common/decorators.js';
import { zodDto } from '../common/zod.js';
import { Db } from '../tenancy/db.service.js';

export class StudentsQueryDto extends zodDto(studentsQuerySchema) {}

/** Digits to look for inside guardian phones, or null when the query is not phone-like. */
function phoneDigits(q: string): string | null {
  const e164 = normalizeBdPhone(q);
  if (e164) return e164.slice(4); // +880 1712345678 → 1712345678
  const digits = q.replace(/[\s\-+]/g, '');
  return /^\d{4,}$/.test(digits) ? digits : null;
}

@Injectable()
export class StudentsService {
  constructor(private readonly db: Db) {}

  async list(query: StudentsQueryDto): Promise<StudentsPage> {
    const tx = this.db.tx;
    const year = await tx.academicYear.findFirst({
      where: { isCurrent: true },
      select: { id: true },
    });
    const filtersByEnrolment = Boolean(query.classLevelId || query.sectionId);
    if (filtersByEnrolment && !year) return { items: [], nextCursor: null };

    let ids: string[] | undefined;
    if (query.q) {
      ids = await searchStudentIds(tx, { term: query.q, phone: phoneDigits(query.q) });
      if (ids.length === 0) return { items: [], nextCursor: null };
    }

    const rows = await tx.student.findMany({
      where: {
        deletedAt: null,
        ...(ids ? { id: { in: ids } } : {}),
        ...(filtersByEnrolment && year
          ? {
              enrolments: {
                some: {
                  academicYearId: year.id,
                  ...(query.classLevelId ? { classLevelId: query.classLevelId } : {}),
                  ...(query.sectionId ? { sectionId: query.sectionId } : {}),
                },
              },
            }
          : {}),
      },
      orderBy: [{ studentCode: 'asc' }, { id: 'asc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        studentCode: true,
        nameBn: true,
        nameEn: true,
        status: true,
        photoUrl: true,
        enrolments: {
          where: { academicYearId: year?.id ?? '00000000-0000-0000-0000-000000000000' },
          take: 1,
          select: {
            roll: true,
            classLevel: { select: { id: true, nameBn: true, nameEn: true } },
            section: { select: { id: true, name: true } },
          },
        },
        guardians: {
          where: { isPrimary: true },
          take: 1,
          select: { guardian: { select: { nameBn: true, nameEn: true, phone: true } } },
        },
      },
    });

    const page = rows.slice(0, query.limit);
    const items: StudentListItem[] = page.map(({ enrolments, guardians, ...s }) => ({
      ...s,
      enrolment: enrolments[0] ?? null,
      primaryGuardian: guardians[0]?.guardian ?? null,
    }));
    return {
      items,
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async filters(): Promise<StudentFilters> {
    const tx = this.db.tx;
    const year = await tx.academicYear.findFirst({
      where: { isCurrent: true },
      select: { id: true },
    });
    const classLevels = await tx.classLevel.findMany({
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        nameBn: true,
        nameEn: true,
        sections: {
          where: { academicYearId: year?.id ?? '00000000-0000-0000-0000-000000000000' },
          orderBy: { sortOrder: 'asc' },
          select: { id: true, name: true },
        },
      },
    });
    return { classLevels };
  }
}

/** Read-only student list (first feature endpoint). */
@Controller('students')
@RequireModule('CORE')
@Roles('OWNER', 'ADMIN', 'TEACHER')
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  @Get()
  list(@Query() query: StudentsQueryDto): Promise<StudentsPage> {
    return this.students.list(query);
  }

  @Get('filters')
  filters(): Promise<StudentFilters> {
    return this.students.filters();
  }
}

@Module({ controllers: [StudentsController], providers: [StudentsService] })
export class StudentsModule {}

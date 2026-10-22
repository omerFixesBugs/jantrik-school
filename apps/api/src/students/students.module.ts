import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { searchStudentIds, type Prisma } from '@jantrik/db';
import {
  addGuardianSchema,
  admissionSchema,
  createEnrolmentSchema,
  guardianLookupQuerySchema,
  normalizeBdPhone,
  recentMonths,
  STUDENT_STATUSES,
  studentSettingsSchema,
  todayIn,
  transferSchema,
  updateGuardianLinkSchema,
  updateStudentSchema,
  type GuardianMatch,
  type StudentProfile,
  type StudentSettings,
  studentsQuerySchema,
  type StudentFilters,
  type StudentListItem,
  type StudentSort,
  type StudentStatus,
  type StudentsPage,
  type StudentsSummary,
} from '@jantrik/shared';
import { RequireModule, Roles } from '../common/decorators.js';
import { zodDto } from '../common/zod.js';
import { Db } from '../tenancy/db.service.js';
import { GuardianLinker } from './guardian-linker.service.js';
import { StudentAdminService } from './student-admin.service.js';
import { StudentAccess } from './student-access.service.js';
import { StudentCodesService } from './student-codes.service.js';

export class StudentsQueryDto extends zodDto(studentsQuerySchema) {}
class AdmissionDto extends zodDto(admissionSchema) {}
class UpdateStudentDto extends zodDto(updateStudentSchema) {}
class AddGuardianDto extends zodDto(addGuardianSchema) {}
class UpdateGuardianLinkDto extends zodDto(updateGuardianLinkSchema) {}
class TransferDto extends zodDto(transferSchema) {}
class CreateEnrolmentDto extends zodDto(createEnrolmentSchema) {}
class StudentSettingsDto extends zodDto(studentSettingsSchema) {}
class GuardianLookupDto extends zodDto(guardianLookupQuerySchema) {}

const Id = () => Param('id', ParseUUIDPipe);

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** ORDER BY for the sorts the database does (code, name); ties by code. */
function databaseOrder(
  sort: StudentSort,
  dir: 'asc' | 'desc',
  locale: 'bn' | 'en',
): Prisma.StudentOrderByWithRelationInput[] {
  if (sort !== 'name') return [{ studentCode: dir }, { id: dir }];
  const bn = { nameBn: { sort: dir, nulls: 'last' } } as const;
  const en = { nameEn: { sort: dir, nulls: 'last' } } as const;
  return [...(locale === 'bn' ? [bn, en] : [en, bn]), { studentCode: 'asc' }, { id: 'asc' }];
}

/** Digits to look for inside guardian phones, or null when the query is not phone-like. */
function phoneDigits(q: string): string | null {
  const e164 = normalizeBdPhone(q);
  if (e164) return e164.slice(4); // +880 1712345678 → 1712345678
  const digits = q.replace(/[\s\-+]/g, '');
  return /^\d{4,}$/.test(digits) ? digits : null;
}

@Injectable()
export class StudentsService {
  constructor(
    private readonly db: Db,
    private readonly access: StudentAccess,
  ) {}

  /**
   * Everyone who may list students sees the basics; the primary guardian (name + phone) only
   * where the caller may see the full record (StudentAccess). Searching by a guardian's phone is
   * for OWNER/ADMIN only (it would tell a teacher whose guardian a number is).
   */
  async list(query: StudentsQueryDto): Promise<StudentsPage> {
    const tx = this.db.tx;
    const scope = await this.access.scope();
    const year = await tx.academicYear.findFirst({
      where: { isCurrent: true },
      select: { id: true },
    });
    const yearId = year?.id ?? NIL_UUID;
    const filtersByEnrolment = Boolean(query.classLevelId || query.sectionId);
    const empty = { items: [], page: query.page, pageSize: query.pageSize, total: 0 };
    if (filtersByEnrolment && !year) return empty;

    let ids: string[] | undefined;
    if (query.q) {
      ids = await searchStudentIds(tx, {
        term: query.q,
        phone: scope.full ? phoneDigits(query.q) : null,
      });
      if (ids.length === 0) return empty;
    }

    const where = {
      deletedAt: null,
      ...(ids ? { id: { in: ids } } : {}),
      ...(query.status ? { status: query.status } : {}),
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
    } satisfies Prisma.StudentWhereInput;

    // Sequential on purpose: the request transaction is a single connection.
    const total = await tx.student.count({ where });
    const skip = (query.page - 1) * query.pageSize;
    if (skip >= total) return { ...empty, total };
    // Class and roll order come from this year's enrolment (one per student), which Prisma
    // cannot order students by: that page's ids come from the enrolments instead.
    const pageIds =
      query.sort === 'class' || query.sort === 'roll'
        ? await this.idsByEnrolment(where, yearId, query.sort, query.dir, skip, query.pageSize)
        : null;

    const rows = await tx.student.findMany({
      where: pageIds ? { id: { in: pageIds } } : where,
      ...(pageIds
        ? {}
        : {
            orderBy: databaseOrder(query.sort, query.dir, query.locale),
            skip,
            take: query.pageSize,
          }),
      select: {
        id: true,
        studentCode: true,
        nameBn: true,
        nameEn: true,
        status: true,
        photoUrl: true,
        enrolments: {
          where: { academicYearId: yearId },
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
    if (pageIds) {
      const at = new Map(pageIds.map((id, i) => [id, i]));
      rows.sort((a, b) => at.get(a.id)! - at.get(b.id)!);
    }

    const items: StudentListItem[] = rows.map(({ enrolments, guardians, ...s }) => ({
      ...s,
      enrolment: enrolments[0] ?? null,
      primaryGuardian: StudentAccess.sees(scope, enrolments[0]?.section?.id)
        ? (guardians[0]?.guardian ?? null)
        : null,
    }));
    return { items, page: query.page, pageSize: query.pageSize, total };
  }

  /**
   * One page of matching ids in class order (class, section, roll) or roll order (roll, class,
   * section), then by code; students not enrolled this year after them, by code.
   */
  private async idsByEnrolment(
    where: Prisma.StudentWhereInput,
    yearId: string,
    sort: 'class' | 'roll',
    dir: 'asc' | 'desc',
    skip: number,
    take: number,
  ): Promise<string[]> {
    const tx = this.db.tx;
    const enrolled = {
      academicYearId: yearId,
      student: where,
    } satisfies Prisma.EnrolmentWhereInput;
    const place: Prisma.EnrolmentOrderByWithRelationInput[] = [
      { classLevel: { sortOrder: dir } },
      { section: { sortOrder: dir } },
      { section: { name: dir } },
    ];
    const roll: Prisma.EnrolmentOrderByWithRelationInput = { roll: { sort: dir, nulls: 'last' } };
    const ids = (
      await tx.enrolment.findMany({
        where: enrolled,
        orderBy: [
          ...(sort === 'class' ? [...place, roll] : [roll, ...place]),
          { student: { studentCode: 'asc' } },
        ],
        skip,
        take,
        select: { studentId: true },
      })
    ).map((e) => e.studentId);
    if (ids.length === take) return ids;
    // Past the enrolled students: the page goes on with the rest.
    const enrolledCount =
      ids.length > 0 ? skip + ids.length : await tx.enrolment.count({ where: enrolled });
    const rest = await tx.student.findMany({
      where: { AND: [where, { enrolments: { none: { academicYearId: yearId } } }] },
      orderBy: [{ studentCode: 'asc' }, { id: 'asc' }],
      skip: Math.max(0, skip - enrolledCount),
      take: take - ids.length,
      select: { id: true },
    });
    return [...ids, ...rest.map((r) => r.id)];
  }

  /** The dashboard's student figures (OWNER/ADMIN). */
  async summary(): Promise<StudentsSummary> {
    const tx = this.db.tx;
    const { timezone } = await tx.tenant.findFirstOrThrow({ select: { timezone: true } });
    const today = todayIn(timezone);
    const year = await tx.academicYear.findFirst({
      where: { isCurrent: true },
      select: { id: true },
    });
    const activeThisYear = {
      academicYearId: year?.id ?? NIL_UUID,
      student: { status: 'ACTIVE', deletedAt: null },
    } satisfies Prisma.EnrolmentWhereInput;

    const byStatus = Object.fromEntries(STUDENT_STATUSES.map((s) => [s, 0])) as Record<
      StudentStatus,
      number
    >;
    const statuses = await tx.student.groupBy({
      by: ['status'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    for (const r of statuses) byStatus[r.status] = r._count._all;

    const classLevels = await tx.classLevel.findMany({
      where: { OR: [{ isActive: true }, { enrolments: { some: activeThisYear } }] },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        nameBn: true,
        nameEn: true,
        _count: { select: { enrolments: { where: activeThisYear } } },
      },
    });

    // Months in the institute's timezone; from a little before the first one's midnight UTC so
    // no timezone is cut off, then bucketed here.
    const months = recentMonths(today.slice(0, 7), 12);
    const added = await tx.student.findMany({
      where: {
        deletedAt: null,
        createdAt: { gte: new Date(Date.parse(`${months[0]}-01T00:00:00Z`) - 86_400_000) },
      },
      select: { createdAt: true },
    });
    const perMonth = new Map(months.map((m) => [m, 0]));
    for (const { createdAt } of added) {
      const m = todayIn(timezone, createdAt).slice(0, 7);
      if (perMonth.has(m)) perMonth.set(m, perMonth.get(m)! + 1);
    }

    return {
      today,
      byStatus,
      byClass: classLevels.map(({ _count, ...classLevel }) => ({
        classLevel,
        count: _count.enrolments,
      })),
      addedByMonth: [...perMonth].map(([month, count]) => ({ month, count })),
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
          where: { academicYearId: year?.id ?? NIL_UUID },
          orderBy: { sortOrder: 'asc' },
          select: { id: true, name: true },
        },
      },
    });
    return { classLevels };
  }
}

/** Students: list and profile for staff; admission and changes for OWNER/ADMIN. */
@Controller('students')
@RequireModule('CORE')
@Roles('OWNER', 'ADMIN', 'TEACHER')
export class StudentsController {
  constructor(
    private readonly students: StudentsService,
    private readonly admin: StudentAdminService,
    private readonly codes: StudentCodesService,
  ) {}

  @Get()
  list(@Query() query: StudentsQueryDto): Promise<StudentsPage> {
    return this.students.list(query);
  }

  @Get('filters')
  filters(): Promise<StudentFilters> {
    return this.students.filters();
  }

  // Declared before ':id' routes.
  @Get('summary')
  @Roles('OWNER', 'ADMIN')
  summary(): Promise<StudentsSummary> {
    return this.students.summary();
  }

  @Get('settings')
  @Roles('OWNER', 'ADMIN')
  settings(): Promise<StudentSettings> {
    return this.codes.get();
  }

  @Put('settings')
  @Roles('OWNER', 'ADMIN')
  updateSettings(@Body() dto: StudentSettingsDto): Promise<StudentSettings> {
    return this.codes.update(dto);
  }

  @Post()
  @Roles('OWNER', 'ADMIN')
  admit(@Body() dto: AdmissionDto): Promise<StudentProfile> {
    return this.admin.admit(dto);
  }

  @Get(':id')
  profile(@Id() id: string): Promise<StudentProfile> {
    return this.admin.view(id);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  update(@Id() id: string, @Body() dto: UpdateStudentDto): Promise<StudentProfile> {
    return this.admin.update(id, dto);
  }

  @Post(':id/guardians')
  @Roles('OWNER', 'ADMIN')
  addGuardian(@Id() id: string, @Body() dto: AddGuardianDto): Promise<StudentProfile> {
    return this.admin.addGuardian(id, dto);
  }

  @Patch(':id/guardians/:linkId')
  @Roles('OWNER', 'ADMIN')
  updateGuardian(
    @Id() id: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
    @Body() dto: UpdateGuardianLinkDto,
  ): Promise<StudentProfile> {
    return this.admin.updateGuardian(id, linkId, dto);
  }

  @Delete(':id/guardians/:linkId')
  @Roles('OWNER', 'ADMIN')
  removeGuardian(
    @Id() id: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
  ): Promise<StudentProfile> {
    return this.admin.removeGuardian(id, linkId);
  }

  @Post(':id/transfer')
  @HttpCode(200)
  @Roles('OWNER', 'ADMIN')
  transfer(@Id() id: string, @Body() dto: TransferDto): Promise<StudentProfile> {
    return this.admin.transfer(id, dto);
  }

  @Post(':id/enrolments')
  @Roles('OWNER', 'ADMIN')
  enrol(@Id() id: string, @Body() dto: CreateEnrolmentDto): Promise<StudentProfile> {
    return this.admin.enrol(id, dto);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @Roles('OWNER', 'ADMIN')
  deactivate(@Id() id: string): Promise<StudentProfile> {
    return this.admin.deactivate(id);
  }
}

/** Admission helpers: this institute's guardians with a phone (pick one or add a new one). */
@Controller('guardians')
@RequireModule('CORE')
@Roles('OWNER', 'ADMIN')
export class GuardiansController {
  constructor(private readonly guardians: GuardianLinker) {}

  @Get()
  lookup(@Query() query: GuardianLookupDto): Promise<GuardianMatch[]> {
    return this.guardians.matches(query.phone);
  }
}

@Module({
  controllers: [StudentsController, GuardiansController],
  providers: [
    StudentsService,
    StudentAdminService,
    StudentCodesService,
    GuardianLinker,
    StudentAccess,
  ],
  exports: [StudentAdminService, StudentCodesService, GuardianLinker, StudentAccess],
})
export class StudentsModule {}

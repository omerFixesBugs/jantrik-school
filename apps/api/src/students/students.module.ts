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
  normalizeBdPhone,
  studentSettingsSchema,
  transferSchema,
  updateGuardianLinkSchema,
  updateStudentSchema,
  type StudentProfile,
  type StudentSettings,
  studentsQuerySchema,
  type StudentFilters,
  type StudentListItem,
  type StudentsPage,
} from '@jantrik/shared';
import { RequireModule, Roles } from '../common/decorators.js';
import { zodDto } from '../common/zod.js';
import { Db } from '../tenancy/db.service.js';
import { GuardianLinker } from './guardian-linker.service.js';
import { StudentAdminService } from './student-admin.service.js';
import { StudentCodesService } from './student-codes.service.js';

export class StudentsQueryDto extends zodDto(studentsQuerySchema) {}
class AdmissionDto extends zodDto(admissionSchema) {}
class UpdateStudentDto extends zodDto(updateStudentSchema) {}
class AddGuardianDto extends zodDto(addGuardianSchema) {}
class UpdateGuardianLinkDto extends zodDto(updateGuardianLinkSchema) {}
class TransferDto extends zodDto(transferSchema) {}
class CreateEnrolmentDto extends zodDto(createEnrolmentSchema) {}
class StudentSettingsDto extends zodDto(studentSettingsSchema) {}

const Id = () => Param('id', ParseUUIDPipe);

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
    const empty = { items: [], nextCursor: null, total: query.cursor ? null : 0 };
    if (filtersByEnrolment && !year) return empty;

    let ids: string[] | undefined;
    if (query.q) {
      ids = await searchStudentIds(tx, { term: query.q, phone: phoneDigits(query.q) });
      if (ids.length === 0) return empty;
    }

    const where = {
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
    } satisfies Prisma.StudentWhereInput;

    const rows = await tx.student.findMany({
      where,
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
    // Counted once, with the first page (the list is paged by cursor). Sequential on purpose:
    // the request transaction is a single connection.
    const total = query.cursor ? null : await tx.student.count({ where });

    const page = rows.slice(0, query.limit);
    const items: StudentListItem[] = page.map(({ enrolments, guardians, ...s }) => ({
      ...s,
      enrolment: enrolments[0] ?? null,
      primaryGuardian: guardians[0]?.guardian ?? null,
    }));
    return {
      items,
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
      total,
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
    return this.admin.profile(id);
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

@Module({
  controllers: [StudentsController],
  providers: [StudentsService, StudentAdminService, StudentCodesService, GuardianLinker],
  exports: [StudentAdminService, StudentCodesService, GuardianLinker],
})
export class StudentsModule {}

import { Injectable, NotFoundException } from '@nestjs/common';
import type { GuardianRelation, Prisma } from '@jantrik/db';
import { dateFromDb, dateToDb, type IsoDate, type StudentProfile } from '@jantrik/shared';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { RequestContext } from '../common/request-context.js';
import { Db } from '../tenancy/db.service.js';
import { GuardianLinker } from './guardian-linker.service.js';
import { StudentAccess } from './student-access.service.js';
import { StudentCodesService } from './student-codes.service.js';

export interface StudentFieldsInput {
  nameBn?: string | null;
  nameEn?: string | null;
  dateOfBirth?: IsoDate | null;
  gender?: 'MALE' | 'FEMALE' | 'OTHER' | null;
  religion?: 'ISLAM' | 'HINDUISM' | 'CHRISTIANITY' | 'BUDDHISM' | 'OTHER' | null;
  bloodGroup?:
    | 'A_POSITIVE'
    | 'A_NEGATIVE'
    | 'B_POSITIVE'
    | 'B_NEGATIVE'
    | 'AB_POSITIVE'
    | 'AB_NEGATIVE'
    | 'O_POSITIVE'
    | 'O_NEGATIVE'
    | null;
  birthRegistrationNo?: string | null;
  fatherNameBn?: string | null;
  fatherNameEn?: string | null;
  motherNameBn?: string | null;
  motherNameEn?: string | null;
  presentAddress?: string | null;
  permanentAddress?: string | null;
  studentCode?: string | null;
}

export interface GuardianInput {
  phone: string;
  nameBn: string | null;
  nameEn: string | null;
  relation: GuardianRelation;
  isPrimary: boolean;
  occupation: string | null;
}

export interface EnrolmentInput {
  academicYearId: string;
  classLevelId: string;
  sectionId: string | null;
  studyGroupId: string | null;
  roll: number | null;
}

export type AdmissionData = StudentFieldsInput & {
  guardians: GuardianInput[];
  enrolment: EnrolmentInput;
};

const STUDENT_COLUMNS = [
  'nameBn',
  'nameEn',
  'gender',
  'religion',
  'bloodGroup',
  'birthRegistrationNo',
  'fatherNameBn',
  'fatherNameEn',
  'motherNameBn',
  'motherNameEn',
  'presentAddress',
  'permanentAddress',
  'studentCode',
] as const;

/**
 * Admission, profile edits, guardians, transfers and deactivation (OWNER/ADMIN). All through the
 * request RLS transaction; every id from the body is looked up under RLS first, so another
 * tenant's year/class/section/group is simply "not found". Everything is audited.
 */
@Injectable()
export class StudentAdminService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
    private readonly codes: StudentCodesService,
    private readonly guardians: GuardianLinker,
    private readonly access: StudentAccess,
  ) {}

  private get tenantId(): string {
    return this.context.requirePrincipal().tenantId!;
  }

  // ─────────────────────────── Admission ───────────────────────────

  async admit(input: AdmissionData): Promise<StudentProfile> {
    const tx = this.db.tx;
    const { year } = await this.checkEnrolment(input.enrolment, null);
    await this.checkUnique(input.birthRegistrationNo ?? null, input.studentCode ?? null, null);
    const studentCode =
      input.studentCode ?? (await this.codes.next(year.startDate.getUTCFullYear()));

    const student = await tx.student.create({
      data: {
        tenantId: this.tenantId,
        ...pickStudent(input),
        studentCode,
        dateOfBirth: input.dateOfBirth ? dateToDb(input.dateOfBirth) : null,
      },
      select: { id: true },
    });
    const enrolment = await tx.enrolment.create({
      data: { tenantId: this.tenantId, studentId: student.id, ...input.enrolment },
      select: { id: true },
    });
    const linked = [];
    for (const g of input.guardians) {
      const guardian = await this.guardians.findOrCreate(g);
      await this.guardians.link(student.id, guardian.id, g.relation, g.isPrimary);
      linked.push({
        phone: g.phone,
        relation: g.relation,
        isPrimary: g.isPrimary,
        newGuardian: guardian.created,
      });
    }
    await this.audit.record({
      entity: 'student',
      entityId: student.id,
      action: 'CREATE',
      newValues: {
        ...pickStudent(input),
        studentCode,
        dateOfBirth: input.dateOfBirth ?? null,
        enrolmentId: enrolment.id,
        enrolment: { ...input.enrolment },
        guardians: linked,
      },
    });
    return this.profile(student.id);
  }

  /**
   * Enrolment rules: the year, class level (active), section (active, in that year and class
   * level), group (active); the roll needs a section and must be free there; capacity respected.
   * `exceptEnrolmentId`: the enrolment being moved (transfer), which doesn't count against it.
   */
  async checkEnrolment(e: EnrolmentInput, exceptEnrolmentId: string | null) {
    const tx = this.db.tx;
    const year = await tx.academicYear.findUnique({
      where: { id: e.academicYearId },
      select: { id: true, startDate: true },
    });
    if (!year) throw new NotFoundException('Academic year not found');
    const classLevel = await tx.classLevel.findUnique({
      where: { id: e.classLevelId },
      select: { isActive: true },
    });
    if (!classLevel) throw new NotFoundException('Class level not found');
    if (!classLevel.isActive)
      throw apiError(422, 'INACTIVE', 'This class level is deactivated', { field: 'classLevelId' });
    if (e.sectionId) {
      const section = await tx.section.findUnique({
        where: { id: e.sectionId },
        select: { academicYearId: true, classLevelId: true, isActive: true, capacity: true },
      });
      if (!section) throw new NotFoundException('Section not found');
      if (section.academicYearId !== e.academicYearId || section.classLevelId !== e.classLevelId) {
        throw apiError(422, 'SECTION_MISMATCH', 'The section is not in that year and class', {
          field: 'sectionId',
        });
      }
      if (!section.isActive)
        throw apiError(422, 'INACTIVE', 'This section is deactivated', { field: 'sectionId' });
      if (section.capacity !== null) {
        // Lock the section so two admissions cannot both take the last seat.
        await tx.$queryRaw`SELECT id FROM sections WHERE id = ${e.sectionId}::uuid FOR UPDATE`;
        const enrolled = await tx.enrolment.count({
          where: {
            sectionId: e.sectionId,
            student: { deletedAt: null },
            ...(exceptEnrolmentId ? { id: { not: exceptEnrolmentId } } : {}),
          },
        });
        if (enrolled >= section.capacity) {
          throw apiError(422, 'SECTION_FULL', 'The section is full', {
            field: 'sectionId',
            capacity: section.capacity,
          });
        }
      }
      if (e.roll !== null) await this.assertRollFree(e.sectionId, e.roll, exceptEnrolmentId);
    } else if (e.roll !== null) {
      throw apiError(422, 'ROLL_NEEDS_SECTION', 'A roll needs a section', { field: 'roll' });
    }
    if (e.studyGroupId) {
      const group = await tx.studyGroup.findUnique({
        where: { id: e.studyGroupId },
        select: { isActive: true },
      });
      if (!group) throw new NotFoundException('Study group not found');
      if (!group.isActive)
        throw apiError(422, 'INACTIVE', 'This study group is deactivated', {
          field: 'studyGroupId',
        });
    }
    return { year };
  }

  private async assertRollFree(sectionId: string, roll: number, exceptEnrolmentId: string | null) {
    const taken = await this.db.tx.enrolment.findFirst({
      where: { sectionId, roll, ...(exceptEnrolmentId ? { id: { not: exceptEnrolmentId } } : {}) },
      select: { id: true },
    });
    if (taken)
      throw apiError(409, 'ROLL_TAKEN', 'This roll is already taken in the section', {
        field: 'roll',
      });
  }

  /** birth_registration_no and student_code are unique per tenant (deactivated students too). */
  async checkUnique(birthReg: string | null, code: string | null, exceptStudentId: string | null) {
    const tx = this.db.tx;
    const not = exceptStudentId ? { id: { not: exceptStudentId } } : {};
    if (
      birthReg &&
      (await tx.student.findFirst({
        where: { birthRegistrationNo: birthReg, ...not },
        select: { id: true },
      }))
    ) {
      throw apiError(409, 'DUPLICATE', 'Another student has this birth registration number', {
        field: 'birthRegistrationNo',
      });
    }
    if (
      code &&
      (await tx.student.findFirst({ where: { studentCode: code, ...not }, select: { id: true } }))
    ) {
      throw apiError(409, 'DUPLICATE', 'Another student has this student code', {
        field: 'studentCode',
      });
    }
  }

  // ─────────────────────────── Profile ───────────────────────────

  /**
   * GET /students/:id: the full record for OWNER/ADMIN and the teachers of the student's
   * current-year section; for other teachers (and for deactivated students) only the basics:
   * name, code, status and the current class/section/roll. The removed fields are not in the
   * JSON at all (null / empty), not just hidden by the UI.
   */
  async view(id: string): Promise<StudentProfile> {
    const p = await this.profile(id);
    const scope = await this.access.scope();
    const current = p.enrolments.find((e) => e.academicYear.isCurrent);
    // A deactivated student's full record is for OWNER/ADMIN only.
    if (scope.full || (!p.deletedAt && StudentAccess.sees(scope, current?.section?.id))) return p;
    return {
      ...p,
      access: 'basic',
      dateOfBirth: null,
      gender: null,
      religion: null,
      bloodGroup: null,
      birthRegistrationNo: null,
      fatherNameBn: null,
      fatherNameEn: null,
      motherNameBn: null,
      motherNameEn: null,
      presentAddress: null,
      permanentAddress: null,
      photoUrl: null,
      guardians: [],
      // The basics: the current class/section/roll, not the history.
      enrolments: current ? [current] : [],
    };
  }

  async profile(id: string): Promise<StudentProfile> {
    const s = await this.db.tx.student.findUnique({
      where: { id },
      include: {
        guardians: {
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          include: {
            guardian: {
              select: {
                id: true,
                nameBn: true,
                nameEn: true,
                phone: true,
                occupation: true,
                user: {
                  select: {
                    memberships: {
                      where: { role: 'GUARDIAN', status: 'ACTIVE' },
                      select: { id: true },
                    },
                  },
                },
              },
            },
          },
        },
        enrolments: {
          orderBy: { academicYear: { startDate: 'desc' } },
          include: {
            academicYear: { select: { id: true, name: true, isCurrent: true } },
            classLevel: { select: { id: true, nameBn: true, nameEn: true } },
            section: { select: { id: true, name: true } },
            studyGroup: { select: { id: true, nameBn: true, nameEn: true } },
          },
        },
      },
    });
    if (!s) throw new NotFoundException('Student not found');
    return {
      id: s.id,
      studentCode: s.studentCode,
      nameBn: s.nameBn,
      nameEn: s.nameEn,
      dateOfBirth: s.dateOfBirth ? dateFromDb(s.dateOfBirth) : null,
      gender: s.gender,
      religion: s.religion,
      bloodGroup: s.bloodGroup,
      birthRegistrationNo: s.birthRegistrationNo,
      fatherNameBn: s.fatherNameBn,
      fatherNameEn: s.fatherNameEn,
      motherNameBn: s.motherNameBn,
      motherNameEn: s.motherNameEn,
      presentAddress: s.presentAddress,
      permanentAddress: s.permanentAddress,
      photoUrl: s.photoUrl,
      status: s.status,
      deletedAt: s.deletedAt?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
      access: 'full',
      guardians: s.guardians.map((l) => ({
        linkId: l.id,
        guardianId: l.guardian.id,
        nameBn: l.guardian.nameBn,
        nameEn: l.guardian.nameEn,
        phone: l.guardian.phone,
        occupation: l.guardian.occupation,
        relation: l.relation,
        isPrimary: l.isPrimary,
        canLogIn: (l.guardian.user?.memberships.length ?? 0) > 0,
      })),
      enrolments: s.enrolments.map((e) => ({
        id: e.id,
        academicYear: e.academicYear,
        classLevel: e.classLevel,
        section: e.section,
        studyGroup: e.studyGroup,
        roll: e.roll,
      })),
    };
  }

  async update(id: string, input: StudentFieldsInput): Promise<StudentProfile> {
    const before = await this.active(id);
    const nameBn = 'nameBn' in input ? input.nameBn : before.nameBn;
    const nameEn = 'nameEn' in input ? input.nameEn : before.nameEn;
    if (!nameBn && !nameEn) {
      throw apiError(422, 'NAME_REQUIRED', 'A name in Bangla or English is required', {
        field: 'nameBn',
      });
    }
    await this.checkUnique(input.birthRegistrationNo ?? null, input.studentCode ?? null, id);
    const data = {
      ...pickStudent(input),
      ...(input.dateOfBirth !== undefined
        ? { dateOfBirth: input.dateOfBirth ? dateToDb(input.dateOfBirth) : null }
        : {}),
    };
    await this.db.tx.student.update({ where: { id }, data });
    const after = await this.profile(id);
    const changed = Object.keys(data) as (keyof StudentProfile)[];
    await this.audit.record({
      entity: 'student',
      entityId: id,
      action: 'UPDATE',
      oldValues: Object.fromEntries(
        changed.map((k) => [k, before[k] ?? null]),
      ) as Prisma.InputJsonValue,
      newValues: Object.fromEntries(
        changed.map((k) => [k, after[k] ?? null]),
      ) as Prisma.InputJsonValue,
    });
    return after;
  }

  // ─────────────────────────── Guardians ───────────────────────────

  async addGuardian(studentId: string, g: GuardianInput): Promise<StudentProfile> {
    const before = await this.active(studentId);
    if (before.guardians.some((x) => x.phone === g.phone)) {
      throw apiError(409, 'ALREADY_LINKED', 'This guardian is already linked', { field: 'phone' });
    }
    if (before.guardians.length >= 4)
      throw apiError(422, 'TOO_MANY_GUARDIANS', 'At most 4 guardians');
    const guardian = await this.guardians.findOrCreate(g);
    const isPrimary = g.isPrimary || before.guardians.length === 0;
    const linkId = await this.guardians.link(studentId, guardian.id, g.relation, isPrimary);
    await this.audit.record({
      entity: 'student_guardian',
      entityId: linkId,
      action: 'CREATE',
      newValues: {
        studentId,
        guardianId: guardian.id,
        phone: g.phone,
        relation: g.relation,
        isPrimary,
        newGuardian: guardian.created,
      },
    });
    return this.profile(studentId);
  }

  async updateGuardian(
    studentId: string,
    linkId: string,
    input: {
      relation?: GuardianRelation;
      isPrimary?: true;
      nameBn?: string | null;
      nameEn?: string | null;
      occupation?: string | null;
    },
  ): Promise<StudentProfile> {
    const tx = this.db.tx;
    const before = await this.active(studentId);
    const link = before.guardians.find((l) => l.linkId === linkId);
    if (!link) throw new NotFoundException('Guardian link not found');
    if (input.isPrimary && !link.isPrimary) {
      await tx.studentGuardian.updateMany({
        where: { studentId, isPrimary: true },
        data: { isPrimary: false },
      });
    }
    await tx.studentGuardian.update({
      where: { id: linkId },
      data: { relation: input.relation, ...(input.isPrimary ? { isPrimary: true } : {}) },
    });
    const guardianData = {
      ...(input.nameBn !== undefined ? { nameBn: input.nameBn } : {}),
      ...(input.nameEn !== undefined ? { nameEn: input.nameEn } : {}),
      ...(input.occupation !== undefined ? { occupation: input.occupation } : {}),
    };
    if (Object.keys(guardianData).length > 0) {
      const nameBn = 'nameBn' in input ? input.nameBn : link.nameBn;
      const nameEn = 'nameEn' in input ? input.nameEn : link.nameEn;
      if (!nameBn && !nameEn) {
        throw apiError(422, 'NAME_REQUIRED', 'A guardian needs a name', { field: 'nameBn' });
      }
      await tx.guardian.update({ where: { id: link.guardianId }, data: guardianData });
    }
    await this.audit.record({
      entity: 'student_guardian',
      entityId: linkId,
      action: 'UPDATE',
      oldValues: {
        relation: link.relation,
        isPrimary: link.isPrimary,
        nameBn: link.nameBn,
        nameEn: link.nameEn,
        occupation: link.occupation,
      },
      newValues: { ...input },
    });
    return this.profile(studentId);
  }

  async removeGuardian(studentId: string, linkId: string): Promise<StudentProfile> {
    const before = await this.active(studentId);
    const link = before.guardians.find((l) => l.linkId === linkId);
    if (!link) throw new NotFoundException('Guardian link not found');
    if (before.guardians.length === 1)
      throw apiError(409, 'GUARDIAN_REQUIRED', 'A student needs a guardian');
    if (link.isPrimary)
      throw apiError(409, 'PRIMARY_REQUIRED', 'Make another guardian primary first');
    await this.db.tx.studentGuardian.delete({ where: { id: linkId } });
    await this.audit.record({
      entity: 'student_guardian',
      entityId: linkId,
      action: 'DELETE',
      oldValues: {
        studentId,
        guardianId: link.guardianId,
        phone: link.phone,
        relation: link.relation,
      },
    });
    return this.profile(studentId);
  }

  // ─────────────────────────── Enrolment ───────────────────────────

  /** Move to another section of the same year and class level (new roll optional). */
  async transfer(
    studentId: string,
    input: { sectionId: string; roll: number | null },
  ): Promise<StudentProfile> {
    const tx = this.db.tx;
    const before = await this.active(studentId);
    const current = before.enrolments.find((e) => e.academicYear.isCurrent) ?? null;
    if (!current) throw apiError(422, 'NOT_ENROLLED', 'Not enrolled in the current year');
    if (current.section?.id === input.sectionId)
      throw apiError(422, 'SAME_SECTION', 'Already in this section', { field: 'sectionId' });
    await this.checkEnrolment(
      {
        academicYearId: current.academicYear.id,
        classLevelId: current.classLevel.id,
        sectionId: input.sectionId,
        studyGroupId: null,
        roll: input.roll,
      },
      current.id,
    );
    await tx.enrolment.update({
      where: { id: current.id },
      data: { sectionId: input.sectionId, roll: input.roll },
    });
    await this.audit.record({
      entity: 'enrolment',
      entityId: current.id,
      action: 'UPDATE',
      oldValues: { sectionId: current.section?.id ?? null, roll: current.roll },
      newValues: { sectionId: input.sectionId, roll: input.roll, reason: 'transfer' },
    });
    return this.profile(studentId);
  }

  /** Enrol in a year the student has no enrolment in yet. */
  async enrol(studentId: string, input: EnrolmentInput): Promise<StudentProfile> {
    const before = await this.active(studentId);
    if (before.enrolments.some((e) => e.academicYear.id === input.academicYearId)) {
      throw apiError(409, 'ALREADY_ENROLLED', 'Already enrolled in that year', {
        field: 'academicYearId',
      });
    }
    await this.checkEnrolment(input, null);
    const row = await this.db.tx.enrolment.create({
      data: { tenantId: this.tenantId, studentId, ...input },
      select: { id: true },
    });
    await this.audit.record({
      entity: 'enrolment',
      entityId: row.id,
      action: 'CREATE',
      newValues: { studentId, ...input },
    });
    return this.profile(studentId);
  }

  /**
   * Soft delete: deleted_at + INACTIVE. Rolls are released (set to NULL) so the numbers can be
   * given to others; the old rolls stay in the audit log.
   */
  async deactivate(studentId: string): Promise<StudentProfile> {
    const tx = this.db.tx;
    const before = await this.active(studentId);
    await tx.student.update({
      where: { id: studentId },
      data: { deletedAt: new Date(), status: 'INACTIVE' },
    });
    // Current year only: past years' rolls stay on their records.
    await tx.enrolment.updateMany({
      where: { studentId, roll: { not: null }, academicYear: { isCurrent: true } },
      data: { roll: null },
    });
    await this.audit.record({
      entity: 'student',
      entityId: studentId,
      action: 'DELETE',
      oldValues: {
        status: before.status,
        rolls: before.enrolments.map((e) => ({
          enrolmentId: e.id,
          sectionId: e.section?.id ?? null,
          roll: e.roll,
        })),
      },
      newValues: { status: 'INACTIVE', softDeleted: true },
    });
    return this.profile(studentId);
  }

  /** A student that exists and is not deactivated (writes need that). */
  private async active(id: string): Promise<StudentProfile> {
    const s = await this.profile(id);
    if (s.deletedAt) throw apiError(409, 'DEACTIVATED', 'This student is deactivated');
    return s;
  }
}

function pickStudent(input: StudentFieldsInput) {
  const out: Record<string, unknown> = {};
  for (const k of STUDENT_COLUMNS)
    if (input[k] !== undefined && !(k === 'studentCode' && input[k] === null)) out[k] = input[k];
  // studentCode is never null here (null = "generate one" is handled by the caller).
  return out as Omit<StudentFieldsInput, 'dateOfBirth' | 'studentCode'> & { studentCode?: string };
}

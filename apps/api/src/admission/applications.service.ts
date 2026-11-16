import { createHash } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@jantrik/db';
import {
  applicationNameKey,
  approvableStatuses,
  dateFromDb,
  dateToDb,
  effectiveAdmissionFields,
  formatApplicationNo,
  formatBdPhone,
  missingAdmissionFields,
  normalizeBdPhone,
  toAsciiDigits,
  toCsv,
  type AdmissionApplicationDetail,
  type AdmissionApplicationFields,
  type AdmissionApplicationListItem,
  type AdmissionApplicationsPage,
  type AdmissionApplicationsQuery,
  type AdmissionApprovalProblem,
  type AdmissionStaffStatus,
  type StaffAdmissionApplication,
  type UpdateAdmissionApplication,
} from '@jantrik/shared';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { Clock } from '../common/clock.js';
import { RequestContext } from '../common/request-context.js';
import type { PreparedImage } from '../files/files.module.js';
import { Db } from '../tenancy/db.service.js';

/** At most this many live applications per phone per cycle (the 4th is refused). */
export const APPLICATIONS_PER_PHONE = 3;
/** CSV rows at most (one download). */
const CSV_LIMIT = 10_000;

const NAMED = { id: true, nameBn: true, nameEn: true } as const;

const LIST_SELECT = {
  id: true,
  applicationNo: true,
  source: true,
  nameBn: true,
  nameEn: true,
  dateOfBirth: true,
  gender: true,
  phone: true,
  guardianNameBn: true,
  guardianNameEn: true,
  status: true,
  submittedAt: true,
  approvalProblem: true,
  studentId: true,
  cycle: { select: { id: true, nameBn: true, nameEn: true } },
  cycleClass: {
    select: { id: true, classLevel: { select: NAMED }, studyGroup: { select: NAMED } },
  },
  photo: { select: { sha256: true } },
} satisfies Prisma.AdmissionApplicationSelect;

type ListRow = Prisma.AdmissionApplicationGetPayload<{ select: typeof LIST_SELECT }>;

/** The application columns an edit may change, from the API's field names. */
const EDITABLE = [
  'nameBn',
  'nameEn',
  'dateOfBirth',
  'gender',
  'religion',
  'bloodGroup',
  'birthRegistrationNo',
  'previousInstitute',
  'presentAddress',
  'permanentAddress',
  'fatherNameBn',
  'fatherNameEn',
  'motherNameBn',
  'motherNameEn',
  'guardianNameBn',
  'guardianNameEn',
  'guardianRelation',
  'guardianOccupation',
  'phone',
  'cycleClassId',
  'staffNote',
] as const;

/** What one application's duplicate and phone-cap checks need. */
export interface AdmissionCandidate {
  cycleId: string;
  phone: string;
  nameKey: string;
  dateOfBirth: string;
  birthRegistrationNo: string | null;
}

/**
 * Applications, staff side (sprint 1 P3a, OWNER/ADMIN): walk-in entry (P3-J), edits, status
 * changes, the list, its CSV and the applicant's photo. The duplicate and per-phone rules here are
 * the same as the public form's (admission_submit, P3b). Everything is audited.
 */
@Injectable()
export class AdmissionApplicationsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
    private readonly clock: Clock,
  ) {}

  private get tenantId(): string {
    return this.context.requireTenantId();
  }

  // ─────────────────────────── The rules shared with the public form ───────────────────────────

  /**
   * Holds the institute's lock for this phone until the transaction ends, then refuses a
   * duplicate (the same birth registration number, or the same phone, name and date of birth, in
   * this cycle, not withdrawn: 409 with its number, decision P3-S) and a phone's fourth live
   * application in the cycle (422). `exceptId`: the application being edited.
   */
  async checkCandidate(c: AdmissionCandidate, exceptId: string | null = null): Promise<void> {
    const tx = this.db.tx;
    const key = `admission:${this.tenantId}:${c.phone}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    const not = exceptId ? { id: { not: exceptId } } : {};
    const duplicate = await tx.admissionApplication.findFirst({
      where: {
        cycleId: c.cycleId,
        status: { not: 'WITHDRAWN' },
        ...not,
        OR: [
          ...(c.birthRegistrationNo ? [{ birthRegistrationNo: c.birthRegistrationNo }] : []),
          { phone: c.phone, nameKey: c.nameKey, dateOfBirth: dateToDb(c.dateOfBirth) },
        ],
      },
      orderBy: { submittedAt: 'asc' },
      select: { applicationNo: true },
    });
    if (duplicate) {
      throw apiError(409, 'ADMISSION_DUPLICATE', 'This child has already applied in this cycle', {
        applicationNo: duplicate.applicationNo,
      });
    }
    const live = await tx.admissionApplication.count({
      where: {
        cycleId: c.cycleId,
        phone: c.phone,
        status: { notIn: ['WITHDRAWN', 'REJECTED'] },
        ...not,
      },
    });
    if (live >= APPLICATIONS_PER_PHONE) {
      throw apiError(422, 'ADMISSION_PHONE_CAP', 'This phone has applied for three children', {
        field: 'phone',
        limit: APPLICATIONS_PER_PHONE,
      });
    }
  }

  /** The next number of the year (<year>-<NNNN>, decision P3-G); the row lock orders takers. */
  async nextNumber(year: number): Promise<string> {
    const [row] = await this.db.tx.$queryRaw<{ last_no: number }[]>`
      INSERT INTO public.admission_counters (tenant_id, year, last_no, created_at, updated_at)
      VALUES (${this.tenantId}::uuid, ${year}::smallint, 1, now(), now())
      ON CONFLICT (tenant_id, year)
      DO UPDATE SET last_no = admission_counters.last_no + 1, updated_at = now()
      RETURNING last_no`;
    return formatApplicationNo(year, row!.last_no);
  }

  // ─────────────────────────── Staff entry and edits ───────────────────────────

  async create(input: StaffAdmissionApplication): Promise<AdmissionApplicationDetail> {
    const tx = this.db.tx;
    const cc = await tx.admissionCycleClass.findUnique({
      where: { id: input.cycleClassId },
      select: {
        id: true,
        cycleId: true,
        cycle: {
          select: {
            fields: true,
            collectPhoto: true,
            academicYear: { select: { startDate: true } },
          },
        },
      },
    });
    if (!cc) throw new NotFoundException('Admission class not found');
    const fields = toFields(input);
    // Staff may record any field; what the cycle requires (except the photo, added afterwards)
    // must be there.
    const settings = effectiveAdmissionFields(
      cc.cycle.fields as Record<string, string>,
      cc.cycle.collectPhoto,
    );
    const missing = missingAdmissionFields(settings, fields, true);
    if (missing.length > 0) {
      throw apiError(422, 'ADMISSION_FIELDS_REQUIRED', 'Some required fields are empty', {
        fields: missing,
      });
    }
    const nameKey = applicationNameKey(fields);
    await this.checkCandidate({
      cycleId: cc.cycleId,
      phone: input.phone,
      nameKey,
      dateOfBirth: fields.dateOfBirth,
      birthRegistrationNo: fields.birthRegistrationNo,
    });
    const applicationNo = await this.nextNumber(cc.cycle.academicYear.startDate.getUTCFullYear());
    const created = await tx.admissionApplication.create({
      data: {
        tenantId: this.tenantId,
        cycleId: cc.cycleId,
        cycleClassId: cc.id,
        applicationNo,
        source: 'STAFF',
        ...dbFields(fields),
        nameKey,
        phone: input.phone,
        staffNote: input.staffNote ?? null,
        submittedAt: this.clock.now(),
      },
      select: { id: true },
    });
    await this.audit.record({
      entity: 'admission_application',
      entityId: created.id,
      action: 'CREATE',
      newValues: {
        applicationNo,
        source: 'STAFF',
        cycleClassId: cc.id,
        ...fields,
        phone: input.phone,
        staffNote: input.staffNote ?? null,
      },
    });
    return this.detail(created.id);
  }

  async update(
    id: string,
    input: UpdateAdmissionApplication,
  ): Promise<AdmissionApplicationDetail> {
    const tx = this.db.tx;
    const old = await this.lockRow(id);
    if (old.status === 'ADMITTED') {
      throw apiError(409, 'APPLICATION_ADMITTED', 'An admitted application cannot be changed');
    }
    const given = input as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    const was: Record<string, unknown> = {};
    for (const key of EDITABLE) {
      if (given[key] === undefined) continue;
      const before =
        key === 'dateOfBirth' ? dateFromDb(old.dateOfBirth) : (old as Record<string, unknown>)[key];
      if (given[key] === before) continue;
      next[key] = given[key];
      was[key] = before ?? null;
    }
    if (Object.keys(next).length === 0) return this.detail(id);

    const pick = (k: 'nameBn' | 'nameEn' | 'guardianNameBn' | 'guardianNameEn') =>
      (k in next ? next[k] : old[k]) as string | null;
    const merged = {
      nameBn: pick('nameBn'),
      nameEn: pick('nameEn'),
      guardianNameBn: pick('guardianNameBn'),
      guardianNameEn: pick('guardianNameEn'),
    };
    if (!merged.nameBn && !merged.nameEn) {
      throw apiError(422, 'NAME_REQUIRED', 'A name in Bangla or English is required', {
        field: 'nameBn',
      });
    }
    if (!merged.guardianNameBn && !merged.guardianNameEn) {
      throw apiError(422, 'GUARDIAN_NAME_REQUIRED', "The guardian's name is required", {
        field: 'guardianNameBn',
      });
    }
    if (next['cycleClassId'] !== undefined) {
      const cc = await tx.admissionCycleClass.findUnique({
        where: { id: next['cycleClassId'] as string },
        select: { cycleId: true },
      });
      if (!cc) throw new NotFoundException('Admission class not found');
      if (cc.cycleId !== old.cycleId) {
        throw apiError(422, 'CLASS_NOT_IN_CYCLE', 'That class belongs to another cycle', {
          field: 'cycleClassId',
        });
      }
    }
    const nameKey = applicationNameKey(merged);
    const dateOfBirth = (next['dateOfBirth'] as string | undefined) ?? dateFromDb(old.dateOfBirth);
    const phone = (next['phone'] as string | undefined) ?? old.phone;
    const birthRegistrationNo =
      'birthRegistrationNo' in next
        ? (next['birthRegistrationNo'] as string | null)
        : old.birthRegistrationNo;
    if (
      'phone' in next ||
      'dateOfBirth' in next ||
      'birthRegistrationNo' in next ||
      nameKey !== old.nameKey
    ) {
      await this.checkCandidate(
        { cycleId: old.cycleId, phone, nameKey, dateOfBirth, birthRegistrationNo },
        id,
      );
    }
    const data: Record<string, unknown> = { ...next, nameKey };
    if (next['dateOfBirth'] !== undefined) data['dateOfBirth'] = dateToDb(dateOfBirth);
    await tx.admissionApplication.update({
      where: { id },
      data: data as Prisma.AdmissionApplicationUncheckedUpdateInput,
      select: { id: true },
    });
    await this.audit.record({
      entity: 'admission_application',
      entityId: id,
      action: 'UPDATE',
      oldValues: was as Prisma.InputJsonValue,
      newValues: next as Prisma.InputJsonValue,
    });
    return this.detail(id);
  }

  async setStatus(
    id: string,
    status: AdmissionStaffStatus,
    reason: string | null,
  ): Promise<AdmissionApplicationDetail> {
    const old = await this.lockRow(id);
    if (old.status === 'ADMITTED') {
      throw apiError(409, 'APPLICATION_ADMITTED', 'An admitted application cannot be changed');
    }
    const at = this.clock.now();
    await this.db.tx.admissionApplication.update({
      where: { id },
      data: {
        status,
        statusReason: reason,
        statusBy: this.context.requirePrincipal().userId,
        statusAt: at,
      },
      select: { id: true },
    });
    await this.audit.record({
      entity: 'admission_application',
      entityId: id,
      action: 'UPDATE',
      oldValues: { status: old.status, statusReason: old.statusReason },
      newValues: { status, statusReason: reason },
    });
    return this.detail(id);
  }

  /** The application row, locked for this transaction (edits, status changes and approval). */
  async lockRow(id: string) {
    await this.db.tx
      .$queryRaw`SELECT id FROM public.admission_applications WHERE id = ${id}::uuid FOR UPDATE`;
    const row = await this.db.tx.admissionApplication.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Application not found');
    return row;
  }

  // ─────────────────────────── Reading ───────────────────────────

  async list(query: AdmissionApplicationsQuery): Promise<AdmissionApplicationsPage> {
    const where = this.where(query);
    const [rows, total] = await Promise.all([
      this.db.tx.admissionApplication.findMany({
        where,
        orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: LIST_SELECT,
      }),
      this.db.tx.admissionApplication.count({ where }),
    ]);
    return { items: rows.map(listItem), page: query.page, pageSize: query.pageSize, total };
  }

  /** The list as CSV: UTF-8 with a BOM, ASCII digits for numbers, phones and dates. */
  async csv(query: AdmissionApplicationsQuery, locale: 'bn' | 'en'): Promise<string> {
    const tenant = await this.db.tx.tenant.findFirstOrThrow({ select: { timezone: true } });
    const rows = await this.db.tx.admissionApplication.findMany({
      where: this.where(query),
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      take: CSV_LIMIT,
      select: {
        ...LIST_SELECT,
        birthRegistrationNo: true,
        guardianRelation: true,
      },
    });
    const at = new Intl.DateTimeFormat('en-CA', {
      timeZone: tenant.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const name = (n: { nameBn: string | null; nameEn: string | null }) =>
      locale === 'bn' ? (n.nameBn ?? n.nameEn) : (n.nameEn ?? n.nameBn);
    const header =
      locale === 'bn'
        ? [
            'আবেদন নম্বর',
            'অবস্থা',
            'উৎস',
            'শ্রেণি',
            'বিভাগ',
            'নাম (বাংলা)',
            'নাম (ইংরেজি)',
            'জন্ম তারিখ',
            'লিঙ্গ',
            'জন্ম নিবন্ধন',
            'অভিভাবক',
            'সম্পর্ক',
            'মোবাইল',
            'জমা',
          ]
        : [
            'Application no',
            'Status',
            'Source',
            'Class',
            'Group',
            'Name (Bangla)',
            'Name (English)',
            'Date of birth',
            'Gender',
            'Birth registration',
            'Guardian',
            'Relation',
            'Phone',
            'Submitted',
          ];
    return toCsv([
      header,
      ...rows.map((r) => [
        r.applicationNo,
        r.status,
        r.source,
        name(r.cycleClass.classLevel),
        r.cycleClass.studyGroup ? name(r.cycleClass.studyGroup) : '',
        r.nameBn,
        r.nameEn,
        dateFromDb(r.dateOfBirth),
        r.gender,
        r.birthRegistrationNo,
        name({ nameBn: r.guardianNameBn, nameEn: r.guardianNameEn }),
        r.guardianRelation,
        formatBdPhone(r.phone),
        at.format(r.submittedAt).replace(',', ''),
      ]),
    ]);
  }

  async detail(id: string): Promise<AdmissionApplicationDetail> {
    const tx = this.db.tx;
    const a = await tx.admissionApplication.findUnique({
      where: { id },
      select: {
        ...LIST_SELECT,
        religion: true,
        bloodGroup: true,
        birthRegistrationNo: true,
        previousInstitute: true,
        presentAddress: true,
        permanentAddress: true,
        fatherNameBn: true,
        fatherNameEn: true,
        motherNameBn: true,
        motherNameEn: true,
        guardianRelation: true,
        guardianOccupation: true,
        statusReason: true,
        statusAt: true,
        staffNote: true,
        student: { select: { id: true, studentCode: true } },
        cycle: {
          select: {
            id: true,
            nameBn: true,
            nameEn: true,
            requiresTest: true,
            academicYear: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!a) throw new NotFoundException('Application not found');
    const possibleDuplicates = a.birthRegistrationNo
      ? await tx.student.findMany({
          where: { birthRegistrationNo: a.birthRegistrationNo },
          select: { id: true, studentCode: true, nameBn: true, nameEn: true },
          take: 5,
        })
      : [];
    return {
      ...listItem(a),
      cycle: { id: a.cycle.id, nameBn: a.cycle.nameBn, nameEn: a.cycle.nameEn },
      religion: a.religion,
      bloodGroup: a.bloodGroup,
      birthRegistrationNo: a.birthRegistrationNo,
      previousInstitute: a.previousInstitute,
      presentAddress: a.presentAddress,
      permanentAddress: a.permanentAddress,
      fatherNameBn: a.fatherNameBn,
      fatherNameEn: a.fatherNameEn,
      motherNameBn: a.motherNameBn,
      motherNameEn: a.motherNameEn,
      guardianRelation: a.guardianRelation,
      guardianOccupation: a.guardianOccupation,
      statusReason: a.statusReason,
      statusAt: a.statusAt?.toISOString() ?? null,
      staffNote: a.staffNote,
      requiresTest: a.cycle.requiresTest,
      approvable:
        a.studentId === null && approvableStatuses(a.cycle.requiresTest).includes(a.status),
      student: a.student,
      possibleDuplicates,
      academicYear: a.cycle.academicYear,
    };
  }

  // ─────────────────────────── The applicant's photo ───────────────────────────

  async photo(id: string) {
    const row = await this.db.tx.admissionApplicationPhoto.findUnique({
      where: { tenantId_applicationId: { tenantId: this.tenantId, applicationId: id } },
      select: { bytes: true, sha256: true, mime: true },
    });
    if (!row) throw apiError(404, 'NOT_FOUND', 'No photo');
    return row;
  }

  /** Staff add or replace an applicant's photo (already re-encoded by ImageService). */
  async setPhoto(id: string, image: PreparedImage): Promise<AdmissionApplicationDetail> {
    const old = await this.lockRow(id);
    if (old.status === 'ADMITTED') {
      throw apiError(409, 'APPLICATION_ADMITTED', 'An admitted application cannot be changed');
    }
    const tx = this.db.tx;
    const key = { tenantId: this.tenantId, applicationId: id };
    const had = await tx.admissionApplicationPhoto.findUnique({
      where: { tenantId_applicationId: key },
      select: { sha256: true },
    });
    if (had) await tx.admissionApplicationPhoto.delete({ where: { tenantId_applicationId: key } });
    const sha256 = createHash('sha256').update(image.bytes).digest('hex');
    await tx.admissionApplicationPhoto.create({
      data: {
        ...key,
        mime: image.mime,
        bytes: new Uint8Array(image.bytes),
        sha256,
        width: image.width,
        height: image.height,
      },
    });
    await this.audit.record({
      entity: 'admission_application',
      entityId: id,
      action: 'UPDATE',
      oldValues: { photoSha256: had?.sha256 ?? null },
      newValues: { photoSha256: sha256 },
    });
    return this.detail(id);
  }

  /** 404 unless the application exists here and may still change (before decoding a photo). */
  async assertEditable(id: string): Promise<void> {
    const a = await this.db.tx.admissionApplication.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!a) throw new NotFoundException('Application not found');
    if (a.status === 'ADMITTED') {
      throw apiError(409, 'APPLICATION_ADMITTED', 'An admitted application cannot be changed');
    }
  }

  private where(q: AdmissionApplicationsQuery): Prisma.AdmissionApplicationWhereInput {
    const where: Prisma.AdmissionApplicationWhereInput = {
      ...(q.cycleId ? { cycleId: q.cycleId } : {}),
      ...(q.cycleClassId ? { cycleClassId: q.cycleClassId } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.source ? { source: q.source } : {}),
    };
    if (!q.q) return where;
    const term = q.q;
    const ascii = toAsciiDigits(term).replace(/\s/g, '');
    const phone = normalizeBdPhone(term);
    const or: Prisma.AdmissionApplicationWhereInput[] = [
      { nameBn: { contains: term, mode: 'insensitive' } },
      { nameEn: { contains: term, mode: 'insensitive' } },
    ];
    if (/^[0-9-]{3,}$/.test(ascii)) or.push({ applicationNo: { startsWith: ascii } });
    if (phone) or.push({ phone });
    else if (/^[0-9]{4,}$/.test(ascii.replace(/-/g, ''))) {
      or.push({ phone: { contains: ascii.replace(/-/g, '').replace(/^0/, '') } });
    }
    return { ...where, OR: or };
  }
}

/** The API's fields from a validated input (one place, so staff entry and P3b agree). */
export function toFields(input: AdmissionApplicationFields): AdmissionApplicationFields {
  return {
    nameBn: input.nameBn ?? null,
    nameEn: input.nameEn ?? null,
    dateOfBirth: input.dateOfBirth,
    gender: input.gender,
    religion: input.religion ?? null,
    bloodGroup: input.bloodGroup ?? null,
    birthRegistrationNo: input.birthRegistrationNo ?? null,
    previousInstitute: input.previousInstitute ?? null,
    presentAddress: input.presentAddress ?? null,
    permanentAddress: input.permanentAddress ?? null,
    fatherNameBn: input.fatherNameBn ?? null,
    fatherNameEn: input.fatherNameEn ?? null,
    motherNameBn: input.motherNameBn ?? null,
    motherNameEn: input.motherNameEn ?? null,
    guardianNameBn: input.guardianNameBn ?? null,
    guardianNameEn: input.guardianNameEn ?? null,
    guardianRelation: input.guardianRelation,
    guardianOccupation: input.guardianOccupation ?? null,
  };
}

/** The same fields as table columns (the date as a database date). */
export function dbFields(f: AdmissionApplicationFields) {
  return { ...f, dateOfBirth: dateToDb(f.dateOfBirth) };
}

function listItem(r: ListRow): AdmissionApplicationListItem {
  return {
    id: r.id,
    applicationNo: r.applicationNo,
    source: r.source,
    nameBn: r.nameBn,
    nameEn: r.nameEn,
    dateOfBirth: dateFromDb(r.dateOfBirth),
    gender: r.gender,
    phone: r.phone,
    guardianNameBn: r.guardianNameBn,
    guardianNameEn: r.guardianNameEn,
    status: r.status,
    submittedAt: r.submittedAt.toISOString(),
    cycle: r.cycle,
    cycleClass: r.cycleClass,
    approvalProblem: r.approvalProblem as AdmissionApprovalProblem | null,
    hasPhoto: r.photo !== null,
    photoVersion: r.photo?.sha256 ?? null,
    studentId: r.studentId,
  };
}

import { InjectQueue } from '@nestjs/bullmq';
import { HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@jantrik/db';
import {
  IMPORT_FIELDS,
  admissionSchema,
  detectMapping,
  findInFileDuplicates,
  formatBdPhone,
  parseImportRow,
  toCsv,
  type ImportField,
  type ImportLookups,
  type ImportMapping,
  type ImportPreviewPage,
  type ImportRowError,
  type ImportRowResult,
  type ImportStudent,
  type StudentImportSummary,
} from '@jantrik/shared';
import type { Queue } from 'bullmq';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { RequestContext } from '../common/request-context.js';
import { StudentAdminService } from '../students/student-admin.service.js';
import { Db } from '../tenancy/db.service.js';
import { parseUpload } from './spreadsheet.js';

export const IMPORT_QUEUE = 'student-import';
export interface ImportJob {
  tenantId: string;
  importId: string;
}

const PAGE_SIZE = 50;
const RETENTION_DAYS = 7;

type Row = Prisma.StudentImportGetPayload<object>;

/**
 * Student import: upload → mapping + validation preview → background run → report.
 * Everything here runs in the request (or job) RLS transaction for one tenant.
 */
@Injectable()
export class StudentImportService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
    private readonly students: StudentAdminService,
    @InjectQueue(IMPORT_QUEUE) private readonly queue: Queue<ImportJob>,
  ) {}

  private get me() {
    const p = this.context.requirePrincipal();
    return { tenantId: p.tenantId!, userId: p.userId };
  }

  // ─────────────────────────── Upload ───────────────────────────

  async upload(
    file: { buffer: Buffer; originalname: string } | undefined,
  ): Promise<StudentImportSummary> {
    if (!file) throw apiError(422, 'FILE_MISSING', 'Choose a file');
    const sheet = await parseUpload(file.buffer, file.originalname);
    const tx = this.db.tx;
    await this.clearExpired();
    const mapping = detectMapping(sheet.headers);
    const row = await tx.studentImport.create({
      data: {
        tenantId: this.me.tenantId,
        createdById: this.me.userId,
        // multer decodes the name as latin1; browsers send UTF-8 (Bangla file names).
        fileName:
          Buffer.from(file.originalname, 'latin1').toString('utf8').slice(0, 255) || 'import',
        headers: sheet.headers,
        rows: sheet.rows,
        mapping,
        rowCount: sheet.rows.length,
      },
    });
    await this.audit.record({
      entity: 'student_import',
      entityId: row.id,
      action: 'CREATE',
      newValues: { fileName: row.fileName, rowCount: row.rowCount },
    });
    return this.validate(row.id, mapping);
  }

  /**
   * Raw rows hold personal data: cleared for imports left unfinished for a week, and for runs
   * stuck for a day (a lost job). Runs on every upload and listing (lazily, per tenant).
   */
  private async clearExpired(): Promise<void> {
    const tx = this.db.tx;
    const day = 24 * 3600 * 1000;
    const data = {
      rows: Prisma.DbNull,
      status: 'FAILED' as const,
      failure: 'EXPIRED',
      finishedAt: new Date(),
    };
    await tx.studentImport.updateMany({
      where: {
        createdAt: { lt: new Date(Date.now() - RETENTION_DAYS * day) },
        rows: { not: Prisma.DbNull },
        status: { in: ['UPLOADED', 'VALIDATED'] },
      },
      data,
    });
    await tx.studentImport.updateMany({
      where: {
        updatedAt: { lt: new Date(Date.now() - day) },
        status: { in: ['QUEUED', 'RUNNING'] },
      },
      data,
    });
  }

  // ─────────────────────────── Mapping + validation ───────────────────────────

  /** Apply a column mapping and check every row (OK / EXISTS / ERROR with exact problems). */
  async validate(id: string, mapping: ImportMapping): Promise<StudentImportSummary> {
    const tx = this.db.tx;
    const imp = await this.load(id);
    if (imp.status !== 'UPLOADED' && imp.status !== 'VALIDATED') {
      throw apiError(409, 'IMPORT_STARTED', 'This import has already started');
    }
    const headers = imp.headers as string[];
    for (const col of Object.values(mapping)) {
      if (col !== null && col !== undefined && col >= headers.length) {
        throw apiError(422, 'MAPPING_INVALID', 'A column does not exist');
      }
    }
    const rows = (imp.rows as string[][] | null) ?? [];
    const results = await this.check(rows, mapping);
    // Conditional: a run started meanwhile must not be turned back into VALIDATED.
    const { count } = await tx.studentImport.updateMany({
      where: { id, status: { in: ['UPLOADED', 'VALIDATED'] } },
      data: {
        mapping: mapping as Prisma.InputJsonValue,
        results: results as unknown as Prisma.InputJsonValue,
        status: 'VALIDATED',
      },
    });
    if (count === 0) throw apiError(409, 'IMPORT_STARTED', 'This import has already started');
    return this.summary(id);
  }

  /** Lookups for the current academic year (imports always go into it). */
  async lookups(): Promise<ImportLookups & { yearId: string; yearStart: Date }> {
    const tx = this.db.tx;
    const year = await tx.academicYear.findFirst({
      where: { isCurrent: true },
      select: { id: true, startDate: true },
    });
    if (!year) throw apiError(422, 'NO_CURRENT_YEAR', 'There is no current academic year');
    const [classLevels, sections, studyGroups] = [
      await tx.classLevel.findMany({
        select: { id: true, code: true, nameBn: true, nameEn: true, isActive: true },
      }),
      await tx.section.findMany({
        where: { academicYearId: year.id },
        select: { id: true, classLevelId: true, name: true, isActive: true },
      }),
      await tx.studyGroup.findMany({
        select: { id: true, code: true, nameBn: true, nameEn: true, isActive: true },
      }),
    ];
    return { classLevels, sections, studyGroups, yearId: year.id, yearStart: year.startDate };
  }

  /** Per row: parse, in-file duplicates, then what is already in the database. */
  private async check(rows: string[][], mapping: ImportMapping): Promise<ImportRowResult[]> {
    const tx = this.db.tx;
    const lookups = await this.lookups();
    const parsed = rows.map((cells) => parseImportRow(cells, mapping, lookups));
    const dups = findInFileDuplicates(parsed);
    const students = parsed.flatMap((p) => (p.ok ? [p.student] : []));
    const codes = students.flatMap((s) => (s.studentCode ? [s.studentCode] : []));
    const regs = students.flatMap((s) => (s.birthRegistrationNo ? [s.birthRegistrationNo] : []));
    const existing = await tx.student.findMany({
      where: { OR: [{ studentCode: { in: codes } }, { birthRegistrationNo: { in: regs } }] },
      select: { studentCode: true, birthRegistrationNo: true },
    });
    const byCode = new Map(existing.map((e) => [e.studentCode, e.studentCode]));
    const byReg = new Map(
      existing.flatMap((e) =>
        e.birthRegistrationNo ? [[e.birthRegistrationNo, e.studentCode]] : [],
      ),
    );
    const sectionIds = [...new Set(students.flatMap((s) => (s.sectionId ? [s.sectionId] : [])))];
    const taken = await tx.enrolment.findMany({
      where: { sectionId: { in: sectionIds }, roll: { not: null } },
      select: { sectionId: true, roll: true },
    });
    const takenRolls = new Set(taken.map((t) => `${t.sectionId}:${t.roll}`));
    // A guardian found by phone keeps their name; a new one needs a name in the row.
    const nameless = [
      ...new Set(
        students.flatMap((s) =>
          s.guardians.filter((g) => !g.nameBn && !g.nameEn).map((g) => g.phone),
        ),
      ),
    ];
    const knownPhones = new Set(
      (
        await tx.guardian.findMany({ where: { phone: { in: nameless } }, select: { phone: true } })
      ).map((g) => g.phone),
    );
    const capacity = new Map(
      (
        await tx.section.findMany({
          where: { id: { in: sectionIds }, capacity: { not: null } },
          select: {
            id: true,
            capacity: true,
            _count: { select: { enrolments: { where: { student: { deletedAt: null } } } } },
          },
        })
      ).map((s) => [s.id, { free: s.capacity! - s._count.enrolments }]),
    );

    return parsed.map((p, i): ImportRowResult => {
      const row = i + 2; // the header is row 1
      if (!p.ok) return { row, status: 'ERROR', errors: p.errors };
      const s = p.student;
      const name = s.nameBn ?? s.nameEn ?? undefined;
      const match =
        (s.studentCode && byCode.get(s.studentCode)) ||
        (s.birthRegistrationNo && byReg.get(s.birthRegistrationNo));
      if (match)
        return { row, status: 'EXISTS', errors: [], studentCode: match, ...(name ? { name } : {}) };
      const errors: ImportRowError[] = [...(dups.get(i) ?? [])];
      s.guardians.forEach((g, gi) => {
        if (!g.nameBn && !g.nameEn && !knownPhones.has(g.phone)) {
          errors.push({
            code: 'GUARDIAN_NAME_MISSING',
            field: gi === 0 ? 'guardianNameBn' : 'guardian2NameBn',
          });
        }
      });
      if (s.sectionId && s.roll !== null && takenRolls.has(`${s.sectionId}:${s.roll}`)) {
        errors.push({ code: 'ROLL_TAKEN', field: 'roll', value: String(s.roll) });
      }
      if (errors.length === 0 && s.sectionId) {
        const c = capacity.get(s.sectionId);
        if (c) {
          if (c.free <= 0) errors.push({ code: 'SECTION_FULL', field: 'section' });
          else c.free--;
        }
      }
      return errors.length > 0
        ? { row, status: 'ERROR', errors, ...(name ? { name } : {}) }
        : { row, status: 'OK', errors: [], ...(name ? { name } : {}) };
    });
  }

  // ─────────────────────────── Read ───────────────────────────

  async summary(id: string): Promise<StudentImportSummary> {
    return toSummary(await this.load(id));
  }

  async list(): Promise<StudentImportSummary[]> {
    await this.clearExpired();
    const rows = await this.db.tx.studentImport.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return rows.map(toSummary);
  }

  async rows(
    id: string,
    filter: 'all' | 'ok' | 'error' | 'exists',
    page: number,
  ): Promise<ImportPreviewPage> {
    const imp = await this.load(id);
    const results = (imp.results as ImportRowResult[] | null) ?? [];
    const cells = (imp.rows as string[][] | null) ?? [];
    const mapping = (imp.mapping as ImportMapping | null) ?? {};
    const wanted = results.filter((r) =>
      filter === 'all'
        ? true
        : filter === 'ok'
          ? r.status === 'OK' || r.status === 'IMPORTED'
          : filter === 'error'
            ? r.status === 'ERROR'
            : r.status === 'EXISTS' || r.status === 'SKIPPED',
    );
    const slice = wanted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    return {
      total: wanted.length,
      rows: slice.map((r) => ({
        ...r,
        values: Object.fromEntries(
          IMPORT_FIELDS.flatMap((f) => {
            const col = mapping[f];
            const v = col === null || col === undefined ? '' : (cells[r.row - 2]?.[col] ?? '');
            return v ? [[f, v]] : [];
          }),
        ) as Partial<Record<ImportField, string>>,
      })),
    };
  }

  private async load(id: string): Promise<Row> {
    const row = await this.db.tx.studentImport.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Import not found');
    return row;
  }

  // ─────────────────────────── Run ───────────────────────────

  /** VALIDATED → QUEUED (a conditional update: a double click cannot start two runs). */
  async start(id: string): Promise<StudentImportSummary> {
    const tx = this.db.tx;
    const imp = await this.load(id);
    const results = (imp.results as ImportRowResult[] | null) ?? [];
    if (!results.some((r) => r.status === 'OK'))
      throw apiError(422, 'NOTHING_TO_IMPORT', 'No rows to import');
    const { count } = await tx.studentImport.updateMany({
      where: { id, status: 'VALIDATED' },
      data: { status: 'QUEUED' },
    });
    if (count === 0) throw apiError(409, 'IMPORT_STARTED', 'This import has already started');
    await this.audit.record({
      entity: 'student_import',
      entityId: id,
      action: 'UPDATE',
      newValues: { status: 'QUEUED' },
    });
    const tenantId = this.me.tenantId;
    await this.context.afterCommit(() =>
      this.queue.add(
        'run',
        { tenantId, importId: id },
        { jobId: `import-${id}`, removeOnComplete: true, removeOnFail: 100 },
      ),
    );
    return this.summary(id);
  }

  /**
   * Job side, step 1 (in the job's tenant transaction): QUEUED → RUNNING, and the uploader must
   * still be an active OWNER/ADMIN here. Returns who to act as, or null when there is nothing to do.
   */
  async claim(id: string): Promise<{ actorUserId: string } | null> {
    const tx = this.db.tx;
    const imp = await tx.studentImport.findUnique({
      where: { id },
      select: { status: true, createdById: true },
    });
    if (!imp || (imp.status !== 'QUEUED' && imp.status !== 'RUNNING')) return null;
    const allowed = await tx.membership.findFirst({
      where: { userId: imp.createdById, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
      select: { id: true },
    });
    if (!allowed) {
      await tx.studentImport.update({
        where: { id },
        data: {
          status: 'FAILED',
          failure: 'NOT_ALLOWED',
          rows: Prisma.DbNull,
          finishedAt: new Date(),
        },
      });
      return null;
    }
    await tx.studentImport.update({ where: { id }, data: { status: 'RUNNING' } });
    return { actorUserId: imp.createdById };
  }

  /**
   * Job side, step 2 (one transaction per chunk, acting as the uploader): import the next
   * `size` rows after `processed`. The import row is locked first, so two workers can never run
   * the same rows; the uploader's role is checked again for every chunk. Each row runs inside a
   * savepoint, so one bad row cannot undo the others. Returns true when every row is done.
   */
  async runChunk(id: string, size: number): Promise<boolean> {
    const tx = this.db.tx;
    await tx.$queryRaw`SELECT id FROM student_imports WHERE id = ${id}::uuid FOR UPDATE`;
    const imp = await this.load(id);
    if (imp.status !== 'RUNNING') return true;
    const allowed = await tx.membership.findFirst({
      where: { userId: imp.createdById, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
      select: { id: true },
    });
    if (!allowed) {
      await tx.studentImport.update({
        where: { id },
        data: {
          status: 'FAILED',
          failure: 'NOT_ALLOWED',
          rows: Prisma.DbNull,
          finishedAt: new Date(),
        },
      });
      return true;
    }
    const from = imp.processed;
    const to = from + size;
    const rows = (imp.rows as string[][] | null) ?? [];
    const results = [...((imp.results as ImportRowResult[] | null) ?? [])];
    const mapping = (imp.mapping as ImportMapping | null) ?? {};
    const lookups = await this.lookups();
    for (let i = from; i < Math.min(to, rows.length); i++) {
      const r = results[i];
      if (!r || r.status !== 'OK') {
        if (r && r.status === 'EXISTS') results[i] = { ...r, status: 'SKIPPED' };
        continue;
      }
      // Parsed again: names/sections may have changed since the preview.
      const parsed = parseImportRow(rows[i]!, mapping, lookups);
      if (!parsed.ok) {
        results[i] = { ...r, status: 'ERROR', errors: parsed.errors };
        continue;
      }
      const s = parsed.student;
      const existing = await tx.student.findFirst({
        where: {
          OR: [
            ...(s.studentCode ? [{ studentCode: s.studentCode }] : []),
            ...(s.birthRegistrationNo ? [{ birthRegistrationNo: s.birthRegistrationNo }] : []),
          ],
        },
        select: { studentCode: true },
      });
      if ((s.studentCode || s.birthRegistrationNo) && existing) {
        results[i] = { ...r, status: 'SKIPPED', studentCode: existing.studentCode };
        continue;
      }
      // Through the same schema as a form admission: no limit can be skipped.
      const checked = admissionSchema.safeParse(toAdmission(s, lookups.yearId));
      if (!checked.success) {
        results[i] = { ...r, status: 'ERROR', errors: [{ code: 'ROW_REJECTED', field: 'nameBn' }] };
        continue;
      }
      await tx.$executeRawUnsafe('SAVEPOINT import_row');
      try {
        const profile = await this.students.admit(checked.data);
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT import_row');
        results[i] = { ...r, status: 'IMPORTED', studentCode: profile.studentCode };
      } catch (error) {
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT import_row');
        results[i] = { ...r, status: 'ERROR', errors: [rowErrorFrom(error)] };
      }
    }
    const done = to >= rows.length;
    await tx.studentImport.update({
      where: { id },
      data: {
        results: results as unknown as Prisma.InputJsonValue,
        processed: Math.min(to, rows.length),
        ...(done ? { status: 'DONE', rows: Prisma.DbNull, finishedAt: new Date() } : {}),
      },
    });
    if (done) {
      const imported = results.filter((x) => x.status === 'IMPORTED').length;
      await this.audit.record({
        entity: 'student_import',
        entityId: id,
        action: 'UPDATE',
        newValues: {
          status: 'DONE',
          imported,
          skipped: results.filter((x) => x.status === 'SKIPPED').length,
          errors: results.filter((x) => x.status === 'ERROR').length,
        },
      });
    }
    return done;
  }

  async fail(id: string, reason: string): Promise<void> {
    await this.db.tx.studentImport.updateMany({
      where: { id, status: { in: ['QUEUED', 'RUNNING'] } },
      data: {
        status: 'FAILED',
        failure: reason.slice(0, 200),
        rows: Prisma.DbNull,
        finishedAt: new Date(),
      },
    });
  }

  // ─────────────────────────── Report ───────────────────────────

  async reportCsv(id: string, locale: 'bn' | 'en'): Promise<{ filename: string; csv: string }> {
    const imp = await this.load(id);
    const results = (imp.results as ImportRowResult[] | null) ?? [];
    const head =
      locale === 'bn'
        ? ['সারি', 'ফলাফল', 'শিক্ষার্থী আইডি', 'নাম', 'সমস্যা']
        : ['Row', 'Result', 'Student ID', 'Name', 'Problems'];
    const lines = results.map((r) => [
      r.row,
      STATUS_TEXT[locale][r.status],
      r.studentCode ?? '',
      r.name ?? '',
      r.errors.map((e) => errorText(e, locale)).join('; '),
    ]);
    const stamp = imp.createdAt.toISOString().slice(0, 10);
    return { filename: `student-import-${stamp}.csv`, csv: toCsv([head, ...lines]) };
  }
}

function toSummary(r: Row): StudentImportSummary {
  const results = (r.results as ImportRowResult[] | null) ?? [];
  const count = (s: ImportRowResult['status']) => results.filter((x) => x.status === s).length;
  const mapping =
    (r.mapping as Record<ImportField, number | null> | null) ??
    detectMapping(r.headers as string[]);
  return {
    id: r.id,
    status: r.status,
    fileName: r.fileName,
    headers: r.headers as string[],
    mapping: Object.fromEntries(IMPORT_FIELDS.map((f) => [f, mapping[f] ?? null])) as Record<
      ImportField,
      number | null
    >,
    rowCount: r.rowCount,
    counts: {
      ok: count('OK'),
      error: count('ERROR'),
      exists: count('EXISTS'),
      imported: count('IMPORTED'),
      skipped: count('SKIPPED'),
    },
    processed: r.processed,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    failure: r.failure,
  };
}

function toAdmission(s: ImportStudent, academicYearId: string) {
  return {
    studentCode: s.studentCode,
    nameBn: s.nameBn,
    nameEn: s.nameEn,
    dateOfBirth: s.dateOfBirth,
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
    guardians: s.guardians,
    enrolment: {
      academicYearId,
      classLevelId: s.classLevelId,
      sectionId: s.sectionId,
      studyGroupId: s.studyGroupId,
      roll: s.roll,
    },
  };
}

/** An admit() refusal at run time (a race since the preview) → a row error. */
function rowErrorFrom(error: unknown): ImportRowError {
  if (error instanceof HttpException) {
    const body = error.getResponse() as { code?: string; field?: string };
    const map: Record<string, ImportRowError> = {
      ROLL_TAKEN: { code: 'ROLL_TAKEN', field: 'roll' },
      SECTION_FULL: { code: 'SECTION_FULL', field: 'section' },
      GUARDIAN_NAME_REQUIRED: { code: 'GUARDIAN_NAME_MISSING', field: 'guardianNameBn' },
      INACTIVE: { code: 'CLASS_UNKNOWN', field: 'classLevel' },
      DUPLICATE:
        body.field === 'birthRegistrationNo'
          ? { code: 'BIRTH_REG_DUPLICATE_IN_FILE', field: 'birthRegistrationNo' }
          : { code: 'CODE_DUPLICATE_IN_FILE', field: 'studentCode' },
    };
    if (body.code && map[body.code]) return map[body.code]!;
    // Any other refusal of this one row (4xx) is reported on the row; the import goes on.
    if (error.getStatus() < 500) return { code: 'ROW_REJECTED', field: 'nameBn' };
  }
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    ['P2002', 'P2003'].includes(error.code)
  ) {
    return { code: 'ROW_REJECTED', field: 'nameBn' };
  }
  throw error; // unexpected (5xx): fail the import rather than hide it
}

const STATUS_TEXT: Record<'bn' | 'en', Record<ImportRowResult['status'], string>> = {
  bn: {
    OK: 'ঠিক আছে',
    ERROR: 'ত্রুটি',
    EXISTS: 'আগে থেকেই আছে',
    IMPORTED: 'যোগ হয়েছে',
    SKIPPED: 'বাদ (আগে থেকেই আছে)',
  },
  en: {
    OK: 'OK',
    ERROR: 'Error',
    EXISTS: 'Already exists',
    IMPORTED: 'Imported',
    SKIPPED: 'Skipped (already exists)',
  },
};

const ERROR_TEXT: Record<ImportRowError['code'], { bn: string; en: string }> = {
  NAME_MISSING: { bn: 'নাম নেই', en: 'Name missing' },
  CLASS_MISSING: { bn: 'শ্রেণি নেই', en: 'Class missing' },
  CLASS_UNKNOWN: { bn: 'অজানা শ্রেণি', en: 'Unknown class' },
  SECTION_UNKNOWN: { bn: 'অজানা শাখা', en: 'Unknown section' },
  GROUP_UNKNOWN: { bn: 'অজানা বিভাগ', en: 'Unknown group' },
  ROLL_INVALID: { bn: 'রোল ১–৯৯৯৯ হতে হবে', en: 'Roll must be 1–9999' },
  ROLL_NEEDS_SECTION: { bn: 'রোলের জন্য শাখা দরকার', en: 'A roll needs a section' },
  ROLL_DUPLICATE_IN_FILE: {
    bn: 'ফাইলে একই শাখায় একই রোল দুবার',
    en: 'Same roll twice in this file',
  },
  ROLL_TAKEN: { bn: 'এই রোল শাখায় আগেই দেওয়া', en: 'Roll already taken in the section' },
  PHONE_MISSING: { bn: 'অভিভাবকের মোবাইল নেই', en: 'Guardian phone missing' },
  PHONE_INVALID: { bn: 'ভুল মোবাইল নম্বর', en: 'Bad phone number' },
  GUARDIAN_NAME_MISSING: { bn: 'নতুন অভিভাবকের নাম নেই', en: 'New guardian has no name' },
  RELATION_UNKNOWN: { bn: 'অজানা সম্পর্ক', en: 'Unknown relation' },
  BIRTH_REG_INVALID: {
    bn: 'জন্ম নিবন্ধন ১৭ অঙ্কের নয়',
    en: 'Birth registration is not 17 digits',
  },
  BIRTH_REG_DUPLICATE_IN_FILE: {
    bn: 'একই জন্ম নিবন্ধন দুবার',
    en: 'Same birth registration twice',
  },
  CODE_INVALID: { bn: 'ভুল আইডি', en: 'Bad student ID' },
  CODE_DUPLICATE_IN_FILE: { bn: 'একই আইডি দুবার', en: 'Same student ID twice' },
  DATE_INVALID: { bn: 'ভুল জন্ম তারিখ', en: 'Bad date of birth' },
  GENDER_UNKNOWN: { bn: 'অজানা লিঙ্গ', en: 'Unknown gender' },
  RELIGION_UNKNOWN: { bn: 'অজানা ধর্ম', en: 'Unknown religion' },
  BLOOD_GROUP_UNKNOWN: { bn: 'অজানা রক্তের গ্রুপ', en: 'Unknown blood group' },
  SECTION_FULL: { bn: 'শাখায় আসন নেই', en: 'Section is full' },
  ROW_REJECTED: {
    bn: 'এই সারি যোগ করা যায়নি; তথ্য দেখে আবার চেষ্টা করুন',
    en: 'This row could not be added; check it and try again',
  },
  GUARDIAN_PHONE_TWICE: { bn: 'দুই অভিভাবকের একই নম্বর', en: 'Both guardians have the same phone' },
};

function errorText(e: ImportRowError, locale: 'bn' | 'en'): string {
  const text = ERROR_TEXT[e.code][locale];
  if (!e.value) return text;
  // Phones are shown in the local 01… form (formula-safe and familiar).
  const value =
    e.field.toLowerCase().includes('phone') && /^\+880/.test(e.value)
      ? formatBdPhone(e.value)
      : e.value;
  return `${text}: ${value}`;
}

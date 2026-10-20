import { InjectQueue } from '@nestjs/bullmq';
import {
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@jantrik/db';
import {
  IMPORT_FIELDS,
  admissionSchema,
  detectMapping,
  findInFileDuplicates,
  formatBdPhone,
  lookalikeKeys,
  parseImportRow,
  planImportGuardian,
  toCsv,
  type ImportDuplicateOf,
  type ImportField,
  type ImportGuardian,
  type ImportLookups,
  type ImportMapping,
  type ImportPreviewPage,
  type ImportRowError,
  type ImportRowNote,
  type ImportRowResult,
  type KnownGuardian,
  type ImportStudent,
  type StudentImportSummary,
} from '@jantrik/shared';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { RequestContext } from '../common/request-context.js';
import { REDIS } from '../redis/redis.constants.js';
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
export const EXPIRE_IMPORTS_JOB = 'expire-imports';
/**
 * Institutes that may hold raw import rows (sorted set, score = last upload, ms). The daily sweep
 * visits only these, one institute per transaction: no cross-tenant query (decision #23).
 */
export const RAW_IMPORT_TENANTS_KEY = 'imports:raw-tenants';
/** Forget an institute only if it did not upload again since its score was read. */
const FORGET_IF_UNCHANGED = `if redis.call('ZSCORE', KEYS[1], ARGV[1]) == ARGV[2] then
  return redis.call('ZREM', KEYS[1], ARGV[1]) end return 0`;

type Row = Prisma.StudentImportGetPayload<object>;

/**
 * Student import: upload → mapping + validation preview → background run → report.
 * Everything here runs in the request (or job) RLS transaction for one tenant.
 */
@Injectable()
export class StudentImportService implements OnModuleInit {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
    private readonly students: StudentAdminService,
    @InjectQueue(IMPORT_QUEUE) private readonly queue: Queue<ImportJob>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** The daily sweep of raw rows past retention (one scheduler for all API instances). */
  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'expire-imports',
      { pattern: '20 0 * * *', tz: 'Asia/Dhaka' },
      { name: EXPIRE_IMPORTS_JOB, opts: { removeOnComplete: true, removeOnFail: 50 } },
    );
  }

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
    // Before the rows are stored (so they are never left out of the daily sweep), and again
    // after commit (see FORGET_IF_UNCHANGED).
    await this.redis.zadd(RAW_IMPORT_TENANTS_KEY, Date.now(), this.me.tenantId);
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
    const tenantId = this.me.tenantId;
    await this.context.afterCommit(async () => {
      await this.redis.zadd(RAW_IMPORT_TENANTS_KEY, Date.now(), tenantId);
    });
    return this.validate(row.id, mapping);
  }

  // ─────────────────────────── Retention sweep (job side) ───────────────────────────

  /** Institutes that may hold raw rows, with the score read now (see FORGET_IF_UNCHANGED). */
  async rawTenants(): Promise<{ tenantId: string; score: string }[]> {
    const flat = await this.redis.zrange(RAW_IMPORT_TENANTS_KEY, 0, -1, 'WITHSCORES');
    const out: { tenantId: string; score: string }[] = [];
    for (let i = 0; i < flat.length; i += 2) out.push({ tenantId: flat[i]!, score: flat[i + 1]! });
    return out;
  }

  async forgetRawTenant(tenantId: string, score: string): Promise<void> {
    await this.redis.eval(FORGET_IF_UNCHANGED, 1, RAW_IMPORT_TENANTS_KEY, tenantId, score);
  }

  /** In the job's tenant transaction: clear what is past retention; how many still hold rows. */
  async expireForSweep(): Promise<number> {
    await this.clearExpired();
    return this.db.tx.studentImport.count({ where: { rows: { not: Prisma.DbNull } } });
  }

  /**
   * Raw rows hold personal data: cleared for imports left unfinished for a week, and for runs
   * stuck for a day (a lost job). Runs daily per institute (the sweep job), and also on every
   * upload and listing.
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
        // Another mapping can change what the rows mean: earlier choices do not carry over.
        duplicateOverrides: [],
      },
    });
    if (count === 0) throw apiError(409, 'IMPORT_STARTED', 'This import has already started');
    return this.summary(id);
  }

  /**
   * Import a possible duplicate anyway (or not). The rows are checked again, since an imported
   * duplicate's new guardians change what the rows after it link to. Audited.
   */
  async setDuplicateOverride(
    id: string,
    row: number,
    include: boolean,
  ): Promise<StudentImportSummary> {
    const tx = this.db.tx;
    await tx.$queryRaw`SELECT id FROM student_imports WHERE id = ${id}::uuid FOR UPDATE`;
    const imp = await this.load(id);
    if (imp.status !== 'VALIDATED') {
      throw apiError(409, 'IMPORT_STARTED', 'This import has already started');
    }
    const results = (imp.results as ImportRowResult[] | null) ?? [];
    if (results.find((r) => r.row === row)?.status !== 'DUPLICATE') {
      throw apiError(422, 'NOT_A_DUPLICATE', 'This row is not a possible duplicate');
    }
    const overrides = new Set(imp.duplicateOverrides);
    if (include) overrides.add(row);
    else overrides.delete(row);
    const fresh = await this.check(
      (imp.rows as string[][] | null) ?? [],
      (imp.mapping as ImportMapping | null) ?? {},
      overrides,
    );
    const status = new Map(fresh.map((r) => [r.row, r.status]));
    if (include && status.get(row) !== 'DUPLICATE') {
      // E.g. its section is full: nothing is saved, the row stays a skipped duplicate.
      throw apiError(422, 'NOT_IMPORTABLE', 'This row cannot be imported', {
        errors: fresh.find((r) => r.row === row)?.errors ?? [],
      });
    }
    const kept = [...overrides].filter((n) => status.get(n) === 'DUPLICATE').sort((a, b) => a - b);
    await tx.studentImport.update({
      where: { id },
      data: { duplicateOverrides: kept, results: fresh as unknown as Prisma.InputJsonValue },
    });
    await this.audit.record({
      entity: 'student_import',
      entityId: id,
      action: 'UPDATE',
      newValues: { duplicateRow: row, importAnyway: kept.includes(row) },
    });
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

  /**
   * Per row: parse, in-file duplicates, then what is already in the database. `overrides`: the
   * possible duplicates the admin imports anyway (their new guardians count for later rows).
   */
  private async check(
    rows: string[][],
    mapping: ImportMapping,
    overrides: ReadonlySet<number> = new Set(),
  ): Promise<ImportRowResult[]> {
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
    const phones = [...new Set(students.flatMap((s) => s.guardians.map((g) => g.phone)))];
    // Guardians with the file's phones (oldest first); rows add the ones they will create.
    const known: KnownGuardian[] = await tx.guardian.findMany({
      where: { phone: { in: phones } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, phone: true, nameBn: true, nameEn: true },
    });
    // Possible duplicates (#22): active students of this year sharing a guardian phone with the
    // file, keyed by class + name + phone; rows of the file are added as they are checked.
    const lookalikes = new Map<string, ImportDuplicateOf>();
    const lookalikeStudents = await tx.student.findMany({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        enrolments: { some: { academicYearId: lookups.yearId } },
        guardians: { some: { guardian: { phone: { in: phones } } } },
      },
      select: {
        studentCode: true,
        nameBn: true,
        nameEn: true,
        enrolments: { where: { academicYearId: lookups.yearId }, select: { classLevelId: true } },
        guardians: { select: { guardian: { select: { phone: true } } } },
      },
    });
    for (const st of lookalikeStudents) {
      for (const e of st.enrolments) {
        const keys = lookalikeKeys({
          nameBn: st.nameBn,
          nameEn: st.nameEn,
          classLevelId: e.classLevelId,
          phones: st.guardians.map((g) => g.guardian.phone),
        });
        for (const k of keys) {
          if (!lookalikes.has(k)) {
            lookalikes.set(k, { studentCode: st.studentCode, name: st.nameBn ?? st.nameEn });
          }
        }
      }
    }
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
      const notes: ImportRowNote[] = [];
      const created: KnownGuardian[] = [];
      s.guardians.forEach((g, gi) => {
        const plan = planImportGuardian(g, s, known);
        if (plan.kind === 'ambiguous') {
          errors.push({ code: 'GUARDIAN_NAME_NEEDED', field: guardianNameField(gi) });
          return;
        }
        if (plan.note) notes.push({ code: plan.note, guardian: gi === 0 ? 1 : 2 });
        if (plan.kind === 'new') {
          created.push({ id: null, phone: g.phone, nameBn: plan.nameBn, nameEn: plan.nameEn });
        }
      });
      if (s.sectionId && s.roll !== null && takenRolls.has(`${s.sectionId}:${s.roll}`)) {
        errors.push({ code: 'ROLL_TAKEN', field: 'roll', value: String(s.roll) });
      }
      if (errors.length > 0) return { row, status: 'ERROR', errors, ...(name ? { name } : {}) };
      const keys = lookalikeKeys({
        nameBn: s.nameBn,
        nameEn: s.nameEn,
        classLevelId: s.classLevelId,
        phones: s.guardians.map((g) => g.phone),
      });
      const duplicateOf = keys.map((k) => lookalikes.get(k)).find(Boolean);
      // A possible duplicate is skipped (takes no seat, adds no guardian) unless imported anyway.
      const importing = !duplicateOf || overrides.has(row);
      if (importing && s.sectionId) {
        const c = capacity.get(s.sectionId);
        if (c) {
          if (c.free <= 0) {
            return {
              row,
              status: 'ERROR',
              errors: [{ code: 'SECTION_FULL', field: 'section' }],
              ...(name ? { name } : {}),
            };
          }
          c.free--;
        }
      }
      for (const k of keys) if (!lookalikes.has(k)) lookalikes.set(k, { row });
      if (importing) known.push(...created); // later rows link to the guardians this one adds
      return {
        row,
        status: duplicateOf ? 'DUPLICATE' : 'OK',
        errors: [],
        ...(name ? { name } : {}),
        ...(notes.length > 0 ? { notes } : {}),
        ...(duplicateOf ? { duplicateOf } : {}),
      };
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
    filter: 'all' | 'ok' | 'error' | 'exists' | 'duplicate',
    page: number,
  ): Promise<ImportPreviewPage> {
    const imp = await this.load(id);
    const results = (imp.results as ImportRowResult[] | null) ?? [];
    const cells = (imp.rows as string[][] | null) ?? [];
    const mapping = (imp.mapping as ImportMapping | null) ?? {};
    const overrides = new Set(imp.duplicateOverrides);
    const skipped = (r: ImportRowResult) => r.status === 'SKIPPED';
    const wanted = results.filter((r) =>
      filter === 'all'
        ? true
        : filter === 'ok'
          ? r.status === 'OK' || r.status === 'IMPORTED'
          : filter === 'error'
            ? r.status === 'ERROR'
            : filter === 'duplicate'
              ? r.status === 'DUPLICATE' || (skipped(r) && Boolean(r.duplicateOf))
              : r.status === 'EXISTS' || (skipped(r) && !r.duplicateOf),
    );
    const slice = wanted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    return {
      total: wanted.length,
      rows: slice.map((r) => ({
        ...r,
        ...(r.status === 'DUPLICATE' ? { importAnyway: overrides.has(r.row) } : {}),
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
    const overrides = new Set(imp.duplicateOverrides);
    if (
      !results.some((r) => r.status === 'OK' || (r.status === 'DUPLICATE' && overrides.has(r.row)))
    )
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
    const overrides = new Set(imp.duplicateOverrides);
    for (let i = from; i < Math.min(to, rows.length); i++) {
      const found = results[i];
      const importAnyway = found?.status === 'DUPLICATE' && overrides.has(found.row);
      if (!found || (found.status !== 'OK' && !importAnyway)) {
        if (found && found.status === 'EXISTS') results[i] = { ...found, status: 'SKIPPED' };
        if (found && found.status === 'DUPLICATE') {
          const { notes: _unused, ...rest } = found; // not imported: no guardian notes
          results[i] = { ...rest, status: 'SKIPPED' };
        }
        continue;
      }
      // The preview's notes say what will happen; a row that is not imported keeps none.
      const { notes: previewNotes, ...r } = found;
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
      // The guardians, decided again on what is in the database now (earlier rows included).
      const known = await tx.guardian.findMany({
        where: { phone: { in: s.guardians.map((g) => g.phone) } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, phone: true, nameBn: true, nameEn: true },
      });
      const notes: ImportRowNote[] = [];
      const guardians: AdmissionGuardian[] = [];
      let ambiguous: ImportRowError | null = null;
      for (const [gi, g] of s.guardians.entries()) {
        const plan = planImportGuardian(g, s, known);
        if (plan.kind === 'ambiguous') {
          ambiguous = { code: 'GUARDIAN_NAME_NEEDED', field: guardianNameField(gi) };
          break;
        }
        // Never link (or add) differently from what the admin saw in the preview.
        const shown = previewNotes?.find((n) => n.guardian === gi + 1)?.code ?? null;
        if ((plan.note ?? null) !== shown) {
          ambiguous = { code: 'GUARDIAN_CHANGED', field: guardianNameField(gi) };
          break;
        }
        if (plan.note) notes.push({ code: plan.note, guardian: gi === 0 ? 1 : 2 });
        guardians.push(
          plan.kind === 'link'
            ? { ...g, guardianId: plan.guardian.id, createNew: false }
            : { ...g, nameBn: plan.nameBn, nameEn: plan.nameEn, guardianId: null, createNew: true },
        );
      }
      if (ambiguous) {
        results[i] = { ...r, status: 'ERROR', errors: [ambiguous] };
        continue;
      }
      // Through the same schema as a form admission: no limit can be skipped.
      const checked = admissionSchema.safeParse(toAdmission(s, lookups.yearId, guardians));
      if (!checked.success) {
        results[i] = { ...r, status: 'ERROR', errors: [{ code: 'ROW_REJECTED', field: 'nameBn' }] };
        continue;
      }
      await tx.$executeRawUnsafe('SAVEPOINT import_row');
      try {
        const profile = await this.students.admit(checked.data);
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT import_row');
        results[i] = {
          ...r,
          status: 'IMPORTED',
          studentCode: profile.studentCode,
          ...(notes.length > 0 ? { notes } : {}),
        };
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
        ? ['সারি', 'ফলাফল', 'শিক্ষার্থী আইডি', 'নাম', 'সমস্যা', 'মন্তব্য']
        : ['Row', 'Result', 'Student ID', 'Name', 'Problems', 'Notes'];
    const lines = results.map((r) => [
      r.row,
      r.status === 'SKIPPED' && r.duplicateOf
        ? SKIPPED_DUPLICATE_TEXT[locale]
        : STATUS_TEXT[locale][r.status],
      r.studentCode ?? '',
      r.name ?? '',
      r.errors.map((e) => errorText(e, locale)).join('; '),
      [
        ...(r.duplicateOf ? [duplicateText(r.duplicateOf, locale)] : []),
        ...(r.notes ?? []).map((n) => noteText(n, locale)),
      ].join('; '),
    ]);
    const stamp = imp.createdAt.toISOString().slice(0, 10);
    return { filename: `student-import-${stamp}.csv`, csv: toCsv([head, ...lines]) };
  }
}

function toSummary(r: Row): StudentImportSummary {
  const results = (r.results as ImportRowResult[] | null) ?? [];
  const count = (s: ImportRowResult['status']) => results.filter((x) => x.status === s).length;
  const overrides = new Set(r.duplicateOverrides);
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
      duplicate: count('DUPLICATE'),
      duplicateImport: results.filter((x) => x.status === 'DUPLICATE' && overrides.has(x.row))
        .length,
      imported: count('IMPORTED'),
      skipped: count('SKIPPED'),
    },
    processed: r.processed,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    failure: r.failure,
  };
}

type AdmissionGuardian = ImportGuardian & { guardianId: string | null; createNew: boolean };

const guardianNameField = (gi: number): ImportField =>
  gi === 0 ? 'guardianNameBn' : 'guardian2NameBn';

function toAdmission(s: ImportStudent, academicYearId: string, guardians: AdmissionGuardian[]) {
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
    guardians,
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
      STUDENT_LIMIT: { code: 'STUDENT_LIMIT', field: 'nameBn' },
      GUARDIAN_NAME_REQUIRED: { code: 'GUARDIAN_NAME_MISSING', field: 'guardianNameBn' },
      GUARDIAN_CHOICE_REQUIRED: { code: 'GUARDIAN_NAME_NEEDED', field: 'guardianNameBn' },
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
    DUPLICATE: 'সম্ভাব্য ডুপ্লিকেট',
    IMPORTED: 'যোগ হয়েছে',
    SKIPPED: 'বাদ (আগে থেকেই আছে)',
  },
  en: {
    OK: 'OK',
    ERROR: 'Error',
    EXISTS: 'Already exists',
    DUPLICATE: 'Possible duplicate',
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
  STUDENT_LIMIT: {
    bn: 'প্রতিষ্ঠানের ছাত্র-ছাত্রীর সীমা পূর্ণ; জান্ত্রিকের সাথে যোগাযোগ করুন',
    en: 'The institute has reached its student limit; contact Jantrik',
  },
  ROW_REJECTED: {
    bn: 'এই সারি যোগ করা যায়নি; তথ্য দেখে আবার চেষ্টা করুন',
    en: 'This row could not be added; check it and try again',
  },
  GUARDIAN_PHONE_TWICE: { bn: 'দুই অভিভাবকের একই নম্বর', en: 'Both guardians have the same phone' },
  GUARDIAN_NAME_NEEDED: {
    bn: 'এই নম্বরে একাধিক অভিভাবক আছেন; কোন জন, তা বোঝাতে অভিভাবকের নাম দিন',
    en: 'Several guardians have this phone; add the guardian name to pick one',
  },
  GUARDIAN_CHANGED: {
    bn: 'যাচাইয়ের পরে এই নম্বরের অভিভাবক বদলেছে; ফাইলটি আবার যাচাই করে যোগ করুন',
    en: 'The guardians on this phone changed after the check; check the file again',
  },
};

const NOTE_TEXT: Record<ImportRowNote['code'], { bn: string; en: string }> = {
  GUARDIAN_LINKED: { bn: 'আগের অভিভাবকের সাথে যুক্ত', en: 'linked to an existing guardian' },
  GUARDIAN_LINKED_BY_PHONE_ONLY: {
    bn: 'নাম ছাড়া শুধু নম্বর মিলিয়ে আগের অভিভাবকের সাথে যুক্ত; দেখে নিন',
    en: 'no name in the list; linked by phone only, please check',
  },
  GUARDIAN_NEW_SAME_PHONE: {
    bn: 'নাম মেলেনি; এই নম্বরে নতুন অভিভাবক যোগ হয়েছে',
    en: 'name did not match; added as a new guardian with this phone',
  },
  GUARDIAN_NAME_GENERATED: {
    bn: 'নাম ছিল না; শিক্ষার্থীর নামে নাম দেওয়া হয়েছে, পরে বদলানো যাবে',
    en: 'no name; named after the student, rename later',
  },
};

const SKIPPED_DUPLICATE_TEXT = {
  bn: 'বাদ (সম্ভাব্য ডুপ্লিকেট)',
  en: 'Skipped (possible duplicate)',
};

function duplicateText(d: ImportDuplicateOf, locale: 'bn' | 'en'): string {
  if ('row' in d) {
    return locale === 'bn'
      ? `ফাইলের ${d.row} নম্বর সারির মতো একই নাম, শ্রেণি ও অভিভাবকের নম্বর`
      : `Same name, class and guardian phone as row ${d.row}`;
  }
  const who = d.name ? `${d.studentCode} (${d.name})` : d.studentCode;
  return locale === 'bn'
    ? `${who}-এর মতো একই নাম, শ্রেণি ও অভিভাবকের নম্বর`
    : `Same name, class and guardian phone as ${who}`;
}

function noteText(n: ImportRowNote, locale: 'bn' | 'en'): string {
  const who =
    locale === 'bn' ? `অভিভাবক ${n.guardian === 1 ? '১' : '২'}` : `Guardian ${n.guardian}`;
  return `${who}: ${NOTE_TEXT[n.code][locale]}`;
}

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

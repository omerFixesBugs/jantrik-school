import { Injectable } from '@nestjs/common';
import {
  DEFAULT_CODE_PATTERN,
  defaultCodePrefix,
  renderStudentCode,
  type StudentSettings,
} from '@jantrik/shared';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { RequestContext } from '../common/request-context.js';
import { Db } from '../tenancy/db.service.js';

/**
 * How many already-taken codes we skip before giving up (imported/seeded codes can collide).
 * Kept small: each try holds the counter row lock, blocking other admissions.
 */
const MAX_SKIPS = 200;

/**
 * student_code generation: the tenant's pattern (default {PREFIX}-{YEAR}-{NNNN}) with a per-year
 * counter in student_code_counters. The counter row is upserted with ON CONFLICT … RETURNING, so
 * concurrent admissions queue on its row lock and never get the same number.
 */
@Injectable()
export class StudentCodesService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
  ) {}

  async settings(): Promise<{ codePrefix: string; codePattern: string }> {
    const tx = this.db.tx;
    const row = await tx.studentSettings.findFirst();
    if (row) return { codePrefix: row.codePrefix, codePattern: row.codePattern };
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: this.context.requirePrincipal().tenantId! },
      select: { slug: true },
    });
    return { codePrefix: defaultCodePrefix(tenant.slug), codePattern: DEFAULT_CODE_PATTERN };
  }

  async get(): Promise<StudentSettings> {
    const s = await this.settings();
    const year = await this.currentYearNumber();
    const counter = await this.db.tx.studentCodeCounter.findFirst({ where: { year } });
    return {
      ...s,
      example: renderStudentCode(s.codePattern, {
        prefix: s.codePrefix,
        year,
        seq: counter?.nextValue ?? 1,
      }),
    };
  }

  async update(input: { codePrefix: string; codePattern: string }): Promise<StudentSettings> {
    const tx = this.db.tx;
    const tenantId = this.context.requirePrincipal().tenantId!;
    const before = await this.settings();
    await tx.studentSettings.upsert({
      where: { tenantId },
      create: { tenantId, ...input },
      update: input,
    });
    await this.audit.record({
      entity: 'student_settings',
      entityId: tenantId,
      action: 'UPDATE',
      oldValues: before,
      newValues: input,
    });
    return this.get();
  }

  /** The next free code for an enrolment in `year` (calendar year the academic year starts). */
  async next(year: number): Promise<string> {
    const tx = this.db.tx;
    const s = await this.settings();
    for (let i = 0; i < MAX_SKIPS; i++) {
      const [row] = await tx.$queryRaw<{ seq: number }[]>`
        INSERT INTO student_code_counters (id, tenant_id, year, next_value, updated_at)
        VALUES (gen_random_uuid(), app_current_tenant_id(), ${year}, 2, now())
        ON CONFLICT (tenant_id, year)
          DO UPDATE SET next_value = student_code_counters.next_value + 1, updated_at = now()
        RETURNING next_value - 1 AS seq`;
      const code = renderStudentCode(s.codePattern, {
        prefix: s.codePrefix,
        year,
        seq: row!.seq,
      });
      const taken = await tx.student.findFirst({
        where: { studentCode: code },
        select: { id: true },
      });
      if (!taken) return code;
    }
    throw apiError(409, 'CODE_EXHAUSTED', 'No free student code: change the pattern');
  }

  private async currentYearNumber(): Promise<number> {
    const year = await this.db.tx.academicYear.findFirst({
      where: { isCurrent: true },
      select: { startDate: true },
    });
    return (year?.startDate ?? new Date()).getUTCFullYear();
  }
}

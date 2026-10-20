import { v7 as uuidv7 } from 'uuid';
import {
  ModuleKey,
  type Locale,
  type PrismaClient,
  type Tenant,
  type TenantStatus,
} from '../generated/prisma/client.js';
import { withTenant, type TenantTx } from './context.js';

export interface ProvisionTenantInput {
  /** The new tenant's id (generated when omitted). */
  id?: string;
  slug: string;
  name: string;
  /** `institute_types.key`, e.g. COACHING, NCTB_SCHOOL_BN. */
  instituteTypeKey: string;
  /** CORE is always enabled. */
  modules?: ModuleKey[];
  status?: TenantStatus;
  timezone?: string;
  /** Defaults to the institute type's default locale. */
  defaultLocale?: Locale;
  mainBranchName?: string;
  /** Creates the first academic year and marks it current. */
  academicYear?: { name: string; startDate: Date; endDate: Date };
}

/**
 * Create a tenant and COPY its institute type's template into it: labels, default grading
 * scheme + bands, study groups, class levels and subjects, plus attendance settings with the
 * type's default mode (absent SMS starts off: it costs the institute money). The copies are ordinary tenant rows
 * (with `source_template_id` for traceability), so each institute can customise them freely.
 *
 * Runs as the app role inside the new tenant's RLS context, in a single transaction.
 * `inTransaction` runs last in that same transaction (e.g. the owner invitation and the audit
 * entry of a platform-created institute), so either everything exists or nothing does.
 */
export async function provisionTenant(
  prisma: PrismaClient,
  input: ProvisionTenantInput,
  inTransaction?: (tx: TenantTx, tenant: Tenant) => Promise<void>,
): Promise<Tenant> {
  const type = await prisma.instituteType.findUnique({
    where: { key: input.instituteTypeKey },
    include: {
      labels: true,
      studyGroups: true,
      classLevels: { include: { subjects: true } },
      defaultGradingSchemeTemplate: { include: { bands: true } },
    },
  });
  if (!type || !type.isActive) {
    throw new Error(`Unknown or inactive institute type: ${input.instituteTypeKey}`);
  }

  const tenantId = input.id ?? uuidv7();
  const now = new Date();
  const modules = [...new Set<ModuleKey>(['CORE', ...(input.modules ?? [])])];

  return withTenant(
    prisma,
    tenantId,
    async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          id: tenantId,
          slug: input.slug,
          name: input.name,
          instituteTypeId: type.id,
          status: input.status ?? 'TRIAL',
          timezone: input.timezone ?? 'Asia/Dhaka',
          defaultLocale: input.defaultLocale ?? type.defaultLocale,
        },
      });

      await tx.branch.create({
        data: { tenantId, name: input.mainBranchName ?? input.name, isMain: true },
      });

      // A row for every module, the ones not chosen switched off: the institute's own role may
      // insert module rows only now (no module rows yet), so none can be added later.
      await tx.tenantModule.createMany({
        data: Object.values(ModuleKey).map((moduleKey) => {
          const enabled = modules.includes(moduleKey);
          return { tenantId, moduleKey, enabled, enabledAt: enabled ? now : null };
        }),
      });

      await tx.tenantLabel.createMany({
        data: type.labels.map((l) => ({
          tenantId,
          key: l.key,
          valueBn: l.valueBn,
          valueEn: l.valueEn,
        })),
      });

      const schemeTemplate = type.defaultGradingSchemeTemplate;
      if (schemeTemplate) {
        const schemeId = uuidv7();
        await tx.gradingScheme.create({
          data: {
            id: schemeId,
            tenantId,
            nameBn: schemeTemplate.nameBn,
            nameEn: schemeTemplate.nameEn,
            roundingMode: schemeTemplate.roundingMode,
            isDefault: true,
            sourceTemplateId: schemeTemplate.id,
          },
        });
        await tx.gradeBand.createMany({
          data: schemeTemplate.bands.map((b) => ({
            tenantId,
            gradingSchemeId: schemeId,
            minPercent: b.minPercent,
            maxPercent: b.maxPercent,
            letter: b.letter,
            gradePoint: b.gradePoint,
          })),
        });
      }

      // Template id → new tenant id, so subjects can point at the copied rows.
      const studyGroupIds = new Map(type.studyGroups.map((g) => [g.id, uuidv7()]));
      await tx.studyGroup.createMany({
        data: type.studyGroups.map((g) => ({
          id: studyGroupIds.get(g.id)!,
          tenantId,
          code: g.code,
          nameBn: g.nameBn,
          nameEn: g.nameEn,
          sortOrder: g.sortOrder,
          sourceTemplateId: g.id,
        })),
      });

      const classLevelIds = new Map(type.classLevels.map((c) => [c.id, uuidv7()]));
      await tx.classLevel.createMany({
        data: type.classLevels.map((c) => ({
          id: classLevelIds.get(c.id)!,
          tenantId,
          code: c.code,
          nameBn: c.nameBn,
          nameEn: c.nameEn,
          sortOrder: c.sortOrder,
          sourceTemplateId: c.id,
        })),
      });

      await tx.subject.createMany({
        data: type.classLevels.flatMap((c) =>
          c.subjects.map((s) => ({
            tenantId,
            classLevelId: classLevelIds.get(c.id)!,
            studyGroupId: s.templateStudyGroupId
              ? (studyGroupIds.get(s.templateStudyGroupId) ?? null)
              : null,
            code: s.code,
            nameBn: s.nameBn,
            nameEn: s.nameEn,
            isOptional: s.isOptional,
            sortOrder: s.sortOrder,
            sourceTemplateId: s.id,
          })),
        ),
      });

      await tx.attendanceSettings.create({
        data: { tenantId, mode: type.attendanceMode, absentSmsEnabled: false },
      });

      if (input.academicYear) {
        await tx.academicYear.create({
          data: { tenantId, ...input.academicYear, isCurrent: true },
        });
      }

      if (inTransaction) await inTransaction(tx, tenant);
      return tenant;
    },
    { timeout: 30_000 },
  );
}

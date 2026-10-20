import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantClient, withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant } from './helpers.js';

describe('provisionTenant copies the institute type template', () => {
  let app: PrismaClient;

  beforeAll(() => {
    app = appClient();
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  it('copies labels, grading scheme, study groups, class levels and subjects', async () => {
    const type = await app.instituteType.findUniqueOrThrow({
      where: { key: 'NCTB_SCHOOL_BN' },
      include: {
        labels: true,
        studyGroups: true,
        classLevels: { include: { subjects: true } },
        defaultGradingSchemeTemplate: { include: { bands: true } },
      },
    });
    const tenant = await createTenant(app, { modules: ['EXAMS'] });
    const db = tenantClient(app, tenant.id);

    expect(tenant.defaultLocale).toBe('bn');
    expect(await db.tenantLabel.count()).toBe(type.labels.length);
    expect(await db.studyGroup.count()).toBe(type.studyGroups.length);
    expect(await db.classLevel.count()).toBe(type.classLevels.length);
    expect(await db.subject.count()).toBe(
      type.classLevels.reduce((n, c) => n + c.subjects.length, 0),
    );

    const scheme = await db.gradingScheme.findFirstOrThrow({
      where: { isDefault: true },
      include: { bands: true },
    });
    expect(scheme.sourceTemplateId).toBe(type.defaultGradingSchemeTemplateId);
    expect(scheme.roundingMode).toBe('NONE');
    expect(scheme.bands).toHaveLength(7);

    const modules = await db.tenantModule.findMany();
    // Every module has a row (so none can be inserted later); only the chosen ones are on.
    expect(modules.map((m) => m.moduleKey).sort()).toEqual(['ATTENDANCE', 'CORE', 'EXAMS', 'FEES']);
    expect(
      modules
        .filter((m) => m.enabled)
        .map((m) => m.moduleKey)
        .sort(),
    ).toEqual(['CORE', 'EXAMS']);
    expect(await db.branch.count({ where: { isMain: true } })).toBe(1);
    expect(await db.academicYear.count({ where: { isCurrent: true } })).toBe(1);

    // Subjects point at the tenant's own study group copies, not at template rows.
    const physics = await db.subject.findFirstOrThrow({
      where: { code: 'PHY', classLevel: { code: 'CLASS_9' } },
      include: { studyGroup: true },
    });
    expect(physics.studyGroup).toMatchObject({ code: 'SCIENCE', tenantId: tenant.id });
  });

  it('uses labels and locale from the type data', async () => {
    const coaching = await createTenant(app, { instituteTypeKey: 'COACHING' });
    const englishVersion = await createTenant(app, { instituteTypeKey: 'NCTB_SCHOOL_EN' });

    const label = await tenantClient(app, coaching.id).tenantLabel.findFirstOrThrow({
      where: { key: 'section' },
    });
    expect(label).toMatchObject({ valueEn: 'Batch', valueBn: 'ব্যাচ' });
    expect(await tenantClient(app, coaching.id).studyGroup.count()).toBe(0);
    expect(englishVersion.defaultLocale).toBe('en');
  });

  it("edits to one tenant's copy do not leak to other tenants or the template", async () => {
    const p = await createTenant(app);
    const q = await createTenant(app);

    await withTenant(app, p.id, async (tx) => {
      const scheme = await tx.gradingScheme.findFirstOrThrow({ where: { isDefault: true } });
      await tx.gradingScheme.update({
        where: { id: scheme.id },
        data: { roundingMode: 'ROUND_HALF_UP' },
      });
      await tx.gradeBand.updateMany({ where: { letter: 'A+' }, data: { minPercent: 85 } });
      await tx.tenantLabel.updateMany({ where: { key: 'section' }, data: { valueEn: 'Division' } });
      await tx.classLevel.updateMany({ where: { code: 'CLASS_6' }, data: { nameEn: 'Grade Six' } });
      await tx.subject.deleteMany({ where: { code: 'ICT' } });
    });

    const dbQ = tenantClient(app, q.id);
    expect(
      (await dbQ.gradingScheme.findFirstOrThrow({ where: { isDefault: true } })).roundingMode,
    ).toBe('NONE');
    expect(
      (await dbQ.gradeBand.findFirstOrThrow({ where: { letter: 'A+' } })).minPercent.toNumber(),
    ).toBe(80);
    expect((await dbQ.tenantLabel.findFirstOrThrow({ where: { key: 'section' } })).valueEn).toBe(
      'Section',
    );
    expect((await dbQ.classLevel.findFirstOrThrow({ where: { code: 'CLASS_6' } })).nameEn).toBe(
      'Class 6',
    );
    expect(await dbQ.subject.count({ where: { code: 'ICT' } })).toBeGreaterThan(0);

    // Global template untouched.
    const template = await app.gradeBandTemplate.findFirstOrThrow({
      where: { letter: 'A+', gradingSchemeTemplate: { key: 'BD_GPA_5' } },
    });
    expect(template.minPercent.toNumber()).toBe(80);
    const label = await app.templateLabel.findFirstOrThrow({
      where: { key: 'section', instituteType: { key: 'NCTB_SCHOOL_BN' } },
    });
    expect(label.valueEn).toBe('Section');
  });

  it('rejects an unknown institute type', async () => {
    await expect(createTenant(app, { instituteTypeKey: 'NOPE' })).rejects.toThrow(
      /Unknown or inactive institute type/,
    );
  });

  it('rejects a duplicate slug', async () => {
    const t = await createTenant(app);
    await expect(createTenant(app, { slug: t.slug })).rejects.toMatchObject({ code: 'P2002' });
  });
});

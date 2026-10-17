import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { searchStudentIds, withContext, withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant, ownerClient } from './helpers.js';

/**
 * Trigram search. Plain ILIKE under RLS cannot use an index (ILIKE is not LEAKPROOF), so the
 * search runs in search_student_ids(), owned by jantrik_search. See the migration
 * `student_search_function` and docs/database.md.
 *
 * Whether the planner *chooses* a trigram index depends on data volume; these tests check that
 * it *can* (sequential scans disabled, so only an index could serve the ILIKE).
 */
describe('student search (trigram indexes + search_student_ids)', () => {
  let app: PrismaClient;
  let owner: PrismaClient;
  let tenantId: string;
  let otherTenantId: string;

  beforeAll(async () => {
    app = appClient();
    owner = ownerClient();
    tenantId = (await createTenant(app)).id;
    otherTenantId = (await createTenant(app)).id;
    await withTenant(app, tenantId, (tx) =>
      tx.student.createMany({
        data: Array.from({ length: 50 }, (_, i) => ({
          tenantId,
          studentCode: `IDX-${String(i).padStart(5, '0')}`,
          nameEn: `Student ${i.toString(36)} ${(i * 7919).toString(36)}`,
          nameBn: `শিক্ষার্থী ${i}`,
        })),
      }),
    );
  });

  afterAll(async () => {
    await Promise.all([app.$disconnect(), owner.$disconnect()]);
  });

  async function planAsSearchRole(sql: string): Promise<string> {
    return withContext(owner, { tenantId }, async (tx) => {
      // The owner may SET ROLE to jantrik_search (granted WITH SET TRUE).
      await tx.$executeRawUnsafe('SET LOCAL ROLE jantrik_search');
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const rows = await tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(`EXPLAIN ${sql}`);
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
  }

  it.each([
    ['students', 'name_bn', 'জিজিজি', 'students_name_bn_trgm_idx'],
    ['students', 'name_en', 'zqzqzq', 'students_name_en_trgm_idx'],
    ['students', 'student_code', 'IDX-0999', 'students_student_code_trgm_idx'],
    ['guardians', 'phone', '9876543', 'guardians_phone_trgm_idx'],
  ])(
    'jantrik_search can use an index for %s.%s ILIKE (%s → %s)',
    async (table, column, term, index) => {
      const plan = await planAsSearchRole(
        `SELECT id FROM ${table} WHERE ${column} ILIKE '%${term}%'`,
      );
      expect(plan).toContain(index);
    },
  );

  it('documents the limitation: under tenant RLS, ILIKE can never use a trigram index', async () => {
    const plan = await withTenant(app, tenantId, async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const rows = await tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
        `EXPLAIN SELECT id FROM students WHERE name_en ILIKE '%zqzqzq%'`,
      );
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    expect(plan).not.toContain('trgm_idx');
    expect(plan).toMatch(/Filter: \(name_en ~~\* /);
  });

  it('finds by name, code and guardian phone, within the current tenant only', async () => {
    const ids = await withTenant(app, tenantId, async (tx) => {
      const [student] = await tx.student.findMany({ where: { studentCode: 'IDX-00042' } });
      const guardian = await tx.guardian.create({
        data: { tenantId, nameEn: 'Phone Parent', phone: '+8801755512345' },
      });
      await tx.studentGuardian.create({
        data: { tenantId, studentId: student!.id, guardianId: guardian.id, relation: 'FATHER' },
      });
      return {
        target: student!.id,
        byCode: await searchStudentIds(tx, { term: 'idx-00042' }),
        byName: await searchStudentIds(tx, { term: student!.nameEn!.split(' ')[1]! }),
        byPhone: await searchStudentIds(tx, { term: '01755512345', phone: '01755512345' }),
      };
    });
    expect(ids.byCode).toEqual([ids.target]);
    expect(ids.byName).toContain(ids.target);
    expect(ids.byPhone).toEqual([ids.target]);

    // Same search from another tenant, or without context: nothing.
    expect(
      await withTenant(app, otherTenantId, (tx) => searchStudentIds(tx, { term: 'IDX-00042' })),
    ).toEqual([]);
    expect(await searchStudentIds(app, { term: 'IDX-00042' })).toEqual([]);
  });

  it('treats % and _ in the search term literally', async () => {
    const all = await withTenant(app, tenantId, (tx) => searchStudentIds(tx, { term: '%' }));
    expect(all).toEqual([]);
    const underscore = await withTenant(app, tenantId, (tx) =>
      searchStudentIds(tx, { term: 'IDX_0' }),
    );
    expect(underscore).toEqual([]);
  });

  it('tenant comes only from app.tenant_id: the same call follows the context, nothing without it', async () => {
    // Give the other tenant a student with the same code.
    await withTenant(app, otherTenantId, (tx) =>
      tx.student.create({
        data: { tenantId: otherTenantId, studentCode: 'IDX-00001', nameEn: 'Other' },
      }),
    );
    const mine = await withTenant(app, tenantId, async (tx) => ({
      ids: await searchStudentIds(tx, { term: 'IDX-00001' }),
      own: (await tx.student.findMany({ where: { studentCode: 'IDX-00001' } })).map((s) => s.id),
    }));
    const theirs = await withTenant(app, otherTenantId, async (tx) => ({
      ids: await searchStudentIds(tx, { term: 'IDX-00001' }),
      own: (await tx.student.findMany({ where: { studentCode: 'IDX-00001' } })).map((s) => s.id),
    }));
    expect(mine.ids).toEqual(mine.own);
    expect(theirs.ids).toEqual(theirs.own);
    expect(mine.ids).not.toEqual(theirs.ids);

    // No tenant context (fresh connection, and a user-only context): nothing.
    expect(await searchStudentIds(app, { term: 'IDX-00001' })).toEqual([]);
    const userOnly = await withContext(app, { userId: crypto.randomUUID() }, (tx) =>
      searchStudentIds(tx, { term: 'IDX-00001' }),
    );
    expect(userOnly).toEqual([]);
  });

  it('excludes soft-deleted students', async () => {
    await withTenant(app, tenantId, async (tx) => {
      await tx.student.updateMany({
        where: { studentCode: 'IDX-00007' },
        data: { deletedAt: new Date() },
      });
      expect(await searchStudentIds(tx, { term: 'IDX-00007' })).toEqual([]);
    });
  });

  it('only jantrik_app may execute it; the owner cannot inherit or call it, the app cannot assume the role', async () => {
    const [fn] = await app.$queryRaw<
      { owner: string; definer: boolean; public_exec: boolean; owner_exec: boolean }[]
    >`
      SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer,
             EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                     WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_exec,
             has_function_privilege('jantrik_owner', p.oid, 'EXECUTE') AS owner_exec
      FROM pg_proc p WHERE p.proname = 'search_student_ids'`;
    expect(fn).toEqual({
      owner: 'jantrik_search',
      definer: true,
      public_exec: false,
      owner_exec: false,
    });

    const [grant] = await app.$queryRaw<{ inherit: boolean }[]>`
      SELECT inherit_option AS inherit FROM pg_auth_members
      WHERE roleid = 'jantrik_search'::regrole AND member = 'jantrik_owner'::regrole`;
    expect(grant).toEqual({ inherit: false });

    await expect(
      withTenant(app, tenantId, (tx) => tx.$executeRawUnsafe('SET LOCAL ROLE jantrik_search')),
    ).rejects.toThrow(/permission denied/i);
  });
});

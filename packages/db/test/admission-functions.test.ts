import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withContext, withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant, platformClient, ingestClient } from './helpers.js';

// Sprint 1 P3b: the three public admission functions, run by jantrik_app with no request context
// (as the API's public routes do), and the role that owns them (review focus 3 and 4).

const NOW = new Date('2026-11-20T06:00:00Z');

interface School {
  tenantId: string;
  slug: string;
  cycleId: string;
  class6: string;
  class7Closed: string;
}

async function school(app: PrismaClient, opts: { status?: 'ACTIVE' | 'SUSPENDED' } = {}) {
  const t = await createTenant(app, opts.status ? { status: opts.status } : {});
  const ids = await withTenant(app, t.id, async (tx) => {
    const year = await tx.academicYear.create({
      data: {
        tenantId: t.id,
        name: '2027',
        startDate: new Date('2027-01-01'),
        endDate: new Date('2027-12-31'),
      },
    });
    const c6 = await tx.classLevel.findFirstOrThrow({ where: { code: 'CLASS_6' } });
    const c7 = await tx.classLevel.findFirstOrThrow({ where: { code: 'CLASS_7' } });
    const cycle = await tx.admissionCycle.create({
      data: {
        tenantId: t.id,
        academicYearId: year.id,
        nameBn: 'ভর্তি ২০২৭',
        status: 'OPEN',
        opensAt: new Date('2026-11-01T00:00:00Z'),
        closesAt: new Date('2026-12-31T00:00:00Z'),
      },
    });
    const cc6 = await tx.admissionCycleClass.create({
      data: { tenantId: t.id, cycleId: cycle.id, classLevelId: c6.id },
    });
    const cc7 = await tx.admissionCycleClass.create({
      data: { tenantId: t.id, cycleId: cycle.id, classLevelId: c7.id, isOpen: false },
    });
    return { cycleId: cycle.id, class6: cc6.id, class7Closed: cc7.id };
  });
  return { tenantId: t.id, slug: t.slug, ...ids } satisfies School;
}

const payload = (over: Record<string, unknown> = {}) => ({
  nameBn: 'রাফি আহমেদ',
  dateOfBirth: '2019-05-01',
  gender: 'MALE',
  guardianNameBn: 'করিম আহমেদ',
  guardianRelation: 'FATHER',
  ...over,
});

/** The API's key (applicationNameKey): the Bangla name, else the English one, NFC, lower case, no spaces. */
const nameKeyOf = (body: object) => {
  const b = body as { nameBn?: string | null; nameEn?: string | null };
  return (b.nameBn || b.nameEn || '').normalize('NFC').toLowerCase().replace(/\s+/gu, '');
};

let phoneN = 0;
const phone = () =>
  `+88017${String(Date.now() % 1e6).padStart(6, '0')}${String(phoneN++ % 100).padStart(2, '0')}`;

describe('admission public functions', () => {
  let app: PrismaClient;
  let a: School;
  let b: School;

  // As the API's public routes: jantrik_app, no institute, no person.
  const call = <T>(fn: (tx: PrismaClient) => Promise<T>) =>
    withContext(app, {}, (tx) => fn(tx as unknown as PrismaClient));
  const form = (slug: string, now = NOW) =>
    call(async (tx) => {
      const [r] = await tx.$queryRaw<{ v: unknown }[]>`
        SELECT public.admission_public_form(${slug}, ${now}::timestamptz) AS v`;
      return r!.v as null | {
        institute: Record<string, unknown>;
        cycles: { classes: { cycleClassId: string }[] }[];
      };
    });
  const submit = (
    slug: string,
    cycleClassId: string,
    ph: string,
    body: object,
    opts: { photo?: Buffer; now?: Date } = {},
  ) =>
    call(async (tx) => {
      const [r] = await tx.$queryRaw<
        {
          outcome: string;
          application_no: string | null;
          tenant_id: string | null;
          application_id: string | null;
        }[]
      >`SELECT * FROM public.admission_submit(${slug}, ${cycleClassId}::uuid, ${ph},
          ${JSON.stringify(body)}::jsonb, ${nameKeyOf(body)}, ${opts.photo ?? null}::bytea, ${opts.photo ? 300 : null}::int,
          ${opts.photo ? 400 : null}::int, ${opts.now ?? NOW}::timestamptz)`;
      return r!;
    });
  const lookup = (slug: string, no: string, ph: string) =>
    call(async (tx) => {
      const [r] = await tx.$queryRaw<{ v: unknown }[]>`
        SELECT public.admission_lookup(${slug}, ${no}, ${ph}) AS v`;
      return r!.v as null | Record<string, unknown>;
    });

  beforeAll(async () => {
    app = appClient();
    a = await school(app);
    b = await school(app);
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  describe('admission_public_form', () => {
    it('an unknown slug, or a suspended institute, is NULL', async () => {
      expect(await form('no-such-institute')).toBeNull();
      const suspended = await school(app, { status: 'SUSPENDED' });
      expect(await form(suspended.slug)).toBeNull();
    });

    it('lists only the open class of the open cycle inside its window; no application data', async () => {
      await submit(a.slug, a.class6, phone(), payload());
      const f = (await form(a.slug))!;
      expect(f.institute).toMatchObject({ name: 'Test Institute', locale: 'bn' });
      expect(f.cycles).toHaveLength(1);
      expect(f.cycles[0]!.classes.map((c) => c.cycleClassId)).toEqual([a.class6]);
      expect(JSON.stringify(f)).not.toMatch(/রাফি|\+880|2019-05-01/);
      // Before the window, and after it: no cycles.
      expect((await form(a.slug, new Date('2026-10-01T00:00:00Z')))!.cycles).toEqual([]);
      expect((await form(a.slug, new Date('2027-01-01T00:00:00Z')))!.cycles).toEqual([]);
    });

    it('a DRAFT or CLOSED cycle, or a deactivated class, is left out', async () => {
      const c = await school(app);
      await withTenant(app, c.tenantId, (tx) =>
        tx.admissionCycle.update({ where: { id: c.cycleId }, data: { status: 'CLOSED' } }),
      );
      expect((await form(c.slug))!.cycles).toEqual([]);
      await withTenant(app, c.tenantId, async (tx) => {
        await tx.admissionCycle.update({ where: { id: c.cycleId }, data: { status: 'OPEN' } });
        await tx.classLevel.updateMany({ where: { code: 'CLASS_6' }, data: { isActive: false } });
      });
      expect((await form(c.slug))!.cycles).toEqual([]);
    });
  });

  describe('admission_submit', () => {
    it('numbers applications per institute and year, with no gap under 20 parallel submits', async () => {
      const c = await school(app);
      const first = await submit(c.slug, c.class6, phone(), payload({ nameBn: 'প্রথম' }));
      expect(first).toMatchObject({
        outcome: 'CREATED',
        application_no: '2027-0001',
        tenant_id: c.tenantId,
      });
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          submit(c.slug, c.class6, phone(), payload({ nameBn: `শিশু ${i}` })),
        ),
      );
      expect(results.every((r) => r.outcome === 'CREATED')).toBe(true);
      const numbers = results.map((r) => Number(r.application_no!.slice(5))).sort((x, y) => x - y);
      expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => i + 2));
      const row = await withTenant(app, c.tenantId, (tx) =>
        tx.admissionApplication.findUniqueOrThrow({ where: { id: first.application_id! } }),
      );
      expect(row).toMatchObject({ source: 'ONLINE', status: 'SUBMITTED', nameKey: 'প্রথম' });
    });

    it("another institute's class with A's slug is CLOSED, and nothing is written anywhere", async () => {
      const before = await withTenant(app, b.tenantId, (tx) => tx.admissionApplication.count());
      const r = await submit(a.slug, b.class6, phone(), payload());
      expect(r).toMatchObject({ outcome: 'CLOSED', application_no: null, application_id: null });
      expect(await withTenant(app, b.tenantId, (tx) => tx.admissionApplication.count())).toBe(
        before,
      );
    });

    it('a closed class, or a time outside the window, is CLOSED; an unknown slug UNKNOWN', async () => {
      expect((await submit(a.slug, a.class7Closed, phone(), payload())).outcome).toBe('CLOSED');
      expect(
        (await submit(a.slug, a.class6, phone(), payload(), { now: new Date('2027-02-01') }))
          .outcome,
      ).toBe('CLOSED');
      expect((await submit('no-such-slug', a.class6, phone(), payload())).outcome).toBe('UNKNOWN');
    });

    it('an unknown key, a missing required field, a hidden field or an unwanted photo is INVALID', async () => {
      expect((await submit(a.slug, a.class6, phone(), payload({ studentId: 'x' }))).outcome).toBe(
        'INVALID',
      );
      expect((await submit(a.slug, a.class6, phone(), payload({ gender: null }))).outcome).toBe(
        'INVALID',
      );
      // Blood group is hidden by default.
      expect(
        (await submit(a.slug, a.class6, phone(), payload({ bloodGroup: 'A_POSITIVE' }))).outcome,
      ).toBe('INVALID');
      // This cycle does not collect photos.
      expect(
        (await submit(a.slug, a.class6, phone(), payload(), { photo: Buffer.from([1, 2, 3]) }))
          .outcome,
      ).toBe('INVALID');
      // A value the table refuses, and a phone that is not E.164.
      expect(
        (await submit(a.slug, a.class6, phone(), payload({ birthRegistrationNo: '123' }))).outcome,
      ).toBe('INVALID');
      expect((await submit(a.slug, a.class6, '01711000000', payload())).outcome).toBe('INVALID');
      expect(
        (await submit(a.slug, a.class6, phone(), payload({ dateOfBirth: '2019-13-45' }))).outcome,
      ).toBe('INVALID');
    });

    it("the cycle's required fields and the photo when it collects one", async () => {
      const c = await school(app);
      await withTenant(app, c.tenantId, (tx) =>
        tx.admissionCycle.update({
          where: { id: c.cycleId },
          data: { collectPhoto: true, fields: { photo: 'REQUIRED', father_name: 'REQUIRED' } },
        }),
      );
      expect((await submit(c.slug, c.class6, phone(), payload())).outcome).toBe('INVALID');
      const ok = await submit(c.slug, c.class6, phone(), payload({ fatherNameEn: 'Karim' }), {
        photo: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      });
      expect(ok.outcome).toBe('CREATED');
      const photo = await withTenant(app, c.tenantId, (tx) =>
        tx.admissionApplicationPhoto.findFirstOrThrow({
          where: { applicationId: ok.application_id! },
        }),
      );
      expect(photo).toMatchObject({ mime: 'image/jpeg', width: 300, height: 400 });
      expect(photo.sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('a DUPLICATE: the earlier number only for the same phone; another phone learns no number (review S1)', async () => {
      const ph = phone();
      const first = await submit(
        a.slug,
        a.class6,
        ph,
        payload({ nameBn: 'দুইবার', birthRegistrationNo: '20191234567890777' }),
      );
      expect(first.outcome).toBe('CREATED');
      // Another family's phone typing this birth registration number: no number.
      const byReg = await submit(
        a.slug,
        a.class6,
        phone(),
        payload({ nameBn: 'অন্য নাম', birthRegistrationNo: '20191234567890777' }),
      );
      expect(byReg).toMatchObject({ outcome: 'DUPLICATE', application_no: null });
      // The same family (the same phone): its own earlier number.
      const byName = await submit(a.slug, a.class6, ph, payload({ nameBn: '  দুইবার ' }));
      expect(byName).toMatchObject({ outcome: 'DUPLICATE', application_no: first.application_no });
      const sameReg = await submit(
        a.slug,
        a.class6,
        ph,
        payload({ nameBn: 'দুইবার', birthRegistrationNo: '20191234567890777' }),
      );
      expect(sameReg).toMatchObject({ outcome: 'DUPLICATE', application_no: first.application_no });
    });

    it('a phone at its cap learns nothing from the duplicate check (the cap comes first)', async () => {
      const victim = await submit(
        a.slug,
        a.class6,
        phone(),
        payload({ nameBn: 'অন্য পরিবার', birthRegistrationNo: '20191234567890888' }),
      );
      expect(victim.outcome).toBe('CREATED');
      const ph = phone();
      for (const n of ['ক', 'খ', 'গ']) {
        expect((await submit(a.slug, a.class6, ph, payload({ nameBn: n }))).outcome).toBe(
          'CREATED',
        );
      }
      const probe = await submit(
        a.slug,
        a.class6,
        ph,
        payload({ nameBn: 'ঘ', birthRegistrationNo: '20191234567890888' }),
      );
      expect(probe).toMatchObject({ outcome: 'PHONE_CAP', application_no: null });
    });

    it('the same child from two phones at the same moment: one CREATED, one DUPLICATE without a number (review S3)', async () => {
      const reg = `2019${String(Date.now()).slice(-13).padStart(13, '0')}`;
      const results = await Promise.all(
        [phone(), phone()].map((ph) =>
          submit(a.slug, a.class6, ph, payload({ nameBn: 'যমজ নয়', birthRegistrationNo: reg })),
        ),
      );
      expect(results.map((r) => r.outcome).sort()).toEqual(['CREATED', 'DUPLICATE']);
      expect(results.find((r) => r.outcome === 'DUPLICATE')!.application_no).toBeNull();
    });

    it('the fourth live application of a phone in the cycle is PHONE_CAP', async () => {
      const ph = phone();
      for (const n of ['এক', 'দুই', 'তিন']) {
        expect((await submit(a.slug, a.class6, ph, payload({ nameBn: n }))).outcome).toBe(
          'CREATED',
        );
      }
      expect((await submit(a.slug, a.class6, ph, payload({ nameBn: 'চার' }))).outcome).toBe(
        'PHONE_CAP',
      );
    });

    it('a submit that waited for a cycle edit sees the edit: a cycle closed meanwhile is CLOSED (review round 2, NIT 2)', async () => {
      const c = await school(app);
      let racing: ReturnType<typeof submit> | undefined;
      await withTenant(
        app,
        c.tenantId,
        async (tx) => {
          // As AdmissionCyclesService.lock() and a status change: the cycle's lock, exclusively.
          const key = `admission-cycle:${c.cycleId}`;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
          await tx.admissionCycle.update({ where: { id: c.cycleId }, data: { status: 'CLOSED' } });
          racing = submit(c.slug, c.class6, phone(), payload());
          // Commit only once the submit waits for this cycle's lock: an ungranted advisory lock on
          // this key in pg_locks (a bigint key shows as classid = high half, objid = low half).
          try {
            await vi.waitFor(
              async () => {
                const [w] = await tx.$queryRaw<{ n: number }[]>`
                  SELECT count(*)::int AS n
                  FROM pg_locks l CROSS JOIN (SELECT hashtextextended(${key}, 0) AS v) k
                  WHERE l.locktype = 'advisory' AND NOT l.granted AND l.objsubid = 1
                    AND l.classid::bigint = ((k.v >> 32) & 4294967295)
                    AND l.objid::bigint = (k.v & 4294967295)`;
                if (w!.n === 0) throw new Error('the submit is not waiting yet');
              },
              { timeout: 15_000, interval: 25 },
            );
          } catch (error) {
            // What the other sessions were doing, for the report.
            const others = await tx.$queryRaw<unknown[]>`
              SELECT state, wait_event_type, wait_event, left(query, 80) AS query
              FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> pg_backend_pid()`;
            throw new Error(`${(error as Error).message}: ${JSON.stringify(others)}`);
          }
        },
        { timeout: 30_000 },
      );
      expect((await racing!).outcome).toBe('CLOSED');
    });
  });

  describe('admission_lookup', () => {
    it('the right phone sees the status; a wrong phone, another slug or number sees nothing', async () => {
      const ph = phone();
      const r = await submit(a.slug, a.class6, ph, payload({ nameBn: 'খোঁজ' }));
      const found = await lookup(a.slug, r.application_no!, ph);
      expect(found).toMatchObject({
        applicationNo: r.application_no,
        status: 'SUBMITTED',
        nameBn: 'খোঁজ',
        cycleNameBn: 'ভর্তি ২০২৭',
      });
      expect(await lookup(a.slug, r.application_no!, phone())).toBeNull();
      expect(await lookup(b.slug, r.application_no!, ph)).toBeNull();
      expect(await lookup(a.slug, '2027-9999', ph)).toBeNull();
    });

    // Sprint 1 P4, review focus 3: nothing about the test or the list before publish; then the
    // published snapshot only (P4-M, S13).
    it('the test details once a roll is issued; the published result only, never the draft or a later score', async () => {
      const c = await school(app);
      const ph = phone();
      const r = await submit(c.slug, c.class6, ph, payload({ nameBn: 'ফলাফল' }));
      const id = r.application_id!;
      const setApp = (data: Record<string, unknown>) =>
        withTenant(app, c.tenantId, (tx) =>
          tx.admissionApplication.update({ where: { id }, data }),
        );
      const setClass = (data: Record<string, unknown>) =>
        withTenant(app, c.tenantId, (tx) =>
          tx.admissionCycleClass.update({ where: { id: c.class6 }, data }),
        );
      const seen = () => lookup(c.slug, r.application_no!, ph);

      // Before rolls: neither.
      let v = await seen();
      expect(v).not.toHaveProperty('test');
      expect(v).not.toHaveProperty('result');

      // A roll, the test's details, a score and a built draft: the details only.
      await setClass({
        fullMarks: 100,
        testDate: new Date('2026-12-20'),
        testTime: new Date('1970-01-01T10:30:00Z'),
        testVenueBn: 'মূল ভবন',
      });
      await setApp({ testRoll: 1001, testScoreH: 8550 });
      await setApp({ testResult: 'SELECTED', meritPosition: 1 });
      v = await seen();
      expect(v).toMatchObject({
        test: { roll: 1001, date: '2026-12-20', time: '10:30', venueBn: 'মূল ভবন', venueEn: null },
      });
      expect(v).not.toHaveProperty('result');
      expect(JSON.stringify(v)).not.toContain('8550');

      // Published (version 1): the snapshot.
      const at = new Date('2026-12-25T06:00:00Z');
      await setClass({ resultsVersion: 1, resultsPublishedAt: at, resultsFullMarks: 100 });
      await setApp({
        status: 'SELECTED',
        resultVersion: 1,
        resultMeritPosition: 1,
        resultScoreH: 8550,
        resultAbsent: false,
      });
      v = await seen();
      expect(v).toMatchObject({
        status: 'SELECTED',
        result: {
          version: 1,
          meritPosition: 1,
          waitlistPosition: null,
          scoreH: 8550,
          fullMarks: 100,
          absent: false,
        },
      });

      // A correction built but not republished: still version 1's values.
      await setApp({
        testScoreH: 4000,
        testResult: 'WAITLISTED',
        meritPosition: 5,
        waitlistPosition: 1,
      });
      v = await seen();
      expect(v).toMatchObject({ result: { meritPosition: 1, scoreH: 8550 } });
      expect(JSON.stringify(v)).not.toContain('4000');

      // Version 2 published without this applicant (withdrawn meanwhile): no result.
      await setClass({ resultsVersion: 2, resultsPublishedAt: new Date() });
      v = await seen();
      expect(v).not.toHaveProperty('result');
      // Another phone still sees nothing at all.
      expect(await lookup(c.slug, r.application_no!, phone())).toBeNull();
    });
  });

  describe('the role (review focus 4)', () => {
    it('jantrik_app is not a member of jantrik_admission and sees nothing without a context', async () => {
      const [m] = await app.$queryRaw<{ member: boolean }[]>`
        SELECT pg_has_role('jantrik_app', 'jantrik_admission', 'MEMBER') AS member`;
      expect(m!.member).toBe(false);
      expect(await call((tx) => tx.admissionApplication.findMany())).toEqual([]);
      expect(await call((tx) => tx.admissionCycle.findMany())).toEqual([]);
    });

    it('the platform and receiver logins cannot run the functions', async () => {
      for (const client of [platformClient(), ingestClient()]) {
        try {
          await expect(
            client.$queryRaw`SELECT public.admission_public_form(${a.slug}, now())`,
          ).rejects.toThrow(/permission denied/);
        } finally {
          await client.$disconnect();
        }
      }
    });
  });
});

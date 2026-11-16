import { randomUUID } from 'node:crypto';
import { withTenant } from '@jantrik/db';
import type {
  FeeDueList,
  FeeHeadView,
  FeeLedger,
  FeeStudentHit,
  StudentProfile,
  StudentsPage,
} from '@jantrik/shared';
import { FeeDuesService } from '../src/fees/dues/fee-dues.service.js';
import { TenantJobRunner } from '../src/tenancy/tenant-job-runner.service.js';
import { bearer, createHarness, http, randomPhone, type Harness } from './support/harness.js';
import { feesSchool, type FeesSchool } from './support/fees.js';
import { platform, platformAdminCookie } from './support/platform.js';

/** P5, S14, P5-J: a student leaves without being deleted, and may come back. */
describe('students: leave and return', () => {
  let h: Harness;
  let s: FeesSchool;

  const api = (token: string) => ({
    get: (path: string) => http(h).get(path).set(bearer(token)),
    post: (path: string, body: object = {}) => http(h).post(path).set(bearer(token)).send(body),
    put: (path: string, body: object) => http(h).put(path).set(bearer(token)).send(body),
  });
  const audit = (studentId: string) =>
    withTenant(h.prisma, s.tenantId, (tx) =>
      tx.auditLog.findMany({
        where: { entity: 'student', entityId: studentId, action: 'UPDATE' },
        orderBy: { createdAt: 'asc' },
      }),
    );

  beforeAll(async () => {
    h = await createHarness();
    s = await feesSchool(h);
    const admin = api(s.tokens.admin);
    const tuition = (
      await admin
        .post('/fees/heads', {
          nameBn: 'মাসিক বেতন',
          nameEn: 'Monthly tuition',
          kind: 'TUITION',
          frequency: 'MONTHLY',
          dueDay: 10,
          fine: { type: 'FLAT', amountPaisa: 5000, capPaisa: null },
        })
        .expect(201)
    ).body as FeeHeadView;
    await admin
      .put('/fees/amounts', {
        academicYearId: s.yearId,
        amounts: [
          { feeHeadId: tuition.id, classLevelId: s.class6, amountPaisa: 100000 },
          { feeHeadId: tuition.id, classLevelId: s.class9, amountPaisa: 150000 },
        ],
      })
      .expect(200);
    await admin
      .put('/fees/settings', {
        duesFrom: `${s.months.previous}-01`,
        receiptSmsEnabled: false,
        sibling: null,
        receiptNote: null,
      })
      .expect(200);
  });

  afterAll(() => h.close());

  it('leaves as TRANSFERRED: not deleted, out of the due list and new dues; ledger and counter still work', async () => {
    const student = s.students[2]!;
    const admin = api(s.tokens.admin);
    // Dues exist before leaving (the ledger generates them).
    const before = (await admin.get(`/fees/students/${student.id}/ledger`).expect(200))
      .body as FeeLedger;
    expect(before.dues.length).toBeGreaterThan(0);

    const left = (
      await admin
        .post(`/students/${student.id}/leave`, {
          status: 'TRANSFERRED',
          leftOn: s.today,
          reason: '  Moved to Chattogram  ',
        })
        .expect(200)
    ).body as StudentProfile;
    expect(left).toMatchObject({
      status: 'TRANSFERRED',
      leftOn: s.today,
      leaveReason: 'Moved to Chattogram',
      deletedAt: null,
    });
    // Rolls are kept (history).
    expect(left.enrolments[0]!.roll).toBe(3);

    // The student list: still there, marked TRANSFERRED; the ACTIVE filter leaves them out.
    const active = (await admin.get('/students?status=ACTIVE').expect(200)).body as StudentsPage;
    expect(active.items.map((i) => i.id)).not.toContain(student.id);
    const transferred = (await admin.get('/students?status=TRANSFERRED').expect(200))
      .body as StudentsPage;
    expect(transferred.items.map((i) => i.id)).toContain(student.id);

    // Out of the due list (another student's ledger view makes their dues first).
    await api(s.tokens.accountant).get(`/fees/students/${s.students[0]!.id}/ledger`).expect(200);
    const dueList = (await api(s.tokens.accountant).get('/fees/reports/dues').expect(200))
      .body as FeeDueList;
    expect(dueList.rows.map((r) => r.student.id)).not.toContain(student.id);
    expect(dueList.rows.map((r) => r.student.id)).toContain(s.students[0]!.id);

    // No new dues: the dues run leaves them out, and the ledger keeps the old ones only.
    const billed = await h.app
      .get(TenantJobRunner)
      .run(s.tenantId, () => h.app.get(FeeDuesService).activeStudentIds());
    expect(billed).not.toContain(student.id);
    expect(billed).toContain(s.students[0]!.id);
    const ledger = (await api(s.tokens.accountant).get(`/fees/students/${student.id}/ledger`))
      .body as FeeLedger;
    expect(ledger.dues.map((d) => d.id)).toEqual(before.dues.map((d) => d.id));

    // The counter still finds them and takes a payment on an old due.
    const hits = (
      await api(s.tokens.accountant).get(`/fees/students?q=${student.code}`).expect(200)
    ).body as FeeStudentHit[];
    expect(hits.map((x) => x.id)).toContain(student.id);
    const open = ledger.dues.filter((d) => d.status === 'OPEN' && d.balance.total > 0);
    const outstanding = open.reduce((sum, d) => sum + d.balance.total, 0);
    expect(outstanding).toBeGreaterThan(0);
    await api(s.tokens.accountant)
      .post('/fees/payments', {
        studentId: student.id,
        dueIds: open.map((d) => d.id),
        amountPaisa: outstanding,
        expectedOutstandingPaisa: outstanding,
        clientRequestId: randomUUID(),
      })
      .expect(201);

    // Audited with the old and new status.
    const rows = await audit(student.id);
    expect(rows.at(-1)).toMatchObject({
      oldValues: { status: 'ACTIVE' },
      newValues: { status: 'TRANSFERRED', leftOn: s.today, leaveReason: 'Moved to Chattogram' },
    });
  });

  it('frees a place under the student limit; return checks the limit again', async () => {
    const admin = api(s.tokens.admin);
    const activeCount = () =>
      withTenant(h.prisma, s.tenantId, (tx) =>
        tx.student.count({ where: { status: 'ACTIVE', deletedAt: null } }),
      );
    const limit = await activeCount();
    const limits = async (studentLimit: number | null) =>
      platform(h, await platformAdminCookie(h))
        .put(`/platform/institutes/${s.tenantId}/limits`)
        .send({ studentLimit, smsDailyCap: null })
        .expect(200);
    await limits(limit);
    const admission = {
      nameEn: 'New Admit',
      guardians: [
        { phone: randomPhone(), nameEn: 'Guardian', relation: 'FATHER', isPrimary: true },
      ],
      enrolment: {
        academicYearId: s.yearId,
        classLevelId: s.class6,
        sectionId: s.sectionId,
        roll: null,
      },
    };
    const full = await admin.post('/students', admission).expect(422);
    expect(full.body.code).toBe('STUDENT_LIMIT');
    const leaver = s.students[1]!;
    await admin
      .post(`/students/${leaver.id}/leave`, { status: 'DROPPED_OUT', leftOn: s.today })
      .expect(200);
    const admitted = await admin.post('/students', admission);
    expect(admitted.body).toMatchObject({ studentCode: expect.any(String) });

    // The limit is reached again: the leaver cannot come back.
    const refused = await admin.post(`/students/${leaver.id}/return`).expect(422);
    expect(refused.body.code).toBe('STUDENT_LIMIT');
    await limits(null);
    const back = (await admin.post(`/students/${leaver.id}/return`).expect(200))
      .body as StudentProfile;
    expect(back).toMatchObject({ status: 'ACTIVE', leftOn: null, leaveReason: null });
    expect((await audit(leaver.id)).at(-1)).toMatchObject({
      oldValues: { status: 'DROPPED_OUT' },
      newValues: { status: 'ACTIVE', returned: true },
    });
  });

  it('refuses a second leave, a return of someone who stayed, a deactivated student and bad input', async () => {
    const admin = api(s.tokens.admin);
    const student = s.students[3]!;
    expect((await admin.post(`/students/${student.id}/return`).expect(422)).body.code).toBe(
      'NOT_LEFT',
    );
    await admin
      .post(`/students/${student.id}/leave`, { status: 'ACTIVE', leftOn: s.today })
      .expect(400);
    await admin
      .post(`/students/${student.id}/leave`, { status: 'GRADUATED', leftOn: '31/12/2026' })
      .expect(400);
    await admin
      .post(`/students/${student.id}/leave`, { status: 'GRADUATED', leftOn: s.today })
      .expect(200);
    expect(
      (
        await admin
          .post(`/students/${student.id}/leave`, { status: 'TRANSFERRED', leftOn: s.today })
          .expect(422)
      ).body.code,
    ).toBe('ALREADY_LEFT');

    const gone = s.students[0]!;
    await admin.post(`/students/${gone.id}/deactivate`).expect(200);
    expect(
      (
        await admin
          .post(`/students/${gone.id}/leave`, { status: 'TRANSFERRED', leftOn: s.today })
          .expect(409)
      ).body.code,
    ).toBe('DEACTIVATED');
    expect((await admin.post(`/students/${gone.id}/return`).expect(409)).body.code).toBe(
      'DEACTIVATED',
    );
  });

  it('teachers and accountants cannot; another institute gets 404', async () => {
    const id = s.students[2]!.id;
    await api(s.tokens.teacher)
      .post(`/students/${id}/leave`, { status: 'GRADUATED', leftOn: s.today })
      .expect(403);
    await api(s.tokens.accountant).post(`/students/${id}/return`).expect(403);
    const other = await feesSchool(h);
    await api(other.tokens.admin)
      .post(`/students/${id}/leave`, { status: 'GRADUATED', leftOn: s.today })
      .expect(404);
  });
});

import { randomUUID } from 'node:crypto';
import { withTenant } from '@jantrik/db';
import { todayIn, type FeeHeadView, type FeeLedger } from '@jantrik/shared';
import { feesSchool, type FeesSchool } from './support/fees.js';
import {
  addMember,
  bearer,
  createHarness,
  http,
  otpLogin,
  type Harness,
} from './support/harness.js';

/**
 * A class teacher who also collects fees (TEACHER + ACCOUNTANT, step 9 A5): fee access comes
 * from ACCOUNTANT only; teaching rights stay those of a teacher.
 */
describe('teacher and accountant together', () => {
  let h: Harness;
  let s: FeesSchool;
  let both: { userId: string; token: string };
  let otherSection: string;
  /** The register lists every student of the section (class 6 ক: students 0–2). */
  let ownSection: string[];

  const api = (token: string) => ({
    get: (path: string) => http(h).get(path).set(bearer(token)),
    post: (path: string, body: object = {}) => http(h).post(path).set(bearer(token)).send(body),
    put: (path: string, body: object) => http(h).put(path).set(bearer(token)).send(body),
  });
  const takeAttendance = (token: string, sectionId: string, studentIds: string[]) =>
    api(token).put('/attendance/sessions', {
      sectionId,
      date: todayIn('Asia/Dhaka'),
      baseVersion: 0,
      submissionId: randomUUID(),
      records: studentIds.map((studentId) => ({ studentId, status: 'PRESENT' as const })),
    });

  beforeAll(async () => {
    h = await createHarness();
    s = await feesSchool(h);
    const m = await addMember(h, s.tenantId, { roles: ['TEACHER', 'ACCOUNTANT'] });
    both = { userId: m.userId, token: (await otpLogin(h, m.phone)).accessToken };
    ownSection = [s.students[0]!.id, s.students[1]!.id, s.students[2]!.id];
    otherSection = await withTenant(h.prisma, s.tenantId, async (tx) => {
      await tx.sectionTeacher.create({
        data: {
          tenantId: s.tenantId,
          sectionId: s.sectionId,
          userId: m.userId,
          isClassTeacher: true,
        },
      });
      // Attendance on any weekday (the test must not depend on today being a working day).
      await tx.attendanceSettings.update({
        where: { tenantId: s.tenantId },
        data: { weeklyOffDays: [] },
      });
      const nine = await tx.enrolment.findFirstOrThrow({ where: { studentId: s.students[3]!.id } });
      return nine.sectionId!;
    });
    const admin = api(s.tokens.admin);
    const head = (
      await admin
        .post('/fees/heads', {
          nameBn: 'বেতন',
          nameEn: 'Tuition',
          kind: 'TUITION',
          frequency: 'MONTHLY',
          dueDay: 10,
        })
        .expect(201)
    ).body as FeeHeadView;
    await admin
      .put('/fees/amounts', {
        academicYearId: s.yearId,
        amounts: [{ feeHeadId: head.id, classLevelId: s.class6, amountPaisa: 100000 }],
      })
      .expect(200);
    await admin
      .put('/fees/settings', {
        duesFrom: `${s.months.current}-01`,
        receiptSmsEnabled: false,
        sibling: null,
        receiptNote: null,
      })
      .expect(200);
  });

  afterAll(() => h.close());

  it('collects fees and sees reports, but not setup or voids', async () => {
    const id = s.students[2]!.id;
    const view = (await api(both.token).get(`/fees/students/${id}/ledger`).expect(200))
      .body as FeeLedger;
    const due = view.dues[0]!;
    const receipt = await api(both.token)
      .post('/fees/payments', {
        studentId: id,
        dueIds: [due.id],
        amountPaisa: 1000,
        expectedOutstandingPaisa: due.balance.total,
        clientRequestId: randomUUID(),
      })
      .expect(201);
    await api(both.token).get('/fees/reports/dues').expect(200);
    await api(both.token).get('/fees/closing').expect(200);
    await api(both.token).get('/fees/heads').expect(403);
    await api(both.token)
      .post(`/fees/payments/${receipt.body.id}/void`, { reason: 'নিজে বাতিল' })
      .expect(403);
    await api(both.token).post('/fees/reminders/preview', {}).expect(403);
  });

  it('still takes attendance only for their own section', async () => {
    const own = await takeAttendance(both.token, s.sectionId, ownSection);
    expect([200, 201]).toContain(own.status);
    await takeAttendance(both.token, otherSection, [s.students[3]!.id]).expect(403);
  });

  it('a teacher without ACCOUNTANT has no fee route; removing ACCOUNTANT applies at once', async () => {
    await api(s.tokens.teacher).get('/fees/students?q=Student').expect(403);
    await api(s.tokens.teacher).get(`/fees/students/${s.students[2]!.id}/ledger`).expect(403);
    await api(s.tokens.admin)
      .put(`/staff/${both.userId}/roles`, { roles: ['TEACHER'] })
      .expect(200);
    await api(both.token).get(`/fees/students/${s.students[2]!.id}/ledger`).expect(403);
    const own = await takeAttendance(both.token, s.sectionId, ownSection);
    expect(own.status).not.toBe(403);
  });
});

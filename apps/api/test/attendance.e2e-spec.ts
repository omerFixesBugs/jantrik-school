import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { createPrismaClient, withTenant, type PrismaClient } from '@jantrik/db';
import {
  addDays,
  isoWeekday,
  todayIn,
  type AttendanceSettings,
  type AttendanceStatus,
  type MySectionsResponse,
  type SmsDailyStatus,
  type SubmitAttendanceResponse,
} from '@jantrik/shared';
import type { Queue } from 'bullmq';
import {
  addMember,
  bearer,
  createHarness,
  createTenant,
  http,
  otpLogin,
  type Harness,
} from './support/harness.js';
import { school, type School } from './support/school.js';

const TODAY = () => todayIn('Asia/Dhaka');

describe('attendance', () => {
  let h: Harness;
  let owner: PrismaClient;
  let s: School;

  beforeAll(async () => {
    h = await createHarness();
    owner = createPrismaClient(process.env['DATABASE_MIGRATION_URL_TEST']!);
    s = await school(h);
  });

  afterAll(async () => {
    await owner.$disconnect();
    await h.close();
  });

  const records = (
    students: { id: string }[],
    absent: number[] = [],
    other: AttendanceStatus = 'PRESENT',
  ) =>
    students.map((st, i) => ({
      studentId: st.id,
      status: absent.includes(i) ? ('ABSENT' as const) : other,
    }));

  const submit = (
    token: string,
    body: {
      sectionId: string;
      records: { studentId: string; status: AttendanceStatus }[];
      date?: string;
      periodNo?: number;
      baseVersion?: number;
      submissionId?: string;
      allowNonWorkingDay?: boolean;
    },
  ) =>
    http(h)
      .put('/attendance/sessions')
      .set(bearer(token))
      .send({ date: TODAY(), baseVersion: 0, submissionId: randomUUID(), ...body });

  /** Rows as the tenant sees them (RLS). */
  const smsLogs = (tenantId: string) =>
    withTenant(h.prisma, tenantId, (tx) => tx.smsLog.findMany({ orderBy: { createdAt: 'asc' } }));
  const auditRows = (tenantId: string, entityId: string) =>
    withTenant(h.prisma, tenantId, (tx) =>
      tx.auditLog.findMany({ where: { entityId }, orderBy: { createdAt: 'asc' } }),
    );
  const waitForSms = (phone: string, count = 1) =>
    vi.waitFor(
      () => {
        if (h.sms.sentTo(phone).length < count) throw new Error('not yet');
      },
      { timeout: 5_000, interval: 25 },
    );
  const waitForStatus = (tenantId: string, status: string, n = 1) =>
    vi.waitFor(
      async () => {
        const rows = (await smsLogs(tenantId)).filter((r) => r.status === status);
        if (rows.length < n) throw new Error('not yet');
      },
      { timeout: 5_000, interval: 25 },
    );

  describe('who can take attendance', () => {
    it("teachers see only their sections, admins all; today is the server's", async () => {
      const mine = (await http(h).get('/attendance/my-sections').set(bearer(s.teacher)).expect(200))
        .body as MySectionsResponse;
      expect(mine.today).toBe(TODAY());
      expect(mine.sections.map((x) => x.id)).toEqual([s.sectionA]);
      expect(mine.sections[0]).toMatchObject({ isClassTeacher: true, studentCount: 3 });
      const all = (await http(h).get('/attendance/my-sections').set(bearer(s.admin)).expect(200))
        .body as MySectionsResponse;
      expect(all.sections.map((x) => x.id).sort()).toEqual([s.sectionA, s.sectionB].sort());
    });

    it("a teacher can't open or mark another section", async () => {
      const res = await submit(s.teacher, { sectionId: s.sectionB, records: records(s.b) }).expect(
        403,
      );
      expect(res.body.code).toBe('NOT_ASSIGNED');
      await http(h)
        .get('/attendance/sessions')
        .query({ sectionId: s.sectionB })
        .set(bearer(s.teacher))
        .expect(403);
      await submit(s.otherTeacher, { sectionId: s.sectionA, records: records(s.a) }).expect(403);
    });

    it('is gated by the ATTENDANCE module and limited to staff', async () => {
      const t = await createTenant(h); // module not enabled
      const { phone } = await addMember(h, t.id, { roles: ['ADMIN'] });
      const token = (await otpLogin(h, phone)).accessToken;
      await http(h).get('/attendance/my-sections').set(bearer(token)).expect(403);
      // Teachers can read settings but not change them.
      await http(h).get('/attendance/settings').set(bearer(s.teacher)).expect(200);
      await http(h).put('/attendance/settings').set(bearer(s.teacher)).send({}).expect(403);
    });

    it("an admin cannot reach another tenant's section", async () => {
      const other = await school(h);
      await http(h)
        .get('/attendance/sessions')
        .query({ sectionId: other.sectionA })
        .set(bearer(s.admin))
        .expect(404);
      await submit(s.admin, { sectionId: other.sectionA, records: records(other.a) }).expect(404);
    });
  });

  describe('submitting', () => {
    it('saves, audits, sends one SMS per absent student, and a retry is answered not re-applied', async () => {
      const submissionId = randomUUID();
      const first = (
        await submit(s.teacher, {
          sectionId: s.sectionA,
          records: records(s.a, [0]),
          submissionId,
        }).expect(200)
      ).body as SubmitAttendanceResponse;
      expect(first.replayed).toBe(false);
      expect(first.session.version).toBe(1);
      expect(first.session.records.find((r) => r.studentId === s.a[0]!.id)?.status).toBe('ABSENT');

      const audit = await auditRows(s.tenantId, first.session.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ entity: 'attendance_session', action: 'CREATE' });
      expect(audit[0]!.newValues).toMatchObject({ lateEdit: false });

      await waitForSms(s.a[0]!.phone);
      expect(h.sms.sentTo(s.a[0]!.phone)[0]).toContain('ছাত্র 1');
      await waitForStatus(s.tenantId, 'SENT');
      const [log] = await smsLogs(s.tenantId);
      expect(log).toMatchObject({
        phone: s.a[0]!.phone,
        purpose: 'ATTENDANCE_ABSENT',
        status: 'SENT',
        dedupeKey: `absent:${s.a[0]!.id}:${TODAY()}`,
      });
      expect(log!.segments).toBeGreaterThanOrEqual(1);
      expect(h.sms.sentTo(s.a[1]!.phone)).toEqual([]); // present: no SMS

      // The same submit again (a retry after a lost response): same answer, nothing new.
      const retry = (
        await submit(s.teacher, {
          sectionId: s.sectionA,
          records: records(s.a, [0]),
          submissionId,
        }).expect(200)
      ).body as SubmitAttendanceResponse;
      expect(retry.replayed).toBe(true);
      expect(retry.session.version).toBe(1);
      expect(await auditRows(s.tenantId, first.session.id)).toHaveLength(1);
      expect(await smsLogs(s.tenantId)).toHaveLength(1);
    });

    it('a resubmit updates only what changed, audits it, and never re-sends an SMS', async () => {
      const sheet = await http(h)
        .get('/attendance/sessions')
        .query({ sectionId: s.sectionA })
        .set(bearer(s.teacher))
        .expect(200);
      expect(sheet.body).toMatchObject({ canSubmit: true, today: TODAY() });
      expect(sheet.body.students.map((x: { roll: number }) => x.roll)).toEqual([1, 2, 3]);
      const version = sheet.body.session.version as number;

      // Student 1 stays absent, student 2 becomes absent.
      const res = (
        await submit(s.teacher, {
          sectionId: s.sectionA,
          records: records(s.a, [0, 1]),
          baseVersion: version,
        }).expect(200)
      ).body as SubmitAttendanceResponse;
      expect(res.session.version).toBe(version + 1);
      const audit = await auditRows(s.tenantId, res.session.id);
      expect(audit.at(-1)).toMatchObject({ action: 'UPDATE' });
      expect(Object.keys(audit.at(-1)!.newValues as object).sort()).toEqual(
        [s.a[1]!.id, 'lateEdit'].sort(),
      );

      await waitForSms(s.a[1]!.phone);
      expect(h.sms.sentTo(s.a[0]!.phone)).toHaveLength(1); // still just the first one
      expect((await smsLogs(s.tenantId)).length).toBe(2);
    });

    it('a stale draft gets a conflict with the current state', async () => {
      const res = await submit(s.teacher, {
        sectionId: s.sectionA,
        records: records(s.a),
        baseVersion: 1,
      }).expect(409);
      expect(res.body.code).toBe('VERSION_CONFLICT');
      expect(res.body.session.version).toBeGreaterThan(1);
      expect(res.body.session.updatedBy).toMatchObject({ name: 'Test User' });
    });

    it('only students enrolled in the section, all of them', async () => {
      const unknown = await submit(s.admin, {
        sectionId: s.sectionB,
        records: [...records(s.b), ...records([s.a[0]!])],
      }).expect(422);
      expect(unknown.body).toMatchObject({ code: 'UNKNOWN_STUDENT', studentIds: [s.a[0]!.id] });
      const missing = await submit(s.admin, {
        sectionId: s.sectionA,
        records: records(s.a.slice(0, 2)),
        date: addDays(TODAY(), -3),
      }).expect(409);
      expect(missing.body.code).toBe('ROSTER_CHANGED');
      expect(missing.body.students).toHaveLength(3);
    });

    it('validates the payload', async () => {
      await http(h)
        .put('/attendance/sessions')
        .set(bearer(s.teacher))
        .send({
          sectionId: s.sectionA,
          date: '2026-02-30',
          baseVersion: 0,
          submissionId: randomUUID(),
          records: records(s.a),
        })
        .expect(400);
      const wrongPeriod = await submit(s.teacher, {
        sectionId: s.sectionA,
        records: records(s.a),
        periodNo: 2,
      }).expect(422);
      expect(wrongPeriod.body.code).toBe('WRONG_PERIOD_FOR_MODE');
    });
  });

  describe('dates', () => {
    it('never the future', async () => {
      const res = await submit(s.admin, {
        sectionId: s.sectionB,
        records: records(s.b),
        date: addDays(TODAY(), 1),
      }).expect(422);
      expect(res.body).toMatchObject({ code: 'FUTURE_DATE', today: TODAY() });
    });

    it('after the edit window only an admin can change it: audited as a late edit, no SMS', async () => {
      const yesterday = addDays(TODAY(), -1);
      const t = await submit(s.teacher, {
        sectionId: s.sectionA,
        records: records(s.a),
        date: yesterday,
      }).expect(403);
      expect(t.body.code).toBe('EDIT_WINDOW_CLOSED');
      const sheet = await http(h)
        .get('/attendance/sessions')
        .query({ sectionId: s.sectionA, date: yesterday })
        .set(bearer(s.teacher))
        .expect(200);
      expect(sheet.body).toMatchObject({ canSubmit: false, blockedReason: 'EDIT_WINDOW_CLOSED' });

      const before = (await smsLogs(s.tenantId)).length;
      const res = (
        await submit(s.admin, {
          sectionId: s.sectionA,
          records: records(s.a, [2]),
          date: yesterday,
        }).expect(200)
      ).body as SubmitAttendanceResponse;
      const [audit] = await auditRows(s.tenantId, res.session.id);
      expect(audit!.newValues).toMatchObject({ lateEdit: true, date: yesterday });
      expect((await smsLogs(s.tenantId)).length).toBe(before); // SMS only for today's registers
    });

    it('a teacher may edit within the window', async () => {
      const t = await school(h, { settings: { editWindowDays: 2 } });
      await submit(t.teacher, {
        sectionId: t.sectionA,
        records: records(t.a),
        date: addDays(TODAY(), -2),
      }).expect(200);
      await submit(t.teacher, {
        sectionId: t.sectionA,
        records: records(t.a),
        date: addDays(TODAY(), -3),
      }).expect(403);
    });

    it('holidays and weekly off days are blocked unless an admin overrides', async () => {
      const t = await school(h, { settings: { absentSmsEnabled: false } });
      await http(h)
        .post('/attendance/holidays')
        .set(bearer(t.admin))
        .send({ startDate: TODAY(), endDate: TODAY(), nameBn: 'ছুটি', nameEn: 'Holiday' })
        .expect(201);
      const blocked = await submit(t.teacher, {
        sectionId: t.sectionA,
        records: records(t.a),
      }).expect(422);
      expect(blocked.body).toMatchObject({
        code: 'NON_WORKING_DAY',
        nonWorkingDay: { reason: 'HOLIDAY', nameEn: 'Holiday' },
      });
      await submit(t.admin, { sectionId: t.sectionA, records: records(t.a) }).expect(422);
      await submit(t.teacher, {
        sectionId: t.sectionA,
        records: records(t.a),
        allowNonWorkingDay: true,
      }).expect(422);
      const ok = await submit(t.admin, {
        sectionId: t.sectionA,
        records: records(t.a),
        allowNonWorkingDay: true,
      }).expect(200);
      const session = await withTenant(h.prisma, t.tenantId, (tx) =>
        tx.attendanceSession.findUniqueOrThrow({ where: { id: ok.body.session.id } }),
      );
      expect(session.onNonWorkingDay).toBe(true);

      const off = await school(h, { settings: { weeklyOffDays: [isoWeekday(TODAY())] } });
      const res = await submit(off.teacher, {
        sectionId: off.sectionA,
        records: records(off.a),
      }).expect(422);
      expect(res.body.nonWorkingDay).toEqual({ reason: 'OFF_DAY' });
    });
  });

  describe('absent SMS', () => {
    it('nothing is saved, queued or sent when the request fails after submitting', async () => {
      const t = await school(h);
      // Watch the queue itself, so a broken afterCommit guard fails here directly
      // (the worker's own "row must exist" check would otherwise hide it).
      const queue = h.app.get<Queue>(getQueueToken('sms'));
      const add = vi.spyOn(queue, 'add');
      await http(h)
        .post('/test/attendance-then-fail')
        .set(bearer(t.admin))
        .send({
          sectionId: t.sectionA,
          date: TODAY(),
          periodNo: 0,
          submissionId: randomUUID(),
          baseVersion: 0,
          records: records(t.a, [0, 1, 2]),
        })
        .expect(400);
      expect(add.mock.calls.filter(([name]) => name === 'tenant')).toEqual([]);
      add.mockRestore();
      expect(await smsLogs(t.tenantId)).toEqual([]);
      const sessions = await withTenant(h.prisma, t.tenantId, (tx) => tx.attendanceSession.count());
      expect(sessions).toBe(0);
      await new Promise((r) => setTimeout(r, 300));
      expect(h.sms.sentTo(t.a[0]!.phone)).toEqual([]);
    });

    it('a successful submit queues exactly one job per absent student (control for the test above)', async () => {
      const t = await school(h);
      const queue = h.app.get<Queue>(getQueueToken('sms'));
      const add = vi.spyOn(queue, 'add');
      await submit(t.admin, { sectionId: t.sectionA, records: records(t.a, [0, 1]) }).expect(200);
      expect(add.mock.calls.filter(([name]) => name === 'tenant')).toHaveLength(2);
      add.mockRestore();
    });

    it('is off by default for new tenants and sends nothing when off', async () => {
      const t = await createTenant(h, { modules: ['ATTENDANCE'] });
      const { phone } = await addMember(h, t.id, { roles: ['ADMIN'] });
      const token = (await otpLogin(h, phone)).accessToken;
      const settings = (await http(h).get('/attendance/settings').set(bearer(token)).expect(200))
        .body as AttendanceSettings;
      expect(settings).toMatchObject({
        absentSmsEnabled: false,
        absentSmsDelayMinutes: 10,
        dailySmsCap: null,
      });

      const off = await school(h, { settings: { absentSmsEnabled: false } });
      await submit(off.teacher, { sectionId: off.sectionA, records: records(off.a, [0]) }).expect(
        200,
      );
      expect(await smsLogs(off.tenantId)).toEqual([]);
    });

    it('one SMS per student per day across periods (coaching, per-session mode)', async () => {
      const c = await school(h, { instituteTypeKey: 'COACHING' });
      const daily = await submit(c.teacher, {
        sectionId: c.sectionA,
        records: records(c.a, [0]),
      }).expect(422);
      expect(daily.body.code).toBe('WRONG_PERIOD_FOR_MODE'); // period 0 is for DAILY mode
      await submit(c.teacher, {
        sectionId: c.sectionA,
        records: records(c.a, [0]),
        periodNo: 1,
      }).expect(200);
      await submit(c.teacher, {
        sectionId: c.sectionA,
        records: records(c.a, [0]),
        periodNo: 2,
      }).expect(200);
      await waitForSms(c.a[0]!.phone);
      await new Promise((r) => setTimeout(r, 300));
      expect(h.sms.sentTo(c.a[0]!.phone)).toHaveLength(1);
      expect(await smsLogs(c.tenantId)).toHaveLength(1);
    });

    it('a mis-tap corrected before the delay ends is cancelled, not sent', async () => {
      const t = await school(h, { settings: { absentSmsDelayMinutes: 10 } });
      const first = (
        await submit(t.teacher, { sectionId: t.sectionA, records: records(t.a, [0]) }).expect(200)
      ).body as SubmitAttendanceResponse;
      await submit(t.teacher, {
        sectionId: t.sectionA,
        records: records(t.a),
        baseVersion: first.session.version,
      }).expect(200);
      // Run the delayed job now instead of waiting 10 minutes.
      const [log] = await smsLogs(t.tenantId);
      const queue = h.app.get<Queue>(getQueueToken('sms'));
      await (await queue.getJob(log!.id))!.promote();
      await waitForStatus(t.tenantId, 'CANCELLED');
      expect(h.sms.sentTo(t.a[0]!.phone)).toEqual([]);
    });

    it('over the daily cap: held back, not sent, and reported', async () => {
      const t = await school(h, { settings: { dailySmsCap: 1 } });
      await submit(t.teacher, { sectionId: t.sectionA, records: records(t.a, [0, 1]) }).expect(200);
      await waitForStatus(t.tenantId, 'SENT');
      const logs = await smsLogs(t.tenantId);
      expect(logs.map((l) => l.status).sort()).toEqual(['HELD_OVER_LIMIT', 'SENT']);
      const held = logs.find((l) => l.status === 'HELD_OVER_LIMIT')!;
      await new Promise((r) => setTimeout(r, 300));
      expect(h.sms.sentTo(held.phone)).toEqual([]);
      const status = (await http(h).get('/attendance/sms/today').set(bearer(t.admin)).expect(200))
        .body as SmsDailyStatus;
      expect(status).toEqual({
        date: TODAY(),
        cap: 1,
        used: 1,
        held: 1,
        heldSegments: held.segments,
      });
      expect(held.segments).toBeGreaterThanOrEqual(1);
      await http(h).get('/attendance/sms/today').set(bearer(t.teacher)).expect(403);
    });

    it('the default cap is 2 × active students', async () => {
      const t = await school(h);
      const settings = (await http(h).get('/attendance/settings').set(bearer(t.admin)).expect(200))
        .body as AttendanceSettings;
      expect(settings.effectiveDailySmsCap).toBe(2 * 4);
    });

    it('uses the tenant template and rejects unknown variables', async () => {
      const t = await school(h, { settings: { absentSmsTemplate: '{student} আজ আসেনি' } });
      await submit(t.teacher, { sectionId: t.sectionA, records: records(t.a, [2]) }).expect(200);
      await waitForSms(t.a[2]!.phone);
      expect(h.sms.sentTo(t.a[2]!.phone)).toEqual(['ছাত্র 3 আজ আসেনি']);
      const bad = await http(h)
        .put('/attendance/settings')
        .set(bearer(t.admin))
        .send({
          mode: 'DAILY',
          weeklyOffDays: [5],
          editWindowDays: 0,
          leaveCountsAsAbsent: false,
          absentSmsEnabled: true,
          absentSmsTemplate: '{name} আসেনি',
          absentSmsDelayMinutes: 10,
          dailySmsCap: null,
        })
        .expect(400);
      expect(JSON.stringify(bad.body)).toContain('absentSmsTemplate');
    });
  });

  describe('today summary (dashboard card)', () => {
    const summary = (token: string) =>
      http(h).get('/attendance/summary/today').set(bearer(token)).expect(200);

    it("counts the caller's sections with the tenant's LEAVE rule", async () => {
      const t = await school(h, { settings: { absentSmsEnabled: false } });
      const mixed: AttendanceStatus[] = ['ABSENT', 'LATE', 'LEAVE'];
      await submit(t.teacher, {
        sectionId: t.sectionA,
        records: t.a.map((st, i) => ({ studentId: st.id, status: mixed[i]! })),
      }).expect(200);

      const mine = (await summary(t.teacher)).body;
      expect(mine).toMatchObject({
        today: TODAY(),
        sectionsTotal: 1,
        sectionsTaken: 1,
        students: 3,
        counts: { present: 0, absent: 1, late: 1, leave: 1 },
        everTaken: true,
      });
      expect(mine.percent).toBeCloseTo(50); // LATE counts as present; LEAVE left out
      const all = (await summary(t.admin)).body;
      expect(all).toMatchObject({ sectionsTotal: 2, sectionsTaken: 1 });

      await http(h)
        .put('/attendance/settings')
        .set(bearer(t.admin))
        .send({
          mode: 'DAILY',
          weeklyOffDays: [],
          editWindowDays: 0,
          leaveCountsAsAbsent: true,
          absentSmsEnabled: false,
          absentSmsTemplate: null,
          absentSmsDelayMinutes: 0,
          dailySmsCap: null,
        })
        .expect(200);
      expect((await summary(t.teacher)).body.percent).toBeCloseTo(100 / 3);
    });

    it('nothing taken yet: percent is null', async () => {
      const t = await school(h);
      expect((await summary(t.teacher)).body).toMatchObject({
        sectionsTaken: 0,
        students: 0,
        percent: null,
        everTaken: false,
      });
    });

    it('per-session mode counts the first period only', async () => {
      const c = await school(h, {
        instituteTypeKey: 'COACHING',
        settings: { absentSmsEnabled: false },
      });
      await submit(c.teacher, { sectionId: c.sectionA, records: records(c.a), periodNo: 1 }).expect(
        200,
      );
      await submit(c.teacher, {
        sectionId: c.sectionA,
        records: records(c.a, [0, 1, 2]),
        periodNo: 2,
      }).expect(200);
      expect((await summary(c.teacher)).body).toMatchObject({
        students: 3,
        counts: { present: 3, absent: 0 },
      });
    });
  });

  describe('admin configuration', () => {
    it('section teachers must be active staff of this tenant', async () => {
      const outsider = await addMember(h, (await createTenant(h)).id, { roles: ['TEACHER'] });
      const res = await http(h)
        .put(`/attendance/sections/${s.sectionB}/teachers`)
        .set(bearer(s.admin))
        .send({ teachers: [{ userId: outsider.userId, isClassTeacher: false }] })
        .expect(422);
      expect(res.body.code).toBe('NOT_STAFF');
      await http(h)
        .put(`/attendance/sections/${s.sectionB}/teachers`)
        .set(bearer(s.teacher))
        .send({ teachers: [] })
        .expect(403);
    });

    it('holiday CRUD is audited', async () => {
      const created = await http(h)
        .post('/attendance/holidays')
        .set(bearer(s.admin))
        .send({
          startDate: '2026-12-16',
          endDate: '2026-12-16',
          nameBn: 'বিজয় দিবস',
          nameEn: 'Victory Day',
        })
        .expect(201);
      await http(h)
        .post('/attendance/holidays')
        .set(bearer(s.admin))
        .send({ startDate: '2026-12-17', endDate: '2026-12-16', nameBn: 'x', nameEn: 'x' })
        .expect(400);
      const list = await http(h)
        .get('/attendance/holidays')
        .query({ year: 2026 })
        .set(bearer(s.teacher))
        .expect(200);
      expect(list.body.map((x: { nameEn: string }) => x.nameEn)).toContain('Victory Day');
      await http(h)
        .delete(`/attendance/holidays/${created.body.id}`)
        .set(bearer(s.admin))
        .expect(204);
      const audit = await auditRows(s.tenantId, created.body.id);
      expect(audit.map((a) => a.action)).toEqual(['CREATE', 'DELETE']);
    });
  });

  describe('platform SMS log (OTP)', () => {
    it('logs each OTP send without the code, for cost tracking', async () => {
      const t = await createTenant(h);
      const { phone } = await addMember(h, t.id);
      await otpLogin(h, phone);
      // Read as the schema owner: the app role may only insert.
      await vi.waitFor(
        async () => {
          const rows = await owner.$queryRaw<{ n: bigint }[]>`
            SELECT count(*) AS n FROM platform_sms_logs WHERE phone = ${phone} AND purpose = 'OTP' AND status = 'SENT'`;
          if (rows[0]!.n < 1n) throw new Error('not yet');
        },
        { timeout: 5_000, interval: 25 },
      );
      const columns = await owner.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns WHERE table_name = 'platform_sms_logs'`;
      expect(columns.map((c) => c.column_name)).not.toContain('body');
    });
  });
});

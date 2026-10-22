import { randomUUID } from 'node:crypto';
import { withTenant } from '@jantrik/db';
import {
  addDays,
  dateToDb,
  todayIn,
  type AttendanceRegisterReport,
  type AttendanceStaffMember,
  type AttendanceStatus,
  type AttendanceTodayReport,
  type AttendanceTrendReport,
  type ChildAttendanceMonth,
  type SendHeldSmsResult,
  type StudentAttendanceReport,
} from '@jantrik/shared';
import type { Redis } from 'ioredis';
import { REDIS } from '../src/redis/redis.constants.js';
import { SmsProcessor } from '../src/sms/sms.service.js';
import { heldTenantsKey } from '../src/sms/tenant-sms.service.js';
import {
  addMember,
  bearer,
  createHarness,
  createTenant,
  http,
  otpLogin,
  type Harness,
} from './support/harness.js';
import { platform, platformAdminCookie } from './support/platform.js';
import { school, type School } from './support/school.js';

const TODAY = () => todayIn('Asia/Dhaka');

describe('attendance reports', () => {
  let h: Harness;
  let s: School;
  const yesterday = () => addDays(TODAY(), -1);

  const submit = (
    token: string,
    sectionId: string,
    students: { id: string }[],
    statuses: AttendanceStatus[],
    extra: { date?: string; baseVersion?: number; periodNo?: number } = {},
  ) =>
    http(h)
      .put('/attendance/sessions')
      .set(bearer(token))
      .send({
        sectionId,
        date: TODAY(),
        baseVersion: 0,
        submissionId: randomUUID(),
        records: students.map((st, i) => ({ studentId: st.id, status: statuses[i] })),
        ...extra,
      });

  const smsLogs = (tenantId: string) =>
    withTenant(h.prisma, tenantId, (tx) => tx.smsLog.findMany({ orderBy: { createdAt: 'asc' } }));

  beforeAll(async () => {
    h = await createHarness();
    s = await school(h, { settings: { absentSmsEnabled: false } });
    // Yesterday (admin: outside the teacher's window) and today (teacher).
    await submit(s.admin, s.sectionA, s.a, ['PRESENT', 'LEAVE', 'ABSENT'], {
      date: yesterday(),
    }).expect(200);
    await submit(s.teacher, s.sectionA, s.a, ['PRESENT', 'LATE', 'ABSENT']).expect(200);
  });

  afterAll(() => h.close());

  describe('today', () => {
    it("every section's first register, absent students by roll, totals", async () => {
      const r = (await http(h).get('/attendance/reports/today').set(bearer(s.admin)).expect(200))
        .body as AttendanceTodayReport;
      expect(r.today).toBe(TODAY());
      expect(r.sections.map((x) => x.section.name)).toEqual(['A', 'B']);
      const [a, b] = r.sections;
      expect(a!.register).toMatchObject({
        periodNo: 0,
        counts: { present: 1, absent: 1, late: 1, leave: 0 },
        absent: [{ id: s.a[2]!.id, roll: 3, streak: 2 }],
      });
      expect(a!.register!.percent).toBeCloseTo((2 / 3) * 100);
      expect(b!.register).toBeNull();
      expect(r.totals).toMatchObject({ sectionsTotal: 2, sectionsTaken: 1 });
    });

    it('teachers see only their sections', async () => {
      const mine = (await http(h).get('/attendance/reports/today').set(bearer(s.teacher)))
        .body as AttendanceTodayReport;
      expect(mine.sections.map((x) => x.section.id)).toEqual([s.sectionA]);
      const other = (await http(h).get('/attendance/reports/today').set(bearer(s.otherTeacher)))
        .body as AttendanceTodayReport;
      expect(other.sections).toEqual([]);
    });
  });

  describe('trend and absence streaks', () => {
    const day = (n: number) => addDays(TODAY(), n);
    const trend = (token: string, query: Record<string, string | number> = {}) =>
      http(h).get('/attendance/reports/trend').query(query).set(bearer(token));

    /**
     * Section A over five days (day -1 has no register): student 1 absent today and on day -2,
     * present on day -3; student 2 absent today, on leave day -2, absent day -3, present day -4.
     */
    const streakSchool = async (leaveCountsAsAbsent: boolean) => {
      const t = await school(h, { settings: { absentSmsEnabled: false, leaveCountsAsAbsent } });
      const days: [number, AttendanceStatus[]][] = [
        [-4, ['ABSENT', 'PRESENT', 'PRESENT']],
        [-3, ['PRESENT', 'ABSENT', 'PRESENT']],
        [-2, ['ABSENT', 'LEAVE', 'PRESENT']],
        [0, ['ABSENT', 'ABSENT', 'PRESENT']],
      ];
      for (const [n, statuses] of days) {
        await submit(t.admin, t.sectionA, t.a, statuses, { date: day(n) }).expect(200);
      }
      return t;
    };
    let t: School;

    beforeAll(async () => {
      t = await streakSchool(false);
    });

    const absentToday = async (token: string) => {
      const r = (await http(h).get('/attendance/reports/today').set(bearer(token)).expect(200))
        .body as AttendanceTodayReport;
      return r.sections[0]!.register!.absent.map((x) => [x.roll, x.streak]);
    };

    it('streak: school days absent in a row; a day without a register does not break it', async () => {
      expect(await absentToday(t.admin)).toEqual([
        [1, 2], // today and day -2 (day -1 had no register; present on day -3)
        [2, 1], // leave on day -2 ends it: this institute does not count leave as absent
      ]);
      expect(await absentToday(t.teacher)).toEqual([
        [1, 2],
        [2, 1],
      ]);
    });

    it('streak: leave counts when the institute counts leave as absent', async () => {
      const u = await streakSchool(true);
      expect(await absentToday(u.admin)).toEqual([
        [1, 2],
        [2, 3],
      ]);
      // Never before the year started (day -3 is then last year's).
      await withTenant(h.prisma, u.tenantId, (tx) =>
        tx.academicYear.updateMany({
          where: { isCurrent: true },
          data: { startDate: dateToDb(day(-2)) },
        }),
      );
      expect(await absentToday(u.admin)).toEqual([
        [1, 2],
        [2, 2],
      ]);
    });

    it("per-session institutes: the day's lowest period counts, whatever was sent first", async () => {
      const c = await school(h, {
        instituteTypeKey: 'COACHING',
        settings: { absentSmsEnabled: false },
      });
      // Yesterday: student 1 absent in period 1, everyone present in period 2.
      await submit(c.admin, c.sectionA, c.a, ['ABSENT', 'PRESENT', 'PRESENT'], {
        date: day(-1),
        periodNo: 1,
      }).expect(200);
      await submit(c.admin, c.sectionA, c.a, ['PRESENT', 'PRESENT', 'PRESENT'], {
        date: day(-1),
        periodNo: 2,
      }).expect(200);
      // Today: period 2 is sent before period 1.
      await submit(c.admin, c.sectionA, c.a, ['PRESENT', 'PRESENT', 'PRESENT'], {
        periodNo: 2,
      }).expect(200);
      await submit(c.admin, c.sectionA, c.a, ['ABSENT', 'ABSENT', 'PRESENT'], {
        periodNo: 1,
      }).expect(200);

      expect(await absentToday(c.admin)).toEqual([
        [1, 2],
        [2, 1],
      ]);
      const r = (await trend(c.admin, { days: 7 }).expect(200)).body as AttendanceTrendReport;
      expect(r.days.at(-2)!.counts).toEqual({ present: 2, absent: 1, late: 0, leave: 0 });
      expect(r.days.at(-1)!.counts).toEqual({ present: 1, absent: 2, late: 0, leave: 0 });
    });

    it("trend: each day's first registers together, every date listed, today last", async () => {
      const r = (await trend(t.admin, { days: 7 }).expect(200)).body as AttendanceTrendReport;
      expect(r).toMatchObject({ today: TODAY(), from: day(-6), to: TODAY() });
      expect(r.days.map((d) => d.date)).toEqual([-6, -5, -4, -3, -2, -1, 0].map(day));
      const at = (n: number) => r.days.find((d) => d.date === day(n))!;
      expect(at(-4)).toMatchObject({
        sectionsTaken: 1,
        counts: { present: 2, absent: 1, late: 0, leave: 0 },
      });
      expect(at(-4).percent).toBeCloseTo((2 / 3) * 100);
      // Leave is left out (this institute): 1 present of 2.
      expect(at(-2)).toMatchObject({ sectionsTaken: 1, percent: 50 });
      expect(at(-1)).toMatchObject({ sectionsTaken: 0, counts: null, percent: null });
      expect(at(0).percent).toBeCloseTo((1 / 3) * 100);
      // Without bySection there are no section lines.
      expect(r.sections).toEqual([]);
    });

    it('trend: one line per section with bySection; holidays are marked', async () => {
      await http(h)
        .post('/attendance/holidays')
        .set(bearer(t.admin))
        .send({ startDate: day(-1), endDate: day(-1), nameBn: 'ছুটি', nameEn: 'Holiday' })
        .expect(201);
      const r = (await trend(t.admin, { days: 7, bySection: 1 }).expect(200))
        .body as AttendanceTrendReport;
      expect(r.days.find((d) => d.date === day(-1))!.nonWorkingDay).toMatchObject({
        reason: 'HOLIDAY',
        nameEn: 'Holiday',
      });
      expect(r.sections.map((x) => x.section.name)).toEqual(['A', 'B']);
      expect(r.sections[1]!.days.every((d) => d.percent === null)).toBe(true);
      expect(r.sections[0]!.days.at(-1)!.counts).toEqual({
        present: 1,
        absent: 2,
        late: 0,
        leave: 0,
      });
    });

    it("trend: teachers get their own sections only; never another section's", async () => {
      const mine = (await trend(t.teacher, { days: 7, bySection: 'true' }).expect(200))
        .body as AttendanceTrendReport;
      expect(mine.sections.map((x) => x.section.id)).toEqual([t.sectionA]);
      expect(mine.days.at(-1)!.sectionsTaken).toBe(1);
      const one = (await trend(t.teacher, { days: 7, sectionId: t.sectionA }).expect(200))
        .body as AttendanceTrendReport;
      expect(one.days.at(-1)!.counts).toMatchObject({ present: 1, absent: 2 });

      await trend(t.teacher, { sectionId: t.sectionB }).expect(403);
      const none = (await trend(t.otherTeacher, { bySection: 1 }).expect(200))
        .body as AttendanceTrendReport;
      expect(none.sections).toEqual([]);
      expect(none.days.every((d) => d.counts === null && d.sectionsTaken === 0)).toBe(true);
    });

    it("trend: another institute's registers never count; its section is not found", async () => {
      // The first school took attendance today too; this one's today is its own register.
      const r = (await trend(t.admin, { days: 7 }).expect(200)).body as AttendanceTrendReport;
      expect(r.days.at(-1)!.counts).toEqual({ present: 1, absent: 2, late: 0, leave: 0 });
      await trend(t.admin, { sectionId: s.sectionA }).expect(404);
    });

    it('trend: a new institute has every day empty', async () => {
      const fresh = await school(h, { settings: { absentSmsEnabled: false } });
      const r = (await trend(fresh.admin, { bySection: 1 }).expect(200))
        .body as AttendanceTrendReport;
      expect(r.days).toHaveLength(30);
      expect(r.days.every((d) => d.counts === null && d.percent === null)).toBe(true);
      expect(r.sections.map((x) => x.section.name)).toEqual(['A', 'B']);
    });

    it('trend: never before the year started; 7 to 90 days; attendance staff only', async () => {
      await withTenant(h.prisma, t.tenantId, (tx) =>
        tx.academicYear.updateMany({
          where: { isCurrent: true },
          data: { startDate: dateToDb(day(-2)) },
        }),
      );
      const r = (await trend(t.admin, { days: 30 }).expect(200)).body as AttendanceTrendReport;
      expect(r.from).toBe(day(-2));
      expect(r.days.map((d) => d.date)).toEqual([day(-2), day(-1), TODAY()]);

      await trend(t.admin, { days: 6 }).expect(400);
      await trend(t.admin, { days: 91 }).expect(400);
      await trend(t.admin, { sectionId: 'not-a-uuid' }).expect(400);

      // Without the attendance module: refused.
      const plain = await createTenant(h, { modules: [] });
      const owner = await otpLogin(h, (await addMember(h, plain.id, { roles: ['OWNER'] })).phone);
      await trend(owner.accessToken).expect(403);
      // Guardians: refused.
      const g = await addMember(h, t.tenantId, { roles: ['GUARDIAN'] });
      await trend((await otpLogin(h, g.phone)).accessToken).expect(403);
    });
  });

  describe('monthly register', () => {
    const month = () => TODAY().slice(0, 7);

    it('students × days with per-student and per-day totals', async () => {
      const r = (
        await http(h)
          .get('/attendance/reports/register')
          .query({ sectionId: s.sectionA, month: month() })
          .set(bearer(s.teacher))
          .expect(200)
      ).body as AttendanceRegisterReport;
      expect(r.days.length).toBeGreaterThanOrEqual(28);
      expect(r.days.find((d) => d.date === TODAY())!.taken).toBe(true);
      expect(r.rows.map((x) => x.roll)).toEqual([1, 2, 3]);
      expect(r.rows[2]!.cells[TODAY()]).toBe('ABSENT');
      expect(r.dayTotals[TODAY()]).toEqual({ present: 1, absent: 1, late: 1, leave: 0 });
      if (yesterday().startsWith(month())) {
        expect(r.daysTaken).toBe(2);
        expect(r.rows[1]!.counts).toEqual({ present: 0, absent: 0, late: 1, leave: 1 });
        expect(r.rows[1]!.percent).toBe(100); // LEAVE left out, LATE present
      }
    });

    it('CSV: UTF-8 BOM, ASCII digits, Bangla or English codes', async () => {
      const res = await http(h)
        .get('/attendance/reports/register/csv')
        .query({ sectionId: s.sectionA, month: month(), locale: 'bn' })
        .set(bearer(s.teacher))
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="attendance-${month()}.csv"`,
      );
      const bytes = res.body as Buffer;
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const lines = bytes.toString('utf8').slice(1).split('\r\n');
      expect(lines[0]).toMatch(/^রোল,আইডি,নাম,/);
      expect(lines[3]).toMatch(/^3,S-[^,]+,ছাত্র 3,.*অ/);
      expect(bytes.toString('utf8')).not.toMatch(/[০-৯]/);

      const en = await http(h)
        .get('/attendance/reports/register/csv')
        .query({ sectionId: s.sectionA, month: month(), locale: 'en' })
        .set(bearer(s.teacher))
        .expect(200);
      expect(en.text.split('\r\n')[2]).toMatch(/^2,S-[^,]+,Student 2,.*L/);
    });

    it("another section's teacher is refused; bad month is 400", async () => {
      await http(h)
        .get('/attendance/reports/register')
        .query({ sectionId: s.sectionA, month: month() })
        .set(bearer(s.otherTeacher))
        .expect(403);
      await http(h)
        .get('/attendance/reports/register')
        .query({ sectionId: s.sectionA, month: '2026-13' })
        .set(bearer(s.admin))
        .expect(400);
    });
  });

  describe('one student over a date range', () => {
    it('present % with the LEAVE rule, newest day first', async () => {
      const r = (
        await http(h)
          .get(`/attendance/reports/students/${s.a[1]!.id}`)
          .query({ from: yesterday(), to: TODAY() })
          .set(bearer(s.teacher))
          .expect(200)
      ).body as StudentAttendanceReport;
      expect(r.student).toMatchObject({ roll: 2, section: { id: s.sectionA } });
      expect(r.daysTaken).toBe(2);
      expect(r.counts).toEqual({ present: 0, absent: 0, late: 1, leave: 1 });
      expect(r.percent).toBe(100);
      expect(r.days.map((d) => [d.date, d.status])).toEqual([
        [TODAY(), 'LATE'],
        [yesterday(), 'LEAVE'],
      ]);
    });

    it('only for staff of that section; a year at most', async () => {
      await http(h)
        .get(`/attendance/reports/students/${s.a[1]!.id}`)
        .query({ from: yesterday(), to: TODAY() })
        .set(bearer(s.otherTeacher))
        .expect(403);
      await http(h)
        .get(`/attendance/reports/students/${s.a[1]!.id}`)
        .query({ from: '2024-01-01', to: TODAY() })
        .set(bearer(s.admin))
        .expect(400);
    });
  });

  describe('guardian calendar', () => {
    let guardian: string;

    beforeAll(async () => {
      // The primary guardian of student 3 gets a login (as the institute would invite them).
      const m = await addMember(h, s.tenantId, { phone: s.a[2]!.phone, roles: ['GUARDIAN'] });
      await withTenant(h.prisma, s.tenantId, (tx) =>
        tx.guardian.updateMany({ where: { phone: s.a[2]!.phone }, data: { userId: m.userId } }),
      );
      guardian = (await otpLogin(h, m.phone)).accessToken;
    });

    it('their own child: every day of the month with status and off days', async () => {
      const r = (
        await http(h).get(`/me/children/${s.a[2]!.id}/attendance`).set(bearer(guardian)).expect(200)
      ).body as ChildAttendanceMonth;
      expect(r.month).toBe(TODAY().slice(0, 7));
      expect(r.days[0]!.date).toBe(`${r.month}-01`);
      expect(r.days.find((d) => d.date === TODAY())!.status).toBe('ABSENT');
      expect(r.counts.absent).toBeGreaterThanOrEqual(1);
      expect(r.percent).toBe(0);
    });

    it("never another child; staff can't use it", async () => {
      await http(h).get(`/me/children/${s.a[0]!.id}/attendance`).set(bearer(guardian)).expect(404);
      await http(h).get(`/me/children/${s.a[2]!.id}/attendance`).set(bearer(s.admin)).expect(403);
    });
  });

  it('staff list for assigning sections (admin only)', async () => {
    const staff = (await http(h).get('/attendance/staff').set(bearer(s.admin)).expect(200))
      .body as AttendanceStaffMember[];
    expect(staff.map((m) => m.role)).toEqual(['ADMIN', 'TEACHER', 'TEACHER']);
    await http(h).get('/attendance/staff').set(bearer(s.teacher)).expect(403);
  });

  describe('held SMS', () => {
    it("an admin sends today's held SMS; a student no longer absent is cancelled", async () => {
      const t = await school(h, { settings: { dailySmsCap: 1 } });
      const first = await submit(t.teacher, t.sectionA, t.a, ['ABSENT', 'ABSENT', 'ABSENT']);
      expect(first.status).toBe(200);
      const held = (await smsLogs(t.tenantId)).filter((l) => l.status === 'HELD_OVER_LIMIT');
      expect(held).toHaveLength(2);
      // One of the held students was marked absent by mistake.
      const corrected = held[0]!.relatedId!;
      await submit(
        t.teacher,
        t.sectionA,
        t.a,
        t.a.map((st) => (st.id === corrected ? 'PRESENT' : 'ABSENT')),
        { baseVersion: (first.body as { session: { version: number } }).session.version },
      ).expect(200);

      await http(h).post('/attendance/sms/held/send').set(bearer(t.teacher)).expect(403);
      const res = (await http(h).post('/attendance/sms/held/send').set(bearer(t.admin)).expect(200))
        .body as SendHeldSmsResult;
      expect(res).toEqual({ queued: 1, cancelled: 1, stillHeld: 0, platformLimit: null });

      await vi.waitFor(
        async () => {
          const l = (await smsLogs(t.tenantId)).find((x) => x.id === held[1]!.id)!;
          if (l.status !== 'SENT') throw new Error('not yet');
        },
        { timeout: 5_000, interval: 25 },
      );
      expect(h.sms.sentTo(held[1]!.phone)).toHaveLength(1);
      expect(h.sms.sentTo(held[0]!.phone)).toEqual([]);
      expect((await smsLogs(t.tenantId)).find((x) => x.id === held[0]!.id)!.status).toBe(
        'CANCELLED',
      );
      const audit = await withTenant(h.prisma, t.tenantId, (tx) =>
        tx.auditLog.findMany({ where: { entity: 'sms_logs' } }),
      );
      expect(audit).toHaveLength(1);
      // Nothing left to send.
      expect(
        (await http(h).post('/attendance/sms/held/send').set(bearer(t.admin)).expect(200)).body,
      ).toEqual({ queued: 0, cancelled: 0, stillHeld: 0, platformLimit: null });
    });

    it("sending held SMS never passes Jantrik's ceiling for the day", async () => {
      const t = await school(h, { settings: { dailySmsCap: 1 } });
      await platform(h, await platformAdminCookie(h))
        .put(`/platform/institutes/${t.tenantId}/limits`)
        .send({ studentLimit: null, smsDailyCap: 2 })
        .expect(200);
      await submit(t.teacher, t.sectionA, t.a, ['ABSENT', 'ABSENT', 'ABSENT']).expect(200);
      expect(
        (await smsLogs(t.tenantId)).filter((l) => l.status === 'HELD_OVER_LIMIT'),
      ).toHaveLength(2);
      const res = (await http(h).post('/attendance/sms/held/send').set(bearer(t.admin)).expect(200))
        .body as SendHeldSmsResult;
      expect(res).toEqual({ queued: 1, cancelled: 0, stillHeld: 1, platformLimit: 2 });
      const logs = await smsLogs(t.tenantId);
      expect(logs.filter((l) => l.status === 'HELD_OVER_LIMIT')).toHaveLength(1);
      expect(logs.filter((l) => l.status !== 'HELD_OVER_LIMIT')).toHaveLength(2);
    });

    it('held SMS of an earlier day expire (daily job) and are never sent', async () => {
      const t = await school(h, { settings: { dailySmsCap: 0 } });
      await submit(t.teacher, t.sectionA, t.a, ['ABSENT', 'PRESENT', 'PRESENT']).expect(200);
      const redis = h.app.get<Redis>(REDIS);
      expect(await redis.sismember(heldTenantsKey(TODAY()), t.tenantId)).toBe(1);
      // Pretend it was held yesterday (the job runs just after midnight).
      await withTenant(h.prisma, t.tenantId, (tx) =>
        tx.smsLog.updateMany({ data: { localDate: dateToDb(yesterday()) } }),
      );
      await redis.sadd(heldTenantsKey(yesterday()), t.tenantId);

      await h.app.get(SmsProcessor).expireHeld();
      const [log] = await smsLogs(t.tenantId);
      expect(log!.status).toBe('EXPIRED');
      expect(await redis.sismember(heldTenantsKey(yesterday()), t.tenantId)).toBe(0);
      // Not today's: the admin's "send held" does not touch it.
      expect(
        (await http(h).post('/attendance/sms/held/send').set(bearer(t.admin)).expect(200)).body,
      ).toEqual({ queued: 0, cancelled: 0, stillHeld: 0, platformLimit: null });
      expect(h.sms.sentTo(log!.phone)).toEqual([]);
    });

    it('also expired on the next read if the job did not run', async () => {
      const t = await school(h, { settings: { dailySmsCap: 0 } });
      await submit(t.teacher, t.sectionA, t.a, ['ABSENT', 'PRESENT', 'PRESENT']).expect(200);
      await withTenant(h.prisma, t.tenantId, (tx) =>
        tx.smsLog.updateMany({ data: { localDate: dateToDb(yesterday()) } }),
      );
      await http(h).get('/attendance/sms/today').set(bearer(t.admin)).expect(200);
      expect((await smsLogs(t.tenantId))[0]!.status).toBe('EXPIRED');
    });
  });
});

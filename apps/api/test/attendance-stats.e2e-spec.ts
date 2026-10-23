import { randomUUID } from 'node:crypto';
import {
  addDays,
  todayIn,
  type AttendanceStatus,
  type StudentAttendanceReport,
} from '@jantrik/shared';
import { AttendanceStatsService } from '../src/attendance/attendance-stats.service.js';
import { TenantJobRunner } from '../src/tenancy/tenant-job-runner.service.js';
import { bearer, createHarness, http, type Harness } from './support/harness.js';
import { school, type School } from './support/school.js';

const TODAY = () => todayIn('Asia/Dhaka');

/** Attendance % for many students at once (report cards); same rule as the per-student report. */
describe('attendance stats for other modules', () => {
  let h: Harness;

  const submit = (
    s: School,
    statuses: AttendanceStatus[],
    extra: { date: string; periodNo?: number },
  ) =>
    http(h)
      .put('/attendance/sessions')
      .set(bearer(s.admin))
      .send({
        sectionId: s.sectionA,
        baseVersion: 0,
        submissionId: randomUUID(),
        records: s.a.map((st, i) => ({ studentId: st.id, status: statuses[i] })),
        ...extra,
      })
      .expect(200);

  const report = async (s: School, studentId: string, from: string, to: string) =>
    (
      await http(h)
        .get(`/attendance/reports/students/${studentId}`)
        .query({ from, to })
        .set(bearer(s.admin))
        .expect(200)
    ).body as StudentAttendanceReport;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('matches the per-student report for every student, with the LEAVE rule', async () => {
    for (const leaveCountsAsAbsent of [false, true]) {
      const s = await school(h, { settings: { absentSmsEnabled: false, leaveCountsAsAbsent } });
      const day = (n: number) => addDays(TODAY(), n);
      await submit(s, ['PRESENT', 'LEAVE', 'ABSENT'], { date: day(-3) });
      await submit(s, ['LATE', 'ABSENT', 'ABSENT'], { date: day(-2) });
      await submit(s, ['PRESENT', 'PRESENT', 'LEAVE'], { date: day(-1) });
      const from = day(-3);
      const to = TODAY();

      const stats = await h.app.get(TenantJobRunner).run(s.tenantId, () =>
        h.app.get(AttendanceStatsService).percentByStudent(
          s.a.map((x) => x.id),
          from,
          to,
        ),
      );
      for (const st of s.a) {
        const r = await report(s, st.id, from, to);
        expect(stats.get(st.id)).toEqual({ counts: r.counts, percent: r.percent });
      }
    }
  });

  it("per-session institutes: each day's lowest period counts", async () => {
    const c = await school(h, {
      instituteTypeKey: 'COACHING',
      settings: { absentSmsEnabled: false },
    });
    const date = addDays(TODAY(), -1);
    await submit(c, ['ABSENT', 'PRESENT', 'PRESENT'], { date, periodNo: 2 });
    await submit(c, ['PRESENT', 'ABSENT', 'PRESENT'], { date, periodNo: 1 });
    const stats = await h.app.get(TenantJobRunner).run(c.tenantId, () =>
      h.app.get(AttendanceStatsService).percentByStudent(
        c.a.map((x) => x.id),
        date,
        date,
      ),
    );
    expect(stats.get(c.a[0]!.id)).toEqual({
      counts: { present: 1, absent: 0, late: 0, leave: 0 },
      percent: 100,
    });
    expect(stats.get(c.a[1]!.id)).toEqual({
      counts: { present: 0, absent: 1, late: 0, leave: 0 },
      percent: 0,
    });
  });

  it('a student with no registers gets empty counts and no percent; no ids, empty map', async () => {
    const s = await school(h, { settings: { absentSmsEnabled: false } });
    const runner = h.app.get(TenantJobRunner);
    const stats = h.app.get(AttendanceStatsService);
    const one = await runner.run(s.tenantId, () =>
      stats.percentByStudent([s.b[0]!.id], TODAY(), TODAY()),
    );
    expect(one.get(s.b[0]!.id)).toEqual({
      counts: { present: 0, absent: 0, late: 0, leave: 0 },
      percent: null,
    });
    const none = await runner.run(s.tenantId, () => stats.percentByStudent([], TODAY(), TODAY()));
    expect(none.size).toBe(0);
  });
});

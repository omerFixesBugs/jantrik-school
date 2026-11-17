import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { withTenant } from '@jantrik/db';
import {
  DEVICE_SETTINGS_DEFAULTS,
  smsLength,
  type BroadcastAlert,
  type BroadcastPreview,
  type BroadcastView,
} from '@jantrik/shared';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BroadcastsService,
  NOTICES_DUE_KEY,
  NOTICES_QUEUE,
  broadcastJobId,
} from '../src/notices/broadcasts.service.js';
import { NoticesProcessor } from '../src/notices/notices.processor.js';
import { TenantSmsService } from '../src/sms/tenant-sms.service.js';
import { TenantJobRunner } from '../src/tenancy/tenant-job-runner.service.js';
import { FakeClock } from './support/clock.js';
import {
  addMember,
  bearer,
  createHarness,
  createTenant,
  http,
  otpLogin,
  randomPhone,
  type Harness,
} from './support/harness.js';

/** A Dhaka wall clock (UTC+6). */
const dhaka = (local: string) => new Date(`${local}+06:00`);

// SMS broadcasts (sprint 1 P6b): the preview (recipients after merging, without phone, segments,
// cost, the cap left), all or nothing over the cap (review focus 1), the job run twice or lost
// (2), quiet hours (3), the audience at send time and the admin's role (4), roles, audit.
describe('SMS broadcasts', () => {
  const clock = new FakeClock(dhaka('2026-11-17T10:00:00'));
  let h: Harness;
  let tenantId: string;
  let admin: string;
  let adminUserId: string;
  let teacher: string;
  let class1: string;
  let class2: string;
  let secKa: string;
  let otherAdmin: string;
  let rate: number;
  /** Phones: a shared primary guardian of two siblings in 1 ক, a second guardian of one of them,
   * a primary guardian in 1 খ, one in class 2. One student in 1 ক has no guardian. */
  const p = {
    siblings: randomPhone(),
    second: randomPhone(),
    kha: randomPhone(),
    c2: randomPhone(),
  };

  const api = (token: string) => ({
    get: (path: string) => http(h).get(path).set(bearer(token)),
    post: (path: string, body: object = {}) => http(h).post(path).set(bearer(token)).send(body),
    put: (path: string, body: object) => http(h).put(path).set(bearer(token)).send(body),
  });
  const create = async (body: object): Promise<BroadcastView> =>
    (await api(admin).post('/broadcasts', body).expect(201)).body as BroadcastView;
  const preview = async (id: string): Promise<BroadcastPreview> =>
    (await api(admin).post(`/broadcasts/${id}/preview`).expect(200)).body as BroadcastPreview;
  /** What the admin confirms: the preview's count and token (B1). */
  const confirm = async (id: string) => {
    const pv = await preview(id);
    return { expectedRecipients: pv.recipients, previewToken: pv.token };
  };
  const setCap = (dailySmsCap: number) =>
    api(admin)
      .put('/attendance/settings', {
        mode: 'DAILY',
        weeklyOffDays: [],
        editWindowDays: 0,
        leaveCountsAsAbsent: false,
        absentSmsEnabled: false,
        absentSmsTemplate: null,
        absentSmsDelayMinutes: 0,
        dailySmsCap,
        ...DEVICE_SETTINGS_DEFAULTS,
      })
      .expect(200);
  const logsOf = (id: string) =>
    withTenant(h.prisma, tenantId, (tx) =>
      tx.smsLog.findMany({
        where: { relatedEntity: `broadcast:${id}` },
        orderBy: { phone: 'asc' },
      }),
    );
  const statusOf = async (id: string) =>
    ((await api(admin).get(`/broadcasts/${id}`).expect(200)).body as BroadcastView).status;
  const processor = () => h.app.get(NoticesProcessor);
  const queue = () => h.app.get<Queue>(getQueueToken(NOTICES_QUEUE));
  const due = (id: string) => h.redis.zscore(NOTICES_DUE_KEY, `${tenantId}|${id}`);

  async function enrol(classLevelId: string, sectionId: string | null, phones: string[]) {
    return withTenant(h.prisma, tenantId, async (tx) => {
      const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
      const s = await tx.student.create({
        data: { tenantId, studentCode: `B-${randomUUID().slice(0, 8)}`, nameEn: 'Child' },
      });
      await tx.enrolment.create({
        data: { tenantId, studentId: s.id, academicYearId: year.id, classLevelId, sectionId },
      });
      for (const [i, phone] of phones.entries()) {
        const g =
          (await tx.guardian.findFirst({ where: { phone } })) ??
          (await tx.guardian.create({ data: { tenantId, nameEn: 'Parent', phone } }));
        await tx.studentGuardian.create({
          data: {
            tenantId,
            studentId: s.id,
            guardianId: g.id,
            relation: 'FATHER',
            isPrimary: i === 0,
          },
        });
      }
      return s.id;
    });
  }

  beforeAll(async () => {
    h = await createHarness({ clock });
    tenantId = (await createTenant(h, { modules: ['ATTENDANCE'] })).id;
    ({ class1, class2, secKa } = await withTenant(h.prisma, tenantId, async (tx) => {
      const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
      const [c1, c2] = await tx.classLevel.findMany({ orderBy: { sortOrder: 'asc' }, take: 2 });
      const ka = await tx.section.create({
        data: { tenantId, academicYearId: year.id, classLevelId: c1!.id, name: 'ক' },
      });
      await tx.section.create({
        data: { tenantId, academicYearId: year.id, classLevelId: c1!.id, name: 'খ' },
      });
      return { class1: c1!.id, class2: c2!.id, secKa: ka.id };
    }));
    const secKha = (
      await withTenant(h.prisma, tenantId, (tx) =>
        tx.section.findFirstOrThrow({ where: { name: 'খ' } }),
      )
    ).id;
    await enrol(class1, secKa, [p.siblings, p.second]);
    await enrol(class1, secKa, [p.siblings]);
    await enrol(class1, secKa, []);
    await enrol(class1, secKha, [p.kha]);
    await enrol(class2, null, [p.c2]);
    const a = await addMember(h, tenantId, { roles: ['ADMIN'] });
    adminUserId = a.userId;
    admin = (await otpLogin(h, a.phone)).accessToken;
    teacher = (await otpLogin(h, (await addMember(h, tenantId, { roles: ['TEACHER'] })).phone))
      .accessToken;
    const other = await createTenant(h);
    otherAdmin = (await otpLogin(h, (await addMember(h, other.id, { roles: ['ADMIN'] })).phone))
      .accessToken;
    await setCap(1000);
    const [row] = await h.prisma.$queryRaw<{ rate: number }[]>`
      SELECT sms_cost_per_segment_paisa AS rate FROM platform_settings`;
    rate = Number(row?.rate ?? 0);
  });

  afterAll(async () => {
    await h?.close();
  });

  it('preview: siblings merged, without phone counted, every guardian, staff once; cost', async () => {
    clock.set(dhaka('2026-11-17T10:00:00'));
    const body =
      'প্রিয় অভিভাবক, আগামীকাল স্কুল বন্ধ থাকবে। কাল সকাল থেকে পরীক্ষা শুরু হবে, সবাই সময়মতো আসবে।';
    const primary = await preview((await create({ body, recipients: 'PRIMARY_GUARDIANS' })).id);
    const { segments } = smsLength(body);
    expect(segments).toBeGreaterThanOrEqual(2);
    expect(primary).toMatchObject({
      recipients: 3,
      mergedPhones: 1,
      withoutPhone: 1,
      segments,
      encoding: 'UCS2',
      costPaisa: 3 * segments * rate,
      fits: true,
      quietNow: false,
    });
    expect(
      (await preview((await create({ body, recipients: 'ALL_GUARDIANS' })).id)).recipients,
    ).toBe(4);
    expect(
      (await preview((await create({ body: 'Meeting at 3', recipients: 'STAFF' })).id)).recipients,
    ).toBe(2);
    // Targets: section ক of class 1 only (the siblings' shared phone; one child without).
    const ka = await create({
      body: 'x',
      recipients: 'PRIMARY_GUARDIANS',
      targets: [{ classLevelId: class1, sectionId: secKa }],
    });
    expect(await preview(ka.id)).toMatchObject({ recipients: 1, mergedPhones: 1, withoutPhone: 1 });
  });

  it('refused: 4 segments, targets on a staff broadcast, teachers, another institute', async () => {
    const long = await api(admin)
      .post('/broadcasts', { body: 'ক'.repeat(202), recipients: 'STAFF' })
      .expect(422);
    expect(long.body.code).toBe('SMS_TOO_LONG');
    const t = await api(admin)
      .post('/broadcasts', { body: 'x', recipients: 'STAFF', targets: [{ classLevelId: class1 }] })
      .expect(422);
    expect(t.body.code).toBe('TARGET_INVALID');
    await api(teacher).post('/broadcasts', { body: 'x', recipients: 'STAFF' }).expect(403);
    await api(teacher).get('/broadcasts').expect(403);
    const mine = await create({ body: 'x', recipients: 'STAFF' });
    await api(otherAdmin).get(`/broadcasts/${mine.id}`).expect(404);
    await api(otherAdmin).post(`/broadcasts/${mine.id}/preview`).expect(404);
  });

  it('review focus 1: the cap left is 2 and the audience 3: refused, nothing stored', async () => {
    clock.set(dhaka('2026-11-17T11:00:00'));
    const b = await create({ body: 'Fees due', recipients: 'PRIMARY_GUARDIANS' });
    const used = await withTenant(h.prisma, tenantId, (tx) =>
      tx.smsLog.count({ where: { status: { in: ['QUEUED', 'SENT'] } } }),
    );
    await setCap(used + 2);
    const pv = await preview(b.id);
    expect(pv).toMatchObject({ recipients: 3, capLeftToday: 2, fits: false });
    const res = await api(admin)
      .post(`/broadcasts/${b.id}/send`, await confirm(b.id))
      .expect(422);
    expect(res.body).toMatchObject({ code: 'OVER_CAP', needed: 3, capLeft: 2 });
    expect(await logsOf(b.id)).toEqual([]);
    expect(await statusOf(b.id)).toBe('DRAFT');
    await setCap(1000);
  });

  it('a changed count is 409 PREVIEW_CHANGED; quiet hours and the schedule window', async () => {
    clock.set(dhaka('2026-11-17T10:00:00'));
    const b = await create({ body: 'Sports day', recipients: 'STAFF' });
    const changed = await api(admin)
      .post(`/broadcasts/${b.id}/send`, { ...(await confirm(b.id)), expectedRecipients: 5 })
      .expect(409);
    expect(changed.body).toMatchObject({ code: 'PREVIEW_CHANGED', recipients: 2 });
    // Scheduling at 22:00 Dhaka: refused with the next allowed time.
    const night = await api(admin)
      .post(`/broadcasts/${b.id}/schedule`, {
        scheduledAt: '2026-11-17T22:00:00+06:00',
        ...(await confirm(b.id)),
      })
      .expect(422);
    expect(night.body).toMatchObject({
      code: 'QUIET_HOURS',
      nextAllowedAt: dhaka('2026-11-18T08:00:00').toISOString(),
    });
    for (const at of [
      new Date(clock.now().getTime() + 3 * 60_000),
      new Date(clock.now().getTime() + 31 * 86_400_000),
    ]) {
      const r = await api(admin)
        .post(`/broadcasts/${b.id}/schedule`, {
          scheduledAt: at.toISOString(),
          ...(await confirm(b.id)),
        })
        .expect(422);
      expect(r.body.code).toBe('SCHEDULE_OUT_OF_RANGE');
    }
    // Send now at 21:30 → refused; at 08:00 → accepted.
    clock.set(dhaka('2026-11-17T21:30:00'));
    const quiet = await api(admin)
      .post(`/broadcasts/${b.id}/send`, await confirm(b.id))
      .expect(422);
    expect(quiet.body.code).toBe('QUIET_HOURS');
    clock.set(dhaka('2026-11-18T08:00:00'));
    await api(admin)
      .post(`/broadcasts/${b.id}/send`, await confirm(b.id))
      .expect(200);
    // The worker sends it now: one SMS per staff phone.
    await expect.poll(() => statusOf(b.id), { timeout: 10_000 }).toBe('SENT');
    expect((await logsOf(b.id)).map((l) => l.purpose)).toEqual(['BROADCAST', 'BROADCAST']);
    // A sent broadcast cannot be cancelled or edited.
    expect((await api(admin).post(`/broadcasts/${b.id}/cancel`).expect(409)).body.code).toBe(
      'NOT_EDITABLE',
    );
    await api(admin).put(`/broadcasts/${b.id}`, { body: 'y', recipients: 'STAFF' }).expect(409);
  });

  it('cancel a scheduled one: the job and the due entry go, nothing is sent; audit has no phones', async () => {
    clock.set(dhaka('2026-11-18T10:00:00'));
    const b = await create({ body: 'Trip', recipients: 'PRIMARY_GUARDIANS' });
    await api(admin)
      .post(`/broadcasts/${b.id}/schedule`, {
        scheduledAt: '2026-11-18T12:00:00+06:00',
        ...(await confirm(b.id)),
      })
      .expect(200);
    expect(await queue().getJob(broadcastJobId(b.id))).toBeTruthy();
    expect(await due(b.id)).not.toBeNull();
    const cancelled = (await api(admin).post(`/broadcasts/${b.id}/cancel`).expect(200))
      .body as BroadcastView;
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'BY_ADMIN' });
    await expect.poll(async () => (await queue().getJob(broadcastJobId(b.id))) ?? null).toBeNull();
    expect(await due(b.id)).toBeNull();
    clock.set(dhaka('2026-11-18T12:01:00'));
    await expect(processor().send({ tenantId, broadcastId: b.id })).resolves.toEqual({
      kind: 'STOP',
    });
    expect(await logsOf(b.id)).toEqual([]);
    const audits = await withTenant(h.prisma, tenantId, (tx) =>
      tx.auditLog.findMany({ where: { entity: 'sms_broadcast', entityId: b.id } }),
    );
    expect(audits.map((a) => (a.newValues as { status?: string }).status ?? 'CREATE')).toEqual(
      expect.arrayContaining(['SCHEDULED', 'CANCELLED']),
    );
    const json = JSON.stringify(audits);
    for (const phone of Object.values(p)) expect(json).not.toContain(phone.slice(-8));
    expect(json).toContain(`"estimatedCostPaisa":${3 * rate}`);
  });

  it('the job: one SMS per phone, safe to run twice; a lost job is re-added by the sweep', async () => {
    clock.set(dhaka('2026-11-19T10:00:00'));
    const b = await create({ body: 'বার্ষিক ক্রীড়া', recipients: 'ALL_GUARDIANS' });
    await api(admin)
      .post(`/broadcasts/${b.id}/schedule`, {
        scheduledAt: '2026-11-19T10:10:00+06:00',
        ...(await confirm(b.id)),
      })
      .expect(200);
    // Redis lost the job: removed by hand. The sweep re-adds it once it is due.
    await (await queue().getJob(broadcastJobId(b.id)))!.remove();
    clock.set(dhaka('2026-11-19T10:11:00'));
    expect(await h.app.get(BroadcastsService).sweep()).toBeGreaterThanOrEqual(1);
    await expect.poll(() => statusOf(b.id), { timeout: 10_000 }).toBe('SENT');
    const logs = await logsOf(b.id);
    expect(logs.map((l) => l.phone).sort()).toEqual([p.siblings, p.second, p.kha, p.c2].sort());
    expect(logs.every((l) => l.dedupeKey === `broadcast:${b.id}:${l.phone}`)).toBe(true);
    expect(logs.every((l) => l.segments === smsLength('বার্ষিক ক্রীড়া').segments)).toBe(true);
    await expect.poll(() => due(b.id)).toBeNull();
    // Run again (a retried job): nothing more is sent (it only checks the SMS jobs exist, B4).
    await expect(processor().send({ tenantId, broadcastId: b.id })).resolves.toEqual({
      kind: 'ALREADY_SENT',
    });
    expect(await logsOf(b.id)).toHaveLength(4);
  });

  it('review focus 3 and SF2: a wait for quiet hours never makes a broadcast more than 3 hours late', async () => {
    clock.set(dhaka('2026-11-20T20:00:00'));
    const b = await create({ body: 'Night', recipients: 'STAFF' });
    await api(admin)
      .post(`/broadcasts/${b.id}/schedule`, {
        scheduledAt: '2026-11-20T20:30:00+06:00',
        ...(await confirm(b.id)),
      })
      .expect(200);
    // Its job was lost; found at 23:20, under 3 hours late, but sending would wait until 08:00
    // (11.5 hours after its time): it expires instead of going out the next morning.
    clock.set(dhaka('2026-11-20T23:20:00'));
    await expect(processor().send({ tenantId, broadcastId: b.id })).resolves.toEqual({
      kind: 'EXPIRED',
    });
    expect(await logsOf(b.id)).toEqual([]);
    const view = (await api(admin).get(`/broadcasts/${b.id}`).expect(200)).body as BroadcastView;
    // The time shown is still the one the admin chose.
    expect(view).toMatchObject({
      status: 'EXPIRED',
      scheduledAt: dhaka('2026-11-20T20:30:00').toISOString(),
    });
    // N-a: an expired broadcast can be edited back into a draft and sent again.
    const again = (
      await api(admin)
        .put(`/broadcasts/${b.id}`, { body: 'Night', recipients: 'STAFF' })
        .expect(200)
    ).body as BroadcastView;
    expect(again).toMatchObject({ status: 'DRAFT', failure: null, scheduledAt: null });
  });

  it('review focus 1 and 4 at send time: the cap used up meanwhile; the audience then; the admin role', async () => {
    clock.set(dhaka('2026-11-22T10:00:00'));
    // The cap used up after scheduling: nothing at all is sent, and the dashboard says so.
    const capped = await create({ body: 'Capped', recipients: 'PRIMARY_GUARDIANS' });
    await api(admin)
      .post(`/broadcasts/${capped.id}/schedule`, {
        scheduledAt: '2026-11-22T10:30:00+06:00',
        ...(await confirm(capped.id)),
      })
      .expect(200);
    const used = await withTenant(h.prisma, tenantId, (tx) =>
      tx.smsLog.count({
        where: { localDate: new Date('2026-11-22'), status: { in: ['QUEUED', 'SENT'] } },
      }),
    );
    await setCap(used + 2);
    clock.set(dhaka('2026-11-22T10:31:00'));
    await expect(processor().send({ tenantId, broadcastId: capped.id })).resolves.toEqual({
      kind: 'FAILED_OVER_CAP',
    });
    expect(await logsOf(capped.id)).toEqual([]);
    const failed = (await api(admin).get(`/broadcasts/${capped.id}`).expect(200))
      .body as BroadcastView;
    expect(failed).toMatchObject({ status: 'FAILED_OVER_CAP', failure: { needed: 3, capLeft: 2 } });
    const alerts = (await api(admin).get('/broadcasts/alerts').expect(200))
      .body as BroadcastAlert[];
    expect(alerts.find((a) => a.id === capped.id)?.status).toBe('FAILED_OVER_CAP');
    await setCap(1000);

    // The audience at send time (S19): a child admitted after scheduling gets it, one who left not.
    const later = await create({
      body: 'Audience',
      recipients: 'PRIMARY_GUARDIANS',
      targets: [{ classLevelId: class2 }],
    });
    await api(admin)
      .post(`/broadcasts/${later.id}/schedule`, {
        scheduledAt: '2026-11-22T11:00:00+06:00',
        ...(await confirm(later.id)),
      })
      .expect(200);
    const newcomer = randomPhone();
    await enrol(class2, null, [newcomer]);
    await withTenant(h.prisma, tenantId, async (tx) => {
      const g = await tx.guardian.findFirstOrThrow({ where: { phone: p.c2 } });
      const link = await tx.studentGuardian.findFirstOrThrow({ where: { guardianId: g.id } });
      await tx.student.update({ where: { id: link.studentId }, data: { status: 'TRANSFERRED' } });
    });
    clock.set(dhaka('2026-11-22T11:01:00'));
    await expect(processor().send({ tenantId, broadcastId: later.id })).resolves.toMatchObject({
      kind: 'SENT',
      queued: 1,
    });
    expect((await logsOf(later.id)).map((l) => l.phone)).toEqual([newcomer]);

    // The scheduling admin lost the role: cancelled, nothing sent, on the dashboard.
    const lost = await create({ body: 'Lost role', recipients: 'STAFF' });
    await api(admin)
      .post(`/broadcasts/${lost.id}/schedule`, {
        scheduledAt: '2026-11-22T12:00:00+06:00',
        ...(await confirm(lost.id)),
      })
      .expect(200);
    await h.access.setMemberRoles(tenantId, adminUserId, ['TEACHER']);
    clock.set(dhaka('2026-11-22T12:01:00'));
    await expect(processor().send({ tenantId, broadcastId: lost.id })).resolves.toEqual({
      kind: 'CANCELLED_ACTOR',
    });
    expect(await logsOf(lost.id)).toEqual([]);
    const row = await withTenant(h.prisma, tenantId, (tx) =>
      tx.smsBroadcast.findUniqueOrThrow({ where: { id: lost.id } }),
    );
    expect(row).toMatchObject({ status: 'CANCELLED', cancelReason: 'ACTOR_NOT_ADMIN' });
    await h.access.setMemberRoles(tenantId, adminUserId, ['ADMIN']);
  });

  it('a queued SMS of a broadcast cancelled afterwards is dropped before sending (P6-L)', async () => {
    const b = await create({ body: 'Dropped', recipients: 'STAFF' });
    const logId = await withTenant(h.prisma, tenantId, async (tx) => {
      await tx.smsBroadcast.update({
        where: { id: b.id },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'BY_ADMIN' },
      });
      const log = await tx.smsLog.create({
        data: {
          tenantId,
          phone: randomPhone(),
          purpose: 'BROADCAST',
          status: 'QUEUED',
          segments: 1,
          body: 'Dropped',
          localDate: new Date('2026-11-22'),
          dedupeKey: `broadcast:${b.id}:test`,
          relatedEntity: `broadcast:${b.id}`,
          relatedId: b.id,
          sendAfter: new Date(),
        },
      });
      return log.id;
    });
    const prepared = await h.app
      .get(TenantJobRunner)
      .run(tenantId, () => h.app.get(TenantSmsService).prepare(logId));
    expect(prepared).toBeNull();
    const log = await withTenant(h.prisma, tenantId, (tx) =>
      tx.smsLog.findUniqueOrThrow({ where: { id: logId } }),
    );
    expect(log.status).toBe('CANCELLED');
  });

  it('B1: an edit after the preview is refused: the cost, text and audience the admin saw must hold', async () => {
    clock.set(dhaka('2026-11-23T10:00:00'));
    const b = await create({ body: 'Short', recipients: 'PRIMARY_GUARDIANS' });
    const seen = await confirm(b.id);
    const before = await preview(b.id);
    expect(before).toMatchObject({ recipients: 3, segments: 1, costPaisa: 3 * rate });
    // Another tab makes it three SMS long, same recipients.
    await api(admin)
      .put(`/broadcasts/${b.id}`, { body: 'x'.repeat(400), recipients: 'PRIMARY_GUARDIANS' })
      .expect(200);
    const res = await api(admin).post(`/broadcasts/${b.id}/send`, seen).expect(409);
    expect(res.body).toMatchObject({
      code: 'PREVIEW_CHANGED',
      segments: 3,
      costPaisa: 3 * 3 * rate,
    });
    expect(await statusOf(b.id)).toBe('DRAFT');
    // The same count with another recipient kind or other targets: refused too.
    const staff = await create({ body: 'Same count', recipients: 'STAFF' });
    const seenStaff = await confirm(staff.id);
    await api(admin)
      .put(`/broadcasts/${staff.id}`, {
        body: 'Same count',
        recipients: 'PRIMARY_GUARDIANS',
        targets: [{ classLevelId: class2 }],
      })
      .expect(200);
    await api(admin)
      .post(`/broadcasts/${staff.id}/schedule`, {
        scheduledAt: '2026-11-23T11:00:00+06:00',
        ...seenStaff,
      })
      .expect(409);
  });

  it('B2: a send job that failed is re-added by the sweep (a kept failed job, not a removed one)', async () => {
    clock.set(dhaka('2026-11-24T10:00:00'));
    const b = await create({ body: 'Retry me', recipients: 'STAFF' });
    await api(admin)
      .post(`/broadcasts/${b.id}/schedule`, {
        scheduledAt: '2026-11-24T10:10:00+06:00',
        ...(await confirm(b.id)),
      })
      .expect(200);
    // The real job is replaced by one that fails (bad data), and stays as a failed job.
    await (await queue().getJob(broadcastJobId(b.id)))!.remove();
    await queue().add(
      'broadcast-send',
      { tenantId: 'not-a-uuid', broadcastId: b.id },
      { jobId: broadcastJobId(b.id), attempts: 1, removeOnFail: 50 },
    );
    await expect
      .poll(async () => (await queue().getJob(broadcastJobId(b.id)))?.isFailed(), {
        timeout: 10_000,
      })
      .toBe(true);
    clock.set(dhaka('2026-11-24T10:11:00'));
    await h.app.get(BroadcastsService).sweep();
    await expect.poll(() => statusOf(b.id), { timeout: 10_000 }).toBe('SENT');
    expect(await logsOf(b.id)).toHaveLength(2);
  });

  it('B3: a broadcast found more than 3 hours late is not sent; it expires and the dashboard says so', async () => {
    clock.set(dhaka('2026-11-25T10:00:00'));
    const b = await create({ body: 'Too late', recipients: 'STAFF' });
    await api(admin)
      .post(`/broadcasts/${b.id}/schedule`, {
        scheduledAt: '2026-11-25T11:00:00+06:00',
        ...(await confirm(b.id)),
      })
      .expect(200);
    // Redis lost it; found six days later.
    clock.set(dhaka('2026-12-01T11:00:00'));
    await expect(processor().send({ tenantId, broadcastId: b.id })).resolves.toEqual({
      kind: 'EXPIRED',
    });
    expect(await logsOf(b.id)).toEqual([]);
    expect(await statusOf(b.id)).toBe('EXPIRED');
    const alerts = (await api(admin).get('/broadcasts/alerts').expect(200))
      .body as BroadcastAlert[];
    expect(alerts.find((a) => a.id === b.id)?.status).toBe('EXPIRED');
  });

  it('B4: SMS of a sent broadcast whose jobs were lost are queued again by the next run', async () => {
    clock.set(dhaka('2026-11-26T10:00:00'));
    const b = await create({ body: 'Jobs lost', recipients: 'STAFF' });
    await api(admin)
      .post(`/broadcasts/${b.id}/schedule`, {
        scheduledAt: '2026-11-26T10:10:00+06:00',
        ...(await confirm(b.id)),
      })
      .expect(200);
    const sms = h.app.get<Queue>(getQueueToken('sms'));
    await sms.pause();
    try {
      clock.set(dhaka('2026-11-26T10:11:00'));
      await expect(processor().send({ tenantId, broadcastId: b.id })).resolves.toMatchObject({
        kind: 'SENT',
      });
      const logs = await logsOf(b.id);
      expect(logs).toHaveLength(2);
      // The jobs vanished after the commit (as if addBulk had failed).
      for (const l of logs) await (await sms.getJob(l.id))?.remove();
      // The job runs again (the due entry is kept until the jobs exist): every QUEUED SMS gets its job.
      await processor().send({ tenantId, broadcastId: b.id });
      for (const l of logs) expect(await sms.getJob(l.id)).toBeTruthy();
    } finally {
      await sms.resume();
    }
    await expect
      .poll(async () => (await logsOf(b.id)).map((l) => l.status), { timeout: 10_000 })
      .toEqual(['SENT', 'SENT']);
  });

  it('B5: a login code is sent before a broadcast queued earlier', async () => {
    clock.set(dhaka('2026-11-27T10:00:00'));
    const sms = h.app.get<Queue>(getQueueToken('sms'));
    const b = await create({ body: 'Big broadcast', recipients: 'ALL_GUARDIANS' });
    await sms.pause();
    const phone = randomPhone();
    let start = 0;
    try {
      await api(admin)
        .post(`/broadcasts/${b.id}/send`, await confirm(b.id))
        .expect(200);
      await expect.poll(() => statusOf(b.id), { timeout: 10_000 }).toBe('SENT');
      await addMember(h, tenantId, { phone, roles: ['TEACHER'] });
      await http(h).post('/auth/otp/request').send({ phone }).expect(202);
      start = h.sms.messages.length;
    } finally {
      await sms.resume();
    }
    const broadcastPhones = new Set((await logsOf(b.id)).map((l) => l.phone));
    await expect
      .poll(() => h.sms.messages.slice(start).filter((m) => broadcastPhones.has(m.to)).length, {
        timeout: 15_000,
      })
      .toBe(broadcastPhones.size);
    const order = h.sms.messages.slice(start).map((m) => m.to);
    const otpAt = order.indexOf(phone);
    expect(otpAt).toBeGreaterThanOrEqual(0);
    expect(otpAt).toBeLessThan(order.findIndex((to) => broadcastPhones.has(to)));
  });

  it('B8: a broadcast SMS still waiting at 21:00 is held until 08:00, not cancelled', async () => {
    const b = await create({ body: 'Late SMS', recipients: 'STAFF' });
    const logId = await withTenant(h.prisma, tenantId, async (tx) => {
      await tx.smsBroadcast.update({
        where: { id: b.id },
        data: {
          status: 'SENT',
          scheduledAt: new Date(),
          scheduledById: adminUserId,
          sentAt: new Date(),
          queuedCount: 1,
          localDate: new Date('2026-11-28'),
        },
      });
      const log = await tx.smsLog.create({
        data: {
          tenantId,
          phone: randomPhone(),
          purpose: 'BROADCAST',
          status: 'QUEUED',
          segments: 1,
          body: 'Late SMS',
          localDate: new Date('2026-11-28'),
          dedupeKey: `broadcast:${b.id}:quiet`,
          relatedEntity: `broadcast:${b.id}`,
          relatedId: b.id,
          sendAfter: new Date(),
        },
      });
      return log.id;
    });
    clock.set(dhaka('2026-11-28T21:05:00'));
    const prepared = await h.app
      .get(TenantJobRunner)
      .run(tenantId, () => h.app.get(TenantSmsService).prepare(logId));
    expect(prepared).toEqual({ later: dhaka('2026-11-29T08:00:00') });
    const log = await withTenant(h.prisma, tenantId, (tx) =>
      tx.smsLog.findUniqueOrThrow({ where: { id: logId } }),
    );
    expect(log.status).toBe('QUEUED');
    clock.set(dhaka('2026-11-29T08:00:00'));
    await expect(
      h.app.get(TenantJobRunner).run(tenantId, () => h.app.get(TenantSmsService).prepare(logId)),
    ).resolves.toMatchObject({ body: 'Late SMS' });
  });

  it('N1: a body of spaces only is SMS_EMPTY, not SMS_TOO_LONG', async () => {
    const res = await api(admin)
      .post('/broadcasts', { body: '   ', recipients: 'STAFF' })
      .expect(422);
    expect(res.body.code).toBe('SMS_EMPTY');
  });

  it('SF1: a scheduled broadcast whose audience grew goes out at its real cost, or not at all when much dearer', async () => {
    clock.set(dhaka('2026-11-21T10:00:00'));
    const [c3, c4] = await withTenant(h.prisma, tenantId, (tx) =>
      tx.classLevel.findMany({ orderBy: { sortOrder: 'asc' }, skip: 2, take: 2 }),
    );
    // One more SMS than confirmed (1 → 2): within one SMS of the confirmed cost, so it is sent;
    // the real cost is stored and shown beside the confirmed one.
    await enrol(c3!.id, null, [randomPhone()]);
    const small = await create({
      body: 'Small growth',
      recipients: 'PRIMARY_GUARDIANS',
      targets: [{ classLevelId: c3!.id }],
    });
    await api(admin)
      .post(`/broadcasts/${small.id}/schedule`, {
        scheduledAt: '2026-11-21T10:30:00+06:00',
        ...(await confirm(small.id)),
      })
      .expect(200);
    await enrol(c3!.id, null, [randomPhone()]);
    clock.set(dhaka('2026-11-21T10:31:00'));
    await expect(processor().send({ tenantId, broadcastId: small.id })).resolves.toMatchObject({
      kind: 'SENT',
      queued: 2,
    });
    expect((await api(admin).get(`/broadcasts/${small.id}`).expect(200)).body).toMatchObject({
      previewCount: 1,
      estimatedCostPaisa: rate,
      queuedCount: 2,
      sentCostPaisa: 2 * rate,
    });

    // Four more than confirmed (1 → 5): far dearer, so nothing is sent; it needs a new preview.
    await enrol(c4!.id, null, [randomPhone()]);
    const big = await create({
      body: 'Big growth',
      recipients: 'PRIMARY_GUARDIANS',
      targets: [{ classLevelId: c4!.id }],
    });
    await api(admin)
      .post(`/broadcasts/${big.id}/schedule`, {
        scheduledAt: '2026-11-21T11:00:00+06:00',
        ...(await confirm(big.id)),
      })
      .expect(200);
    for (let i = 0; i < 4; i++) await enrol(c4!.id, null, [randomPhone()]);
    clock.set(dhaka('2026-11-21T11:01:00'));
    await expect(processor().send({ tenantId, broadcastId: big.id })).resolves.toEqual({
      kind: 'COST_CHANGED',
    });
    expect(await logsOf(big.id)).toEqual([]);
    expect((await api(admin).get(`/broadcasts/${big.id}`).expect(200)).body).toMatchObject({
      status: 'COST_CHANGED',
      failure: { confirmedCostPaisa: rate, costPaisa: 5 * rate },
    });
    const alerts = (await api(admin).get('/broadcasts/alerts').expect(200))
      .body as BroadcastAlert[];
    expect(alerts.find((x) => x.id === big.id)?.status).toBe('COST_CHANGED');
  });
});

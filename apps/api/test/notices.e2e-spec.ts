import { findOrCreateUser, withTenant } from '@jantrik/db';
import type { NoticeBoardItem, NoticeManageItem } from '@jantrik/shared';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { noticesVersionKey } from '../src/notices/notices.service.js';
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

// Notices (sprint 1 P6a): who sees what (review focus 5), scheduling without a job (P6-A),
// withdraw and expiry, reads and the cached unread count (P6-I), roles (S20), audit.
describe('notices', () => {
  const clock = new FakeClock('2026-11-17T04:00:00.000Z');
  let h: Harness;
  let tenantId: string;
  let admin: string;
  let teacher: string;
  /** Guardians: a child in class 1 section ক; a child in class 2; children in both. */
  let g1: string;
  let g2: string;
  let gBoth: string;
  let g1UserId: string;
  let class1: string;
  let class2: string;
  let sec1a: string;
  let sec1b: string;
  let otherAdmin: string;
  let otherClass: string;

  const api = (token: string) => ({
    get: (path: string) => http(h).get(path).set(bearer(token)),
    post: (path: string, body: object = {}) => http(h).post(path).set(bearer(token)).send(body),
    put: (path: string, body: object) => http(h).put(path).set(bearer(token)).send(body),
  });
  const board = async (token: string) =>
    ((await api(token).get('/notices').expect(200)).body as NoticeBoardItem[]).map((n) => n.title);
  const unread = async (token: string) =>
    ((await api(token).get('/notices/unread-count').expect(200)).body as { count: number }).count;

  async function guardianWith(children: { classLevelId: string; sectionId: string | null }[]) {
    const phone = randomPhone();
    const userId = await withTenant(h.prisma, tenantId, async (tx) => {
      const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
      const uid = await findOrCreateUser(tx, phone, 'Parent');
      await tx.membership.create({ data: { tenantId, userId: uid, role: 'GUARDIAN' } });
      const g = await tx.guardian.create({
        data: { tenantId, userId: uid, nameEn: 'Parent', phone },
      });
      for (const c of children) {
        const s = await tx.student.create({
          data: { tenantId, studentCode: `N-${randomUUID().slice(0, 8)}`, nameEn: 'Child' },
        });
        await tx.enrolment.create({
          data: {
            tenantId,
            studentId: s.id,
            academicYearId: year.id,
            classLevelId: c.classLevelId,
            sectionId: c.sectionId,
          },
        });
        await tx.studentGuardian.create({
          data: {
            tenantId,
            studentId: s.id,
            guardianId: g.id,
            relation: 'FATHER',
            isPrimary: true,
          },
        });
      }
      return uid;
    });
    return { token: (await otpLogin(h, phone)).accessToken, userId };
  }

  const draft = async (body: object): Promise<NoticeManageItem> =>
    (await api(admin).post('/notices', body).expect(201)).body as NoticeManageItem;
  const publish = async (id: string, publishAt?: string) =>
    (
      await api(admin)
        .post(`/notices/${id}/publish`, publishAt ? { publishAt } : {})
        .expect(200)
    ).body as NoticeManageItem;
  const published = async (body: object) => publish((await draft(body)).id);

  beforeAll(async () => {
    h = await createHarness({ clock });
    tenantId = (await createTenant(h)).id;
    ({ class1, class2, sec1a, sec1b } = await withTenant(h.prisma, tenantId, async (tx) => {
      const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
      const [c1, c2] = await tx.classLevel.findMany({ orderBy: { sortOrder: 'asc' }, take: 2 });
      const mk = (classLevelId: string, name: string) =>
        tx.section.create({ data: { tenantId, academicYearId: year.id, classLevelId, name } });
      return {
        class1: c1!.id,
        class2: c2!.id,
        sec1a: (await mk(c1!.id, 'ক')).id,
        sec1b: (await mk(c1!.id, 'খ')).id,
      };
    }));
    admin = (await otpLogin(h, (await addMember(h, tenantId, { roles: ['ADMIN'] })).phone))
      .accessToken;
    teacher = (await otpLogin(h, (await addMember(h, tenantId, { roles: ['TEACHER'] })).phone))
      .accessToken;
    const one = await guardianWith([{ classLevelId: class1, sectionId: sec1a }]);
    g1 = one.token;
    g1UserId = one.userId;
    g2 = (await guardianWith([{ classLevelId: class2, sectionId: null }])).token;
    gBoth = (
      await guardianWith([
        { classLevelId: class1, sectionId: sec1a },
        { classLevelId: class2, sectionId: null },
      ])
    ).token;
    const other = await createTenant(h);
    otherAdmin = (await otpLogin(h, (await addMember(h, other.id, { roles: ['ADMIN'] })).phone))
      .accessToken;
    otherClass = (await withTenant(h.prisma, other.id, (tx) => tx.classLevel.findFirstOrThrow()))
      .id;
  });

  afterAll(async () => {
    await h?.close();
  });

  it('only OWNER/ADMIN write and manage (S20)', async () => {
    await api(teacher).post('/notices', { title: 't', body: 'b', audience: 'ALL' }).expect(403);
    await api(g1).post('/notices', { title: 't', body: 'b', audience: 'ALL' }).expect(403);
    await api(g1).get('/notices/manage').expect(403);
    await api(teacher).get('/notices/manage').expect(403);
  });

  it('who sees what: class and section targets, staff vs guardians, both children once', async () => {
    const forClass1 = await published({
      title: 'Class 1 trip',
      body: 'b',
      audience: 'GUARDIANS',
      targets: [{ classLevelId: class1 }],
    });
    await published({
      title: 'Section খ only',
      body: 'b',
      audience: 'ALL',
      targets: [{ classLevelId: class1, sectionId: sec1b }],
    });
    await published({ title: 'Staff meeting', body: 'b', audience: 'STAFF' });
    await published({ title: 'Holiday', body: 'b', audience: 'ALL' });

    expect(await board(g1)).toEqual(expect.arrayContaining(['Class 1 trip', 'Holiday']));
    expect(await board(g1)).not.toContain('Section খ only');
    expect(await board(g1)).not.toContain('Staff meeting');
    expect(await board(g2)).not.toContain('Class 1 trip');
    expect(await board(g2)).toContain('Holiday');
    const both = await board(gBoth);
    expect(both.filter((t) => t === 'Class 1 trip')).toHaveLength(1);
    // Staff: ALL notices whatever their targets (P6-G), STAFF ones, never GUARDIANS ones.
    const staff = await board(teacher);
    expect(staff).toEqual(expect.arrayContaining(['Staff meeting', 'Holiday', 'Section খ only']));
    expect(staff).not.toContain('Class 1 trip');
    // A notice not visible to the caller is 404, as is another institute's.
    await api(g2).get(`/notices/${forClass1.id}`).expect(404);
    await api(g1).get(`/notices/${forClass1.id}`).expect(200);
    await api(otherAdmin).get(`/notices/${forClass1.id}`).expect(404);
    await api(otherAdmin).get(`/notices/manage/${forClass1.id}`).expect(404);
    await api(otherAdmin).post(`/notices/${forClass1.id}/read`).expect(404);
  });

  it("targets: never on a staff notice, only this institute's classes and sections", async () => {
    const res = await api(admin)
      .post('/notices', {
        title: 't',
        body: 'b',
        audience: 'STAFF',
        targets: [{ classLevelId: class1 }],
      })
      .expect(422);
    expect(res.body.code).toBe('TARGET_INVALID');
    await api(admin)
      .post('/notices', {
        title: 't',
        body: 'b',
        audience: 'ALL',
        targets: [{ classLevelId: otherClass }],
      })
      .expect(422);
    // A section of another class.
    await api(admin)
      .post('/notices', {
        title: 't',
        body: 'b',
        audience: 'ALL',
        targets: [{ classLevelId: class2, sectionId: sec1a }],
      })
      .expect(422);
  });

  it('a scheduled notice appears when its time comes, without any job (P6-A)', async () => {
    const n = await draft({ title: 'Exam routine', body: 'b', audience: 'ALL' });
    const at = new Date(clock.now().getTime() + 60 * 60_000).toISOString();
    expect((await publish(n.id, at)).state).toBe('SCHEDULED');
    expect(await board(g1)).not.toContain('Exam routine');
    clock.advance(61 * 60_000);
    expect(await board(g1)).toContain('Exam routine');
    // Out of range: more than 30 days ahead, or in the past.
    const late = await draft({ title: 'Late', body: 'b', audience: 'ALL' });
    const far = new Date(clock.now().getTime() + 31 * 86_400_000).toISOString();
    expect(
      (await api(admin).post(`/notices/${late.id}/publish`, { publishAt: far }).expect(422)).body
        .code,
    ).toBe('SCHEDULE_OUT_OF_RANGE');
    const past = new Date(clock.now().getTime() - 3_600_000).toISOString();
    await api(admin).post(`/notices/${late.id}/publish`, { publishAt: past }).expect(422);
    // A live notice cannot be "published" again.
    await api(admin).post(`/notices/${n.id}/publish`).expect(409);
  });

  it('withdrawn and expired notices leave the board but stay in manage', async () => {
    const gone = await published({ title: 'Wrong date', body: 'b', audience: 'ALL' });
    const withdrawn = (
      await api(admin).post(`/notices/${gone.id}/withdraw`, { reason: 'Typo' }).expect(200)
    ).body as NoticeManageItem;
    expect(withdrawn).toMatchObject({ state: 'WITHDRAWN', withdrawnReason: 'Typo' });
    expect(await board(g1)).not.toContain('Wrong date');
    await api(admin).post(`/notices/${gone.id}/withdraw`, { reason: 'again' }).expect(409);
    const edit = await api(admin)
      .put(`/notices/${gone.id}`, { title: 'x', body: 'b', audience: 'ALL' })
      .expect(409);
    expect(edit.body.code).toBe('NOT_EDITABLE');

    const expiresAt = new Date(clock.now().getTime() + 30 * 60_000).toISOString();
    await published({ title: 'Short lived', body: 'b', audience: 'ALL', expiresAt });
    expect(await board(g1)).toContain('Short lived');
    clock.advance(31 * 60_000);
    expect(await board(g1)).not.toContain('Short lived');
    const manage = (await api(admin).get('/notices/manage').expect(200)).body as NoticeManageItem[];
    expect(manage.find((n) => n.title === 'Short lived')?.state).toBe('EXPIRED');
    expect(manage.find((n) => n.title === 'Wrong date')?.state).toBe('WITHDRAWN');
    // An expiry before now is refused.
    const res = await api(admin)
      .post('/notices', {
        title: 't',
        body: 'b',
        audience: 'ALL',
        expiresAt: new Date(clock.now().getTime() - 60_000).toISOString(),
      })
      .expect(422);
    expect(res.body.code).toBe('EXPIRY_INVALID');
  });

  it('reads: idempotent, only visible notices; the cached unread count follows (P6-I)', async () => {
    const before = await unread(g1);
    // Served from Redis on the second call (the key exists under the current version).
    const version = (await h.redis.get(noticesVersionKey(tenantId))) ?? '0';
    expect(
      await h.redis.get(`tenant:${tenantId}:user:${g1UserId}:notices:unread:v${version}`),
    ).toBe(String(before));
    const n = await published({ title: 'Fee date', body: 'b', audience: 'ALL' });
    // The publish bumped the version: the new notice counts at once.
    expect(await unread(g1)).toBe(before + 1);
    await api(g1).post(`/notices/${n.id}/read`).expect(204);
    await api(g1).post(`/notices/${n.id}/read`).expect(204);
    expect(await unread(g1)).toBe(before);
    const card = ((await api(g1).get('/notices').expect(200)).body as NoticeBoardItem[]).find(
      (c) => c.id === n.id,
    );
    expect(card?.read).toBe(true);
    // A notice the caller cannot see cannot be marked read.
    const staffOnly = await published({ title: 'Payroll', body: 'b', audience: 'STAFF' });
    await api(g1).post(`/notices/${staffOnly.id}/read`).expect(404);
    const counts = (await api(admin).get(`/notices/${n.id}/reads`).expect(200)).body;
    expect(counts.guardians.read).toBe(1);
    expect(counts.guardians.of).toBe(3);
    expect(counts.staff).toEqual({ read: 0, of: 2 });
  });

  it('editing a published notice marks it edited and keeps reads; every change is audited', async () => {
    const n = await published({ title: 'Sports day', body: 'b', audience: 'ALL' });
    await api(g1).post(`/notices/${n.id}/read`).expect(204);
    const edited = (
      await api(admin)
        .put(`/notices/${n.id}`, {
          title: 'Sports day (new date)',
          body: 'b2',
          audience: 'ALL',
          pinned: true,
        })
        .expect(200)
    ).body as NoticeManageItem;
    expect(edited.editedAt).not.toBeNull();
    expect(edited.readCount).toBe(1);
    const card = ((await api(g1).get('/notices').expect(200)).body as NoticeBoardItem[])[0];
    expect(card).toMatchObject({ id: n.id, pinned: true, edited: true, read: true });
    const audits = await withTenant(h.prisma, tenantId, (tx) =>
      tx.auditLog.findMany({
        where: { entity: 'notice', entityId: n.id },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(audits.map((a) => a.action)).toEqual(['CREATE', 'UPDATE', 'UPDATE']);
    expect(audits[2]!.newValues).toMatchObject({ title: 'Sports day (new date)', pinned: true });
  });
});

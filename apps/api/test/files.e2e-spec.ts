import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crc32, deflateSync } from 'node:zlib';
import { withTenant } from '@jantrik/db';
import type { GuardianChild, StudentProfile } from '@jantrik/shared';
import sharp from 'sharp';
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
import { UploadLimits } from '../src/files/upload-limits.js';

// Sprint 1 P2 (docs/plans/sprint-1-p2-files.md): student photos through FileStore. Who may see
// and change them, the hostile uploads, ETag/304, the per-institute total and its cap.

const CAP = 1024 * 1024 * 1024; // FILE_STORAGE_PER_TENANT_MB's default, in bytes

const photo = (w = 300, h = 400, background = '#88aa55') =>
  sharp({ create: { width: w, height: h, channels: 3, background } })
    .jpeg()
    .toBuffer();

function pngClaiming(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(width + 1))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('student photos', () => {
  let h: Harness;
  let s: School;
  let owner: string;

  const put = (token: string, studentId: string, file: Buffer, name = 'photo.jpg') =>
    http(h)
      .put(`/students/${studentId}/photo`)
      .set(bearer(token))
      .attach('file', file, { filename: name, contentType: 'image/jpeg' });
  const usage = (tenantId: string) =>
    withTenant(h.prisma, tenantId, async (tx) => {
      const row = await tx.storedFileUsage.findFirst();
      const files = await tx.storedFile.findMany({ select: { sizeBytes: true } });
      return {
        bytesUsed: Number(row?.bytesUsed ?? 0),
        fileCount: row?.fileCount ?? 0,
        sum: files.reduce((n, f) => n + f.sizeBytes, 0),
        count: files.length,
      };
    });

  beforeAll(async () => {
    h = await createHarness();
    s = await school(h);
    owner = (await otpLogin(h, (await addMember(h, s.tenantId, { roles: ['OWNER'] })).phone))
      .accessToken;
  });

  afterAll(() => h.close());

  it('an admin adds a photo: stored as a JPEG, served with an ETag, 304 when unchanged', async () => {
    const student = s.a[0]!.id;
    const res = await put(s.admin, student, await photo(1200, 1600)).expect(200);
    const profile = res.body as StudentProfile;
    expect(profile.photoId).toMatch(/^[0-9a-f-]{36}$/);

    const got = await http(h)
      .get(`/students/${student}/photo`)
      .set(bearer(s.admin))
      .buffer(true)
      .expect(200);
    expect(got.headers['content-type']).toBe('image/jpeg');
    expect(got.headers['cache-control']).toBe('private, no-cache');
    expect(got.headers['etag']).toMatch(/^"[0-9a-f]{64}"$/);
    const meta = await sharp(got.body as Buffer).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 600, 800]);

    await http(h)
      .get(`/students/${student}/photo`)
      .set(bearer(s.admin))
      .set('If-None-Match', got.headers['etag']!)
      .expect(304);

    // The list and the profile carry the id; the audit has the change.
    const listed = await http(h).get('/students').set(bearer(s.admin)).expect(200);
    const row = (listed.body.items as { id: string; photoId: string | null }[]).find(
      (i) => i.id === student,
    );
    expect(row?.photoId).toBe(profile.photoId);
    const audit = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.auditLog.findMany({ where: { entity: 'student', entityId: student } }),
    );
    expect(audit.at(-1)).toMatchObject({
      action: 'UPDATE',
      oldValues: { photoFileId: null },
      newValues: { photoFileId: profile.photoId },
    });
  });

  it('teachers see the photo only for their own section; others get 403 or 404', async () => {
    const student = s.a[0]!.id;
    await http(h).get(`/students/${student}/photo`).set(bearer(s.teacher)).expect(200);
    await http(h).get(`/students/${student}/photo`).set(bearer(s.otherTeacher)).expect(404);
    const listed = await http(h).get('/students').set(bearer(s.otherTeacher)).expect(200);
    for (const item of listed.body.items as { photoId: string | null }[]) {
      expect(item.photoId).toBeNull();
    }
    const accountant = await otpLogin(
      h,
      (await addMember(h, s.tenantId, { roles: ['ACCOUNTANT'] })).phone,
    );
    await http(h).get(`/students/${student}/photo`).set(bearer(accountant.accessToken)).expect(403);
    await put(s.teacher, student, await photo()).expect(403);
    await http(h).delete(`/students/${student}/photo`).set(bearer(s.teacher)).expect(403);
  });

  it("another institute's admin gets 404 for this institute's student", async () => {
    const other = await createTenant(h);
    const admin = (await otpLogin(h, (await addMember(h, other.id, { roles: ['ADMIN'] })).phone))
      .accessToken;
    const student = s.a[0]!.id;
    await http(h).get(`/students/${student}/photo`).set(bearer(admin)).expect(404);
    await put(admin, student, await photo()).expect(404);
    // Checked before the upload is decoded (review round 2): not a 422 for a non-image.
    await put(admin, student, Buffer.from('not an image'), 'x.jpg').expect(404);
    await http(h).delete(`/students/${student}/photo`).set(bearer(admin)).expect(404);
    expect((await usage(other.id)).count).toBe(0);
  });

  it("a guardian sees their own child's photo, and no one else's", async () => {
    const child = s.a[1]!;
    await put(s.admin, child.id, await photo()).expect(200);
    await put(s.admin, s.a[2]!.id, await photo()).expect(200);
    const m = await addMember(h, s.tenantId, { phone: child.phone, roles: ['GUARDIAN'] });
    await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.guardian.updateMany({ where: { phone: child.phone }, data: { userId: m.userId } }),
    );
    const guardian = (await otpLogin(h, m.phone)).accessToken;
    const children = (await http(h).get('/me/children').set(bearer(guardian)).expect(200))
      .body as GuardianChild[];
    expect(children.map((c) => [c.id, typeof c.photoId])).toEqual([[child.id, 'string']]);
    const got = await http(h)
      .get(`/me/children/${child.id}/photo`)
      .set(bearer(guardian))
      .buffer(true)
      .expect(200);
    expect(got.headers['content-type']).toBe('image/jpeg');
    await http(h).get(`/me/children/${s.a[2]!.id}/photo`).set(bearer(guardian)).expect(404);
    await http(h).get(`/students/${child.id}/photo`).set(bearer(guardian)).expect(403);
  });

  it('replacing deletes the old file and removing deletes it too; the total follows', async () => {
    const student = s.b[0]!.id;
    const before = await usage(s.tenantId);
    const first = (await put(owner, student, await photo(300, 400, '#112233')).expect(200))
      .body as StudentProfile;
    const second = (await put(owner, student, await photo(300, 400, '#445566')).expect(200))
      .body as StudentProfile;
    expect(second.photoId).not.toBe(first.photoId);
    let now = await usage(s.tenantId);
    expect(now.count).toBe(before.count + 1);
    expect(now.bytesUsed).toBe(now.sum);
    expect(now.fileCount).toBe(now.count);

    const removed = (
      await http(h).delete(`/students/${student}/photo`).set(bearer(owner)).expect(200)
    ).body as StudentProfile;
    expect(removed.photoId).toBeNull();
    await http(h).get(`/students/${student}/photo`).set(bearer(owner)).expect(404);
    now = await usage(s.tenantId);
    expect([now.count, now.bytesUsed]).toEqual([before.count, before.bytesUsed]);
    expect(now.bytesUsed).toBe(now.sum);
  });

  it('hostile uploads are refused and leave nothing behind', async () => {
    const student = s.b[0]!.id;
    const before = await usage(s.tenantId);
    const tooBig = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(6 * 1024 * 1024)]);
    await put(s.admin, student, tooBig).expect(413);
    const text = await put(s.admin, student, Buffer.from('not an image at all'), 'x.jpg').expect(
      422,
    );
    expect(text.body.code).toBe('IMAGE_INVALID');
    const bomb = await put(s.admin, student, pngClaiming(50_000, 50_000), 'bomb.png').expect(422);
    expect(bomb.body.code).toBe('IMAGE_TOO_BIG');
    await http(h)
      .put(`/students/${student}/photo`)
      .set(bearer(s.admin))
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('FILE_REQUIRED'));
    expect(await usage(s.tenantId)).toEqual(before);
  });

  it('a deactivated student cannot get a new photo (409)', async () => {
    const t = await school(h);
    const student = t.b[0]!.id;
    await http(h).post(`/students/${student}/deactivate`).set(bearer(t.admin)).expect(200);
    const res = await put(t.admin, student, await photo()).expect(409);
    expect(res.body.code).toBe('DEACTIVATED');
    // Before decoding: a non-image gets the same 409, not a 422 (review round 2).
    const garbage = await put(t.admin, student, Buffer.from('not an image'), 'x.jpg').expect(409);
    expect(garbage.body.code).toBe('DEACTIVATED');
  });

  it('over the institute cap: 413 STORAGE_FULL; two uploads at once when one fits: exactly one', async () => {
    const t = await school(h);
    // The size of one processed photo, measured on the first upload.
    const image = await photo(900, 1200, '#336699');
    await put(t.admin, t.a[0]!.id, image).expect(200);
    const size = (await usage(t.tenantId)).bytesUsed;
    expect(size).toBeGreaterThan(0);

    // Room for one more of these, not two.
    const preset = CAP - size - Math.floor(size * 1.5);
    await withTenant(h.prisma, t.tenantId, (tx) =>
      tx.storedFileUsage.updateMany({ data: { bytesUsed: { increment: preset } } }),
    );
    const results = await Promise.all([
      put(t.admin, t.a[1]!.id, image),
      put(t.admin, t.a[2]!.id, image),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 413]);
    expect(results.find((r) => r.status === 413)!.body.code).toBe('STORAGE_FULL');
    const now = await usage(t.tenantId);
    expect(now.count).toBe(2);
    expect(now.bytesUsed).toBe(now.sum + preset);
    // Full now: a third is refused.
    const third = await put(t.admin, t.b[0]!.id, image).expect(413);
    expect(third.body).toMatchObject({ code: 'STORAGE_FULL', capBytes: CAP });
    // Replacing a photo with one of the same size does not grow the total: allowed (review).
    await put(t.admin, t.a[0]!.id, image).expect(200);
    expect((await usage(t.tenantId)).bytesUsed).toBe(now.bytesUsed);
    // Even when the total is over the cap (a lowered cap): a replacement no bigger than the old
    // file is allowed; a new photo is not (review round 2).
    await withTenant(h.prisma, t.tenantId, (tx) =>
      tx.storedFileUsage.updateMany({ data: { bytesUsed: { increment: size } } }),
    );
    await put(t.admin, t.a[0]!.id, image).expect(200);
    await put(t.admin, t.b[0]!.id, image).expect(413);
  });

  describe('uploads in flight (reviews)', () => {
    let port: number;
    const boundary = 'jantrik-slow-upload';

    beforeAll(async () => {
      const server = h.app.getHttpServer() as Server;
      if (!server.listening) await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      port = (server.address() as AddressInfo).port;
    });

    /**
     * A multipart upload whose body stalls after 64 bytes for `stallMs`, then completes (or is
     * dropped by the client with `abort`). Resolves with the status (0 when aborted).
     */
    const slowUpload = (
      path: string,
      token: string,
      image: Buffer,
      opts: { stallMs: number; abort?: boolean },
    ) =>
      new Promise<number>((resolve, reject) => {
        const head = Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="slow.jpg"\r\n` +
            'Content-Type: image/jpeg\r\n\r\n',
        );
        const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            method: 'PUT',
            path,
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': `multipart/form-data; boundary=${boundary}`,
              'Content-Length': head.length + image.length + tail.length,
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode!));
          },
        );
        req.on('error', (e) => (opts.abort ? resolve(0) : reject(e)));
        req.write(head);
        req.write(image.subarray(0, 64));
        setTimeout(() => {
          if (opts.abort) req.destroy();
          else req.end(Buffer.concat([image.subarray(64), tail]));
        }, opts.stallMs);
      });
    const openTransactions = async () =>
      (
        await h.prisma.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE usename = current_user AND datname = current_database()
            AND state LIKE 'idle in transaction%'`
      )[0]!.n;
    const limits = () => h.app.get(UploadLimits);

    it.each([
      ['a student photo', () => `/students/${s.a[0]!.id}/photo`],
      ['the institute logo', () => '/institute/profile/logo'],
    ])('%s: no database transaction is open while the body arrives', async (_n, path) => {
      const image = await photo(400, 500, '#aa6633');
      const status = slowUpload(path(), s.admin, image, { stallMs: 2_500 });
      // Sampled every 100 ms while the body is stalled (review round 2); the short store
      // transaction after it is allowed, so sampling stops before the body completes.
      let most = 0;
      const until = Date.now() + 1_900;
      while (Date.now() < until) {
        most = Math.max(most, await openTransactions());
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(await status).toBe(200);
      expect(most).toBe(0);
    });

    it('a person has at most two uploads in flight; the third gets 503 IMAGE_BUSY at once', async () => {
      const image = await photo(300, 300, '#336655');
      const first = slowUpload(`/students/${s.a[1]!.id}/photo`, owner, image, { stallMs: 1_500 });
      const second = slowUpload(`/students/${s.a[2]!.id}/photo`, owner, image, {
        stallMs: 1_500,
      });
      await vi.waitFor(() => expect(limits().inFlight).toBe(2));
      const third = await put(owner, s.b[0]!.id, image).expect(503);
      expect(third.body.code).toBe('IMAGE_BUSY');
      expect(await Promise.all([first, second])).toEqual([200, 200]);
      await vi.waitFor(() => expect(limits().inFlight).toBe(0));
    });

    it('an upload the client drops gives its slot back', async () => {
      const image = await photo(300, 300, '#665533');
      const dropped = slowUpload(`/students/${s.b[0]!.id}/photo`, owner, image, {
        stallMs: 500,
        abort: true,
      });
      await vi.waitFor(() => expect(limits().inFlight).toBe(1));
      expect(await dropped).toBe(0);
      await vi.waitFor(() => expect(limits().inFlight).toBe(0));
    });

    it('an admin downgraded while the body arrives gets 403, and nothing is stored', async () => {
      const t = await school(h);
      const m = await addMember(h, t.tenantId, { roles: ['ADMIN'] });
      const token = (await otpLogin(h, m.phone)).accessToken;
      const before = await usage(t.tenantId);
      const status = slowUpload(`/students/${t.a[0]!.id}/photo`, token, await photo(), {
        stallMs: 1_500,
      });
      await vi.waitFor(() => expect(limits().inFlight).toBe(1));
      await h.access.setMemberRoles(t.tenantId, m.userId, ['TEACHER']);
      expect(await status).toBe(403);
      const logo = slowUpload('/institute/profile/signature', token, await photo(), {
        stallMs: 10,
      });
      expect(await logo).toBe(403);
      expect(await usage(t.tenantId)).toEqual(before);
    });
  });

  it('a suspended institute or a disabled member stores nothing (403)', async () => {
    const t = await school(h);
    const m = await addMember(h, t.tenantId, { roles: ['ADMIN'] });
    const token = (await otpLogin(h, m.phone)).accessToken;
    const before = await usage(t.tenantId);
    // A disabled membership (the roles cache still says ADMIN: the transaction's re-check refuses).
    await withTenant(h.prisma, t.tenantId, (tx) =>
      tx.membership.updateMany({ where: { userId: m.userId }, data: { status: 'DISABLED' } }),
    );
    await put(token, t.a[0]!.id, await photo()).expect(403);
    await http(h)
      .put('/institute/profile/logo')
      .set(bearer(token))
      .attach('file', await photo(), { filename: 'logo.jpg', contentType: 'image/jpeg' })
      .expect(403);
    // The whole institute suspended by the platform.
    await platform(h, await platformAdminCookie(h))
      .post(`/platform/institutes/${t.tenantId}/suspend`)
      .send({ reason: 'invoice unpaid' })
      .expect(200);
    await put(t.admin, t.a[0]!.id, await photo()).expect(403);
    await http(h)
      .put('/institute/profile/logo')
      .set(bearer(t.admin))
      .attach('file', await photo(), { filename: 'logo.jpg', contentType: 'image/jpeg' })
      .expect(403);
    expect(await usage(t.tenantId)).toEqual(before);
  });

  it('at most 60 uploads per person in 10 minutes (F8)', async () => {
    const t = await school(h);
    const tiny = await photo(20, 20);
    for (let i = 0; i < 60; i++) await put(t.admin, t.b[0]!.id, tiny).expect(200);
    const res = await put(t.admin, t.b[0]!.id, tiny).expect(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  }, 90_000);
});

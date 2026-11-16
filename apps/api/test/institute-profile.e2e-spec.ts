import { withTenant } from '@jantrik/db';
import type { InstituteProfile } from '@jantrik/shared';
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

// Sprint 1 P2: the institute's own profile and its logo, head's signature and seal.

const png = (w: number, h: number) =>
  sharp({
    create: { width: w, height: h, channels: 4, background: { r: 20, g: 90, b: 60, alpha: 0.8 } },
  })
    .png()
    .toBuffer();

describe('institute profile', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(() => h.close());

  const institute = async () => {
    const t = await createTenant(h);
    const login = async (role: 'OWNER' | 'ADMIN' | 'TEACHER' | 'GUARDIAN') =>
      (await otpLogin(h, (await addMember(h, t.id, { roles: [role] })).phone)).accessToken;
    return {
      id: t.id,
      owner: await login('OWNER'),
      admin: await login('ADMIN'),
      teacher: await login('TEACHER'),
      guardian: await login('GUARDIAN'),
    };
  };
  const audits = (tenantId: string) =>
    withTenant(h.prisma, tenantId, (tx) =>
      tx.auditLog.findMany({
        where: { entity: 'institute_profile' },
        orderBy: { createdAt: 'asc' },
      }),
    );
  const upload = (token: string, slot: string, file: Buffer) =>
    http(h)
      .put(`/institute/profile/${slot}`)
      .set(bearer(token))
      .attach('file', file, { filename: `${slot}.png`, contentType: 'image/png' });

  it('starts empty with the registered name; the owner saves it (Bangla digits accepted)', async () => {
    const t = await institute();
    const empty = (await http(h).get('/institute/profile').set(bearer(t.admin)).expect(200))
      .body as InstituteProfile;
    expect(empty).toMatchObject({
      saved: false,
      registeredName: 'Test Institute',
      nameBn: null,
      nameEn: null,
      logo: null,
      signature: null,
      seal: null,
      storage: { bytesUsed: 0, capBytes: 1024 * 1024 * 1024 },
    });

    const body = {
      nameBn: 'শাপলা উচ্চ বিদ্যালয়',
      nameEn: 'Shapla High School',
      eiin: '১০৮১২৩',
      phone: '০১৭১১-০০০০০০',
      website: 'shapla.edu.bd',
      email: 'office@shapla.edu.bd',
      headTitleBn: 'প্রধান শিক্ষক',
      headNameEn: 'Md. Rahim',
      establishedYear: '১৯৬৫',
    };
    const saved = (
      await http(h).put('/institute/profile').set(bearer(t.owner)).send(body).expect(200)
    ).body as InstituteProfile;
    expect(saved).toMatchObject({
      saved: true,
      eiin: '108123',
      phone: '+8801711000000',
      website: 'https://shapla.edu.bd',
      establishedYear: 1965,
      shortName: null,
    });
    // Saving the same again changes nothing and is not audited a second time.
    await http(h).put('/institute/profile').set(bearer(t.admin)).send(body).expect(200);
    const rows = await audits(t.id);
    expect(rows.map((r) => r.action)).toEqual(['CREATE']);
    expect(rows[0]!.newValues).toMatchObject({ eiin: '108123' });
  });

  it('an upper-case web address is stored with a lower-case scheme, never a 500 (review)', async () => {
    const t = await institute();
    const res = await http(h)
      .put('/institute/profile')
      .set(bearer(t.owner))
      .send({ nameEn: 'X', website: 'HTTPS://Shapla.edu.bd' })
      .expect(200);
    expect(res.body.website).toBe('https://Shapla.edu.bd');
  });

  it('the first logo and the first save at the same moment both succeed (review)', async () => {
    for (let i = 0; i < 3; i++) {
      const t = await institute();
      const logo = await png(64, 64);
      const [up, save] = await Promise.all([
        upload(t.admin, 'logo', logo),
        http(h).put('/institute/profile').set(bearer(t.owner)).send({ nameBn: 'শাপলা' }),
      ]);
      expect([up.status, save.status]).toEqual([200, 200]);
    }
  });

  it('refuses bad values (400) and non-admins (403)', async () => {
    const t = await institute();
    for (const bad of [
      { nameBn: '', nameEn: '' },
      { nameEn: 'X', eiin: '12345' },
      { nameEn: 'X', email: 'office@' },
      { nameEn: 'X', establishedYear: 1700 },
    ]) {
      await http(h).put('/institute/profile').set(bearer(t.owner)).send(bad).expect(400);
    }
    await http(h).get('/institute/profile').set(bearer(t.teacher)).expect(403);
    await http(h)
      .put('/institute/profile')
      .set(bearer(t.teacher))
      .send({ nameEn: 'X' })
      .expect(403);
    await upload(t.teacher, 'logo', await png(100, 100)).expect(403);
  });

  it('a logo uploaded before the first save creates the profile with the registered name', async () => {
    const t = await institute();
    const res = (await upload(t.admin, 'logo', await png(1000, 600)).expect(200))
      .body as InstituteProfile;
    expect(res).toMatchObject({ saved: true, nameEn: 'Test Institute', nameBn: null });
    expect(res.logo).toMatchObject({ mime: 'image/png', width: 512 });
    expect(res.storage.bytesUsed).toBe(res.logo!.sizeBytes);
  });

  it('everyone sees the logo; only owner and admin see the signature and the seal', async () => {
    const t = await institute();
    await upload(t.owner, 'logo', await png(300, 300)).expect(200);
    await upload(t.owner, 'signature', await png(900, 300)).expect(200);
    const sealed = (await upload(t.owner, 'seal', await png(400, 400)).expect(200))
      .body as InstituteProfile;
    expect(sealed.signature).toMatchObject({ mime: 'image/png' });

    for (const token of [t.owner, t.admin, t.teacher, t.guardian]) {
      const r = await http(h)
        .get('/institute/profile/logo')
        .set(bearer(token))
        .buffer(true)
        .expect(200);
      expect(r.headers['content-type']).toBe('image/png');
    }
    for (const slot of ['signature', 'seal']) {
      await http(h).get(`/institute/profile/${slot}`).set(bearer(t.admin)).expect(200);
      await http(h).get(`/institute/profile/${slot}`).set(bearer(t.teacher)).expect(403);
      await http(h).get(`/institute/profile/${slot}`).set(bearer(t.guardian)).expect(403);
    }
    await http(h).get('/institute/profile/stamp').set(bearer(t.admin)).expect(400);

    // Another institute has none of these.
    const other = await institute();
    await http(h).get('/institute/profile/logo').set(bearer(other.admin)).expect(404);
  });

  it('replacing and removing an image keep the total equal to the stored files', async () => {
    const t = await institute();
    const first = (await upload(t.admin, 'seal', await png(200, 200)).expect(200))
      .body as InstituteProfile;
    const second = (await upload(t.admin, 'seal', await png(300, 300)).expect(200))
      .body as InstituteProfile;
    expect(second.seal!.id).not.toBe(first.seal!.id);
    expect(second.storage.bytesUsed).toBe(second.seal!.sizeBytes);

    const removed = (
      await http(h).delete('/institute/profile/seal').set(bearer(t.admin)).expect(200)
    ).body as InstituteProfile;
    expect(removed.seal).toBeNull();
    expect(removed.storage.bytesUsed).toBe(0);
    await http(h).get('/institute/profile/seal').set(bearer(t.admin)).expect(404);
    const images = (await audits(t.id)).filter(
      (r) => (r.newValues as { image?: string } | null)?.image === 'seal',
    );
    expect(images.map((r) => (r.newValues as { fileId: string | null }).fileId)).toEqual([
      first.seal!.id,
      second.seal!.id,
      null,
    ]);
  });
});

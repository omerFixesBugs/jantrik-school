import { withTenant } from '@jantrik/db';
import type { AdmissionPublicForm, AdmissionPublicStatus } from '@jantrik/shared';
import sharp from 'sharp';
import { TURNSTILE_DUMMY_TOKEN } from '../src/admission/public/turnstile.js';
import { admissionCycle, admissionSchool, type AdmissionSchool } from './support/admission.js';
import { FakeClock } from './support/clock.js';
import {
  addMember,
  bearer,
  createHarness,
  createStudent,
  http,
  otpLogin,
  randomIp,
  randomPhone,
  type Harness,
} from './support/harness.js';

// The per-institute ceiling of codes is set low here, before the app reads its settings.
vi.hoisted(() => {
  process.env['ADMISSION_OTP_PER_TENANT_PER_DAY'] = '20';
});

type Form = AdmissionPublicForm & { formTicket: string };

/**
 * Sprint 1 P3b: the public admission form, no login (S4–S6, S9, S11; review focus 1, 3, 6, 7).
 * Turnstile is the fake verifier (TURNSTILE_PROVIDER=fake), SMS the memory provider, and the
 * clock a FakeClock inside the cycle's window (the form ticket needs 15 s to pass).
 */
describe('admission (public): form, codes, submit, status', () => {
  const clock = new FakeClock('2026-11-20T06:00:00.000Z');
  let h: Harness;
  let a: AdmissionSchool;
  let b: AdmissionSchool;
  let classA: string;
  let classB: string;

  const pub = (slug: string, path = '') => `/public/admission/${slug}${path}`;
  const getForm = async (slug: string, ip = randomIp()) =>
    (await http(h).get(pub(slug)).set('X-Forwarded-For', ip).expect(200)).body as Form;
  const askCode = (slug: string, phone: string, ip = randomIp(), token = TURNSTILE_DUMMY_TOKEN) =>
    http(h)
      .post(pub(slug, '/otp'))
      .set('X-Forwarded-For', ip)
      .send({ phone, turnstileToken: token });
  const lastCode = async (phone: string) =>
    vi.waitFor(
      () => {
        const texts = h.sms.sentTo(phone);
        const m = /(\d{6})/.exec(texts.at(-1) ?? '');
        if (!m) throw new Error('no code yet');
        return m[1]!;
      },
      { timeout: 15_000, interval: 100 },
    );
  /** A proved phone: code requested, read from the outbox, verified. */
  const prove = async (slug: string, phone = randomPhone()) => {
    const before = h.sms.sentTo(phone).length;
    await askCode(slug, phone).expect(202);
    await vi.waitFor(() => expect(h.sms.sentTo(phone).length).toBeGreaterThan(before), {
      timeout: 15_000,
    });
    const code = await lastCode(phone);
    const res = await http(h)
      .post(pub(slug, '/otp/verify'))
      .set('X-Forwarded-For', randomIp())
      .send({ phone, code })
      .expect(200);
    return { phone, token: res.body.phoneToken as string };
  };
  const fields = (over: Record<string, unknown> = {}) => ({
    nameBn: 'রাফি আহমেদ',
    dateOfBirth: '2019-05-01',
    gender: 'MALE',
    guardianNameBn: 'করিম আহমেদ',
    guardianRelation: 'FATHER',
    ...over,
  });
  const submit = (
    slug: string,
    token: string,
    o: {
      cycleClassId: string;
      ticket: string;
      payload?: object;
      website?: string;
      turnstile?: string;
      photo?: Buffer;
    },
  ) => {
    const req = http(h)
      .post(pub(slug, '/applications'))
      .set('X-Forwarded-For', randomIp())
      .set('X-Admission-Token', token)
      .field('payload', JSON.stringify(o.payload ?? fields()))
      .field('cycleClassId', o.cycleClassId)
      .field('turnstileToken', o.turnstile ?? TURNSTILE_DUMMY_TOKEN)
      .field('formTicket', o.ticket)
      .field('website', o.website ?? '');
    return o.photo ? req.attach('photo', o.photo, 'photo.png') : req;
  };
  const smsLogs = (tenantId: string) =>
    withTenant(h.prisma, tenantId, (tx) =>
      tx.smsLog.findMany({ where: { purpose: { in: ['ADMISSION_OTP', 'ADMISSION_SUBMITTED'] } } }),
    );

  beforeAll(async () => {
    h = await createHarness({ clock });
    a = await admissionSchool(h);
    b = await admissionSchool(h);
    classA = (await admissionCycle(h, a)).classes.find((c) => c.classLevel.id === a.class6)!.id;
    const cycleB = await admissionCycle(h, b);
    classB = cycleB.classes.find((c) => c.classLevel.id === b.class6)!.id;
    // The institute's automatic SMS cap is twice its active students: give A some.
    for (let i = 0; i < 5; i++) await createStudent(h, a.tenantId, `PUB-${i}`);
    // Photos for A's cycle.
    await withTenant(h.prisma, a.tenantId, (tx) =>
      tx.admissionCycle.updateMany({ data: { collectPhoto: true } }),
    );
  });

  afterAll(() => h.close());

  it('the happy path: form → code → verify → submit with a photo → 2027-0001; both SMS logged, the code masked', async () => {
    const form = await getForm(a.slug);
    expect(form.cycles).toHaveLength(1);
    expect(form.cycles[0]!.classes.map((c) => c.cycleClassId)).toContain(classA);
    expect(JSON.stringify(form)).not.toContain(a.tenantId);
    const { phone, token } = await prove(a.slug);
    clock.advance(20_000);
    const png = await sharp({
      create: { width: 1200, height: 1600, channels: 3, background: { r: 30, g: 90, b: 160 } },
    })
      .png()
      .withMetadata({ exif: { IFD0: { Copyright: 'GPS 23.81,90.41' } } })
      .toBuffer();
    const res = await submit(a.slug, token, {
      cycleClassId: classA,
      ticket: form.formTicket,
      photo: png,
    });
    expect(res.status).toBe(201);
    expect(res.body.applicationNo).toMatch(/^2027-\d{4}$/);
    const app = await withTenant(h.prisma, a.tenantId, (tx) =>
      tx.admissionApplication.findFirstOrThrow({
        where: { applicationNo: res.body.applicationNo },
        include: { photo: true },
      }),
    );
    expect(app).toMatchObject({ source: 'ONLINE', status: 'SUBMITTED', phone });
    const meta = await sharp(Buffer.from(app.photo!.bytes)).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.exif).toBeUndefined();
    expect(app.photo!.bytes.length).toBeLessThanOrEqual(200 * 1024);
    await vi.waitFor(
      async () => {
        const logs = (await smsLogs(a.tenantId)).filter((l) => l.phone === phone);
        expect(logs.map((l) => l.purpose).sort()).toEqual(['ADMISSION_OTP', 'ADMISSION_SUBMITTED']);
        const otp = logs.find((l) => l.purpose === 'ADMISSION_OTP')!;
        expect(otp.body).toContain('••••••');
        expect(otp.body).not.toMatch(/\d{6}/);
        expect(otp.status).toBe('SENT');
      },
      { timeout: 15_000, interval: 200 },
    );
    // The received SMS names the number.
    await vi.waitFor(() =>
      expect(h.sms.sentTo(phone).some((t) => t.includes(res.body.applicationNo))).toBe(true),
    );
  });

  it('the status: the proved phone sees it; another phone gets 404', async () => {
    const form = await getForm(a.slug);
    const me = await prove(a.slug);
    clock.advance(20_000);
    const no = (
      await submit(a.slug, me.token, {
        cycleClassId: classA,
        ticket: form.formTicket,
        payload: fields({ nameBn: 'অবস্থা দেখা' }),
      }).expect(201)
    ).body.applicationNo as string;
    const st = (
      await http(h)
        .post(pub(a.slug, '/status'))
        .set('X-Admission-Token', me.token)
        .send({ applicationNo: no })
        .expect(200)
    ).body as AdmissionPublicStatus;
    expect(st).toMatchObject({ applicationNo: no, status: 'SUBMITTED', nameBn: 'অবস্থা দেখা' });
    const other = await prove(a.slug);
    const res = await http(h)
      .post(pub(a.slug, '/status'))
      .set('X-Admission-Token', other.token)
      .send({ applicationNo: no });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('APPLICATION_NOT_FOUND');
  });

  it('review focus 1: 50 phones from 10 addresses against a ceiling of 20 → exactly 20 codes', async () => {
    const t = await admissionSchool(h);
    await admissionCycle(h, t);
    const ips = Array.from({ length: 10 }, () => randomIp());
    const phones = Array.from({ length: 50 }, () => randomPhone());
    const results = [];
    for (let i = 0; i < phones.length; i++) {
      results.push((await askCode(t.slug, phones[i]!, ips[i % 10])).status);
    }
    expect(results.filter((s) => s === 202)).toHaveLength(20);
    expect(results.filter((s) => s === 429)).toHaveLength(30);
    await vi.waitFor(
      async () =>
        expect(
          (await smsLogs(t.tenantId)).filter((l) => l.purpose === 'ADMISSION_OTP'),
        ).toHaveLength(20),
      { timeout: 20_000, interval: 250 },
    );
  });

  it('no code without a Turnstile pass (no SMS, no counter used); Cloudflare down → 503', async () => {
    const phone = randomPhone();
    const failed = await askCode(a.slug, phone, randomIp(), 'fail');
    expect(failed.status).toBe(403);
    expect(failed.body.code).toBe('TURNSTILE_FAILED');
    const down = await askCode(a.slug, phone, randomIp(), 'down');
    expect(down.status).toBe(503);
    expect(h.sms.sentTo(phone)).toEqual([]);
    // The refusals used no counter: the phone gets its code now.
    await askCode(a.slug, phone).expect(202);
    // And a second one within a minute is refused.
    expect((await askCode(a.slug, phone)).status).toBe(429);
  });

  it('a wrong code is refused; an unknown institute is 404', async () => {
    const phone = randomPhone();
    await askCode(a.slug, phone).expect(202);
    await lastCode(phone);
    const res = await http(h).post(pub(a.slug, '/otp/verify')).send({ phone, code: '000000' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('ADMISSION_CODE_INVALID');
    await http(h).get(pub('no-such-school')).expect(404);
  });

  it('review focus 6: token confusion is 401 every way', async () => {
    const { token } = await prove(a.slug);
    const form = await getForm(a.slug);
    // The phone token is not an access token.
    await http(h).get('/students').set(bearer(token)).expect(401);
    // An access token is not a phone token.
    const admin = await addMember(h, a.tenantId, { roles: ['ADMIN'] });
    const access = (await otpLogin(h, admin.phone)).accessToken;
    clock.advance(20_000);
    expect(
      (await submit(a.slug, access, { cycleClassId: classA, ticket: form.formTicket })).status,
    ).toBe(401);
    // A's token at B.
    const formB = await getForm(b.slug);
    clock.advance(20_000);
    const atB = await submit(b.slug, token, { cycleClassId: classB, ticket: formB.formTicket });
    expect(atB.status).toBe(401);
    expect(atB.body.code).toBe('ADMISSION_TOKEN_INVALID');
    // Expired (31 minutes later).
    clock.advance(31 * 60_000);
    const fresh = await getForm(a.slug);
    clock.advance(20_000);
    expect(
      (await submit(a.slug, token, { cycleClassId: classA, ticket: fresh.formTicket })).status,
    ).toBe(401);
  });

  it("review focus 3: B's class with A's slug is CLOSED and nothing is written", async () => {
    const form = await getForm(a.slug);
    const { token } = await prove(a.slug);
    clock.advance(20_000);
    const before = await withTenant(h.prisma, b.tenantId, (tx) => tx.admissionApplication.count());
    const res = await submit(a.slug, token, { cycleClassId: classB, ticket: form.formTicket });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('ADMISSION_CLOSED');
    expect(await withTenant(h.prisma, b.tenantId, (tx) => tx.admissionApplication.count())).toBe(
      before,
    );
  });

  it('too fast, or a filled honeypot: the same vague 422; an unknown key is ADMISSION_INVALID', async () => {
    const form = await getForm(a.slug);
    const { token } = await prove(a.slug);
    clock.advance(5_000);
    const fast = await submit(a.slug, token, { cycleClassId: classA, ticket: form.formTicket });
    expect(fast.status).toBe(422);
    expect(fast.body.code).toBe('ADMISSION_REJECTED');
    clock.advance(15_000);
    const honey = await submit(a.slug, token, {
      cycleClassId: classA,
      ticket: form.formTicket,
      website: 'http://spam.example',
    });
    expect(honey.status).toBe(422);
    expect(honey.body.code).toBe('ADMISSION_REJECTED');
    expect(honey.body.message).toBe(fast.body.message);
    const bad = await submit(a.slug, token, {
      cycleClassId: classA,
      ticket: form.formTicket,
      payload: { ...fields(), studentId: 'x' },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('ADMISSION_INVALID');
  });

  it('review focus 7: a 6 MB upload is 413 before decoding; a text file named .png is refused', async () => {
    const form = await getForm(a.slug);
    const { token } = await prove(a.slug);
    clock.advance(20_000);
    const big = await submit(a.slug, token, {
      cycleClassId: classA,
      ticket: form.formTicket,
      photo: Buffer.alloc(6 * 1024 * 1024, 7),
    });
    expect(big.status).toBe(413);
    const text = await submit(a.slug, token, {
      cycleClassId: classA,
      ticket: form.formTicket,
      payload: fields({ nameBn: 'ছবি নয়' }),
      photo: Buffer.from('this is not an image at all'),
    });
    expect(text.status).toBe(422);
  });

  it('a duplicate submit is refused with the first number (P3-S)', async () => {
    const form = await getForm(a.slug);
    const { token } = await prove(a.slug);
    clock.advance(20_000);
    const body = {
      cycleClassId: classA,
      ticket: form.formTicket,
      payload: fields({ nameBn: 'একই শিশু' }),
    };
    const first = await submit(a.slug, token, body).expect(201);
    const again = await submit(a.slug, token, body);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      code: 'ADMISSION_DUPLICATE',
      applicationNo: first.body.applicationNo,
    });
  });
});

import { TURNSTILE_DUMMY_TOKEN } from '../src/admission/public/turnstile.js';
import { admissionCycle, admissionSchool } from './support/admission.js';
import { FakeClock } from './support/clock.js';
import { createHarness, http, randomIp, randomPhone, type Harness } from './support/harness.js';

// A small ceiling and a 1 s cooldown, before the app reads its settings.
vi.hoisted(() => {
  process.env['ADMISSION_OTP_PER_TENANT_PER_DAY'] = '6';
  process.env['ADMISSION_OTP_PHONE_COOLDOWN_SEC'] = '1';
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sprint 1 P3b, review round 2 (SHOULD-FIX 1): the status page's code request answers the same
 * for a matching (phone, application number) and for any other pair in every budget state, so it
 * is never an oracle for "this phone made this application". Before the fix, a spent institute
 * ceiling or a spent per-phone day made a match answer 429 (with Retry-After) and a non-match 202.
 */
describe('admission (public): the status code request is no oracle', () => {
  const clock = new FakeClock('2026-11-20T06:00:00.000Z');
  let h: Harness;
  const pub = (slug: string, path = '') => `/public/admission/${slug}${path}`;
  const askCode = (slug: string, phone: string) =>
    http(h)
      .post(pub(slug, '/otp'))
      .set('X-Forwarded-For', randomIp())
      .send({ phone, turnstileToken: TURNSTILE_DUMMY_TOKEN });
  const askStatusCode = (slug: string, phone: string, applicationNo: string) =>
    http(h).post(pub(slug, '/otp')).set('X-Forwarded-For', randomIp()).send({
      phone,
      turnstileToken: TURNSTILE_DUMMY_TOKEN,
      purpose: 'status',
      applicationNo,
    });
  const lastCode = async (phone: string) =>
    vi.waitFor(
      () => {
        const m = /(\d{6})/.exec(h.sms.sentTo(phone).at(-1) ?? '');
        if (!m) throw new Error('no code yet');
        return m[1]!;
      },
      { timeout: 15_000, interval: 100 },
    );
  /** An application made through the form; returns its phone and number. */
  const applied = async (slug: string, cycleClassId: string) => {
    const form = (await http(h).get(pub(slug)).set('X-Forwarded-For', randomIp()).expect(200))
      .body as { formTicket: string };
    const phone = randomPhone();
    await askCode(slug, phone).expect(202);
    const code = await lastCode(phone);
    const token = (
      await http(h)
        .post(pub(slug, '/otp/verify'))
        .set('X-Forwarded-For', randomIp())
        .send({ phone, code })
        .expect(200)
    ).body.phoneToken as string;
    clock.advance(20_000);
    const no = (
      await http(h)
        .post(pub(slug, '/applications'))
        .set('X-Forwarded-For', randomIp())
        .set('X-Admission-Token', token)
        .field(
          'payload',
          JSON.stringify({
            nameBn: 'অবস্থার শিশু',
            dateOfBirth: '2019-05-01',
            gender: 'MALE',
            guardianNameBn: 'অভিভাবক',
            guardianRelation: 'FATHER',
          }),
        )
        .field('cycleClassId', cycleClassId)
        .field('turnstileToken', TURNSTILE_DUMMY_TOKEN)
        .field('formTicket', form.formTicket)
        .field('website', '')
        .expect(201)
    ).body.applicationNo as string;
    return { phone, no };
  };
  /** Status, body and Retry-After: what a caller can tell apart. */
  const seen = (r: { status: number; body: unknown; headers: Record<string, string> }) => [
    r.status,
    JSON.stringify(r.body),
    r.headers['retry-after'] ?? null,
  ];

  beforeAll(async () => {
    h = await createHarness({ clock });
  });
  afterAll(() => h.close());

  it("the institute's ceiling spent: a matching pair answers exactly as a wrong number and a stranger's phone", async () => {
    const t = await admissionSchool(h);
    const cc = (await admissionCycle(h, t)).classes.find((x) => x.classLevel.id === t.class6)!.id;
    const { phone, no } = await applied(t.slug, cc); // ceiling 1 of 6
    for (let i = 0; i < 5; i++) await askCode(t.slug, randomPhone()).expect(202); // 6 of 6
    await sleep(1_200);
    const match = await askStatusCode(t.slug, phone, no);
    await sleep(1_200);
    const wrongNo = await askStatusCode(t.slug, phone, '2027-0999');
    const stranger = await askStatusCode(t.slug, randomPhone(), no);
    expect(seen(match)).toEqual(seen(wrongNo));
    expect(seen(match)).toEqual(seen(stranger));
    expect(match.status).toBe(202);
  });

  it("the phone's five a day spent by someone else: the same", async () => {
    const u = await admissionSchool(h);
    const cc = (await admissionCycle(h, u)).classes.find((x) => x.classLevel.id === u.class6)!.id;
    const { phone, no } = await applied(u.slug, cc); // the phone's day 1 of 5
    for (let i = 0; i < 4; i++) {
      await sleep(1_200);
      await askCode(u.slug, phone).expect(202); // 5 of 5
    }
    await sleep(1_200);
    const match = await askStatusCode(u.slug, phone, no);
    await sleep(1_200);
    const wrongNo = await askStatusCode(u.slug, phone, '2027-0999');
    expect(seen(match)).toEqual(seen(wrongNo));
    expect(match.status).toBe(202);
  });
});

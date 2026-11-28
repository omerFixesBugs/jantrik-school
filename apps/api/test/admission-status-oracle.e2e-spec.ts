import { withTenant } from '@jantrik/db';
import { TURNSTILE_DUMMY_TOKEN } from '../src/admission/public/turnstile.js';
import { admissionCycle, admissionSchool } from './support/admission.js';
import { FakeClock } from './support/clock.js';
import { createHarness, http, randomIp, randomPhone, type Harness } from './support/harness.js';

// A small ceiling and a 1 s cooldown, before the app reads its settings. The ceiling is the
// institute's total of codes a day: the form gets 5 of the 6, the status page 1.
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
 * Nor may a probe leave a trace a later request can read: a match used to spend the form's shared
 * budgets, so the next ordinary code request answered 429 only after a match (follow-up review).
 * A status code proves the phone for the status only (its own slot and token), and the configured
 * ceiling caps all of an institute's codes together (second follow-up).
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
  // A code SMS (not the "application received" one, which can arrive in any order).
  const CODE = /(?:কোড|code): (\d{6})/;
  const codesTo = (phone: string) => h.sms.sentTo(phone).filter((m) => CODE.test(m));
  /** The newest code SMS to this phone once there are more than `before` of them. */
  const nextCode = (phone: string, before: number) =>
    vi.waitFor(
      () => {
        const codes = codesTo(phone);
        if (codes.length <= before) throw new Error('no new code yet');
        return CODE.exec(codes.at(-1)!)![1]!;
      },
      { timeout: 15_000, interval: 100 },
    );
  const lastCode = (phone: string) => nextCode(phone, 0);
  /** An application made through the form; returns its phone, number and form token. */
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
    const no = (await submit(slug, token, cycleClassId, form.formTicket).expect(201)).body
      .applicationNo as string;
    return { phone, no, token };
  };
  const submit = (slug: string, token: string, cycleClassId: string, ticket: string) =>
    http(h)
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
      .field('formTicket', ticket)
      .field('website', '');
  const verify = (slug: string, phone: string, code: string, purpose?: 'status') =>
    http(h)
      .post(pub(slug, '/otp/verify'))
      .set('X-Forwarded-For', randomIp())
      .send({ phone, code, ...(purpose ? { purpose } : {}) });
  const otpLogs = (tenantId: string) =>
    withTenant(h.prisma, tenantId, (tx) =>
      tx.smsLog.count({ where: { purpose: 'ADMISSION_OTP' } }),
    );
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
    const { phone, no } = await applied(t.slug, cc); // the form's share 1 of 5
    for (let i = 0; i < 4; i++) await askCode(t.slug, randomPhone()).expect(202); // 5 of 5
    await askCode(t.slug, randomPhone()).expect(429);
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

  it("a status probe leaves no trace in the budgets the form's code request reads", async () => {
    // One institute per victim, so each stays under the ceiling (6): the phone's day decides.
    const trace = async (matching: boolean) => {
      const v = await admissionSchool(h);
      const cc = (await admissionCycle(h, v)).classes.find((x) => x.classLevel.id === v.class6)!.id;
      const { phone, no } = await applied(v.slug, cc); // the phone's day 1 of 5
      for (let i = 0; i < 3; i++) {
        await sleep(1_200);
        await askCode(v.slug, phone).expect(202); // 4 of 5
      }
      await sleep(1_200);
      const before = codesTo(phone).length;
      await askStatusCode(v.slug, phone, matching ? no : '2027-0999').expect(202);
      // The matching pair still gets its code (the status page works).
      if (matching) await nextCode(phone, before);
      await sleep(1_200);
      return seen(await askCode(v.slug, phone));
    };
    const afterMatch = await trace(true);
    const afterOther = await trace(false);
    expect(afterMatch).toEqual(afterOther);
    expect(afterMatch[0]).toBe(202);
  }, 90_000);

  it('a status code proves the phone for the status only: it cannot submit, a form code cannot read the status, neither verifies as the other', async () => {
    const v = await admissionSchool(h);
    const cc = (await admissionCycle(h, v)).classes.find((x) => x.classLevel.id === v.class6)!.id;
    const { phone, no, token: formToken } = await applied(v.slug, cc);
    // The form's token never reads the status.
    const byForm = await http(h)
      .post(pub(v.slug, '/status'))
      .set('X-Forwarded-For', randomIp())
      .set('X-Admission-Token', formToken)
      .send({ applicationNo: no });
    expect(byForm.status).toBe(401);
    expect(byForm.body.code).toBe('ADMISSION_TOKEN_INVALID');

    await sleep(1_200);
    const beforeStatus = codesTo(phone).length;
    await askStatusCode(v.slug, phone, no).expect(202);
    const statusCode = await nextCode(phone, beforeStatus);
    // A status code is not a form code (its own slot) ...
    expect((await verify(v.slug, phone, statusCode)).status).toBe(422);
    // ... it verifies only as a status code, into a token that reads the status ...
    const statusToken = (await verify(v.slug, phone, statusCode, 'status').expect(200)).body
      .phoneToken as string;
    await http(h)
      .post(pub(v.slug, '/status'))
      .set('X-Forwarded-For', randomIp())
      .set('X-Admission-Token', statusToken)
      .send({ applicationNo: no })
      .expect(200);
    // ... and is refused by the submit (before the body is read, by the upload guard).
    const form = (await http(h).get(pub(v.slug)).set('X-Forwarded-For', randomIp()).expect(200))
      .body as { formTicket: string };
    clock.advance(20_000);
    const bySubmit = await submit(v.slug, statusToken, cc, form.formTicket);
    expect(bySubmit.status).toBe(401);
    expect(bySubmit.body.code).toBe('ADMISSION_TOKEN_INVALID');

    // A form code does not verify as a status code.
    await sleep(1_200);
    const beforeForm = codesTo(phone).length;
    await askCode(v.slug, phone).expect(202);
    const formCode = await nextCode(phone, beforeForm);
    expect((await verify(v.slug, phone, formCode, 'status')).status).toBe(422);
  });

  it("all of an institute's codes in a day stay within ADMISSION_OTP_PER_TENANT_PER_DAY (6 here: the form 5, the status page 1)", async () => {
    const z = await admissionSchool(h);
    const cc = (await admissionCycle(h, z)).classes.find((x) => x.classLevel.id === z.class6)!.id;
    const first = await applied(z.slug, cc); // the form 1 of 5
    const second = await applied(z.slug, cc); // 2 of 5
    for (let i = 0; i < 3; i++) await askCode(z.slug, randomPhone()).expect(202); // 5 of 5
    await askCode(z.slug, randomPhone()).expect(429);
    await sleep(1_200);
    const sent = (phone: string) => codesTo(phone).length;
    const before = sent(first.phone) + sent(second.phone);
    await askStatusCode(z.slug, first.phone, first.no).expect(202); // the status page 1 of 1
    await askStatusCode(z.slug, second.phone, second.no).expect(202); // none left: nothing sent
    await vi.waitFor(() => expect(sent(first.phone) + sent(second.phone)).toBe(before + 1), {
      timeout: 15_000,
      interval: 100,
    });
    await sleep(1_500);
    expect(sent(first.phone) + sent(second.phone)).toBe(before + 1);
    await vi.waitFor(async () => expect(await otpLogs(z.tenantId)).toBe(6), {
      timeout: 15_000,
      interval: 250,
    });
  }, 60_000);
});

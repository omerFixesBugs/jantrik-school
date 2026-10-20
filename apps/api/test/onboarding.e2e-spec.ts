import { randomUUID } from 'node:crypto';
import { withTenant } from '@jantrik/db';
import { TENANT_HEADER, type AuthResponse, type Onboarding } from '@jantrik/shared';
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
import { platform, platformAdminCookie } from './support/platform.js';

// Step 8, part 5: the new owner's setup wizard. Institutes the platform creates get one; the
// owner (or an admin) saves each step as done or skipped, then finishes. See docs/platform.md.

describe('onboarding wizard', () => {
  let h: Harness;
  let cookie: string;

  /** A new institute from the platform; its owner signs in, accepts and gets a token. */
  const newInstitute = async (modules: string[] = ['ATTENDANCE']) => {
    const phone = randomPhone();
    const res = await platform(h, cookie)
      .post('/platform/institutes')
      .send({
        name: 'নতুন বিদ্যালয়',
        slug: `o-${randomUUID().slice(0, 8)}`,
        instituteTypeKey: 'NCTB_SCHOOL_BN',
        modules,
        owner: { phone, name: 'New Owner', nameBn: null },
        plan: { planName: 'Standard', pricing: 'PER_STUDENT', corePaisa: 1000 },
      })
      .expect(201);
    const tenantId = (res.body as { id: string }).id;
    const login = await otpLogin(h, phone);
    await http(h)
      .post(`/me/invitations/${tenantId}/accept`)
      .set(bearer(login.accessToken))
      .send({ roles: ['OWNER'] })
      .expect(204);
    const switched = await http(h)
      .post('/auth/switch-tenant')
      .set(bearer(login.accessToken))
      .send({ tenantId })
      .expect(200);
    return { tenantId, token: (switched.body as AuthResponse).accessToken };
  };
  const get = async (token: string) =>
    (await http(h).get('/onboarding').set(bearer(token)).expect(200)).body as Onboarding;
  const put = (token: string, step: string, state: unknown) =>
    http(h).put(`/onboarding/steps/${step}`).set(bearer(token)).send({ state });

  beforeAll(async () => {
    h = await createHarness();
    cookie = await platformAdminCookie(h);
  });

  afterAll(async () => {
    await h.close();
  });

  it('a new institute starts at the first step; attendance only with that module', async () => {
    const withAttendance = await newInstitute(['ATTENDANCE']);
    expect(await get(withAttendance.token)).toEqual({
      wizard: true,
      steps: ['year', 'classes', 'shifts', 'teachers', 'students', 'attendance'],
      states: {},
      nextStep: 'year',
      completedAt: null,
    });

    const coreOnly = await newInstitute([]);
    expect((await get(coreOnly.token)).steps).toEqual([
      'year',
      'classes',
      'shifts',
      'teachers',
      'students',
    ]);
    const res = await put(coreOnly.token, 'attendance', 'done').expect(422);
    expect(res.body).toMatchObject({ code: 'ONBOARDING_STEP_UNAVAILABLE' });
  });

  it('saves each step as done or skipped; the latest answer wins; the next step follows', async () => {
    const { token } = await newInstitute();
    let state = (await put(token, 'year', 'done').expect(200)).body as Onboarding;
    expect(state).toMatchObject({ states: { year: 'done' }, nextStep: 'classes' });
    state = (await put(token, 'classes', 'skipped').expect(200)).body as Onboarding;
    expect(state).toMatchObject({
      states: { year: 'done', classes: 'skipped' },
      nextStep: 'shifts',
    });
    // A later step first: the next one is still the earliest open step.
    state = (await put(token, 'students', 'done').expect(200)).body as Onboarding;
    expect(state.nextStep).toBe('shifts');
    state = (await put(token, 'year', 'skipped').expect(200)).body as Onboarding;
    expect(state.states).toEqual({ year: 'skipped', classes: 'skipped', students: 'done' });
    expect(await get(token)).toEqual(state);

    await put(token, 'fees', 'done').expect(404);
    await put(token, 'shifts', 'maybe').expect(400);
    await put(token, 'shifts', undefined).expect(400);
  });

  it('two steps saved at once both keep their answer', async () => {
    const { token } = await newInstitute();
    await Promise.all([
      put(token, 'year', 'done').expect(200),
      put(token, 'classes', 'done').expect(200),
      put(token, 'shifts', 'skipped').expect(200),
    ]);
    expect((await get(token)).states).toEqual({ year: 'done', classes: 'done', shifts: 'skipped' });
  });

  it('owners and admins only: a teacher or a guardian gets 403', async () => {
    const { tenantId, token } = await newInstitute();
    const admin = await otpLogin(h, (await addMember(h, tenantId, { roles: ['ADMIN'] })).phone);
    expect((await put(admin.accessToken, 'year', 'done').expect(200)).body).toMatchObject({
      states: { year: 'done' },
    });
    for (const role of ['TEACHER', 'GUARDIAN'] as const) {
      const other = await otpLogin(h, (await addMember(h, tenantId, { roles: [role] })).phone);
      await http(h).get('/onboarding').set(bearer(other.accessToken)).expect(403);
      await put(other.accessToken, 'classes', 'done').expect(403);
      await http(h).post('/onboarding/finish').set(bearer(other.accessToken)).expect(403);
    }
    expect((await get(token)).states).toEqual({ year: 'done' });
  });

  it('finishing marks the open steps skipped, is audited, and closes the wizard', async () => {
    const { tenantId, token } = await newInstitute();
    await put(token, 'year', 'done').expect(200);
    await put(token, 'teachers', 'done').expect(200);
    const done = (await http(h).post('/onboarding/finish').set(bearer(token)).expect(200))
      .body as Onboarding;
    expect(done).toMatchObject({
      wizard: true,
      nextStep: null,
      states: {
        year: 'done',
        classes: 'skipped',
        shifts: 'skipped',
        teachers: 'done',
        students: 'skipped',
        attendance: 'skipped',
      },
    });
    expect(done.completedAt).not.toBeNull();

    // Twice is fine (no second audit entry); saving a step afterwards is refused.
    const again = (await http(h).post('/onboarding/finish').set(bearer(token)).expect(200))
      .body as Onboarding;
    expect(again).toEqual(done);
    const late = await put(token, 'classes', 'done').expect(409);
    expect(late.body).toMatchObject({ code: 'ONBOARDING_FINISHED' });

    const audit = await withTenant(h.prisma, tenantId, (tx) =>
      tx.auditLog.findMany({ where: { entity: 'onboarding_progress' } }),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'UPDATE',
      oldValues: { completed: false, steps: { year: 'done', teachers: 'done' } },
      newValues: { completed: true },
    });
  });

  it('one institute cannot read or change another institute’s wizard', async () => {
    const a = await newInstitute();
    const b = await newInstitute();
    await put(a.token, 'year', 'done').expect(200);
    await http(h).post('/onboarding/finish').set(bearer(a.token)).expect(200);
    expect(await get(b.token)).toMatchObject({ states: {}, nextStep: 'year', completedAt: null });
    // The institute comes from the token: naming A in the header is refused, not switched.
    const mismatch = await http(h)
      .put('/onboarding/steps/classes')
      .set(bearer(b.token))
      .set(TENANT_HEADER, a.tenantId)
      .send({ state: 'done' })
      .expect(409);
    expect(mismatch.body).toMatchObject({ code: 'TENANT_MISMATCH' });
    expect((await get(a.token)).states).toMatchObject({ classes: 'skipped' });
    expect((await get(b.token)).states).toEqual({});
  });

  it('an institute without a wizard (made before it, or a demo one) has none', async () => {
    const coreOnly = await createTenant(h);
    const coreOwner = await otpLogin(
      h,
      (await addMember(h, coreOnly.id, { roles: ['OWNER'] })).phone,
    );
    await put(coreOwner.accessToken, 'attendance', 'done').expect(404);
    const t = await createTenant(h, { modules: ['ATTENDANCE'] });
    const owner = await otpLogin(h, (await addMember(h, t.id, { roles: ['OWNER'] })).phone);
    expect(await get(owner.accessToken)).toEqual({
      wizard: false,
      steps: [],
      states: {},
      nextStep: null,
      completedAt: null,
    });
    await put(owner.accessToken, 'year', 'done').expect(404);
    await http(h).post('/onboarding/finish').set(bearer(owner.accessToken)).expect(404);
  });
});

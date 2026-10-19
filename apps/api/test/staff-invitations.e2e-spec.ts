import { findOrCreateUser, withTenant } from '@jantrik/db';
import type { MembershipSummary, StaffInvitation, StaffMember } from '@jantrik/shared';
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

// Staff invitations (step 7 review, decision #15): typed names only, access after accept,
// 14-day expiry, cancel / re-invite, rate limit.
describe('staff invitations', () => {
  let h: Harness;
  let tenantId: string;
  let owner: string;
  let admin: string;

  const invite = (body: object, token = admin) =>
    http(h).post('/staff').set(bearer(token)).send(body);
  const staffList = async () =>
    (await http(h).get('/staff').set(bearer(admin)).expect(200)) as {
      body: StaffMember[];
      text: string;
    };
  /** A person who already exists elsewhere, with a global name this institute must never see. */
  const existingElsewhere = async () => {
    const other = (await createTenant(h)).id;
    const phone = randomPhone();
    await withTenant(h.prisma, other, async (tx) => {
      const id = await findOrCreateUser(tx, phone, 'Secret Global Name', 'গোপন নাম');
      await tx.membership.create({ data: { tenantId: other, userId: id, role: 'GUARDIAN' } });
    });
    return phone;
  };

  beforeAll(async () => {
    h = await createHarness();
    tenantId = (await createTenant(h)).id;
    owner = (await otpLogin(h, (await addMember(h, tenantId, { roles: ['OWNER'] })).phone))
      .accessToken;
    admin = (await otpLogin(h, (await addMember(h, tenantId, { roles: ['ADMIN'] })).phone))
      .accessToken;
  });

  afterAll(async () => {
    await h.close();
  });

  it('the response is the same whether or not the phone already exists; global names never show', async () => {
    const body = (phone: string) => ({
      phone,
      name: 'Typed Name',
      nameBn: 'টাইপ করা নাম',
      roles: ['TEACHER'],
    });
    const fresh = await invite(body(randomPhone())).expect(201);
    const existing = await invite(body(await existingElsewhere())).expect(201);
    const strip = (m: StaffMember) => {
      const { userId: _u, phone: _p, since: _s, inviteExpiresAt: _e, ...rest } = m;
      return rest;
    };
    expect(Object.keys(existing.body as object).sort()).toEqual(
      Object.keys(fresh.body as object).sort(),
    );
    expect(strip(existing.body as StaffMember)).toEqual(strip(fresh.body as StaffMember));
    expect(existing.body).toMatchObject({
      status: 'INVITED',
      name: 'Typed Name',
      nameBn: 'টাইপ করা নাম',
    });
    // Both ids are random v4 UUIDs (no creation time in them).
    for (const r of [fresh, existing])
      expect((r.body as StaffMember).userId).toMatch(/^[0-9a-f-]{14}4/);
    expect(existing.text).not.toContain('Secret');
    const list = await staffList();
    expect(list.text).not.toContain('Secret Global Name');
    expect(list.text).not.toContain('গোপন নাম');
  });

  it('access starts only after accept; the typed name stays after accepting', async () => {
    const phone = await existingElsewhere();
    const m = (await invite({ phone, name: 'Mr Typed', roles: ['TEACHER'] }).expect(201))
      .body as StaffMember;
    const login = await otpLogin(h, phone);
    const mine = (await http(h).get('/auth/memberships').set(bearer(login.accessToken)).expect(200))
      .body as MembershipSummary[];
    expect(mine.find((x) => x.tenant.id === tenantId)).toMatchObject({
      selectable: false,
      roles: [],
      invitation: { roles: ['TEACHER'] },
    });
    // Not yet: no switching into the institute.
    await http(h)
      .post('/auth/switch-tenant')
      .set(bearer(login.accessToken))
      .send({ tenantId })
      .expect(403);
    const invitations = (
      await http(h).get('/me/invitations').set(bearer(login.accessToken)).expect(200)
    ).body as StaffInvitation[];
    expect(invitations.map((i) => i.tenant.id)).toContain(tenantId);

    await http(h)
      .post(`/me/invitations/${tenantId}/accept`)
      .set(bearer(login.accessToken))
      .send({ roles: ['TEACHER'] })
      .expect(204);
    await http(h)
      .post('/auth/switch-tenant')
      .set(bearer(login.accessToken))
      .send({ tenantId })
      .expect(200);
    const list = await staffList();
    expect(list.body.find((x) => x.userId === m.userId)).toMatchObject({
      status: 'ACTIVE',
      name: 'Mr Typed',
    });
    expect(list.text).not.toContain('Secret Global Name');
  });

  it('decline: no access, shown as DECLINED; the admin can invite again', async () => {
    const phone = randomPhone();
    const m = (await invite({ phone, name: 'Decliner', roles: ['STAFF'] }).expect(201))
      .body as StaffMember;
    const login = await otpLogin(h, phone);
    await http(h)
      .post(`/me/invitations/${tenantId}/decline`)
      .set(bearer(login.accessToken))
      .expect(204);
    await http(h)
      .post(`/me/invitations/${tenantId}/accept`)
      .set(bearer(login.accessToken))
      .send({ roles: ['STAFF'] })
      .expect(404);
    expect((await staffList()).body.find((x) => x.userId === m.userId)!.status).toBe('DECLINED');
    const again = (await http(h).post(`/staff/${m.userId}/reinvite`).set(bearer(admin)).expect(200))
      .body as StaffMember;
    expect(again.status).toBe('INVITED');
    await http(h)
      .post(`/me/invitations/${tenantId}/accept`)
      .set(bearer(login.accessToken))
      .send({ roles: ['STAFF'] })
      .expect(204);
  });

  it('invitations expire after 14 days: not listed, cannot be accepted, can be sent again', async () => {
    const phone = randomPhone();
    const m = (await invite({ phone, name: 'Late', roles: ['TEACHER'] }).expect(201))
      .body as StaffMember;
    await withTenant(h.prisma, tenantId, (tx) =>
      tx.membership.updateMany({
        where: { userId: m.userId },
        data: { invitedAt: new Date(Date.now() - 15 * 24 * 3600 * 1000) },
      }),
    );
    const login = await otpLogin(h, phone);
    const invitations = (
      await http(h).get('/me/invitations').set(bearer(login.accessToken)).expect(200)
    ).body as StaffInvitation[];
    expect(invitations.map((i) => i.tenant.id)).not.toContain(tenantId);
    const r = await http(h)
      .post(`/me/invitations/${tenantId}/accept`)
      .set(bearer(login.accessToken))
      .send({ roles: ['TEACHER'] })
      .expect(410);
    expect(r.body.code).toBe('INVITATION_EXPIRED');
    expect((await staffList()).body.find((x) => x.userId === m.userId)!.status).toBe('EXPIRED');
    // Pending ones cannot be re-sent; expired ones can.
    await http(h).post(`/staff/${m.userId}/reinvite`).set(bearer(admin)).expect(200);
    await http(h).post(`/staff/${m.userId}/reinvite`).set(bearer(admin)).expect(409);
    await http(h)
      .post(`/me/invitations/${tenantId}/accept`)
      .set(bearer(login.accessToken))
      .send({ roles: ['TEACHER'] })
      .expect(204);
  });

  it('accept must name the roles shown; changed meanwhile: 409, nothing granted', async () => {
    const phone = randomPhone();
    const m = (await invite({ phone, name: 'Changed', roles: ['TEACHER'] }).expect(201))
      .body as StaffMember;
    const login = await otpLogin(h, phone);
    // The admin widens the invitation after the invitee saw "Teacher".
    await http(h)
      .put(`/staff/${m.userId}/roles`)
      .set(bearer(admin))
      .send({ roles: ['TEACHER', 'ADMIN'] })
      .expect(200);
    const r = await http(h)
      .post(`/me/invitations/${tenantId}/accept`)
      .set(bearer(login.accessToken))
      .send({ roles: ['TEACHER'] })
      .expect(409);
    expect(r.body.code).toBe('INVITATION_CHANGED');
    expect((await staffList()).body.find((x) => x.userId === m.userId)!.status).toBe('INVITED');
    // No body at all is a validation error, not an accept.
    await http(h)
      .post(`/me/invitations/${tenantId}/accept`)
      .set(bearer(login.accessToken))
      .expect(400);
    await http(h)
      .post(`/me/invitations/${tenantId}/accept`)
      .set(bearer(login.accessToken))
      .send({ roles: ['ADMIN', 'TEACHER'] })
      .expect(204);
    expect((await staffList()).body.find((x) => x.userId === m.userId)).toMatchObject({
      status: 'ACTIVE',
      roles: ['ADMIN', 'TEACHER'],
    });
  });

  it('cancel a pending invitation (wrong number): gone for both sides; audited', async () => {
    const phone = randomPhone();
    const m = (await invite({ phone, name: 'Wrong Number', roles: ['TEACHER'] }).expect(201))
      .body as StaffMember;
    await http(h).post(`/staff/${m.userId}/cancel-invitation`).set(bearer(admin)).expect(204);
    expect((await staffList()).body.map((x) => x.userId)).not.toContain(m.userId);
    const login = await otpLogin(h, phone);
    await http(h)
      .post(`/me/invitations/${tenantId}/accept`)
      .set(bearer(login.accessToken))
      .send({ roles: ['TEACHER'] })
      .expect(404);
    // Members cannot be "cancelled".
    const member = await addMember(h, tenantId, { roles: ['TEACHER'] });
    await http(h).post(`/staff/${member.userId}/cancel-invitation`).set(bearer(admin)).expect(409);
    const audit = await withTenant(h.prisma, tenantId, (tx) =>
      tx.auditLog.findMany({ where: { entity: 'membership', entityId: m.userId } }),
    );
    expect(audit.map((a) => a.action).sort()).toEqual(['CREATE', 'DELETE']);
    expect(audit.find((a) => a.action === 'DELETE')!.newValues).toMatchObject({
      reason: 'invitation_cancelled',
    });
  });

  it('owner invitations: only owners invite, cancel or re-send them', async () => {
    await invite({ phone: randomPhone(), name: 'x', roles: ['OWNER'] }, admin).expect(403);
    const m = (
      await invite({ phone: randomPhone(), name: 'New Owner', roles: ['OWNER'] }, owner).expect(201)
    ).body as StaffMember;
    await http(h).post(`/staff/${m.userId}/cancel-invitation`).set(bearer(admin)).expect(403);
    await http(h).post(`/staff/${m.userId}/cancel-invitation`).set(bearer(owner)).expect(204);
  });

  it("nobody can answer someone else's invitation or one to an institute that did not invite them", async () => {
    const phone = randomPhone();
    await invite({ phone, name: 'Invitee', roles: ['TEACHER'] }).expect(201);
    // A person with a login (staff elsewhere) who was not invited here.
    const elsewhere = (await createTenant(h)).id;
    const stranger = await otpLogin(
      h,
      (await addMember(h, elsewhere, { roles: ['TEACHER'] })).phone,
    );
    await http(h)
      .post(`/me/invitations/${tenantId}/accept`)
      .set(bearer(stranger.accessToken))
      .send({ roles: ['TEACHER'] })
      .expect(404);
    const other = (await createTenant(h)).id;
    const invitee = await otpLogin(h, phone);
    await http(h)
      .post(`/me/invitations/${other}/accept`)
      .set(bearer(invitee.accessToken))
      .send({ roles: ['TEACHER'] })
      .expect(404);
  });

  it('staff additions are rate-limited per institute', async () => {
    const t = (await createTenant(h)).id;
    const a = (await otpLogin(h, (await addMember(h, t, { roles: ['ADMIN'] })).phone)).accessToken;
    for (let i = 0; i < 30; i++) {
      await invite({ phone: randomPhone(), name: `P${i}`, roles: ['STAFF'] }, a).expect(201);
    }
    const r = await invite(
      { phone: randomPhone(), name: 'one too many', roles: ['STAFF'] },
      a,
    ).expect(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
  });
});

import { createPrismaClient, totpCode, totpStep, type PrismaClient } from '@jantrik/db';
import { PLATFORM_CLIENT, type PlatformLoginResponse } from '@jantrik/shared';
import { hash } from '@node-rs/argon2';
import { http, randomIp, randomPhone, type Harness } from './harness.js';

/** Platform tables are owner-only (the app role has no grants): fixtures use the owner role. */
export const ownerClient = (): PrismaClient =>
  createPrismaClient(process.env['DATABASE_MIGRATION_URL_TEST']!);

export interface TestPlatformAdmin {
  id: string;
  phone: string;
  password: string;
  /** Known once enrolled (base32). */
  secret?: string;
  /** Time steps already used for this admin (a step is accepted once). */
  usedSteps: Set<number>;
}

export async function createPlatformAdmin(
  owner: PrismaClient,
  opts: { phone?: string; password?: string; email?: string; enrolBy?: Date | null } = {},
): Promise<TestPlatformAdmin> {
  const phone = opts.phone ?? randomPhone();
  const password = opts.password ?? `Platform-${Math.random().toString(36).slice(2)}!`;
  const admin = await owner.platformAdmin.create({
    data: {
      name: 'Test Platform Admin',
      phone,
      email: opts.email ?? null,
      passwordHash: await hash(password),
      // As `pnpm platform:admin create` does: the authenticator may be set up for a while.
      totpEnrolBy: opts.enrolBy === undefined ? new Date(Date.now() + 3600_000) : opts.enrolBy,
    },
  });
  return { id: admin.id, phone, password, usedSteps: new Set() };
}

/** Request helpers that send the platform client header (and a cookie, if given). */
export const platform = (h: Harness, cookie?: string) => {
  const ip = randomIp();
  const withHeaders = <T extends { set: (k: string, v: string) => T }>(r: T): T => {
    r.set('X-Jantrik-Client', PLATFORM_CLIENT).set('X-Forwarded-For', ip);
    return cookie ? r.set('Cookie', cookie) : r;
  };
  return {
    get: (path: string) => withHeaders(http(h).get(path)),
    post: (path: string) => withHeaders(http(h).post(path)),
    put: (path: string) => withHeaders(http(h).put(path)),
  };
};

/** A code for a time step this admin has not used yet (previous, current or next). */
export function freshCode(admin: TestPlatformAdmin): string {
  const now = totpStep();
  for (const step of [now, now + 1, now - 1]) {
    if (!admin.usedSteps.has(step)) {
      admin.usedSteps.add(step);
      return totpCode(admin.secret!, step);
    }
  }
  throw new Error('All usable TOTP steps were used in this 30 s window');
}

export const cookieFrom = (setCookie: string[] | string | undefined): string => {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const found = list.find((c) => c.startsWith('jantrik_ps='));
  if (!found) throw new Error('No platform session cookie');
  return found.split(';')[0]!;
};

/** Password + TOTP (enrolling on the first login). Returns the session cookie. */
export async function platformLogin(
  h: Harness,
  admin: TestPlatformAdmin,
): Promise<{ cookie: string; backupCodes?: string[] }> {
  const step1 = await platform(h)
    .post('/platform/auth/login')
    .send({ identifier: admin.phone, password: admin.password })
    .expect(200);
  const body = step1.body as PlatformLoginResponse;
  if (body.enrol) admin.secret = body.enrol.secret;
  const step2 = await platform(h)
    .post('/platform/auth/verify')
    .send({ challengeId: body.challengeId, code: freshCode(admin) })
    .expect(200);
  return {
    cookie: cookieFrom(step2.headers['set-cookie']),
    ...(step2.body.backupCodes ? { backupCodes: step2.body.backupCodes as string[] } : {}),
  };
}

/** A new platform admin, signed in: the session cookie for platform(h, cookie). */
export async function platformAdminCookie(h: Harness): Promise<string> {
  const owner = ownerClient();
  try {
    return (await platformLogin(h, await createPlatformAdmin(owner))).cookie;
  } finally {
    await owner.$disconnect();
  }
}

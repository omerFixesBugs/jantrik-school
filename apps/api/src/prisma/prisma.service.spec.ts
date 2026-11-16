import type { LoginPrivileges } from '@jantrik/db';
import { PrismaService } from './prisma.service.js';

// The API's (and the worker's) login is checked before the app starts: never a superuser, never
// one that bypasses RLS or can become a role that does (docs/database.md → Database roles).

const SAFE: LoginPrivileges = {
  login: 'jantrik_app',
  superuser: false,
  bypassRls: false,
  replication: false,
  createRole: false,
  canBecome: [],
  temp: false,
};

/** The database server not answering, as the driver adapter reports it. */
const unreachable = () =>
  Object.assign(new Error("Raw query failed. Message: Can't reach database server"), {
    name: 'PrismaClientKnownRequestError',
    code: 'P2010',
    meta: { driverAdapterError: { cause: { kind: 'DatabaseNotReachable', port: 5432 } } },
  });

/** The service with the privilege query answering each call in turn (a row, or a failure). */
function service(...answers: (LoginPrivileges | Error)[]) {
  return serviceIn(false, ...answers);
}

function serviceIn(production: boolean, ...answers: (LoginPrivileges | Error)[]) {
  const queryRaw = vi.fn();
  for (const a of answers) {
    queryRaw.mockImplementationOnce(() =>
      a instanceof Error
        ? Promise.reject(a)
        : Promise.resolve([
            {
              login: a.login,
              superuser: a.superuser,
              bypass_rls: a.bypassRls,
              replication: a.replication,
              create_role: a.createRole,
              temp: a.temp,
              can_become: a.canBecome,
            },
          ]),
    );
  }
  const s = Object.create(PrismaService.prototype) as PrismaService;
  const warn = vi.fn();
  Object.assign(s, {
    client: { $queryRaw: queryRaw },
    logger: { warn, log: vi.fn() },
    production,
    retryDelaysMs: [0, 0, 0],
    checkTimeoutMs: 50,
  });
  return { s, queryRaw, warn };
}

describe('PrismaService and TEMP (P1-J8 review)', () => {
  it('refuses, in production, a login that may create temporary objects', async () => {
    await expect(serviceIn(true, { ...SAFE, temp: true }).s.onModuleInit()).rejects.toThrow(
      /DATABASE_URL.*may create temporary objects \(TEMP\)/,
    );
  });

  it('starts elsewhere, warning loudly with the REVOKE to run', async () => {
    const { s, warn } = serviceIn(false, { ...SAFE, temp: true });
    await expect(s.onModuleInit()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /jantrik_app may create temporary objects.*REVOKE TEMPORARY ON DATABASE/,
      ),
    );
  });

  it('says nothing about TEMP when the login has none', async () => {
    const { s, warn } = serviceIn(true, SAFE);
    await expect(s.onModuleInit()).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('PrismaService startup check', () => {
  it('starts when the login has no privileges', async () => {
    await expect(service(SAFE).s.onModuleInit()).resolves.toBeUndefined();
  });

  it('refuses a superuser login at once, naming DATABASE_URL and the login, never retrying', async () => {
    const { s, queryRaw } = service({ ...SAFE, login: 'postgres', superuser: true }, SAFE);
    await expect(s.onModuleInit()).rejects.toThrow(/DATABASE_URL.*postgres is a superuser/);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('refuses a login with BYPASSRLS', async () => {
    await expect(service({ ...SAFE, bypassRls: true }).s.onModuleInit()).rejects.toThrow(
      /DATABASE_URL.*has BYPASSRLS/,
    );
  });

  it('refuses a login with REPLICATION or CREATEROLE', async () => {
    await expect(service({ ...SAFE, replication: true }).s.onModuleInit()).rejects.toThrow(
      /DATABASE_URL.*has REPLICATION/,
    );
    await expect(service({ ...SAFE, createRole: true }).s.onModuleInit()).rejects.toThrow(
      /DATABASE_URL.*has CREATEROLE/,
    );
  });

  it('refuses a login that can become a BYPASSRLS role', async () => {
    await expect(
      service({ ...SAFE, canBecome: ['admin_bypass'] }).s.onModuleInit(),
    ).rejects.toThrow(/can become admin_bypass/);
  });

  it('waits while the database is unreachable, then starts (review focus 2)', async () => {
    const { s, queryRaw } = service(unreachable(), unreachable(), SAFE);
    await expect(s.onModuleInit()).resolves.toBeUndefined();
    expect(queryRaw).toHaveBeenCalledTimes(3);
  });

  it('refuses to start unchecked when the database never answers', async () => {
    const { s } = service(unreachable(), unreachable(), unreachable(), unreachable());
    await expect(s.onModuleInit()).rejects.toThrow(
      /DATABASE_URL\): PrismaClientKnownRequestError P2010 DatabaseNotReachable\. The API does not start unchecked/,
    );
  });
});

import type { LoginPrivileges } from '@jantrik/db';
import { LoginPrismaService } from './login-prisma.service.js';

// The password login's own database login (P1-J), checked at start-up like the platform one.

const SAFE: LoginPrivileges = {
  login: 'jantrik_login_app',
  superuser: false,
  bypassRls: false,
  canBecome: [],
};

/** The privilege query's row (readLoginPrivileges reads pg_roles). */
const privilegeRow = (p: LoginPrivileges) => ({
  login: p.login,
  superuser: p.superuser,
  bypass_rls: p.bypassRls,
  can_become: p.canBecome,
});

/**
 * A client whose privilege query answers `privileges` in turn (a row or a failure; the last one
 * repeats) and whose role check (may it run the password lookup?) answers `ok` (or fails).
 */
const client = (ok: boolean | Error, privileges: (LoginPrivileges | Error)[] = [SAFE]) => {
  let i = 0;
  return {
    $queryRaw: vi.fn((strings: TemplateStringsArray) => {
      if (strings.join('').includes('pg_roles')) {
        const p = privileges[Math.min(i++, privileges.length - 1)]!;
        return p instanceof Error ? Promise.reject(p) : Promise.resolve([privilegeRow(p)]);
      }
      return ok instanceof Error ? Promise.reject(ok) : Promise.resolve([{ ok }]);
    }),
  };
};

const unreachable = () =>
  Object.assign(new Error("Raw query failed. Message: Can't reach database server"), {
    name: 'PrismaClientKnownRequestError',
    code: 'P2010',
    meta: { driverAdapterError: { cause: { kind: 'DatabaseNotReachable', port: 5432 } } },
  });

function service(
  loginCanRun: boolean | Error,
  mainCanRun: boolean | Error,
  privileges: (LoginPrivileges | Error)[] = [SAFE],
) {
  const warn = vi.fn();
  const s = Object.create(LoginPrismaService.prototype) as LoginPrismaService;
  Object.assign(s, {
    client: client(loginCanRun, privileges),
    main: { client: client(mainCanRun) },
    logger: { warn, log: vi.fn() },
    retryDelaysMs: [0, 0, 0],
    checkTimeoutMs: 50,
  });
  return { s, warn };
}

describe('LoginPrismaService startup check', () => {
  it('starts when only the login login may run the password lookup', async () => {
    await expect(service(true, false).s.onModuleInit()).resolves.toBeUndefined();
  });

  it.each([
    ['DATABASE_URL uses the login login', true, true],
    ['DATABASE_LOGIN_URL uses the app login', false, false],
    ['the two are swapped', false, true],
  ])('refuses to start when %s', async (_case, login, main) => {
    await expect(service(login, main).s.onModuleInit()).rejects.toThrow(/mixed up/);
  });

  it('only warns when the role check itself fails after the privilege check passed', async () => {
    const { s, warn } = service(new Error('connect ECONNREFUSED'), false);
    await expect(s.onModuleInit()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });
});

describe('LoginPrismaService login privileges (fail closed)', () => {
  it('refuses a superuser login at once, naming DATABASE_LOGIN_URL and the login', async () => {
    const { s } = service(true, false, [{ ...SAFE, login: 'postgres', superuser: true }]);
    await expect(s.onModuleInit()).rejects.toThrow(/DATABASE_LOGIN_URL.*postgres is a superuser/);
  });

  it('refuses a login with BYPASSRLS', async () => {
    const { s } = service(true, false, [{ ...SAFE, bypassRls: true }]);
    await expect(s.onModuleInit()).rejects.toThrow(/DATABASE_LOGIN_URL.*has BYPASSRLS/);
  });

  it('refuses a login that can become a superuser role', async () => {
    const { s } = service(true, false, [{ ...SAFE, canBecome: ['postgres'] }]);
    await expect(s.onModuleInit()).rejects.toThrow(/can become postgres/);
  });

  it('waits while the database is unreachable, then checks as usual', async () => {
    const { s } = service(true, false, [unreachable(), unreachable(), SAFE]);
    await expect(s.onModuleInit()).resolves.toBeUndefined();
  });

  it('refuses to start unchecked when the database never answers', async () => {
    const { s } = service(true, false, [unreachable()]);
    await expect(s.onModuleInit()).rejects.toThrow(
      /DATABASE_LOGIN_URL\).*DatabaseNotReachable\. The password login does not start unchecked/,
    );
  });
});

import { requestContextKey, type LoginPrivileges } from '@jantrik/db';
import { LoginPrismaService } from './login-prisma.service.js';

// The password login's own database login (P1-J), checked at start-up like the platform one.

const SAFE: LoginPrivileges = {
  login: 'jantrik_login_app',
  superuser: false,
  bypassRls: false,
  replication: false,
  createRole: false,
  canBecome: [],
  temp: false,
  roleSettings: [],
};

/** The privilege query's row (readLoginPrivileges reads pg_roles). */
const privilegeRow = (p: LoginPrivileges) => ({
  login: p.login,
  superuser: p.superuser,
  bypass_rls: p.bypassRls,
  replication: p.replication,
  create_role: p.createRole,
  temp: p.temp,
  role_settings: p.roleSettings,
  can_become: p.canBecome,
});

/** Where a client is connected: its database, port and server start (one cluster, one start). */
interface Where {
  db: string;
  port: number | null;
  started: string;
}
const HERE: Where = { db: 'jantrik', port: 5432, started: '2026-11-16T06:00:00.000Z' };

/** What auth_context_key() returns (P1-J8): 48 bytes, or a failure. */
const KEY = Buffer.alloc(48, 7);

/**
 * A client whose privilege query answers `privileges` in turn (a row or a failure; the last one
 * repeats), whose role check (may it run the password lookup?) answers `ok` (or fails), and that
 * says it is connected to `where`.
 */
const client = (
  ok: boolean | Error,
  privileges: (LoginPrivileges | Error)[] = [SAFE],
  where: Where = HERE,
  key: Buffer | Error = KEY,
) => {
  let i = 0;
  return {
    $queryRaw: vi.fn((strings: TemplateStringsArray) => {
      const sql = strings.join('');
      if (sql.includes('auth_context_key')) {
        return key instanceof Error ? Promise.reject(key) : Promise.resolve([{ key }]);
      }
      if (sql.includes('pg_roles')) {
        const p = privileges[Math.min(i++, privileges.length - 1)]!;
        return p instanceof Error ? Promise.reject(p) : Promise.resolve([privilegeRow(p)]);
      }
      if (sql.includes('current_database')) {
        return Promise.resolve([{ ...where, started: new Date(where.started) }]);
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
  loginWhere: Where = HERE,
  key: Buffer | Error = KEY,
  production = false,
) {
  const warn = vi.fn();
  const error = vi.fn();
  const s = Object.create(LoginPrismaService.prototype) as LoginPrismaService;
  Object.assign(s, {
    client: client(loginCanRun, privileges, loginWhere, key),
    main: { client: client(mainCanRun) },
    logger: { warn, error, log: vi.fn() },
    production,
    retryDelaysMs: [0, 0, 0],
    checkTimeoutMs: 50,
  });
  // What the constructor does.
  s.registerContextKeySource();
  return { s, warn, error };
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

  it.each([
    ['another database', { ...HERE, db: 'jantrik_test' }],
    ['another port', { ...HERE, port: 5433 }],
    ['another server (started at another time)', { ...HERE, started: '2026-11-15T00:00:00.000Z' }],
  ])('refuses to start when DATABASE_LOGIN_URL points at %s', async (_case, where) => {
    await expect(service(true, false, [SAFE], where).s.onModuleInit()).rejects.toThrow(
      /DATABASE_LOGIN_URL and DATABASE_URL must reach the same database/,
    );
  });

  it('only warns when the role check itself fails after the privilege check passed', async () => {
    const { s, warn } = service(new Error('connect ECONNREFUSED'), false);
    await expect(s.onModuleInit()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });
});

describe('LoginPrismaService and the request context key (P1-J8)', () => {
  it('reads the key through the login login at start-up; withContext then signs with it', async () => {
    const { s } = service(true, false);
    await s.onModuleInit();
    expect((await requestContextKey()).equals(KEY)).toBe(true);
    const asked = (s.client.$queryRaw as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([strings]) => (strings as TemplateStringsArray).join('').includes('auth_context_key'),
    );
    expect(asked).toHaveLength(1);
  });

  it('in production, refuses to start without the key (no migration, or no privilege)', async () => {
    const missing = new Error('function auth_context_key() does not exist');
    const { s } = service(true, false, [SAFE], HERE, missing, true);
    await expect(s.onModuleInit()).rejects.toThrow(
      /request context key through DATABASE_LOGIN_URL \(.*does not exist\)\. Run the database migrations/,
    );
  });

  it('elsewhere, starts without the key but logs an error; institute transactions keep failing until it can be read', async () => {
    const missing = new Error('function auth_context_key() does not exist');
    const { s, error } = service(true, false, [SAFE], HERE, missing);
    await expect(s.onModuleInit()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(
        /request context key through DATABASE_LOGIN_URL \(.*does not exist\)\..*Institute requests fail/,
      ),
    );
    await expect(requestContextKey()).rejects.toThrow(/does not exist/);
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

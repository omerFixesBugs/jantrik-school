import type { LoginPrivileges } from '@jantrik/db';
import { PlatformPrismaService } from './platform-prisma.service.js';

const SAFE: LoginPrivileges = {
  login: 'jantrik_platform_app',
  superuser: false,
  bypassRls: false,
  replication: false,
  createRole: false,
  canBecome: [],
};

/** The privilege query's row (readLoginPrivileges reads pg_roles). */
const privilegeRow = (p: LoginPrivileges) => ({
  login: p.login,
  superuser: p.superuser,
  bypass_rls: p.bypassRls,
  replication: p.replication,
  create_role: p.createRole,
  can_become: p.canBecome,
});

/**
 * A client whose privilege query answers `privileges` in turn (a row or a failure; the last one
 * repeats) and whose role check (`platform_me()`) answers `ok` (or fails).
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
  platformCanRun: boolean | Error,
  mainCanRun: boolean | Error,
  privileges: (LoginPrivileges | Error)[] = [SAFE],
) {
  const warn = vi.fn();
  const s = Object.create(PlatformPrismaService.prototype) as PlatformPrismaService;
  Object.assign(s, {
    client: client(platformCanRun, privileges),
    main: { client: client(mainCanRun) },
    logger: { warn, log: vi.fn() },
    retryDelaysMs: [0, 0, 0],
    checkTimeoutMs: 50,
  });
  return { s, warn };
}

describe('PlatformPrismaService startup check', () => {
  it('starts when only the platform login may run the platform functions', async () => {
    await expect(service(true, false).s.onModuleInit()).resolves.toBeUndefined();
  });

  it.each([
    ['DATABASE_URL uses the platform login', true, true],
    ['DATABASE_PLATFORM_URL uses the app login', false, false],
    ['the two are swapped', false, true],
  ])('refuses to start when %s', async (_case, platform, main) => {
    await expect(service(platform, main).s.onModuleInit()).rejects.toThrow(/mixed up/);
  });

  it('only warns when the role check itself fails after the privilege check passed', async () => {
    const { s, warn } = service(new Error('connect ECONNREFUSED'), false);
    await expect(s.onModuleInit()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });
});

describe('PlatformPrismaService login privileges (fail closed)', () => {
  it('refuses a superuser login at once, naming DATABASE_PLATFORM_URL and the login', async () => {
    const { s } = service(true, false, [{ ...SAFE, login: 'postgres', superuser: true }]);
    await expect(s.onModuleInit()).rejects.toThrow(
      /DATABASE_PLATFORM_URL.*postgres is a superuser/,
    );
  });

  it('refuses a login with BYPASSRLS', async () => {
    const { s } = service(true, false, [{ ...SAFE, bypassRls: true }]);
    await expect(s.onModuleInit()).rejects.toThrow(/DATABASE_PLATFORM_URL.*has BYPASSRLS/);
  });

  it('refuses a login that can become a superuser role', async () => {
    const { s } = service(true, false, [{ ...SAFE, canBecome: ['postgres'] }]);
    await expect(s.onModuleInit()).rejects.toThrow(/can become postgres/);
  });

  it('waits while the database is unreachable, then checks as usual', async () => {
    const { s } = service(true, false, [unreachable(), unreachable(), SAFE]);
    await expect(s.onModuleInit()).resolves.toBeUndefined();
  });

  it('refuses to start unchecked when the database never answers (it used to only warn)', async () => {
    const { s } = service(true, false, [unreachable()]);
    await expect(s.onModuleInit()).rejects.toThrow(
      /DATABASE_PLATFORM_URL\).*DatabaseNotReachable\. The platform module does not start unchecked/,
    );
  });
});

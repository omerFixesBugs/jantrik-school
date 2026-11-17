import { createServer, type Socket } from 'node:net';
import type { createPrismaClient, LoginPrivileges } from '@jantrik/db';
import {
  INGEST_POOL,
  IngestPrismaService,
  errorLabel,
  ingestRefusalStatus,
} from './ingest-prisma.service.js';

/** The arguments of each createPrismaClient call (the real one still builds the client). */
const created = vi.hoisted(() => [] as unknown[][]);
vi.mock('@jantrik/db', async (importOriginal) => {
  const real = await importOriginal<{ createPrismaClient: typeof createPrismaClient }>();
  return {
    ...real,
    createPrismaClient: (...args: Parameters<typeof createPrismaClient>) => {
      created.push(args);
      return real.createPrismaClient(...args);
    },
  };
});

type Check = { resolve: boolean; students: boolean; punches: boolean; statement_timeout?: string };
const PASS: Check = { resolve: true, students: false, punches: false, statement_timeout: '5s' };
/** A check that never answers (a database that took the connection and went quiet). */
const HANG = 'hang' as const;
/** A login with no privileges beyond its grants (readLoginPrivileges' row). */
const SAFE: LoginPrivileges = {
  login: 'jantrik_ingest_app',
  superuser: false,
  bypassRls: false,
  replication: false,
  createRole: false,
  canBecome: [],
};

/**
 * The service with its start-up check answering each call in turn (a row, or a failure).
 * `queryRaw` is the check query; the privilege query (pg_roles) answers `privileges` (SAFE by
 * default) through its own mock, so the check's call counts keep their meaning.
 */
function service(...answers: (Check | Error | typeof HANG)[]) {
  return serviceWith(SAFE, ...answers);
}

function serviceWith(privileges: LoginPrivileges, ...answers: (Check | Error | typeof HANG)[]) {
  const warn = vi.fn();
  const log = vi.fn();
  const queryRaw = vi.fn();
  for (const a of answers) {
    queryRaw.mockImplementationOnce(() =>
      a === HANG
        ? new Promise(() => undefined)
        : a instanceof Error
          ? Promise.reject(a)
          : Promise.resolve([a]),
    );
  }
  const privilegeQuery = vi.fn(() =>
    Promise.resolve([
      {
        login: privileges.login,
        superuser: privileges.superuser,
        bypass_rls: privileges.bypassRls,
        replication: privileges.replication,
        create_role: privileges.createRole,
        can_become: privileges.canBecome,
      },
    ]),
  );
  const $queryRaw = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.join('').includes('pg_roles')
      ? privilegeQuery()
      : (queryRaw as (...a: unknown[]) => Promise<unknown>)(strings, ...values);
  const s = Object.create(IngestPrismaService.prototype) as IngestPrismaService;
  Object.assign(s, {
    client: { $queryRaw },
    logger: { warn, log },
    retryDelaysMs: [0, 0, 0],
    checkTimeoutMs: 50,
  });
  return { s, warn, log, queryRaw, privilegeQuery };
}

/** The database server not answering, as the driver adapter reports it. */
const unreachable = () =>
  Object.assign(new Error("Raw query failed. Message: Can't reach database server"), {
    name: 'PrismaClientKnownRequestError',
    code: 'P2010',
    meta: { driverAdapterError: { cause: { kind: 'DatabaseNotReachable', port: 5432 } } },
  });

/** A failed raw query as Prisma reports it with the pg driver adapter. */
const dbError = (code: string, message: string) =>
  Object.assign(new Error(`Raw query failed. Code: \`${code}\`. Message: \`${message}\``), {
    name: 'PrismaClientKnownRequestError',
    code: 'P2010',
    meta: { driverAdapterError: { cause: { originalCode: code, originalMessage: message } } },
  });

describe('IngestPrismaService startup check', () => {
  it('starts when the login runs ingest_resolve and reads neither students nor punches', async () => {
    await expect(service(PASS).s.onModuleInit()).resolves.toBeUndefined();
  });

  it.each([
    ['the app login (cannot run the function, reads students)', false, true, true],
    ['a login that may run it but also reads students', true, true, false],
    ['a login that may run it but also reads punches', true, false, true],
    ['a login with no rights at all', false, false, false],
  ])('refuses to start with %s', async (_case, resolve, students, punches) => {
    await expect(service({ resolve, students, punches }).s.onModuleInit()).rejects.toThrow(
      /jantrik_ingest_app/,
    );
  });

  it('asks again while the check fails (not migrated yet: 42501), then starts', async () => {
    const denied = () => dbError('42501', 'permission denied for schema public');
    const { s, warn, log, queryRaw } = service(denied(), denied(), PASS);
    await expect(s.onModuleInit()).resolves.toBeUndefined();
    expect(queryRaw).toHaveBeenCalledTimes(3);
    // One line per attempt, with the error's codes only, never its message.
    expect(warn).toHaveBeenCalledTimes(2);
    for (const [line] of warn.mock.calls) {
      expect(line).toContain('PrismaClientKnownRequestError P2010 42501');
      expect(line).not.toContain('permission denied');
    }
    expect(log).toHaveBeenCalledWith('Start-up check passed');
  });

  it('refuses to start when the check still fails after the last wait', async () => {
    const missing = () => dbError('42883', 'function ingest_resolve does not exist');
    const { s, queryRaw } = service(missing(), missing(), missing(), missing());
    await expect(s.onModuleInit()).rejects.toThrow(/42883\. The receiver does not start unchecked/);
    expect(queryRaw).toHaveBeenCalledTimes(4);
  });

  it('waits 1, 2, 4 and 8 s, then every 15 s, about 3 minutes in all', () => {
    const real = new IngestPrismaService({ get: () => 'postgresql://x@localhost/db' } as never);
    expect(real.retryDelaysMs.slice(0, 5)).toEqual([1000, 2000, 4000, 8000, 15000]);
    const total = real.retryDelaysMs.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(170_000);
    expect(total).toBeLessThanOrEqual(190_000);
    // Each check may take 10 s: a start that never gets an answer fails within about 6 minutes.
    expect(real.checkTimeoutMs).toBe(10_000);
  });

  it("builds the receiver's pool with a connection timeout no longer than a check, and keep-alive after 30 s idle", () => {
    created.length = 0;
    new IngestPrismaService({ get: () => 'postgresql://x@localhost/db' } as never);
    expect(created).toEqual([['postgresql://x@localhost/db', INGEST_POOL]]);
    expect(INGEST_POOL).toEqual({
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 30_000,
      statement_timeout: 5000,
    });
  });

  it("builds the receiver's pool with a 5 s statement timeout (decision #79)", () => {
    expect(INGEST_POOL.statement_timeout).toBe(5000);
  });

  it('refuses to start, at once, when the login runs without the 5 s limit', async () => {
    const { s, queryRaw } = service({ ...PASS, statement_timeout: '0' }, PASS);
    await expect(s.onModuleInit()).rejects.toThrow(/statement_timeout.*5s.*got 0/);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('refuses a receiver login that can become a superuser role', async () => {
    const { s } = serviceWith({ ...SAFE, canBecome: ['postgres'] }, PASS);
    await expect(s.onModuleInit()).rejects.toThrow(/DATABASE_INGEST_URL.*can become postgres/);
  });

  it('refuses a superuser receiver login', async () => {
    const { s } = serviceWith({ ...SAFE, login: 'postgres', superuser: true }, PASS);
    await expect(s.onModuleInit()).rejects.toThrow(/DATABASE_INGEST_URL.*postgres is a superuser/);
  });

  it('asks again while the database is not reachable, then checks as usual', async () => {
    const { s, warn, queryRaw } = service(unreachable(), unreachable(), PASS);
    await expect(s.onModuleInit()).resolves.toBeUndefined();
    expect(queryRaw).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('DatabaseNotReachable'));
  });

  it('refuses to start when the database stays unreachable', async () => {
    const { s, queryRaw } = service(unreachable(), unreachable(), unreachable(), unreachable());
    await expect(s.onModuleInit()).rejects.toThrow(/DatabaseNotReachable.*does not start/);
    expect(queryRaw).toHaveBeenCalledTimes(4);
  });

  it('gives each check a time limit: one with no answer counts as failed and is asked again', async () => {
    const { s, warn, queryRaw } = service(HANG, HANG, PASS);
    await expect(s.onModuleInit()).resolves.toBeUndefined();
    expect(queryRaw).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('(StartupCheckTimeout)'));
  });

  it('refuses to start when no check ever answers, instead of hanging the start', async () => {
    const { s, queryRaw } = service(HANG, HANG, HANG, HANG);
    await expect(s.onModuleInit()).rejects.toThrow(/StartupCheckTimeout\. The receiver does not/);
    expect(queryRaw).toHaveBeenCalledTimes(4);
  });

  it('a late failure of a check that already timed out is ignored', async () => {
    let fail: (e: Error) => void = () => undefined;
    const late = new Promise((_, reject) => (fail = reject));
    const { s, queryRaw } = service(PASS);
    queryRaw.mockReset();
    queryRaw.mockImplementationOnce(() => late).mockResolvedValueOnce([PASS]);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await expect(s.onModuleInit()).resolves.toBeUndefined();
      fail(unreachable());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('a real client against a server that accepts and never answers fails the start in time', async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => sockets.add(socket));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const real = new IngestPrismaService({
      get: () => `postgresql://ingest:x@127.0.0.1:${port}/silent`,
    } as never);
    Object.assign(real, { retryDelaysMs: [0], checkTimeoutMs: 300 });
    Object.assign(real, { logger: { warn: vi.fn(), log: vi.fn() } });
    const started = Date.now();
    try {
      await expect(real.onModuleInit()).rejects.toThrow(/StartupCheckTimeout/);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(sockets.size).toBeGreaterThan(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await real.onModuleDestroy().catch(() => undefined);
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('a check that answers wrongly (a wrong login) is refused at once, never asked again', async () => {
    const { s, queryRaw } = service({ resolve: false, students: true, punches: true }, PASS);
    await expect(s.onModuleInit()).rejects.toThrow(/jantrik_ingest_app/);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('refuses to be built without DATABASE_INGEST_URL', () => {
    const config = { get: () => undefined };
    expect(() => new IngestPrismaService(config as never)).toThrow(/DATABASE_INGEST_URL/);
  });
});

describe('ingest function errors', () => {
  it('maps what the functions refuse to 400 or 413, and nothing else', () => {
    expect(ingestRefusalStatus(dbError('P0001', 'INGEST_BAD_ROWS'))).toBe(400);
    expect(ingestRefusalStatus(dbError('P0001', 'INGEST_BAD_RESULTS'))).toBe(400);
    expect(ingestRefusalStatus(dbError('P0001', 'INGEST_TOO_MANY_ROWS'))).toBe(413);
    expect(ingestRefusalStatus(dbError('P0001', 'INGEST_TOO_MANY_RESULTS'))).toBe(413);
    expect(ingestRefusalStatus(dbError('P0001', 'something else'))).toBeNull();
    expect(ingestRefusalStatus(dbError('23514', 'INGEST_BAD_ROWS'))).toBeNull();
    expect(ingestRefusalStatus(new Error('INGEST_BAD_ROWS'))).toBeNull();
    expect(ingestRefusalStatus(null)).toBeNull();
  });

  it('labels an error by name and codes only, never its message or detail', () => {
    const check = dbError(
      '23514',
      'new row violates check constraint; Failing row contains (0190-tenant-id, ...)',
    );
    expect(errorLabel(check)).toBe('PrismaClientKnownRequestError P2010 23514');
    expect(errorLabel(new TypeError('device said: hello'))).toBe('TypeError');
    expect(errorLabel(Object.assign(new Error('x'), { name: 'Bad name\nINJECTED' }))).toBe('Error');
    expect(errorLabel('a string')).toBe('Error');
  });
});

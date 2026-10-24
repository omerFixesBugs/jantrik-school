import { IngestPrismaService, errorLabel, ingestRefusalStatus } from './ingest-prisma.service.js';

type Check = { resolve: boolean; students: boolean; punches: boolean };
const PASS: Check = { resolve: true, students: false, punches: false };

/** The service with the privilege check answering each call in turn (a row, or a failure). */
function service(...answers: (Check | Error)[]) {
  const warn = vi.fn();
  const queryRaw = vi.fn();
  for (const a of answers) {
    queryRaw.mockImplementationOnce(() =>
      a instanceof Error ? Promise.reject(a) : Promise.resolve([a]),
    );
  }
  const s = Object.create(IngestPrismaService.prototype) as IngestPrismaService;
  Object.assign(s, { client: { $queryRaw: queryRaw }, logger: { warn }, retryDelaysMs: [0, 0, 0] });
  return { s, warn, queryRaw };
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

  it('refuses to start when the check itself fails (e.g. the function is missing)', async () => {
    const { s, queryRaw } = service(dbError('42883', 'function ingest_resolve does not exist'));
    await expect(s.onModuleInit()).rejects.toThrow(/42883.*does not start unchecked/);
    expect(queryRaw).toHaveBeenCalledTimes(1);
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

  it('a wrong login is refused at once, never asked again', async () => {
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

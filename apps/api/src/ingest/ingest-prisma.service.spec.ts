import { IngestPrismaService, errorLabel, ingestRefusalStatus } from './ingest-prisma.service.js';

/** The privilege check's answer for the configured login (or a failure to connect). */
function service(answer: { resolve: boolean; students: boolean; punches: boolean } | Error) {
  const warn = vi.fn();
  const s = Object.create(IngestPrismaService.prototype) as IngestPrismaService;
  Object.assign(s, {
    client: {
      $queryRaw: () =>
        answer instanceof Error ? Promise.reject(answer) : Promise.resolve([answer]),
    },
    logger: { warn },
  });
  return { s, warn };
}

/** A failed raw query as Prisma reports it with the pg driver adapter. */
const dbError = (code: string, message: string) =>
  Object.assign(new Error(`Raw query failed. Code: \`${code}\`. Message: \`${message}\``), {
    name: 'PrismaClientKnownRequestError',
    code: 'P2010',
    meta: { driverAdapterError: { cause: { originalCode: code, originalMessage: message } } },
  });

describe('IngestPrismaService startup check', () => {
  it('starts when the login runs ingest_resolve and reads neither students nor punches', async () => {
    const { s } = service({ resolve: true, students: false, punches: false });
    await expect(s.onModuleInit()).resolves.toBeUndefined();
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

  it('only warns when the database cannot be reached', async () => {
    const { s, warn } = service(new Error('connect ECONNREFUSED'));
    await expect(s.onModuleInit()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
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

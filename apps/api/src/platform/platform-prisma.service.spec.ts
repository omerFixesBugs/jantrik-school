import { PlatformPrismaService } from './platform-prisma.service.js';

/** A client whose privilege check answers `ok` (or fails to connect). */
const client = (ok: boolean | Error) => ({
  $queryRaw: () => (ok instanceof Error ? Promise.reject(ok) : Promise.resolve([{ ok }])),
});

function service(platformCanRun: boolean | Error, mainCanRun: boolean | Error) {
  const warn = vi.fn();
  const s = Object.create(PlatformPrismaService.prototype) as PlatformPrismaService;
  Object.assign(s, {
    client: client(platformCanRun),
    main: { client: client(mainCanRun) },
    logger: { warn },
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

  it('only warns when the database cannot be reached', async () => {
    const { s, warn } = service(new Error('connect ECONNREFUSED'), false);
    await expect(s.onModuleInit()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });
});

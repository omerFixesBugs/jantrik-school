import { createHash } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { PasswordService } from './password.service.js';

// Wrapped so the tests can count the hashes a login computes; the real library does the work.
vi.mock('@node-rs/argon2', async (importOriginal) => {
  const real = await importOriginal<typeof import('@node-rs/argon2')>();
  return { ...real, hash: vi.fn(real.hash) };
});

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
/** What the login lookup returns: the PHC string up to its last `$` (no digest). */
const paramsOf = (phc: string): string => phc.slice(0, phc.lastIndexOf('$'));
const NO_MATCH = Buffer.alloc(32);

describe('PasswordService.loginDigest (P1-J: the database compares, the hash never leaves it)', () => {
  const service = new PasswordService();
  const password = 'correct horse battery staple';
  let stored: string;

  beforeAll(async () => {
    stored = await service.hash(password);
  });

  it('is the SHA-256 of the hash that the stored parameters and salt give the password', async () => {
    expect(await service.loginDigest(paramsOf(stored), password)).toEqual(sha256(stored));
  });

  it('hashes the password NFC-normalised, as setting it did (P1-C)', async () => {
    const composed = 'পাসওয়ার্ড-café-2026';
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed);
    const storedNfc = await service.hash(composed);
    expect(await service.loginDigest(paramsOf(storedNfc), decomposed)).toEqual(sha256(storedNfc));
  });

  it('gives another digest for a wrong password', async () => {
    const digest = await service.loginDigest(paramsOf(stored), `${password}!`);
    expect(digest).not.toEqual(sha256(stored));
    expect(digest).toHaveLength(32);
  });

  it('follows stored parameters other than today’s, up to the ceiling', async () => {
    const costly = await hash(password, { memoryCost: 65_536, timeCost: 3, parallelism: 2 });
    expect(await service.loginDigest(paramsOf(costly), password)).toEqual(sha256(costly));
  });

  it.each([
    ['no user', undefined],
    ['no password', null],
    ['empty', ''],
    ['not a hash', 'not-a-real-hash'],
    ['argon2i', 'ALGO'],
    ['version 16', 'V16'],
    ['memory above 64 MiB', 'M_HIGH'],
    ['more than 10 passes', 'T_HIGH'],
    ['more than 4 lanes', 'P_HIGH'],
    ['memory below 8 × lanes', 'M_LOW'],
    ['a digest left on', 'WITH_DIGEST'],
  ])('%s: hashes once with the defaults and matches nothing', async (_, kind) => {
    const p = paramsOf(stored);
    const params =
      {
        ALGO: p.replace('$argon2id$', '$argon2i$'),
        V16: p.replace('$v=19$', '$v=16$'),
        M_HIGH: p.replace('m=19456', 'm=65537'),
        T_HIGH: p.replace('t=2', 't=11'),
        P_HIGH: p.replace('p=1', 'p=5'),
        M_LOW: p.replace('m=19456,t=2,p=1', 'm=15,t=2,p=2'),
        WITH_DIGEST: stored,
      }[kind as string] ?? kind;
    vi.mocked(hash).mockClear();
    expect(await service.loginDigest(params, password)).toEqual(NO_MATCH);
    // One hash at today's cost, as for a real account: the time does not tell the cases apart.
    expect(vi.mocked(hash)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(hash).mock.calls[0]![1]).toMatchObject({
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
  });

  it('a real account also hashes exactly once', async () => {
    vi.mocked(hash).mockClear();
    await service.loginDigest(paramsOf(stored), 'wrong but long password');
    expect(vi.mocked(hash)).toHaveBeenCalledTimes(1);
  });
});

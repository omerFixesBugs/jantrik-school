import { hash, verify } from '@node-rs/argon2';
import { PasswordService } from './password.service.js';

// Wrapped so the tests can see which hash each check verified against; the real library works.
vi.mock('@node-rs/argon2', async (importOriginal) => {
  const real = await importOriginal<typeof import('@node-rs/argon2')>();
  return { ...real, verify: vi.fn(real.verify) };
});

describe('PasswordService.verify', () => {
  const service = new PasswordService();
  const password = 'correct horse battery staple';
  let stored: string;

  beforeAll(async () => {
    stored = await service.hash(password);
  });

  beforeEach(() => {
    vi.mocked(verify).mockClear();
  });

  it('accepts the right password, NFC-normalised (P1-C), and refuses a wrong one', async () => {
    expect(await service.verify(stored, password)).toBe(true);
    expect(await service.verify(stored, `${password}!`)).toBe(false);
    const composed = 'পাসওয়ার্ড-café-2026';
    const nfc = await service.hash(composed);
    expect(await service.verify(nfc, composed.normalize('NFD'))).toBe(true);
  });

  it('follows stored parameters other than today’s, up to the ceiling', async () => {
    const costly = await hash(password, { memoryCost: 65_536, timeCost: 3, parallelism: 2 });
    expect(await service.verify(costly, password)).toBe(true);
  });

  it.each([
    ['no user', undefined],
    ['no password', null],
    ['not a hash', 'not-a-real-hash'],
    ['memory above 64 MiB', 'M_HIGH'],
    ['more than 10 passes', 'T_HIGH'],
    ['more than 4 lanes', 'P_HIGH'],
    ['an output over 64 bytes', 'LONG_OUTPUT'],
    ['a salt over 64 bytes', 'LONG_SALT'],
    ['more than 255 characters', 'TOO_LONG'],
  ])('%s: refused after one full argon2 check against the dummy hash (P1-J4)', async (_, kind) => {
    const salt = stored.split('$')[4]!; // 22 characters: 16 bytes
    const stored2 =
      {
        M_HIGH: stored.replace('m=19456', 'm=65537'),
        T_HIGH: stored.replace('t=2', 't=11'),
        P_HIGH: stored.replace('p=1', 'p=5'),
        LONG_OUTPUT: `${stored}${'A'.repeat(85)}`, // a 128-character digest: 96 bytes
        LONG_SALT: stored.replace(`$${salt}$`, `$${salt.repeat(4)}$`), // 88 characters: 66 bytes
        TOO_LONG: `${stored}${'A'.repeat(200)}`,
      }[kind as string] ?? kind;
    expect(await service.verify(stored2, password)).toBe(false);
    // The time matches a real account's: one verification, at today's cost, never the stored one.
    expect(vi.mocked(verify)).toHaveBeenCalledTimes(1);
    const checked = vi.mocked(verify).mock.calls[0]![0] as string;
    expect(checked).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(checked).not.toBe(stored2);
  });
});

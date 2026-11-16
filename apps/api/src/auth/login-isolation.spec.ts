import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// P1-J: the password login's own database login (LoginPrismaService, jantrik_login_app) is the
// only way to a password hash. It stays with the password login in code as well as in the
// database: only AuthService holds it, and only the login lookup names the function.
const SRC = path.resolve(import.meta.dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sources(full);
    return e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') ? [full] : [];
  });
}

const files = sources(SRC).map((full) => ({
  rel: path.relative(SRC, full).split(path.sep).join('/'),
  code: readFileSync(full, 'utf8'),
}));

const usesLoginClient = (code: string) => /login-prisma\.service/.test(code);
const namesLookup = (code: string) => /\bauth_find_user_for_password_login\b/.test(code);
const namesLoginUrl = (code: string) => /\bDATABASE_LOGIN_URL\b/.test(code);
const usesLookup = (code: string) => /\bfindUserForPasswordLogin\b/.test(code);
const where = (test: (code: string) => boolean) =>
  files.filter((f) => test(f.code)).map((f) => f.rel);

describe('the password login’s database login stays with the password login', () => {
  it('only the env checks and LoginPrismaService read DATABASE_LOGIN_URL (no second client)', () => {
    expect(where(namesLoginUrl)).toEqual([
      'auth/login-prisma.service.ts',
      'config/env.ts',
      'config/production-env.ts',
    ]);
  });

  it('only AuthService calls the hash lookup', () => {
    expect(where(usesLookup)).toEqual(['auth/auth.service.ts', 'auth/login-lookup.ts']);
  });

  it('only AuthService (and its module) use LoginPrismaService', () => {
    expect(files.filter((f) => usesLoginClient(f.code)).map((f) => f.rel)).toEqual([
      'auth/auth.module.ts',
      'auth/auth.service.ts',
    ]);
  });

  it('only the login lookup and the start-up check name the password lookup', () => {
    expect(files.filter((f) => namesLookup(f.code)).map((f) => f.rel)).toEqual([
      'auth/login-lookup.ts',
      'auth/login-prisma.service.ts',
    ]);
  });

  it('the scan finds what it looks for', () => {
    expect(usesLoginClient("import { LoginPrismaService } from './login-prisma.service.js';")).toBe(
      true,
    );
    expect(namesLookup('SELECT * FROM auth_find_user_for_password_login($1, $2)')).toBe(true);
    expect(namesLookup('SELECT * FROM auth_find_user_for_login($1, $2)')).toBe(false);
    expect(namesLoginUrl("createPrismaClient(config.get('DATABASE_LOGIN_URL'))")).toBe(true);
    expect(usesLookup('await findUserForPasswordLogin(client, { phone })')).toBe(true);
  });
});

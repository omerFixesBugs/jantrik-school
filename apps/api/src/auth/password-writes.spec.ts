import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Sprint 1 P1: a person's password is set in one place only, after a code sent to their phone
// (PasswordSettingsService). This scan keeps any other code from writing users.password_hash.
const SRC = path.resolve(import.meta.dirname, '..');
const THE_WRITER = 'auth/password-settings.service.ts';

/** The `( … )` call that starts at `open` (balanced parentheses), or the rest of the code. */
function call(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')' && --depth === 0) return code.slice(open, i + 1);
  }
  return code.slice(open);
}

/** Whether `code` writes a user's password hash (Prisma or raw SQL). */
export function writesUserPassword(code: string): boolean {
  for (const m of code.matchAll(/\.user\.(update|updateMany|upsert|create|createMany)\s*\(/g)) {
    if (/\bpasswordHash\b/.test(call(code, m.index + m[0].length - 1))) return true;
  }
  const users = String.raw`(?:"?public"?\.)?"?users"?`;
  return (
    new RegExp(String.raw`\bUPDATE\s+${users}\s[^\x60;]*\bpassword_hash\b`, 'i').test(code) ||
    new RegExp(String.raw`\bINSERT\s+INTO\s+${users}\s*\([^)]*\bpassword_hash\b`, 'i').test(code)
  );
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sources(full);
    return e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') ? [full] : [];
  });
}

describe('who writes users.password_hash', () => {
  it(`only ${THE_WRITER}`, () => {
    const writers = sources(SRC)
      .filter((file) => writesUserPassword(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file).replaceAll('\\', '/'));
    expect(writers).toEqual([THE_WRITER]);
  });

  it('the scan finds what it looks for', () => {
    const caught = [
      'await tx.user.update({ where: { id }, data: { passwordHash } })',
      'await this.db.tx.user.updateMany({ where: { id }, data: { locale, passwordHash: h } })',
      'tx.user.upsert({ where: { id }, create: { phone, name }, update: { passwordHash: x } })',
      'tx.user.create({ data: { phone, name, passwordHash } })',
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      'update "public"."users" set locale = $1, password_hash = $2',
      'INSERT INTO users (id, phone, name, password_hash) VALUES (…)',
    ];
    for (const sample of caught) expect(writesUserPassword(sample), sample).toBe(true);
    const fine = [
      'await this.db.tx.user.update({ where: { id }, data: { locale } })',
      'const ok = await this.passwords.verify(user?.password_hash, password)',
      'SELECT id, password_hash FROM auth_find_user_for_login($1, $2)',
      'tx.platformAdmin.update({ where: { id }, data: { passwordHash } })',
      'UPDATE platform_admins SET password_hash = $1',
    ];
    for (const sample of fine) expect(writesUserPassword(sample), sample).toBe(false);
  });
});

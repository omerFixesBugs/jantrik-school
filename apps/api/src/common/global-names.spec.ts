import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Decision #5: a person's global row (users.name / name_bn / email) is read only by the self
// endpoints (the signed-in person's own account). Everything shown to others uses the names an
// institute keeps itself: guardians, students, staff_profiles. This scan keeps it that way.
const SRC = path.resolve(import.meta.dirname, '..');
const SCHEMA = path.resolve(import.meta.dirname, '../../../../packages/db/prisma/schema.prisma');
const SELF_ONLY = new Set(['auth/auth.service.ts', 'auth/login-lookup.ts']);

/** Every relation field that points at User (from the schema, so new ones are covered). */
export function userRelations(schema: string): string[] {
  const names = new Set<string>();
  for (const m of schema.matchAll(/^\s+(\w+)\s+User(\[\]|\?)?\s/gm)) names.add(m[1]!);
  return [...names];
}

/** The `{ … }` block that starts at `open` (balanced braces), or null. */
function block(code: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return code.slice(open, i + 1);
  }
  return null;
}

/** What in `code` reads a person's global name or email; empty when nothing does. */
export function findUserReads(code: string, relations: string[]): string[] {
  const found: string[] = [];
  if (/\.user\.(?!update\()\w+\(/.test(code)) found.push('reads users rows');
  const rel = new RegExp(`\\b(${relations.join('|')})\\s*:\\s*`, 'g');
  for (const m of code.matchAll(rel)) {
    const at = m.index + m[0].length;
    if (code.startsWith('true', at)) found.push(`selects the whole ${m[1]} relation`);
    else if (code[at] === '{') {
      const body = block(code, at) ?? '';
      // select/where/omit/include of a user's own fields (any depth; memberships etc. are fine).
      if (/\b(name|nameBn|email|passwordHash|omit|include)\s*:/.test(body)) {
        found.push(`reads ${m[1]}’s own fields`);
      }
    }
  }
  const table = String.raw`(?:"?public"?\.)?"?users(?:_visible)?"?`;
  if (
    new RegExp(String.raw`\b(FROM|JOIN)\s+${table}(?=[\s,;)\x60]|$)`, 'i').test(code) ||
    new RegExp(String.raw`\bFROM\b[^\x60;]*,\s*${table}\b`, 'i').test(code)
  ) {
    found.push('raw SQL on users');
  }
  return found;
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sources(full);
    return e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') ? [full] : [];
  });
}

describe('global user names stay out of API responses', () => {
  const relations = userRelations(readFileSync(SCHEMA, 'utf8'));

  it('knows every relation to User', () => {
    for (const r of ['user', 'updatedBy', 'takenBy', 'createdBy', 'actorUser']) {
      expect(relations).toContain(r);
    }
  });

  it('only the self endpoints read users.name / name_bn / email', () => {
    const found: string[] = [];
    for (const file of sources(SRC)) {
      const rel = path.relative(SRC, file).replaceAll('\\', '/');
      if (SELF_ONLY.has(rel)) continue;
      for (const what of findUserReads(readFileSync(file, 'utf8'), relations)) {
        found.push(`${rel}: ${what}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('the scan finds what it looks for', () => {
    const caught = [
      'await tx.user.findMany({ where: {} })',
      'await tx.user.count({ where: { name: "x" } })',
      'select: { updatedBy: { select: { id: true, name: true } } }',
      'select: { takenBy: { select: { nameBn: true } } }',
      'select: { user: true }',
      'include: { actorUser: true }',
      'include: { other: true, user: { select: { email: true } } }',
      'select: { user: { select: { memberships: { select: { id: true } }, name: true } } }',
      'select: { user: { omit: { passwordHash: true } } }',
      'where: { user: { name: { contains: "Ka" } } }',
      'SELECT name FROM users WHERE id = $1',
      'SELECT u.name FROM "users" u',
      'SELECT 1 FROM public.users',
      'SELECT m.id FROM memberships m, users u WHERE u.id = m.user_id',
      'SELECT * FROM users_visible',
    ];
    for (const sample of caught) expect(findUserReads(sample, relations), sample).not.toEqual([]);
    const fine = [
      'select: { user: { select: { memberships: { select: { id: true } } } } }',
      'where: { user: { memberships: { some: { status: "ACTIVE" } } } }',
      'await this.db.tx.user.update({ where: { id }, data: { locale } })',
      'return { isClassTeacher: r.isClassTeacher, user: staffRef(names, r.userId) }',
      'SELECT id FROM memberships WHERE user_id = $1',
    ];
    for (const sample of fine) expect(findUserReads(sample, relations), sample).toEqual([]);
  });
});

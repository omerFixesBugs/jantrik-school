import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Only one service may read an institute's encrypted gateway credentials (sprint 1 P7a, docs/
// payments.md → Credentials). The database cannot tell services apart, so this scan does: no
// file of the API or its scripts but payment-credentials.service.ts names the column, in either
// spelling, or the table as raw SQL would. Every
// client leaves it out of reads unless a query names it (@jantrik/db CLIENT_OMIT), so a service
// that does not name it never holds it.

const SRC = path.resolve(import.meta.dirname, '..');
const SCRIPTS = path.resolve(SRC, '..', 'scripts');
const ALLOWED = path.join(SRC, 'payments', 'payment-credentials.service.ts');
// Built from parts, so this file does not name them itself: the column in either spelling, and
// the table as raw SQL names it (a `SELECT *` names no column).
const NAMES = [
  ['credentials', 'Ciphertext'].join(''),
  ['credentials', 'ciphertext'].join('_'),
  ['payment', 'gateway', 'accounts'].join('_'),
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|js|mjs|cjs|json|sql)$/.test(entry.name) ? [full] : [];
  });
}

describe('the encrypted gateway credentials', () => {
  it('are named by payment-credentials.service.ts and by no other file of the API or its scripts', () => {
    const files = [...sourceFiles(SRC), ...sourceFiles(SCRIPTS)];
    expect(files).toContain(ALLOWED);
    const naming = files.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return NAMES.some((name) => text.includes(name));
    });
    expect(naming).toEqual([ALLOWED]);
  });
});

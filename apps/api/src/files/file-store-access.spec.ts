import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Sprint 1 P2 (decision S7): files are reached only through the FileStore interface, so storage can
// move to a bucket without touching callers. This scan keeps any other code from reading or
// writing stored_files and stored_file_usage directly (Prisma or raw SQL).
const SRC = path.resolve(import.meta.dirname, '..');
const THE_STORE = 'files/postgres-file-store.ts';

export function touchesFileTables(code: string): boolean {
  return /\.storedFile(Usage)?\b|\bstored_file(s|_usage)\b/.test(code);
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sources(full);
    return e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') ? [full] : [];
  });
}

describe('who touches stored_files', () => {
  it(`only ${THE_STORE}`, () => {
    const touching = sources(SRC)
      .filter((file) => touchesFileTables(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file).replaceAll('\\', '/'));
    expect(touching).toEqual([THE_STORE]);
  });

  it('the scan finds what it looks for', () => {
    const caught = [
      'await tx.storedFile.findUnique({ where: { id } })',
      'this.db.tx.storedFile.create({ data })',
      'tx.storedFileUsage.update({ where: { tenantId } })',
      'SELECT bytes FROM stored_files WHERE id = $1',
      'DELETE FROM stored_files',
      'UPDATE stored_file_usage SET bytes_used = 0',
    ];
    for (const sample of caught) expect(touchesFileTables(sample), sample).toBe(true);
    const fine = [
      'await this.files.get(id)',
      'tx.student.update({ data: { photoFileId } })',
      'const storedFiles = 3;',
      "'stored-files:' advisory lock name",
    ];
    for (const sample of fine) expect(touchesFileTables(sample), sample).toBe(false);
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The device receiver and the institute API stay apart in code as well as in the database: only
// src/ingest holds the receiver's login and calls the ingest_* functions, and src/ingest never
// reaches the app's login, the request transaction, an institute context or the auth guards.
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
const inIngest = (rel: string) => rel.startsWith('ingest/');

/** What in a file outside src/ingest reaches the receiver's login or functions. */
export function ingestReach(code: string): string[] {
  const found: string[] = [];
  if (/ingest-prisma\.service|\bIngestPrismaService\b/.test(code)) {
    found.push('imports IngestPrismaService');
  }
  if (/\bingest_[a-z_]+\s*\(/.test(code)) found.push('calls an ingest_* function');
  return found;
}

/** What in a src/ingest file reaches the institute API's database access or login. */
export function apiReach(code: string): string[] {
  const found: string[] = [];
  if (/prisma\/prisma\.(service|module)|\bPrismaService\b|\bPrismaModule\b/.test(code)) {
    found.push('uses the app login (PrismaService)');
  }
  if (/tenancy\/db\.service|\bDb\b/.test(code)) found.push('uses the request transaction (Db)');
  if (/tenant-job-runner|\bTenantJobRunner\b/.test(code)) found.push('uses TenantJobRunner');
  if (/tenancy\/tenancy\.module|\bTenancyModule\b/.test(code)) found.push('imports TenancyModule');
  if (/\b(withTenant|withContext|tenantClient)\b/.test(code)) found.push('opens a tenant context');
  if (
    /common\/guards|platform-auth\.guard|\b(JwtAuthGuard|PlatformAuthGuard|TenantHeaderGuard|RolesGuard|ModuleGuard|RateLimitGuard)\b/.test(
      code,
    )
  ) {
    found.push('uses an auth guard');
  }
  return found;
}

describe('ingest isolation (code scan)', () => {
  it('finds what it should', () => {
    expect(ingestReach("import { X } from '../ingest/ingest-prisma.service.js';")).toEqual([
      'imports IngestPrismaService',
    ]);
    expect(ingestReach('tx.$queryRaw`SELECT * FROM ingest_resolve(${sn}::text)`')).toEqual([
      'calls an ingest_* function',
    ]);
    expect(ingestReach("const INGEST_PORT = 4080; config.get('INGEST_PORT')")).toEqual([]);
    expect(apiReach("import { PrismaService } from '../prisma/prisma.service.js';")).toEqual([
      'uses the app login (PrismaService)',
    ]);
    expect(apiReach("import { IngestPrismaService } from './ingest-prisma.service.js';")).toEqual(
      [],
    );
    expect(apiReach("import { Db } from '../tenancy/db.service.js';")).toEqual([
      'uses the request transaction (Db)',
    ]);
    expect(apiReach('constructor(private readonly jobs: TenantJobRunner) {}')).toEqual([
      'uses TenantJobRunner',
    ]);
    expect(apiReach('imports: [TenancyModule]')).toEqual(['imports TenancyModule']);
    expect(apiReach('withTenant(prisma, id, fn)')).toEqual(['opens a tenant context']);
    expect(apiReach("import { JwtAuthGuard } from '../common/guards.js';")).toEqual([
      'uses an auth guard',
    ]);
  });

  it('only src/ingest reaches the receiver login and the ingest_* functions', () => {
    const offenders = files
      .filter((f) => !inIngest(f.rel))
      .map((f) => ({ file: f.rel, found: ingestReach(f.code) }))
      .filter((o) => o.found.length > 0);
    expect(offenders).toEqual([]);
  });

  it('src/ingest never reaches the app login, an institute context or the auth guards', () => {
    const ingestFiles = files.filter((f) => inIngest(f.rel));
    expect(ingestFiles.length).toBeGreaterThanOrEqual(5);
    const offenders = ingestFiles
      .map((f) => ({ file: f.rel, found: apiReach(f.code) }))
      .filter((o) => o.found.length > 0);
    expect(offenders).toEqual([]);
  });
});

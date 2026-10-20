import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The platform module and the institute API stay apart in code as well as in the database:
// only src/platform holds the platform login (PlatformPrismaService) and calls the platform_*
// functions, and src/platform never opens an institute context (tenant or user) itself.
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
const inPlatform = (rel: string) => rel.startsWith('platform/');

/** What in a file outside src/platform reaches the platform side. */
export function platformReach(code: string): string[] {
  const found: string[] = [];
  if (/platform-prisma\.service/.test(code)) found.push('imports PlatformPrismaService');
  if (/\b(platform_[a-z_]+|app_current_platform_admin_id)\s*\(/.test(code)) {
    found.push('calls a platform_* function');
  }
  return found;
}

/** What in a src/platform file opens or uses an institute context. */
export function tenantReach(code: string): string[] {
  const found: string[] = [];
  if (/\b(withTenant|withContext|tenantClient)\b/.test(code)) found.push('opens a tenant context');
  if (/app\.(tenant_id|user_id)/.test(code)) found.push('sets app.tenant_id / app.user_id');
  if (/tenancy\/db\.service/.test(code)) found.push('uses the institute request transaction');
  return found;
}

describe('platform isolation (code scan)', () => {
  it('finds what it should', () => {
    expect(platformReach("import { X } from '../platform/platform-prisma.service.js';")).toEqual([
      'imports PlatformPrismaService',
    ]);
    expect(platformReach('tx.$queryRaw`SELECT * FROM platform_me()`')).toEqual([
      'calls a platform_* function',
    ]);
    expect(platformReach("const platform_sms_logs = 'x'; tx.platformSmsLog.create()")).toEqual([]);
    expect(tenantReach('withTenant(prisma, id, fn)')).toEqual(['opens a tenant context']);
    expect(tenantReach("set_config('app.tenant_id', id, true)")).toEqual([
      'sets app.tenant_id / app.user_id',
    ]);
    expect(tenantReach("set_config('app.platform_session', h, true)")).toEqual([]);
  });

  it('only src/platform reaches the platform login and functions', () => {
    const offenders = files
      .filter((f) => !inPlatform(f.rel))
      .map((f) => ({ file: f.rel, found: platformReach(f.code) }))
      .filter((o) => o.found.length > 0);
    expect(offenders).toEqual([]);
  });

  it('src/platform never opens an institute context', () => {
    const platformFiles = files.filter((f) => inPlatform(f.rel));
    expect(platformFiles.length).toBeGreaterThan(3);
    const offenders = platformFiles
      .map((f) => ({ file: f.rel, found: tenantReach(f.code) }))
      .filter((o) => o.found.length > 0);
    expect(offenders).toEqual([]);
  });
});

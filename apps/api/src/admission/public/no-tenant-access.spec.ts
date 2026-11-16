import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The public admission routes never open an institute's transaction (decision P3-C): nothing in
// this folder may import Db, TenantJobRunner or TenantSmsService (the SMS jobs that need the
// institute's context live in ../admission-sms.processor.ts and run in the worker).
describe('admission/public: no institute access', () => {
  const dir = import.meta.dirname;
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));

  it('finds the folder', () => {
    expect(files).toContain('public.service.ts');
  });

  it.each(files)('%s imports none of Db, TenantJobRunner, TenantSmsService', (file) => {
    const src = readFileSync(path.join(dir, file), 'utf8');
    for (const name of ['Db', 'TenantJobRunner', 'TenantSmsService']) {
      expect(src).not.toMatch(new RegExp(`\\bimport\\b[^;]*\\b${name}\\b[^;]*from`));
    }
    expect(src).not.toMatch(/tenancy\/db\.service|tenant-job-runner|tenant-sms\.service/);
  });
});

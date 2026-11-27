import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The gateway's public routes never open an institute's transaction (sprint 1 P7a2, P7a-B):
// nothing in this folder may import Db, TenantJobRunner, a fee service or the credentials service.
// The signal is stored by payment_signal_record with no context; the confirm job, which runs as
// the institute, decides everything.
describe('payments/public: no institute access', () => {
  const dir = import.meta.dirname;
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));

  it('finds the folder', () => {
    expect(files).toEqual(
      expect.arrayContaining(['gateway-signals.controller.ts', 'gateway-signals.service.ts']),
    );
  });

  it.each(files)(
    '%s imports none of Db, TenantJobRunner, the fee or credentials services',
    (file) => {
      const src = readFileSync(path.join(dir, file), 'utf8');
      for (const name of [
        'Db',
        'TenantJobRunner',
        'FeeCollectionService',
        'PaymentCredentialsService',
        'TenantSmsService',
        'withTenant',
        'tenantClient',
      ]) {
        expect(src).not.toMatch(new RegExp(`\\bimport\\b[^;]*\\b${name}\\b[^;]*from`));
      }
      expect(src).not.toMatch(
        /tenancy\/db\.service|tenant-job-runner|fee-collection\.service|payment-credentials\.service/,
      );
      // Its own transactions only with no institute and no person.
      expect(src.match(/withContext\(\s*this\.prisma\.client,\s*\{\}/g)?.length ?? 0).toBe(
        src.match(/withContext\(/g)?.length ?? 0,
      );
    },
  );
});

import nest from '@jantrik/eslint-config/nest';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  ...nest,
  {
    // Services get the request's RLS transaction from `Db.tx` and must never set the tenant
    // themselves. Only the tenancy layer, the auth flows and the public admission form (which
    // run before a context exists; the form opens none, docs/admission.md) and the gateway's
    // public signal routes (they open none either, docs/payments.md) may open their own context.
    // See docs/database.md.
    files: ['src/**/*.ts'],
    ignores: ['src/tenancy/**', 'src/auth/**', 'src/admission/public/**', 'src/payments/public/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@jantrik/db',
              importNames: ['withContext', 'withTenant', 'tenantClient'],
              message: 'Use the request transaction (inject Db, use this.db.tx) instead.',
            },
          ],
        },
      ],
    },
  },
]);

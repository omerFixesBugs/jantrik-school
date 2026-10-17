import type { TenantTx } from './context.js';

/**
 * Get the id of the person with this phone (E.164), creating them if new. Must run inside a
 * tenant context (`withContext` / `withTenant`). Returns only the id: a person who already
 * exists in another tenant becomes visible here only once they get a membership in this tenant.
 */
export async function findOrCreateUser(tx: TenantTx, phone: string, name: string): Promise<string> {
  const [row] = await tx.$queryRaw<{ id: string }[]>`
    SELECT app_find_or_create_user(${phone}, ${name})::text AS id`;
  if (!row) throw new Error('app_find_or_create_user returned no id');
  return row.id;
}

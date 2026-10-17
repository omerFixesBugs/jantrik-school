import type { TenantTx } from './context.js';

type Queryable = Pick<TenantTx, '$queryRaw'>;

/**
 * Ids of the current tenant's (non-deleted) students matching `term` in name / student code,
 * or `phone` (digits) in a guardian's phone. Runs `search_student_ids()` so the trigram indexes
 * can be used (plain ILIKE under RLS cannot use them). Load the students themselves through
 * normal RLS afterwards. Without a tenant context it returns nothing.
 */
export async function searchStudentIds(
  tx: Queryable,
  search: { term: string; phone?: string | null; limit?: number },
): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id
    FROM search_student_ids(${search.term}, ${search.phone ?? null}, ${search.limit ?? 2000}::int) AS id`;
  return rows.map((r) => r.id);
}

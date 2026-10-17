import { withContext, type PrismaClient, type Role } from '@jantrik/db';
import type { MembershipSummary } from '@jantrik/shared';

export interface LoginUser {
  id: string;
  name: string;
  locale: 'bn' | 'en';
  password_hash: string | null;
}

/** Login lookup through the SECURITY DEFINER function (users RLS hides everyone otherwise). */
export async function findUserForLogin(
  prisma: PrismaClient,
  by: { phone?: string | null; email?: string | null },
): Promise<LoginUser | undefined> {
  const rows = await prisma.$queryRaw<LoginUser[]>`
    SELECT id::text, name, locale::text AS locale, password_hash
    FROM auth_find_user_for_login(${by.phone ?? null}, ${by.email ?? null})`;
  return rows[0];
}

interface MembershipRow {
  tenant_id: string;
  tenant_slug: string;
  tenant_name: string;
  tenant_status: MembershipSummary['tenant']['status'];
  role: Role;
  membership_status: 'ACTIVE' | 'DISABLED';
}

const SELECTABLE_TENANT = new Set(['ACTIVE', 'TRIAL']);

/** Memberships of the current user, grouped per tenant. Run with app.user_id set. */
export async function listMemberships(
  query: Pick<PrismaClient, '$queryRaw'>,
): Promise<MembershipSummary[]> {
  const rows = await query.$queryRaw<MembershipRow[]>`
    SELECT tenant_id::text, tenant_slug, tenant_name, tenant_status::text AS tenant_status,
           role::text AS role, membership_status::text AS membership_status
    FROM auth_list_my_memberships()`;

  const byTenant = new Map<string, MembershipSummary>();
  for (const row of rows) {
    let summary = byTenant.get(row.tenant_id);
    if (!summary) {
      summary = {
        tenant: {
          id: row.tenant_id,
          slug: row.tenant_slug,
          name: row.tenant_name,
          status: row.tenant_status,
        },
        roles: [],
        selectable: false,
      };
      byTenant.set(row.tenant_id, summary);
    }
    if (row.membership_status === 'ACTIVE') {
      summary.roles.push(row.role);
      summary.selectable = SELECTABLE_TENANT.has(row.tenant_status);
    }
  }
  return [...byTenant.values()];
}

/** `listMemberships` for a user outside a request transaction (login, refresh). */
export function listMembershipsFor(
  prisma: PrismaClient,
  userId: string,
): Promise<MembershipSummary[]> {
  return withContext(prisma, { userId }, (tx) => listMemberships(tx));
}

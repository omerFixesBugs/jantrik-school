import { withContext, type PrismaClient, type Role } from '@jantrik/db';
import { INVITATION_DAYS, type MembershipSummary } from '@jantrik/shared';

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
  membership_status: 'ACTIVE' | 'DISABLED' | 'INVITED' | 'DECLINED';
  invited_at: Date | null;
}

/** When an invitation sent at `invitedAt` expires. */
export const inviteExpiry = (invitedAt: Date): Date =>
  new Date(invitedAt.getTime() + INVITATION_DAYS * 24 * 3600 * 1000);

const SELECTABLE_TENANT = new Set(['ACTIVE', 'TRIAL']);

/** Memberships of the current user, grouped per tenant. Run with app.user_id set. */
export async function listMemberships(
  query: Pick<PrismaClient, '$queryRaw'>,
): Promise<MembershipSummary[]> {
  const rows = await query.$queryRaw<MembershipRow[]>`
    SELECT tenant_id::text, tenant_slug, tenant_name, tenant_status::text AS tenant_status,
           role::text AS role, membership_status::text AS membership_status, invited_at
    FROM auth_list_my_memberships()`;
  const now = Date.now();

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
        invitation: null,
      };
      byTenant.set(row.tenant_id, summary);
    }
    if (row.membership_status === 'ACTIVE') {
      summary.roles.push(row.role);
      summary.selectable = SELECTABLE_TENANT.has(row.tenant_status);
    } else if (
      row.membership_status === 'INVITED' &&
      row.invited_at &&
      inviteExpiry(row.invited_at).getTime() > now &&
      SELECTABLE_TENANT.has(row.tenant_status)
    ) {
      // Pending staff invitation (not expired): no access until accepted.
      const expiresAt = inviteExpiry(row.invited_at).toISOString();
      summary.invitation ??= { roles: [], expiresAt };
      summary.invitation.roles.push(row.role);
    }
  }
  // Institutes known only through a declined/expired invitation or a disabled membership with
  // nothing else to show are left out.
  return [...byTenant.values()].filter(
    (m) => m.roles.length > 0 || m.invitation || hadOtherMembership(rows, m.tenant.id),
  );
}

/** Disabled memberships keep showing (as "unavailable"), as before invitations existed. */
function hadOtherMembership(rows: MembershipRow[], tenantId: string): boolean {
  return rows.some((r) => r.tenant_id === tenantId && r.membership_status === 'DISABLED');
}

/** `listMemberships` for a user outside a request transaction (login, refresh). */
export function listMembershipsFor(
  prisma: PrismaClient,
  userId: string,
): Promise<MembershipSummary[]> {
  return withContext(prisma, { userId }, (tx) => listMemberships(tx));
}

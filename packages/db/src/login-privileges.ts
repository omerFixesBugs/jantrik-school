import type { PrismaClient } from './client.js';

/**
 * Predefined roles that pass the grants this design relies on (the platform tables, the
 * receiver's functions) even though they do not bypass RLS: reading or writing every table, and
 * the server's files and programs. A runtime login must not be able to become any of them.
 */
export const PRIVILEGED_PREDEFINED_ROLES = [
  'pg_read_all_data',
  'pg_write_all_data',
  'pg_read_server_files',
  'pg_write_server_files',
  'pg_execute_server_program',
] as const;

/** What a database login can do beyond its grants (docs/database.md → Database roles). */
export interface LoginPrivileges {
  /** `session_user` of the connection: the login, whatever role the session switched to. */
  login: string;
  superuser: boolean;
  bypassRls: boolean;
  /**
   * Other roles the login is a member of (it can SET ROLE to them, or inherits them) that are
   * superusers, bypass RLS, or are one of PRIVILEGED_PREDEFINED_ROLES.
   */
  canBecome: string[];
}

/**
 * Reads the privileges of the client's own login (one catalog query, no table access). The login
 * is `session_user`, never `current_user`: a URL's `options=-c role=…` or a role default
 * (`ALTER ROLE … SET role`) makes the session run as another role, and any SQL can `RESET ROLE`
 * back to the login.
 */
export async function readLoginPrivileges(client: PrismaClient): Promise<LoginPrivileges> {
  const roles = [...PRIVILEGED_PREDEFINED_ROLES];
  const [row] = await client.$queryRaw<
    { login: string; superuser: boolean; bypass_rls: boolean; can_become: string[] }[]
  >`
    SELECT session_user::text AS login, r.rolsuper AS superuser, r.rolbypassrls AS bypass_rls,
           COALESCE(array_agg(o.rolname::text ORDER BY o.rolname)
                    FILTER (WHERE o.rolname IS NOT NULL), '{}') AS can_become
      FROM pg_roles r
      LEFT JOIN pg_roles o
        ON o.rolname <> session_user
       AND (o.rolsuper OR o.rolbypassrls OR o.rolname::text = ANY (${roles}::text[]))
       AND pg_has_role(session_user, o.oid, 'MEMBER')
     WHERE r.rolname = session_user
     GROUP BY r.rolsuper, r.rolbypassrls`;
  if (!row) throw new Error('The login has no pg_roles row');
  return {
    login: row.login,
    superuser: row.superuser,
    bypassRls: row.bypass_rls,
    canBecome: row.can_become,
  };
}

/**
 * Why a running service must not use this login, in plain words; empty when it may. A superuser
 * gets only "is a superuser": it can become every role anyway.
 */
export function loginPrivilegeProblems(p: LoginPrivileges): string[] {
  if (p.superuser) return ['is a superuser'];
  return [...(p.bypassRls ? ['has BYPASSRLS'] : []), ...p.canBecome.map((r) => `can become ${r}`)];
}

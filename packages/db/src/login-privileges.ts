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
  /** It may open replication connections, which stream every row whatever RLS says. */
  replication: boolean;
  /** It may create roles; no runtime login needs that (create-roles.sh refuses it too). */
  createRole: boolean;
  /**
   * Other roles the login is a member of (it can SET ROLE to them, or inherits them) that are
   * superusers, bypass RLS, have REPLICATION or CREATEROLE, or are one of
   * PRIVILEGED_PREDEFINED_ROLES.
   */
  canBecome: string[];
  /**
   * It may create temporary tables, views and functions in this database. On a pooled connection
   * they outlive the request: an SQL injection could plant a temporary view named like a table
   * (`pg_temp` is searched first for relations) that the next request on that connection, someone
   * else's, runs in its own signed context (P1-J8 review). Production revokes it
   * (deploy/postgres/database-setup.sql), and so does a migration; see `loginStartupVerdict`.
   * Counted through any role the login is a member of (inherited or only SET ROLE-able).
   */
  temp: boolean;
  /**
   * Settings stored for the login itself (`ALTER ROLE <login> [IN DATABASE <this one>] SET …`),
   * as `name=value`. A login may change its own: an SQL injection could store
   * `statement_timeout=1ms` and every new connection, of the API and the worker, would fail, even
   * after restarts (P1-J8 review round 2).
   */
  roleSettings: string[];
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
    {
      login: string;
      superuser: boolean;
      bypass_rls: boolean;
      replication: boolean;
      create_role: boolean;
      can_become: string[];
      temp: boolean;
      role_settings: string[];
    }[]
  >`
    SELECT session_user::text AS login, r.rolsuper AS superuser, r.rolbypassrls AS bypass_rls,
           r.rolreplication AS replication, r.rolcreaterole AS create_role,
           COALESCE(array_agg(o.rolname::text ORDER BY o.rolname)
                    FILTER (WHERE o.rolname IS NOT NULL), '{}') AS can_become,
           (has_database_privilege(session_user, current_database(), 'TEMPORARY')
            OR EXISTS (SELECT FROM pg_roles m
                       WHERE m.rolname <> session_user
                         AND pg_has_role(session_user, m.oid, 'MEMBER')
                         AND has_database_privilege(m.oid, current_database(), 'TEMPORARY'))) AS temp,
           ARRAY(SELECT unnest(d.setconfig) FROM pg_db_role_setting d
                 WHERE d.setrole = r.oid
                   AND d.setdatabase IN (0, (SELECT oid FROM pg_database
                                             WHERE datname = current_database()))
                 ORDER BY 1) AS role_settings
      FROM pg_roles r
      LEFT JOIN pg_roles o
        ON o.rolname <> session_user
       AND (o.rolsuper OR o.rolbypassrls OR o.rolreplication OR o.rolcreaterole
            OR o.rolname::text = ANY (${roles}::text[]))
       AND pg_has_role(session_user, o.oid, 'MEMBER')
     WHERE r.rolname = session_user
     GROUP BY r.oid, r.rolsuper, r.rolbypassrls, r.rolreplication, r.rolcreaterole`;
  if (!row) throw new Error('The login has no pg_roles row');
  return {
    login: row.login,
    superuser: row.superuser,
    bypassRls: row.bypass_rls,
    replication: row.replication,
    createRole: row.create_role,
    canBecome: row.can_become,
    temp: row.temp,
    roleSettings: row.role_settings,
  };
}

/**
 * Why a running service must not use this login, in plain words; empty when it may. A superuser
 * gets only "is a superuser": it can become every role anyway.
 */
export function loginPrivilegeProblems(p: LoginPrivileges): string[] {
  if (p.superuser) return ['is a superuser'];
  return [
    ...(p.bypassRls ? ['has BYPASSRLS'] : []),
    ...(p.replication ? ['has REPLICATION'] : []),
    ...(p.createRole ? ['has CREATEROLE'] : []),
    ...p.canBecome.map((r) => `can become ${r}`),
  ];
}

/** How a service's start-up check treats what `loginPrivilegeProblems` does not refuse everywhere. */
export interface LoginStartupOptions {
  /** NODE_ENV=production: refuse; elsewhere: warn. */
  production: boolean;
  /** Role settings this login is meant to have (the receiver's `statement_timeout=5s`). */
  expectedSettings?: readonly string[];
}

/**
 * A runtime login's start-up verdict (P1-J8 review). Always refused: `loginPrivilegeProblems`.
 * Refused in production, a warning elsewhere: TEMP (an injection could leave a temporary object
 * for the next request on a pooled connection) and role settings the login is not meant to have
 * (an injection could store one, e.g. a 1 ms statement timeout, that outlives restarts).
 */
export function loginStartupVerdict(
  p: LoginPrivileges,
  options: LoginStartupOptions,
): { problems: string[]; warnings: string[] } {
  const strict: string[] = [];
  const advice: string[] = [];
  if (p.temp) {
    strict.push('may create temporary objects (TEMP)');
    advice.push(
      `${p.login} may create temporary objects in this database (TEMP): an SQL injection could ` +
        'plant one that a later request on the same pooled connection runs. Revoke it: ' +
        'REVOKE TEMPORARY ON DATABASE <database> FROM PUBLIC (docs/database.md → The request context).',
    );
  }
  const unexpected = p.roleSettings.filter((s) => !(options.expectedSettings ?? []).includes(s));
  if (unexpected.length > 0) {
    strict.push(`has role settings it should not have (${unexpected.join(', ')})`);
    advice.push(
      `${p.login} has stored role settings (${unexpected.join(', ')}), which every new connection ` +
        `takes: check them, then ALTER ROLE ${p.login} RESET ALL (and ALTER ROLE ${p.login} IN ` +
        'DATABASE <database> RESET ALL) as the superuser (docs/database.md → The request context).',
    );
  }
  return options.production
    ? { problems: [...loginPrivilegeProblems(p), ...strict], warnings: [] }
    : { problems: loginPrivilegeProblems(p), warnings: advice };
}

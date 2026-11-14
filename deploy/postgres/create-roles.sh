#!/bin/sh
# Creates Jantrik's database roles and the production database (docs/deploy.md → Database roles).
# Run it once, BEFORE the first `prisma migrate deploy`: the migrations grant to these roles.
#
#   - The production compose Postgres runs it on its first start (deploy/postgres/initdb).
#   - By hand, on any Postgres 16 (a managed one too), as an admin with CREATEROLE and CREATEDB:
#       PGHOST=db.example.com PGUSER=admin PGPASSWORD=... \
#       DB_OWNER_PASSWORD=... DB_APP_PASSWORD=... DB_PLATFORM_PASSWORD=... DB_INGEST_PASSWORD=... \
#       sh deploy/postgres/create-roles.sh
#
# Passwords come from the environment only, never the command line (psql reads them with \getenv,
# psql 15 or newer). JANTRIK_DB_NAME names the database (default jantrik). Safe to run again: an
# existing role keeps its password, an existing database is left as it is; both are checked.
# Development and CI use docker/postgres/init/01-roles.sh (dev, test and e2e databases) instead.

jantrik_create_roles() (
  set -eu
  die() {
    echo "create-roles: $*" >&2
    exit 1
  }
  here=$(cd "$(dirname "$0")" && pwd)
  [ -f "$here/database-setup.sql" ] || die "database-setup.sql not found next to $0"
  export PGUSER="${PGUSER:-${POSTGRES_USER:-postgres}}"

  db="${JANTRIK_DB_NAME:-jantrik}"
  printf '%s' "$db" | grep -Eq '^[a-z_][a-z0-9_]{0,62}$' \
    || die "JANTRIK_DB_NAME must be lower-case letters, digits and _ (got '$db')"
  case "$db" in
    postgres | template0 | template1 | jantrik_test | jantrik_e2e)
      die "JANTRIK_DB_NAME=$db is not a production database name"
      ;;
  esac

  # Strong, distinct passwords that can go into a URL as they are (openssl rand -hex 24).
  for var in DB_OWNER_PASSWORD DB_APP_PASSWORD DB_PLATFORM_PASSWORD DB_INGEST_PASSWORD; do
    eval "pw=\${$var:-}"
    [ -n "$pw" ] || die "$var is not set"
    [ "${#pw}" -ge 24 ] || die "$var must be at least 24 characters (openssl rand -hex 24)"
    printf '%s' "$pw" | grep -Eq '^[A-Za-z0-9._~-]+$' \
      || die "$var may hold only letters, digits and . _ ~ - (it goes into the DATABASE_*_URL as it is)"
    if printf '%s' "$pw" | grep -Eiq 'change[-_]?me|dev_password|ci_password|example|placeholder'; then
      die "$var is an example value: generate one (openssl rand -hex 24)"
    fi
  done
  dupes=$(printf '%s\n' "$DB_OWNER_PASSWORD" "$DB_APP_PASSWORD" "$DB_PLATFORM_PASSWORD" \
    "$DB_INGEST_PASSWORD" | sort | uniq -d)
  [ -z "$dupes" ] || die "the four DB_*_PASSWORD values must differ"

  psql -X -q -v ON_ERROR_STOP=1 --dbname postgres -v db="$db" <<'SQL'
SET client_min_messages TO warning;
\getenv owner_pw DB_OWNER_PASSWORD
\getenv app_pw DB_APP_PASSWORD
\getenv platform_pw DB_PLATFORM_PASSWORD
\getenv ingest_pw DB_INGEST_PASSWORD

-- Each role as in docker/postgres/init/01-roles.sh (docs/database.md → Database roles).
-- Owns the schema and runs migrations. Not a superuser, so FORCE ROW LEVEL SECURITY applies to it.
SELECT format('CREATE ROLE jantrik_owner LOGIN CREATEDB NOSUPERUSER NOBYPASSRLS PASSWORD %L', :'owner_pw')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'jantrik_owner') \gexec
-- The API (DATABASE_URL): subject to Row-Level Security, owns nothing.
SELECT format('CREATE ROLE jantrik_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', :'app_pw')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'jantrik_app') \gexec
-- The API's platform module (DATABASE_PLATFORM_URL): the platform_* functions only.
SELECT format('CREATE ROLE jantrik_platform_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', :'platform_pw')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'jantrik_platform_app') \gexec
-- The device receiver (DATABASE_INGEST_URL): the four ingest_* functions only.
SELECT format('CREATE ROLE jantrik_ingest_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', :'ingest_pw')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'jantrik_ingest_app') \gexec

-- Owners of the SECURITY DEFINER functions: no login, no RLS bypass. jantrik_owner may SET ROLE
-- to them (migrations hand them their functions) but never inherits them: their policies would
-- otherwise show the owner every row.
SELECT format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS', r)
  FROM unnest(ARRAY['jantrik_auth', 'jantrik_search', 'jantrik_platform', 'jantrik_ingest']) AS r
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r) \gexec
GRANT jantrik_auth TO jantrik_owner WITH INHERIT FALSE, SET TRUE;
GRANT jantrik_search TO jantrik_owner WITH INHERIT FALSE, SET TRUE;
GRANT jantrik_platform TO jantrik_owner WITH INHERIT FALSE, SET TRUE;
GRANT jantrik_ingest TO jantrik_owner WITH INHERIT FALSE, SET TRUE;

-- An admin that is not a superuser (a managed Postgres) must be able to act as the owner to
-- create its database and set it up. SET only: it never inherits the owner's rights.
SELECT 'GRANT jantrik_owner TO CURRENT_USER WITH INHERIT FALSE, SET TRUE'
 WHERE NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) \gexec

-- Check every role, new or found: the attributes and memberships the security model relies on.
DO $$
DECLARE
  missing text;
  bad text;
BEGIN
  SELECT string_agg(r, ', ') INTO missing
    FROM unnest(ARRAY['jantrik_owner', 'jantrik_app', 'jantrik_auth', 'jantrik_search',
                      'jantrik_platform', 'jantrik_platform_app', 'jantrik_ingest',
                      'jantrik_ingest_app']) AS r
   WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'roles missing: %', missing;
  END IF;

  SELECT string_agg(rolname, ', ') INTO bad FROM pg_roles
   WHERE rolname LIKE 'jantrik\_%' AND (rolsuper OR rolbypassrls OR rolreplication OR rolcreaterole);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'roles must not be SUPERUSER, BYPASSRLS, REPLICATION or CREATEROLE: %', bad;
  END IF;

  SELECT string_agg(rolname, ', ') INTO bad FROM pg_roles
   WHERE (rolname IN ('jantrik_auth', 'jantrik_search', 'jantrik_platform', 'jantrik_ingest')
          AND rolcanlogin)
      OR (rolname IN ('jantrik_owner', 'jantrik_app', 'jantrik_platform_app', 'jantrik_ingest_app')
          AND NOT rolcanlogin)
      OR (rolname IN ('jantrik_app', 'jantrik_platform_app', 'jantrik_ingest_app') AND rolcreatedb);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'roles with the wrong LOGIN or CREATEDB attribute: %', bad;
  END IF;

  -- The runtime logins are members of no role (jantrik_app's rights are its own grants).
  SELECT string_agg(DISTINCT pg_get_userbyid(member)::text, ', ') INTO bad FROM pg_auth_members
   WHERE pg_get_userbyid(member) IN ('jantrik_app', 'jantrik_platform_app', 'jantrik_ingest_app');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'runtime logins must be members of no role: %', bad;
  END IF;

  -- The owner may SET ROLE to the function owners but never inherits them.
  SELECT string_agg(pg_get_userbyid(roleid)::text, ', ') INTO bad FROM pg_auth_members
   WHERE member = 'jantrik_owner'::regrole::oid
     AND pg_get_userbyid(roleid) IN ('jantrik_auth', 'jantrik_search', 'jantrik_platform',
                                     'jantrik_ingest')
     AND (inherit_option OR NOT set_option);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'jantrik_owner must hold these with INHERIT FALSE, SET TRUE: %', bad;
  END IF;
END
$$;

-- The production database, owned by the owner role. Development, test and e2e databases are not
-- created here.
SELECT format('CREATE DATABASE %I OWNER jantrik_owner', :'db')
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'db') \gexec
SELECT format('DO $x$ BEGIN RAISE EXCEPTION %L; END $x$',
              'the database ' || datname || ' exists and is not owned by jantrik_owner')
  FROM pg_database WHERE datname = :'db' AND pg_get_userbyid(datdba) <> 'jantrik_owner' \gexec
SQL

  psql -X -q -v ON_ERROR_STOP=1 --dbname "$db" -f "$here/database-setup.sql"
  echo "create-roles: the roles and the database $db are ready; next: prisma migrate deploy"
)

jantrik_create_roles

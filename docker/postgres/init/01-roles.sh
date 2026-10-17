#!/bin/sh
# Runs once, when the Postgres volume is first created (docker-entrypoint-initdb.d).
# Creates the two application roles and the dev + test databases.
# Table grants and RLS policies live in Prisma migrations, not here.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner_pw="$DB_OWNER_PASSWORD" -v app_pw="$DB_APP_PASSWORD" <<'SQL'
-- Owns the schema and runs migrations. Not a superuser, so FORCE ROW LEVEL SECURITY applies to it.
-- CREATEDB is needed for Prisma's shadow database during `prisma migrate dev`.
CREATE ROLE jantrik_owner LOGIN CREATEDB NOSUPERUSER NOBYPASSRLS PASSWORD :'owner_pw';

-- Runtime role used by the API. Never owns tables, can never bypass RLS.
CREATE ROLE jantrik_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'app_pw';

-- Owns the narrow SECURITY DEFINER auth functions (login lookup, memberships, tenant by slug).
-- NOLOGIN and NOBYPASSRLS: it only sees rows through explicit `TO jantrik_auth` policies.
-- jantrik_owner may SET ROLE to it (needed to hand function ownership over in migrations) but
-- does NOT inherit it: otherwise the `TO jantrik_auth` policies would let the owner see every
-- row and defeat FORCE ROW LEVEL SECURITY.
CREATE ROLE jantrik_auth NOLOGIN NOSUPERUSER NOBYPASSRLS;
GRANT jantrik_auth TO jantrik_owner WITH INHERIT FALSE, SET TRUE;

CREATE DATABASE jantrik OWNER jantrik_owner;
CREATE DATABASE jantrik_test OWNER jantrik_owner;
SQL

for db in jantrik jantrik_test; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<'SQL'
ALTER SCHEMA public OWNER TO jantrik_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO jantrik_app;
SQL
done

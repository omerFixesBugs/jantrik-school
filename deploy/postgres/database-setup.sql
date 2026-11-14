-- What a Jantrik database needs that a migration or pg_dump does not carry. Run while connected to
-- that database, as an admin that may SET ROLE jantrik_owner: create-roles.sh after creating the
-- database, restore.sh before restoring into one. Safe to run again.
\set ON_ERROR_STOP on

-- As the owner, so an admin without superuser (a managed Postgres) can run it too.
SET ROLE jantrik_owner;

-- The owner role owns the schema; nobody else may create in it. Table grants come from migrations.
ALTER SCHEMA public OWNER TO jantrik_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO jantrik_app;

-- Hardening (docs/decisions-pending.md, deployment requirement 3): no temporary tables for the
-- runtime logins, so one created through an SQL injection cannot shadow a table on a pooled
-- connection. Nothing in the app creates temporary tables; the owner keeps the right.
SELECT format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database()) \gexec

-- Dates the database works out itself (e.g. the 30-day punch floor) use UTC, as in development
-- and CI, whatever the server's own time zone.
SELECT format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC') \gexec

RESET ROLE;

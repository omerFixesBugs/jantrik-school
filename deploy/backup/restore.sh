#!/bin/sh
# Restores a backup.sh file into a database (docs/deploy.md → Restore). POSIX sh; needs psql and
# pg_restore 16, and a superuser connection (PGHOST, PGPORT, PGUSER, PGPASSWORD): restoring sets
# each object's owner and its grants, and loads tables that force row-level security.
#
#   restore.sh [--drop-existing=<db>] <file.dump> <db>
#
# The roles come first: they belong to the cluster, not to a backup. On a new server run
# deploy/postgres/create-roles.sh, then this. The target database must not exist or be empty:
#   - missing: it is created (owned by jantrik_owner) and set up as create-roles.sh does;
#   - empty (e.g. just made by create-roles.sh): it is set up and filled;
#   - holding anything: refused, unless --drop-existing names it again. Then it is dropped and
#     made anew, and only when nothing is connected to it (stop the services first).
# It never touches another database. Restore into a new name to look at old data side by side.
set -eu

die() {
  echo "restore: $*" >&2
  exit 1
}
usage() {
  die "usage: restore.sh [--drop-existing=<db>] <file.dump> <db>"
}

here=$(cd "$(dirname "$0")" && pwd)
setup_sql="$here/../postgres/database-setup.sql"
[ -f "$setup_sql" ] || die "deploy/postgres/database-setup.sql not found ($setup_sql)"

drop=""
while [ $# -gt 0 ]; do
  case "$1" in
    --drop-existing=*) drop="${1#*=}" ;;
    --) shift && break ;;
    -*) usage ;;
    *) break ;;
  esac
  shift
done
[ $# -eq 2 ] || usage
file=$1
target=$2

printf '%s' "$target" | grep -Eq '^[a-z_][a-z0-9_]{0,62}$' \
  || die "the database name must be lower-case letters, digits and _ (got '$target')"
case "$target" in
  postgres | template0 | template1) die "refusing to restore into $target" ;;
esac
[ -z "$drop" ] || [ "$drop" = "$target" ] \
  || die "--drop-existing must name the target database again (--drop-existing=$target)"
[ -f "$file" ] || die "no such file: $file"
pg_restore --list "$file" > /dev/null 2>&1 || die "$file is not a pg_dump custom-format archive"
if [ -f "$file.sha256" ]; then
  (cd "$(dirname "$file")" && sha256sum -c "$(basename "$file").sha256" > /dev/null) \
    || die "$file does not match its checksum ($file.sha256)"
fi

# psql on the maintenance database (or another with -d), one value per line, stop on any error.
sql() {
  psql -X -q -At -v ON_ERROR_STOP=1 --no-password "$@"
}

[ "$(sql -d postgres -c 'SELECT rolsuper FROM pg_roles WHERE rolname = current_user')" = t ] \
  || die "connect as a superuser (PGUSER): only it may set every owner and load forced-RLS tables"

missing=$(sql -d postgres -c "SELECT string_agg(r, ', ') FROM unnest(ARRAY['jantrik_owner',
  'jantrik_app', 'jantrik_auth', 'jantrik_search', 'jantrik_platform', 'jantrik_platform_app',
  'jantrik_ingest', 'jantrik_ingest_app']) AS r WHERE NOT EXISTS
  (SELECT FROM pg_roles WHERE rolname = r)")
[ -z "$missing" ] \
  || die "roles missing ($missing): run deploy/postgres/create-roles.sh first (roles are not in a backup)"

if [ "$(sql -d postgres -c "SELECT count(*) FROM pg_database WHERE datname = '$target'")" = 1 ]; then
  if [ -n "$drop" ]; then
    others=$(sql -d postgres -c "SELECT count(*) FROM pg_stat_activity
      WHERE datname = '$target' AND pid <> pg_backend_pid()")
    [ "$others" = 0 ] || die "$others connection(s) to $target: stop the services first"
    echo "restore: dropping $target (--drop-existing)"
    sql -d postgres -c "DROP DATABASE \"$target\""
  else
    objects=$(sql -d "$target" -c "SELECT count(*) FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg\_toast%' AND n.nspname NOT LIKE 'pg\_temp%'")
    [ "$objects" = 0 ] || die "$target is not empty ($objects objects). Restore into a new name, or replace it with --drop-existing=$target"
  fi
fi
if [ "$(sql -d postgres -c "SELECT count(*) FROM pg_database WHERE datname = '$target'")" = 0 ]; then
  sql -d postgres -c "CREATE DATABASE \"$target\" OWNER jantrik_owner"
fi
owner=$(sql -d postgres -c "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$target'")
[ "$owner" = jantrik_owner ] || die "$target is owned by $owner, not jantrik_owner"

sql -d "$target" -f "$setup_sql"

# Extensions as the owner role, as the migrations made them, so it keeps owning them (a later
# migration may change one). pg_restore's own CREATE EXTENSION IF NOT EXISTS then does nothing.
for ext in $(pg_restore --list "$file" | awk '$4 == "EXTENSION" && $5 == "-" { print $6 }'); do
  [ "$ext" = plpgsql ] && continue
  sql -d "$target" -c 'SET ROLE jantrik_owner' -c "CREATE EXTENSION IF NOT EXISTS \"$ext\"" \
    || echo "restore: $ext could not be created as jantrik_owner; pg_restore creates it" >&2
done

# All or nothing: one transaction, stopped by the first error.
pg_restore --single-transaction --exit-on-error --no-password --dbname="$target" "$file"
sql -d "$target" -c 'ANALYZE'

migrations=$(sql -d "$target" -c 'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL')
forced=$(sql -d "$target" -c "SELECT count(*) FROM pg_class
  WHERE relnamespace = 'public'::regnamespace AND relforcerowsecurity")
echo "restore: $file → $target ($migrations migrations, $forced tables with forced row-level security)"
echo "restore: check it (deploy/backup/restore-check.sh compares a copy with its source), then point the services at it"

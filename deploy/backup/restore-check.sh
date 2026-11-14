#!/bin/sh
# The restore drill as a test (docs/deploy.md → Restore drill; CI runs it): backs up <source-db>
# with backup.sh, restores the file with restore.sh into a scratch database that it names, creates
# and drops itself, and checks the copy against the source:
#   - the same migrations, row counts per table, sequences, constraints, triggers and extensions;
#   - the same owners and grants of every table and function (the SECURITY DEFINER functions
#     keep jantrik_auth, jantrik_search, jantrik_platform and jantrik_ingest), policies included;
#   - row-level security still enabled and forced on every table with a tenant_id;
#   - jantrik_app and jantrik_owner see no student without a tenant context, and jantrik_app sees
#     exactly one institute's students with it.
#
#   restore-check.sh <source-db>
#
# Needs a superuser connection (PGHOST, PGPORT, PGUSER, PGPASSWORD) and pg_dump/psql 16. The
# source is only read. Nothing else is touched: the scratch database is never jantrik,
# jantrik_test or jantrik_e2e, never one that existed before, and is dropped at the end.
set -eu

die() {
  echo "restore-check: $*" >&2
  exit 1
}

# A lower-case database name (letters, digits, _), checked as a whole with case: grep would check
# line by line, and the name goes into SQL.
db_name_ok() {
  lower=abcdefghijklmnopqrstuvwxyz
  case "$1" in
    '' | [!"$lower"_]* | *[!"$lower"0123456789_]*) return 1 ;;
  esac
  [ "${#1}" -le 63 ]
}

here=$(cd "$(dirname "$0")" && pwd)
[ $# -eq 1 ] || die "usage: restore-check.sh <source-db>"
src=$1
db_name_ok "$src" || die "bad database name '$src'"

scratch="jantrik_restorecheck_$(date -u +%Y%m%d%H%M%S)_$$"
case "$scratch" in
  jantrik | jantrik_test | jantrik_e2e | "$src") die "refusing to use $scratch as the scratch database" ;;
esac

sql() {
  psql -X -q -At -v ON_ERROR_STOP=1 --no-password "$@"
}

[ "$(sql -d postgres -c "SELECT count(*) FROM pg_database WHERE datname = '$scratch'")" = 0 ] \
  || die "$scratch already exists: not ours, left alone"

work=$(mktemp -d)
created=""
cleanup() {
  status=$?
  if [ -n "$created" ]; then
    sql -d postgres -c "DROP DATABASE IF EXISTS \"$scratch\" WITH (FORCE)" \
      || echo "restore-check: could not drop $scratch; drop it by hand" >&2
  fi
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

echo "restore-check: backing up $src"
BACKUP_DIR="$work" PGDATABASE="$src" BACKUP_KEEP_DAYS=0 sh "$here/backup.sh"
file=$(ls "$work"/*.dump)

echo "restore-check: restoring into $scratch"
created=1
sh "$here/restore.sh" "$file" "$scratch"

# Everything compared, as the superuser (it sees every row). One query per line of output.
# Expressions (checks, policies) are compared without brackets and spaces: a restore re-parses them
# and Postgres prints nested ANDs with fewer brackets.
facts() {
  sql -d "$1" <<'SQL'
SELECT 'migration', migration_name, checksum, finished_at IS NOT NULL, rolled_back_at IS NULL
  FROM _prisma_migrations ORDER BY migration_name;
SELECT 'rows', table_name,
       (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I.%I',
         table_schema, table_name), false, true, '')))[1]::text
  FROM information_schema.tables
 WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name;
SELECT 'sequence', sequencename, last_value FROM pg_sequences
 WHERE schemaname = 'public' ORDER BY sequencename;
SELECT 'relation', c.relname, c.relkind, pg_get_userbyid(c.relowner), c.relrowsecurity,
       c.relforcerowsecurity, coalesce(c.relacl::text, '')
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace ORDER BY c.relname;
SELECT 'column-grant', table_name, column_name, grantee, privilege_type
  FROM information_schema.column_privileges
 WHERE table_schema = 'public' AND grantee LIKE 'jantrik%'
 ORDER BY table_name, column_name, grantee, privilege_type;
SELECT 'policy', tablename, policyname, permissive, roles::text, cmd,
       md5(regexp_replace(coalesce(qual, '') || ' | ' || coalesce(with_check, ''), '[()[:space:]]', '', 'g'))
  FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname;
SELECT 'function', p.oid::regprocedure::text, pg_get_userbyid(p.proowner), p.prosecdef,
       coalesce(p.proconfig::text, ''), coalesce(p.proacl::text, ''), md5(p.prosrc)
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace ORDER BY 2;
SELECT 'constraint', conrelid::regclass::text, conname, contype, convalidated,
       md5(regexp_replace(pg_get_constraintdef(oid), '[()[:space:]]', '', 'g'))
  FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 2, 3;
SELECT 'trigger', tgrelid::regclass::text, tgname, tgenabled
  FROM pg_trigger WHERE NOT tgisinternal ORDER BY 2, 3;
SELECT 'extension', extname, extversion, pg_get_userbyid(extowner)
  FROM pg_extension ORDER BY extname;
SELECT 'schema', nspname, pg_get_userbyid(nspowner), coalesce(nspacl::text, '')
  FROM pg_namespace WHERE nspname = 'public';
SQL
}

facts "$src" > "$work/source.txt"
facts "$scratch" > "$work/restored.txt"
if ! diff "$work/source.txt" "$work/restored.txt" > "$work/diff.txt"; then
  head -50 "$work/diff.txt" >&2
  die "the restored copy differs from $src (above: < source, > restored)"
fi
echo "restore-check: equal to $src: $(grep -c '^migration' "$work/source.txt") migrations, $(grep -c '^rows' "$work/source.txt") tables, $(grep -c '^function' "$work/source.txt") functions, $(grep -c '^policy' "$work/source.txt") policies"

# Row-level security on every tenant table, and no function left to a superuser.
unforced=$(sql -d "$scratch" -c "SELECT string_agg(DISTINCT c.relname, ', ') FROM pg_class c
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity)")
[ -z "$unforced" ] || die "tenant tables without forced row-level security: $unforced"
# (An extension's own functions, pg_trgm's, belong to the bootstrap superuser by design.)
superowned=$(sql -d "$scratch" -c "SELECT count(*) FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
  WHERE p.pronamespace = 'public'::regnamespace AND r.rolsuper
    AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
                    AND d.objid = p.oid AND d.deptype = 'e')")
[ "$superowned" = 0 ] || die "$superowned function(s) owned by a superuser after the restore"
[ "$(sql -d "$scratch" -c "SELECT count(*) FROM pg_class
  WHERE relnamespace = 'public'::regnamespace AND relforcerowsecurity")" -gt 0 ] \
  || die "no table forces row-level security: not a Jantrik database?"

# The runtime role sees nothing without a tenant context, and one institute's rows with it.
students=$(sql -d "$scratch" -c 'SELECT count(*) FROM students')
if [ "$students" = 0 ]; then
  echo "restore-check: SKIPPED the row-level security check: $src has no students"
else
  for role in jantrik_app jantrik_owner; do
    seen=$(sql -d "$scratch" -c "SET ROLE $role" -c 'SELECT count(*) FROM students' 2>&1 || true)
    case "$seen" in
      0 | *ERROR*) ;;
      *) die "$role sees $seen students without a tenant context" ;;
    esac
  done
  tenant=$(sql -d "$scratch" -c 'SELECT tenant_id FROM students GROUP BY tenant_id ORDER BY count(*) DESC LIMIT 1')
  expected=$(sql -d "$scratch" -c "SELECT count(*) FROM students WHERE tenant_id = '$tenant'")
  seen=$(sql -d "$scratch" -c "SELECT set_config('app.tenant_id', '$tenant', false)" \
    -c 'SET ROLE jantrik_app' -c 'SELECT count(*) FROM students' | tail -1)
  [ "$seen" = "$expected" ] \
    || die "jantrik_app sees $seen students of one institute, expected $expected"
  echo "restore-check: row-level security holds: no students without a tenant context, $seen of $students with one"
fi
echo "restore-check: OK ($scratch is dropped now)"

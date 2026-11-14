#!/bin/sh
# Backs up the Jantrik database (docs/deploy.md → Backups): pg_dump in custom format, timestamped,
# checked, with a checksum; then deletes backups older than BACKUP_KEEP_DAYS. POSIX sh for a Linux
# server's cron; needs pg_dump and pg_restore 16. The compose service `backup` runs it.
#
#   PGHOST, PGPORT, PGUSER, PGPASSWORD   a login that reads past row-level security: the cluster
#                                        superuser. Not jantrik_owner: FORCE ROW LEVEL SECURITY
#                                        applies to it, and pg_dump stops rather than dump part
#                                        of a table.
#   PGDATABASE         the database (e.g. jantrik)
#   BACKUP_DIR         where the files go
#   BACKUP_KEEP_DAYS   delete backups older than this many days (default 14; 0 keeps them all)
#   BACKUP_UPLOAD_CMD  optional: a command run after each backup with the file as $1, to copy it
#                      off the server, e.g. 'rclone copy "$1" offsite:jantrik-backups/' (a
#                      placeholder: pick your storage, docs/deploy.md)
#
# Writes <db>-<UTC time>.dump and <file>.sha256, then LAST_SUCCESS (time and file) for monitoring.
# The roles are not in a backup (they belong to the cluster): a restore needs
# deploy/postgres/create-roles.sh first (deploy/backup/restore.sh checks).
set -eu

die() {
  echo "backup: $*" >&2
  exit 1
}

dir="${BACKUP_DIR:-}"
db="${PGDATABASE:-}"
keep="${BACKUP_KEEP_DAYS:-14}"
[ -n "$dir" ] || die "BACKUP_DIR is not set"
[ -n "$db" ] || die "PGDATABASE is not set"
case "$keep" in
  '' | *[!0-9]*) die "BACKUP_KEEP_DAYS must be a whole number of days" ;;
esac

umask 077
mkdir -p "$dir"
name="$db-$(date -u +%Y%m%dT%H%M%SZ).dump"
tmp="$dir/$name.partial"
trap 'rm -f "$tmp"' EXIT

pg_dump --format=custom --no-password --file="$tmp" "$db"

# Readable, and holds the migrations table: not an empty or a foreign database. (grep reads it
# all: with -q it would stop early, and pg_restore would complain of a broken pipe.)
pg_restore --list "$tmp" | grep 'TABLE DATA public _prisma_migrations' > /dev/null \
  || die "the dump of $db has no _prisma_migrations data: not a migrated Jantrik database?"
mv "$tmp" "$dir/$name"
(cd "$dir" && sha256sum "$name" > "$name.sha256")

if [ -n "${BACKUP_UPLOAD_CMD:-}" ]; then
  sh -c "$BACKUP_UPLOAD_CMD" upload "$dir/$name" || die "BACKUP_UPLOAD_CMD failed for $name"
fi

if [ "$keep" -gt 0 ]; then
  # Only after a good new backup, so the newest one always stays.
  find "$dir" -maxdepth 1 -type f \( -name "$db-*.dump" -o -name "$db-*.dump.sha256" \) \
    -mtime +"$keep" -exec rm -f {} \;
fi

printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$name" > "$dir/LAST_SUCCESS"
echo "backup: $dir/$name ($(du -h "$dir/$name" | cut -f1))"

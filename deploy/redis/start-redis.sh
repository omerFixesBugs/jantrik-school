#!/bin/sh
# Starts Redis for the production compose (docs/deploy.md → Redis): every write kept (AOF, fsync
# each second), never evicting (noeviction under REDIS_MAXMEMORY), the default user behind
# REDIS_PASSWORD (the API and the worker), and the device receiver's own user, jantrik_ingest,
# limited by the rules in ingest-user.acl (its keys and its queue only). Mounted read-only with
# the rules at /usr/local/etc/jantrik-redis.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
rules_file="$here/ingest-user.acl"

fail() {
  echo "start-redis: $*" >&2
  exit 1
}

: "${REDIS_PASSWORD:?REDIS_PASSWORD is not set}"
: "${REDIS_INGEST_PASSWORD:?REDIS_INGEST_PASSWORD is not set (the Redis user of the receiver)}"
: "${REDIS_MAXMEMORY:?REDIS_MAXMEMORY is not set}"
prefix=${QUEUE_PREFIX:-jantrik}

# One word each: a space would add ACL rules of its own (compose.sh allows only these anyway).
case "$REDIS_INGEST_PASSWORD" in
  *[!A-Za-z0-9._~-]*) fail 'REDIS_INGEST_PASSWORD may hold only letters, digits and . _ ~ -' ;;
esac
case "$prefix" in
  '' | *[!A-Za-z0-9_-]*) fail 'QUEUE_PREFIX may hold only letters, digits, _ and -' ;;
esac
[ "$REDIS_INGEST_PASSWORD" != "$REDIS_PASSWORD" ] ||
  fail 'REDIS_INGEST_PASSWORD must differ from REDIS_PASSWORD'
[ -r "$rules_file" ] || fail "$rules_file not found"

# The rules: comment and blank lines dropped, {prefix} replaced by QUEUE_PREFIX.
rules=$(sed -e 's/#.*$//' -e "s/{prefix}/$prefix/g" "$rules_file" | tr '\n' ' ')

# The rules are passed as separate words, unquoted on purpose; no file name expansion (~ingest:*).
set -f
# shellcheck disable=SC2086
exec redis-server --appendonly yes --appendfsync everysec \
  --maxmemory "$REDIS_MAXMEMORY" --maxmemory-policy noeviction \
  --requirepass "$REDIS_PASSWORD" \
  --user jantrik_ingest on ">$REDIS_INGEST_PASSWORD" $rules

#!/bin/sh
# Checks the device receiver's Redis user inside the running redis container (CI, and after each
# deploy, docs/deploy.md → Redis):
#   deploy/compose.sh exec -T redis sh /usr/local/etc/jantrik-redis/check-ingest-acl.sh
# It logs in as jantrik_ingest and writes one of its own keys (expires in 5 s); what the user must
# not do is asked of Redis's ACL itself (ACL DRYRUN, as the default user), so a wrong rule never
# runs a destructive command here.
set -eu

: "${REDIS_INGEST_PASSWORD:?REDIS_INGEST_PASSWORD is not set}"
: "${REDISCLI_AUTH:?REDISCLI_AUTH (the password of the default user) is not set}"

fail() {
  echo "check-ingest-acl: $*" >&2
  exit 1
}

as_ingest() {
  redis-cli --no-auth-warning --user jantrik_ingest --pass "$REDIS_INGEST_PASSWORD" "$@" 2>&1
}

[ "$(as_ingest SET rl:ingest-ip:acl-check 1 EX 5)" = OK ] ||
  fail 'jantrik_ingest cannot log in or write its own keys'

refused() {
  answer=$(redis-cli ACL DRYRUN jantrik_ingest "$@" 2>&1)
  case "$answer" in
    *'no permissions'* | *NOPERM*) ;;
    *) fail "jantrik_ingest may run: $* ($answer)" ;;
  esac
}
refused SET otp:acl-check 1
refused GET rl:otp-phone-day:acl-check
refused FLUSHALL
refused KEYS '*'
refused CONFIG GET maxmemory
refused FUNCTION FLUSH
refused PUBLISH anything x
refused SCAN 0
refused RANDOMKEY
refused DBSIZE

echo 'check-ingest-acl: jantrik_ingest reaches its own keys only and no dangerous command'

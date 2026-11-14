#!/bin/sh
# docker compose for the production stack, with its settings (docs/deploy.md):
#   deploy/compose.sh up -d --build
#   deploy/compose.sh run --rm migrate node dist/cli/main.js list
# JANTRIK_ENV_FILE points at another settings file (default deploy/.env.prod). A server-local
# deploy/docker-compose.override.yml (git-ignored) is added when it exists.
#
# Before any command it checks the settings file, so a published or weak value never reaches
# Postgres (which takes its passwords on the first start) or Redis:
#   - every line is a comment, empty, or KEY=value (export KEY=value too): nothing compose would
#     read differently from this check;
#   - no value holds CHANGE_ME or example.com;
#   - every *_PASSWORD has at least 24 characters, only letters, digits and . _ ~ -, no example
#     marker, and all differ; the secrets have no example marker;
#   - none of its keys is also set in this shell (compose would take the shell's value instead).
here=$(cd "$(dirname "$0")" && pwd)
env_file="${JANTRIK_ENV_FILE:-$here/.env.prod}"
if [ ! -f "$env_file" ]; then
  echo "compose.sh: $env_file not found (cp deploy/.env.prod.example deploy/.env.prod)" >&2
  exit 1
fi

upper=ABCDEFGHIJKLMNOPQRSTUVWXYZ
url_safe="${upper}abcdefghijklmnopqrstuvwxyz0123456789._~-"
cr=$(printf '\r')
tab=$(printf '\t')
problems=""
passwords=""
add() {
  problems="$problems
  $1"
}
# The example and test markers, as in production-env.ts (isPlaceholderSecret) and create-roles.sh.
is_example() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    *change_me* | *change-me* | *'change me'* | *changeme* | *dev-only* | *dev_only* | \
      *test-only* | *test_only* | *ci-only* | *ci_only* | *dev_password* | *ci_password* | \
      *placeholder* | *example*)
      return 0
      ;;
  esac
  return 1
}

n=0
while IFS= read -r line || [ -n "$line" ]; do
  n=$((n + 1))
  line=${line%"$cr"}
  case "$line" in
    '' | '#'*) continue ;;
    'export '*) line=${line#export } ;;
  esac
  key=${line%%=*}
  case "$line" in
    *=*) ;;
    *) key="" ;;
  esac
  case "$key" in
    '' | [!"$upper"]* | *[!"$upper"0123456789_]*)
      add "line $n is not KEY=value (no spaces around =, upper-case KEY)"
      continue
      ;;
  esac
  value=${line#*=}
  # What compose reads: a quoted value up to its closing quote, else up to an inline comment.
  case "$value" in
    \"*) value=${value#\"} && value=${value%%\"*} ;;
    \'*) value=${value#\'} && value=${value%%\'*} ;;
    *)
      value=${value%%" #"*}
      value=${value%%"$tab#"*}
      while :; do
        case "$value" in
          *' ' | *"$tab") value=${value%?} ;;
          *) break ;;
        esac
      done
      ;;
  esac
  if env | grep -q "^$key="; then
    add "$key is also set in this shell, and compose would use that value: unset $key"
  fi
  case "$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')" in
    *change_me* | *example.com*) add "$key still holds the example value" ;;
  esac
  case "$key" in
    *_PASSWORD)
      [ "${#value}" -ge 24 ] || add "$key is shorter than 24 characters (openssl rand -hex 24)"
      case "$value" in
        *[!"$url_safe"]*) add "$key may hold only letters, digits and . _ ~ - (openssl rand -hex 24)" ;;
      esac
      if is_example "$value"; then add "$key is an example value"; fi
      passwords="$passwords$value
"
      ;;
    JWT_ACCESS_SECRET | OTP_PEPPER | PLATFORM_TOTP_KEY)
      if is_example "$value"; then add "$key is an example value"; fi
      ;;
  esac
done < "$env_file"
# One per line: a password with a newline was refused above.
if [ -n "$(printf '%s' "$passwords" | sort | uniq -d)" ]; then
  add "two *_PASSWORD values are the same: every password must differ"
fi
if [ -n "$problems" ]; then
  echo "compose.sh: fix $env_file first:$problems" >&2
  exit 1
fi

set -- --env-file "$env_file" "$@"
if [ -f "$here/docker-compose.override.yml" ]; then
  set -- -f "$here/docker-compose.override.yml" "$@"
fi
exec docker compose -f "$here/docker-compose.prod.yml" "$@"

#!/bin/sh
# docker compose for the production stack, with its settings (docs/deploy.md):
#   deploy/compose.sh up -d --build
#   deploy/compose.sh run --rm migrate node dist/cli/main.js list
# JANTRIK_ENV_FILE points at another settings file (default deploy/.env.prod). A server-local
# deploy/docker-compose.override.yml (git-ignored) is added when it exists.
#
# Before anything else it refuses a settings file that still holds an example value (CHANGE_ME,
# example.com) or a *_PASSWORD under 24 characters or with characters a URL cannot carry: Postgres
# and Redis take their passwords as they are, and nothing else would stop a published one.
here=$(cd "$(dirname "$0")" && pwd)
env_file="${JANTRIK_ENV_FILE:-$here/.env.prod}"
if [ ! -f "$env_file" ]; then
  echo "compose.sh: $env_file not found (cp deploy/.env.prod.example deploy/.env.prod)" >&2
  exit 1
fi

url_safe=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~-
cr=$(printf '\r')
problems=""
while IFS= read -r line || [ -n "$line" ]; do
  line=${line%"$cr"}
  case "$line" in
    '' | '#'*) continue ;;
  esac
  key=${line%%=*}
  value=${line#*=}
  # Quotes around a value are not part of it.
  case "$value" in
    \"*\") value=${value#\"} && value=${value%\"} ;;
    \'*\') value=${value#\'} && value=${value%\'} ;;
  esac
  case "$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')" in
    *change_me* | *change-me* | *changeme* | *example.com*)
      problems="$problems
  $key still holds the example value"
      ;;
  esac
  case "$key" in
    *_PASSWORD)
      if [ "${#value}" -lt 24 ]; then
        problems="$problems
  $key is shorter than 24 characters (openssl rand -hex 24)"
      fi
      case "$value" in
        *[!"$url_safe"]*)
          problems="$problems
  $key may hold only letters, digits and . _ ~ - (openssl rand -hex 24)"
          ;;
      esac
      ;;
  esac
done < "$env_file"
if [ -n "$problems" ]; then
  echo "compose.sh: fix $env_file first:$problems" >&2
  exit 1
fi

set -- --env-file "$env_file" "$@"
if [ -f "$here/docker-compose.override.yml" ]; then
  set -- -f "$here/docker-compose.override.yml" "$@"
fi
exec docker compose -f "$here/docker-compose.prod.yml" "$@"

#!/bin/sh
# docker compose for the production stack, with its settings (docs/deploy.md):
#   deploy/compose.sh up -d --build
#   deploy/compose.sh run --rm migrate node dist/cli/main.js list
# JANTRIK_ENV_FILE points at another settings file (default deploy/.env.prod).
here=$(cd "$(dirname "$0")" && pwd)
env_file="${JANTRIK_ENV_FILE:-$here/.env.prod}"
if [ ! -f "$env_file" ]; then
  echo "compose.sh: $env_file not found (cp deploy/.env.prod.example deploy/.env.prod)" >&2
  exit 1
fi
exec docker compose -f "$here/docker-compose.prod.yml" --env-file "$env_file" "$@"

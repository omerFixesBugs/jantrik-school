# Jantrik School

Multi-tenant SaaS for education institutes in Bangladesh. See [CLAUDE.md](CLAUDE.md) for scope,
architecture rules and the current phase.

## Prerequisites

- **Node.js 22+** (24 recommended, see `.nvmrc`)
- **Corepack** (ships with Node). Provides the pinned pnpm version.
- **Docker** with Compose v2+ (for Postgres 16 and Redis)

## First-time setup

```bash
corepack enable                 # makes the pinned pnpm (package.json "packageManager") available
pnpm install                    # install all workspace dependencies
cp .env.example .env            # Windows PowerShell: Copy-Item .env.example .env
docker compose up -d --wait     # start Postgres 16 + Redis; first start creates DB roles + databases
pnpm db:generate                # generate the Prisma client
pnpm db:deploy                  # apply migrations (tables, RLS, grants)
pnpm db:seed                    # institute types, templates, GPA scheme + 2 demo tenants
pnpm dev                        # start web + api (and watch shared packages)
```

Then open:

| What       | URL                                                                              |
| ---------- | -------------------------------------------------------------------------------- |
| Web app    | http://localhost:3000                                                            |
| API health | http://localhost:4000/health                                                     |
| Postgres   | `localhost:5432`, db `jantrik` (roles: see [docs/database.md](docs/database.md)) |
| Redis      | `localhost:6379`                                                                 |

`GET /health` returns `{"status":"ok","db":"up","timestamp":"..."}`, or HTTP 503 with
`"db":"down"` if Postgres is unreachable.

## Everyday commands

All commands run from the repo root.

| Command                  | What it does                                                                  |
| ------------------------ | ----------------------------------------------------------------------------- |
| `pnpm dev`               | Run all apps in watch mode (web :3000, api :4000)                             |
| `pnpm build`             | Production build of every package and app                                     |
| `pnpm lint`              | ESLint across the workspace                                                   |
| `pnpm typecheck`         | TypeScript `--noEmit` across the workspace                                    |
| `pnpm test`              | All tests (Vitest). `packages/db` and `apps/api` tests need Docker running    |
| `pnpm e2e`               | Playwright end-to-end (run `pnpm build` first; stop dev servers on 3000/4000) |
| `pnpm format`            | Format everything with Prettier                                               |
| `pnpm format:check`      | Check formatting (CI)                                                         |
| `pnpm db:generate`       | Regenerate the Prisma client after editing `schema.prisma`                    |
| `pnpm db:migrate`        | Create + apply a dev migration (`prisma migrate dev`)                         |
| `pnpm db:deploy`         | Apply pending migrations (production/CI)                                      |
| `pnpm db:seed`           | Seed templates + demo tenants (idempotent)                                    |
| `pnpm db:reset`          | Drop the local dev database, re-migrate and re-seed (see below)               |
| `pnpm db:studio`         | Open Prisma Studio                                                            |
| `docker compose up -d`   | Start Postgres + Redis                                                        |
| `docker compose down`    | Stop them (data is kept in named volumes)                                     |
| `docker compose down -v` | Stop and **delete all local data**                                            |

**Resetting the dev database.** `pnpm db:seed` skips demo tenants that already exist, so after a
seed or schema change that existing rows don't pick up, run `pnpm db:reset`. It drops the
`jantrik` database, applies every migration and runs the seed. Every session goes with it, so sign
in again afterwards. It refuses to run unless all of these hold:

- `NODE_ENV` is not `production`;
- `DATABASE_MIGRATION_URL` and `DATABASE_URL` point at the same database;
- the host is this machine (`localhost`, `127.0.0.1` or `::1`);
- the database is `jantrik`, the local dev database. `jantrik_test` and `jantrik_e2e` are managed
  by their test setups.

`pnpm db:reset --dry-run` runs the same checks and prints the steps without changing anything.

Run a command in a single package with a filter, e.g. `pnpm --filter @jantrik/api test`.

## Repository layout

```
apps/
  web/                 Next.js (App Router) + Tailwind v4 + shadcn/ui + next-intl (bn, en)
  api/                 NestJS 12 (ESM), one Nest module per product module
packages/
  db/                  Prisma 7 schema + client (PostgreSQL via @prisma/adapter-pg)
  shared/              zod schemas + types shared by web and api
  eslint-config/       shared ESLint flat configs (base, nest, next)
  typescript-config/   shared tsconfig bases
docker-compose.yml     Postgres 16 + Redis 7 for local development
```

## Auth

Phone + OTP and password login, rotating refresh sessions, tenant switching and the per-request
RLS transaction are described in [docs/auth.md](docs/auth.md). After `pnpm db:seed`, log in as
demo staff with phone `01711000001` and password `Jantrik@2026` (development only), or as a
guardian with OTP to `01811000101` (the code is printed in the API log). `01911000999` (same
password) teaches at both demo institutes and gets the institute picker.

## Database

Read [docs/database.md](docs/database.md) before touching the schema: roles, Row-Level Security,
`withTenant` vs `tenantClient`, and the checklist for adding a tenant table.

> Upgrading an existing local database? The Postgres roles changed. Either run
> `docker compose down -v` once (deletes local DB data) and follow the setup steps above, or
> create the new `jantrik_auth` role with the one-liner in [docs/database.md](docs/database.md).

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push and pull request to
`main`. It uses Postgres 16 and Redis 7 service containers. It creates the database roles with
the same script Docker uses locally ([`docker/postgres/init/01-roles.sh`](docker/postgres/init/01-roles.sh)),
then runs these steps in order and stops at the first failure:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm format:check
pnpm db:deploy      # migrations against jantrik_test
pnpm test
pnpm build
pnpm e2e            # Playwright: built API + web against jantrik_e2e (Chromium)
```

On failure the Playwright HTML report is uploaded as a build artifact.

A newer push to the same branch cancels the older run. To check a change before pushing, run
the same commands locally with `docker compose up -d` running.

## Environment

A single root `.env` is used by every app and package (`.env.example` lists all variables).
Never commit `.env`. `NEXT_PUBLIC_*` variables are inlined into the web build at build time.

## Notes

- **pnpm build scripts**: pnpm only runs dependency install scripts that are allow-listed in
  `pnpm-workspace.yaml` (`allowBuilds`). If an install fails with `ERR_PNPM_IGNORED_BUILDS`, decide
  whether that package needs its script, then add it there as `true` or `false`.
- **pnpm minimum release age**: pnpm refuses packages published in the last day. If an
  install fails with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, pin the previous version.

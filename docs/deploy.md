# Deploying Jantrik (production runbook)

A step-by-step guide for putting Jantrik on one Linux server with Docker. It does not depend on a
hosting provider: any server you can reach over SSH works (a VPS from any provider, or your own
machine). Decisions behind it: [decisions-pending.md](decisions-pending.md) → "Deployment
readiness". Things only the owner can do are listed at the end.

## What runs

Everything is in [`deploy/docker-compose.prod.yml`](../deploy/docker-compose.prod.yml), built from
the repo's [`Dockerfile`](../Dockerfile):

| Service    | What it is                                                                | Reached from                            |
| ---------- | ------------------------------------------------------------------------- | --------------------------------------- |
| `postgres` | PostgreSQL 16. On its first start it creates the roles and the database   | the other services only                 |
| `redis`    | Redis with persistence (AOF) and no eviction                              | the other services only                 |
| `migrate`  | One shot: the migrations, then the institute types and templates          | runs and exits before the apps start    |
| `api`      | The API (`node dist/main.js`)                                             | Caddy; `127.0.0.1:4000` on the server   |
| `worker`   | The queue jobs (SMS, imports, fees, exams, devices): the API without HTTP | nothing (no port)                       |
| `receiver` | The ZKTeco device receiver (`node dist/ingest-main.js`), its own login    | the internet, port **4080**, plain HTTP |
| `web`      | The Next.js app                                                           | Caddy; `127.0.0.1:3000` on the server   |
| `caddy`    | HTTPS for the web app, the platform area and the API (Let's Encrypt)      | the internet, ports **80** and **443**  |
| `backup`   | `pg_dump` to a folder on the server; only when you run it (cron)          | nothing                                 |

Start order (Docker enforces it): `postgres` and `redis` healthy → `migrate` finished without an
error → `api`, `worker`, `receiver`. Only `migrate` gets the owner role's password; the API and
the worker log in as `jantrik_app` and `jantrik_platform_app`, the receiver as
`jantrik_ingest_app` and gets none of the API's secrets.

## 1. A server

- **To start:** 2 vCPU, 4 GB RAM, 60–80 GB SSD, Ubuntu 24.04 LTS, a fixed public IPv4 address.
  Add 2 GB of swap: building the images (Next.js) needs memory for a few minutes.
- **Grow when** CPU stays above about 70 % at busy hours (morning attendance), memory is short, or
  the database outgrows the disk: first 4 vCPU / 8 GB; then move Postgres to its own server or a
  managed Postgres 16 (see "A managed Postgres" below), then run more workers.
- Pick a region close to Bangladesh (e.g. Singapore or Mumbai) for low latency.

## 2. DNS

Create these records at your domain's DNS provider, all pointing at the server's IPv4 address
(A records). A low TTL (300 s) at first makes mistakes cheap.

**No AAAA (IPv6) records yet**, even if the server has IPv6. The compose network has no IPv6:
Docker would hand every IPv6 visitor to the API as one address (the network's gateway), so they
would all share one per-address rate limit. The device port is published on IPv4 only, so
`device.` must never get an AAAA record. Enabling IPv6 end to end is a later step (below).

| Name                     | For                                                        |
| ------------------------ | ---------------------------------------------------------- |
| `app.<your-domain>`      | the institute app (staff, guardians)                       |
| `platform.<your-domain>` | Jantrik's own admins (`/platform`), on their own subdomain |
| `api.<your-domain>`      | the API                                                    |
| `device.<your-domain>`   | what attendance devices dial (port 4080). Or use the IP    |

## 3. Firewall

Open only SSH, 80, 443 and 4080:

```bash
sudo ufw default deny incoming
sudo ufw allow OpenSSH            # better: only from your own address
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp            # HTTP/3
sudo ufw allow 4080/tcp           # attendance devices (plain HTTP)
sudo ufw enable
```

Docker publishes container ports past `ufw`. That is why the compose file publishes only 80, 443
and 4080 to the world, binds the API and the web app to `127.0.0.1`, and publishes Postgres and
Redis nowhere. Keep it that way when you edit it. If your provider has a firewall of its own, open
the same ports there.

## 4. Docker and the code

1. Install Docker Engine and its compose plugin by following
   <https://docs.docker.com/engine/install/ubuntu/>, then let your user run it
   (`sudo usermod -aG docker $USER`, log out and in).
2. Get the code at the version you deploy:

   ```bash
   sudo mkdir -p /srv/jantrik && sudo chown $USER /srv/jantrik
   git clone https://github.com/<owner>/jantrik-school.git /srv/jantrik
   cd /srv/jantrik
   git checkout <tag or commit>
   ```

All commands below run from `/srv/jantrik`. `deploy/compose.sh` is `docker compose` with the
production compose file and settings file filled in.

## 5. The settings file

```bash
cp deploy/.env.prod.example deploy/.env.prod
chmod 600 deploy/.env.prod
```

Fill in every value of `deploy/.env.prod` (git-ignored, never commit it):

- **Domains:** `APP_DOMAIN`, `API_DOMAIN`, `PLATFORM_DOMAIN`, `DEVICE_HOST` (a domain or the
  server's fixed IP), `ACME_EMAIL` (Let's Encrypt's expiry warnings).
- **Passwords** (Postgres superuser, the four roles, Redis): `openssl rand -hex 24` each. Letters
  and digits only, because they go into connection URLs as they are. Postgres takes the
  superuser's and the roles' passwords on its **first start only** (below).
- **Redis memory:** `REDIS_MAXMEMORY` (default `512mb`, about an eighth of a 4 GB server). Redis
  refuses writes beyond it rather than evicting anything, so watch it (Monitoring) and raise it
  before it fills.
- **Backups:** `BACKUP_HOST_DIR` (default `/srv/jantrik-backups`, outside the git checkout) and
  the deploy user's ids `BACKUP_UID` / `BACKUP_GID` (`id -u`, `id -g`; Backups below).
- **Secrets** (`JWT_ACCESS_SECRET`, `OTP_PEPPER`, `PLATFORM_TOTP_KEY`):
  `openssl rand -base64 48 | tr -d '\n'` each, all different.
- Keep a copy of the file in a password manager. Losing `PLATFORM_TOTP_KEY` means every platform
  admin enrols their authenticator again; losing the role passwords means resetting them as the
  superuser (First start below).

Nothing starts with the example values:

- `deploy/compose.sh` checks the settings file before running any command, so a bad value never
  reaches Postgres's first start. It refuses a line that is not plain `KEY=value` (no spaces
  around `=`; compose would read some of those differently), a `CHANGE_ME` or `example.com`
  value, a `*_PASSWORD` shorter than 24 characters, with characters other than letters, digits
  and `. _ ~ -`, with an example marker (the list below) or equal to another password, a secret
  with an example marker, and any of the file's keys also set in your shell (compose would take
  the shell's value);
- `create-roles.sh` checks the superuser's and the roles' passwords again (step 7);
- the API, the worker and the receiver refuse example secrets, an example or short Redis password
  and development settings (next section).

## 6. Environment checks

With `NODE_ENV=production` (set in the images) the API, the worker and the device receiver check
their settings at start-up and stop with a list of every problem. Tests and Playwright run with
`NODE_ENV=test`, development with `development`; none of this applies there. Code:
[`production-env.ts`](../apps/api/src/config/production-env.ts) and `env.ts`, `ingest-env.ts`
next to it; every rule has a test in `production-env.spec.ts`.

The API and the worker refuse:

| Setting                                                                                                                                                                                                      | Why                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SMS_PROVIDER` `console`, `memory`, `outbox`                                                                                                                                                                 | they print or keep every code, OTPs included. Use `none` until a real gateway is built                                                                                                                   |
| `COOKIE_SECURE` not `true`                                                                                                                                                                                   | the refresh cookie would travel over plain HTTP                                                                                                                                                          |
| `DEV_LAN=true`                                                                                                                                                                                               | development only (LAN CORS, cookie without Secure)                                                                                                                                                       |
| `JANTRIK_TEST_TODAY` set                                                                                                                                                                                     | tests only (a fixed "today")                                                                                                                                                                             |
| `TRUST_PROXY` (or `INGEST_TRUST_PROXY`) `true` or a `/0` range                                                                                                                                               | Express would believe any client's `X-Forwarded-For`: anyone could pose as any address, or a new one per request past every per-address limit. Use a hop count (`1` behind Caddy) or the proxy's address |
| `TRUST_PROXY` or `REDIS_URL` not set                                                                                                                                                                         | their defaults (no proxy; Redis on localhost) suit a laptop. Behind Caddy, `TRUST_PROXY=false` would rate-limit everyone as one address                                                                  |
| `INGEST_IN_PROCESS=true`                                                                                                                                                                                     | the receiver is its own process, without the API's logins (deployment requirement 4)                                                                                                                     |
| `CORS_ORIGINS` with `http://`, localhost, `127.0.0.1`, `[::1]`, `0.0.0.0`, `*.localhost` or `*`; or empty                                                                                                    | the API answers browsers with credentials only from the real https origins                                                                                                                               |
| a secret under 32 characters                                                                                                                                                                                 | too short to resist guessing                                                                                                                                                                             |
| a secret with an example marker (`change-me`, `CHANGE_ME`, `dev-only`, `test-only`, `ci-only`, `dev_password`, `ci_password`, `placeholder`, `example`; the same list as `compose.sh` and `create-roles.sh`) | copied from `.env.example`, `deploy/.env.prod.example`, CI or a test config, not generated                                                                                                               |
| two of `JWT_ACCESS_SECRET`, `OTP_PEPPER`, `PLATFORM_TOTP_KEY` equal                                                                                                                                          | one leak would open two doors                                                                                                                                                                            |
| `DATABASE_URL`, `DATABASE_PLATFORM_URL` or `DATABASE_INGEST_URL` logging in as `jantrik_owner` or `postgres`, or naming no login                                                                             | the owner and the superuser are not subject to the database's protections the app relies on                                                                                                              |
| a password in `REDIS_URL` under 24 characters or with an example marker                                                                                                                                      | the published example would open Redis (its queues and sessions) to anything on the network. A URL without a password is allowed (Redis on a private network)                                            |
| `DATABASE_MIGRATION_URL`, `POSTGRES_PASSWORD` or any `DB_*_PASSWORD` in its environment                                                                                                                      | the owner's and the superuser's credentials and the roles' raw passwords belong to Postgres and the migrate step only                                                                                    |
| `PLATFORM_TOTP_KEY` missing                                                                                                                                                                                  | the platform admins' 2FA secrets need their own key                                                                                                                                                      |
| `INGEST_PUBLIC_HOST` missing, localhost or `0.0.0.0`                                                                                                                                                         | the device setup guide would show an address no device can dial                                                                                                                                          |

The device receiver refuses:

| Setting                                                                                                                                             | Why                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| any of `DATABASE_URL`, `DATABASE_PLATFORM_URL`, `DATABASE_MIGRATION_URL`, `JWT_ACCESS_SECRET`, `OTP_PEPPER`, `PLATFORM_TOTP_KEY` in its environment | it is open to the internet without a login: code run in it must find no login that can choose an institute and no key that signs sessions |
| `INGEST_TRUST_PROXY` `true` or a `/0` range                                                                                                         | a client could claim a school's trusted address and receive its commands                                                                  |
| `DATABASE_INGEST_URL` as `jantrik_owner`, `postgres`, `jantrik_app` or `jantrik_platform_app`                                                       | its own login only                                                                                                                        |
| `REDIS_URL` not set, or with an example or short password                                                                                           | as for the API                                                                                                                            |
| `DATABASE_MIGRATION_URL`, `POSTGRES_PASSWORD` or any `DB_*_PASSWORD` in its environment                                                             | as for the API                                                                                                                            |

Beyond these, the API checks at start-up that its platform login can run the platform functions
and its main login cannot, and the receiver that its login cannot read a table
([devices.md](devices.md)). The database passwords are checked by `compose.sh` and the roles
script (next step).

## 7. First start

```bash
deploy/compose.sh build                 # about 5–10 minutes the first time
deploy/compose.sh up -d postgres redis  # first start: the roles and the database
deploy/compose.sh logs postgres | grep create-roles
deploy/compose.sh run --rm migrate      # the migrations, then the institute types and templates
deploy/compose.sh up -d                 # api, worker, receiver, web, caddy
deploy/compose.sh ps                    # every service "healthy" (worker: "running"; migrate exited 0)
```

`deploy/compose.sh up -d --build` alone does the same in the same order; the steps above show
where something failed.

**The database roles** ([`deploy/postgres/create-roles.sh`](../deploy/postgres/create-roles.sh))
must exist before the first migration: the migrations grant to them. The compose Postgres runs
the script on its first start (an empty volume) with the passwords from the settings file. It:

- creates `jantrik_owner` (owns the schema, runs migrations; not a superuser, so forced row-level
  security applies to it), `jantrik_app` (the API), `jantrik_platform_app` (the API's platform
  module), `jantrik_ingest_app` (the receiver), and the function owners `jantrik_auth`,
  `jantrik_search`, `jantrik_platform`, `jantrik_ingest` (no login; the owner may `SET ROLE` to
  them but never inherits them), exactly as `docker/postgres/init/01-roles.sh` does for
  development ([database.md](database.md) → Database roles);
- creates the production database only (`POSTGRES_DB_NAME`, default `jantrik`), owned by
  `jantrik_owner`, with the schema set up as in development, temporary tables taken away from the
  runtime logins and the time zone UTC
  ([`database-setup.sql`](../deploy/postgres/database-setup.sql));
- refuses passwords shorter than 24 characters, with characters a URL cannot carry, example
  values or two equal ones; and checks every role's attributes and memberships, new or found.

The Postgres health check is a query: the roles exist and the production database has been set
up (schema owner, no USAGE or TEMPORARY for PUBLIC, UTC), so the apps never start against a
half-made database.

**When the first start fails** (`deploy/compose.sh logs postgres` shows a `create-roles:` error,
and `postgres` stays "unhealthy"): Postgres has already made its data directory, with the
superuser password of that first start, so it will not run the roles script again by itself.
Fix the settings file, then **start Postgres over from an empty volume** (nothing is stored yet):

```bash
deploy/compose.sh rm -sf postgres
docker volume rm jantrik-prod_postgres-data
deploy/compose.sh up -d postgres
```

Only if you must keep that cluster: recreate the container with the fixed settings
(`deploy/compose.sh up -d postgres`), run the script by hand
(`deploy/compose.sh exec -u postgres postgres sh /jantrik/postgres/create-roles.sh`), and, if
`POSTGRES_PASSWORD` changed, set it in Postgres too (`\password postgres`, below). Otherwise the
health check still passes (it connects without a password from inside the container) while the
nightly backup, which logs in with the new password, fails.

**Changing a password later:** the settings file alone does not change a role or the superuser.
Change it in Postgres too, typed at psql's hidden prompt (not on a command line, where it would
land in the shell history and the process list), then restart the services:

```bash
deploy/compose.sh exec -u postgres postgres psql
#   \password jantrik_app        (or jantrik_platform_app, jantrik_ingest_app, jantrik_owner, postgres)
```

**Check it:**

```bash
curl https://api.<your-domain>/health      # {"status":"ok","db":"up",...}
```

Open `https://app.<your-domain>` (the login page) and `https://platform.<your-domain>` (the
platform login). Certificates appear within a minute of the first request; `deploy/compose.sh
logs caddy` shows why if not (usually DNS not pointing at the server yet, or port 80 closed).

## 8. The first platform admin

Platform admins are made with the CLI ([platform.md](platform.md) → Managing platform admins). In
production it runs in the `migrate` service, the only one with the owner role:

```bash
deploy/compose.sh run --rm migrate node dist/cli/main.js create \
  --phone 01712345678 --name "Rahim Uddin" --email rahim@example.com
# asks for the password (hidden, at least 12 characters)
deploy/compose.sh run --rm migrate node dist/cli/main.js list
```

Then, **within 24 hours** (the enrolment window), sign in at
`https://platform.<your-domain>/platform/login`, scan the QR code with an authenticator app and
store the 10 backup codes somewhere safe. `password`, `disable`, `enable` and `reset-2fa` work the
same way.

## 9. Attendance devices

- Devices dial `DEVICE_HOST` on port `INGEST_PUBLIC_PORT` (4080) over plain HTTP; the setup guide
  in the app shows both ([devices.md](devices.md) → Setting up a device).
- The receiver sees the devices' real addresses (no proxy), so every `X-Forwarded-For` it gets
  is a client's own words: the compose file fixes `INGEST_TRUST_PROXY=false`. A hop count there
  without a proxy would be as bad as `true` (anyone could claim a school's trusted address and
  receive its device commands). Only if you run a TLS proxy or load balancer in front of port 4080
  (for devices that support HTTPS) set its hop count or address, in
  `deploy/docker-compose.override.yml`; never `true`.
- IPv4 only (DNS above).
- Its health check asks for an unknown path and expects `404`: that proves it serves HTTP without
  touching the database or writing a log line.

## 10. HTTPS and the platform subdomain

[`deploy/Caddyfile`](../deploy/Caddyfile):

- **Certificates** from Let's Encrypt, renewed by Caddy; HSTS on every site.
- **`app.`** serves the web app; any `/platform` path there is redirected to `platform.`.
- **`platform.`** serves only the web app's `/platform` pages and its assets (`/_next/*`); `/`
  goes to `/platform`, everything else is 404 (deployment requirement 1).
- **`api.`** serves the API. A browser request to `/platform/*` whose `Origin` is not
  `https://platform.<your-domain>` gets 403 from Caddy. This is a stopgap: the requirement asks
  for the same `Origin` allowlist check inside `PlatformAuthGuard`, an auth change left to the
  owner. Until then, keep this rule if you replace Caddy with another proxy.
- Caddy replaces any `X-Forwarded-For` a client sends with the address it sees, so
  `TRUST_PROXY=1` gives the API each visitor's real address.

**Another proxy (nginx, a provider's load balancer):** route the three names the same way, add the
`Origin` rule, overwrite `X-Forwarded-For` (nginx: `proxy_set_header X-Forwarded-For
$remote_addr;`), set `TRUST_PROXY` to the number of proxies, and leave port 4080 out of it.

## 11. Upgrades

Migrations first, then the apps (deployment requirement 3: an old API still running after a
migration can fail on a changed function until it restarts).

```bash
cd /srv/jantrik
deploy/compose.sh run --rm backup                 # a backup first
git fetch && git checkout <new tag or commit>
deploy/compose.sh build                           # set IMAGE_TAG to the new version first, to keep the old images
deploy/compose.sh run --rm migrate                # migrations + templates
deploy/compose.sh up -d                           # restarts api, worker, receiver, web with the new images
deploy/compose.sh ps
```

- **Rollback:** migrations only go forward. If a release must be undone after its migrations ran,
  restore the backup you took (below) and start the previous version's images.
- `NEXT_PUBLIC_API_URL` is baked into the web image: changing `API_DOMAIN` needs a rebuild.

## 12. Backups

`deploy/compose.sh run --rm backup` runs [`deploy/backup/backup.sh`](../deploy/backup/backup.sh):
a `pg_dump` (custom format) of the database to `BACKUP_HOST_DIR` (default
`/srv/jantrik-backups`) as `jantrik-<UTC time>.dump`, checked and with a `.sha256` file; then it
deletes backups older than `BACKUP_KEEP_DAYS` (default 14) and writes `LAST_SUCCESS`. The files
are private (mode 600) and belong to `BACKUP_UID:BACKUP_GID`, the deploy user, so its own cron
jobs can copy them away.

Create the folder once, outside the git checkout (a `git clean` there would delete it), owned by
the deploy user, and put that user's ids in the settings file:

```bash
sudo mkdir -p /srv/jantrik-backups && sudo chown "$(id -u):$(id -g)" /srv/jantrik-backups
chmod 700 /srv/jantrik-backups
id -u; id -g          # BACKUP_UID and BACKUP_GID in deploy/.env.prod
```

Every night, from the deploy user's crontab (`crontab -e`):

```cron
15 2 * * * cd /srv/jantrik && deploy/compose.sh run --rm -T backup >> /var/log/jantrik-backup.log 2>&1
```

(Create the log file once: `sudo touch /var/log/jantrik-backup.log && sudo chown $USER
/var/log/jantrik-backup.log`.)

- **The superuser takes the backup.** `jantrik_owner` cannot: forced row-level security applies
  to it, and `pg_dump` stops rather than dump part of a table. Never use `--enable-row-security`
  (it would silently leave rows out).
- **Copy backups off the server.** A disk failure takes the backups with it. `BACKUP_UPLOAD_CMD`
  is a placeholder hook: run on a machine with your storage tool, `backup.sh` runs it with the
  file as `$1`, e.g. `rclone copy "$1" offsite:jantrik-backups/`. The `backup` container has no
  such tool, so on this setup copy from the host after the cron job instead (e.g. a second cron
  line `rclone copy /srv/jantrik-backups offsite:jantrik-backups`, as the same user). Pick the
  storage (the owner's decision).
- **Not in a backup:** the roles (they belong to the cluster: `create-roles.sh` makes them first
  on a new server), the settings file (keep it in the password manager), and Redis. Redis keeps
  the revoked-session markers, the roles-cache versions, rate-limit counters, OTP codes, platform
  login challenges, held SMS and the job queues; its AOF file on the `redis-data` volume survives
  restarts. **Losing Redis** (a deleted volume, a new server) lets a revoked access token work
  again until it expires (up to 15 minutes) and drops queued jobs, held SMS and pending codes;
  the roles cache simply starts empty. **Bringing back an older copy** of Redis's data (e.g. an
  old volume) is worse: its older roles-cache versions can serve someone's old roles until the
  entry is rebuilt. Do not restore Redis from a copy; start it empty. After a move to a new
  server, ask admins to sign out everywhere if a recent revocation mattered.

## 13. Restore

[`deploy/backup/restore.sh`](../deploy/backup/restore.sh) restores into a named database only, as
the superuser, and refuses: missing roles, a database that is not empty (unless
`--drop-existing=<name>` repeats its name and nothing is connected to it), `postgres` and the
templates, a file that fails its checksum, a file it cannot read. It warns when the file has no
`.sha256` next to it.

**On a new server** (the old one is gone): steps 1–5 with the same settings file, then

```bash
deploy/compose.sh up -d postgres redis            # the roles and an empty database
# copy the backup file and its .sha256 into BACKUP_HOST_DIR *as the deploy user* (the backup
# service runs as BACKUP_UID and cannot read a root-owned private copy), then:
deploy/compose.sh run --rm --entrypoint sh backup /jantrik/backup/restore.sh /backups/<file>.dump jantrik
deploy/compose.sh run --rm migrate                # brings the restored database up to this version
deploy/compose.sh up -d
```

**On the same server, replacing the live database:**

```bash
deploy/compose.sh stop api worker receiver
deploy/compose.sh run --rm --entrypoint sh backup /jantrik/backup/restore.sh \
  --drop-existing=jantrik /backups/<file>.dump jantrik
deploy/compose.sh run --rm migrate
deploy/compose.sh up -d
```

To look at old data without touching the live database, restore into a new name
(`... restore.sh /backups/<file>.dump jantrik_old`), then drop it when done.

Ownership survives a restore: tables stay owned by `jantrik_owner`, the definer functions by
`jantrik_auth`, `jantrik_search`, `jantrik_platform` and `jantrik_ingest`, and forced row-level
security, policies and grants come back as they were (the restore drill checks all of it).

## 14. Restore drill

Once a month, and after any change to the backup set-up:

```bash
deploy/compose.sh run --rm -T --entrypoint sh backup /jantrik/backup/restore-check.sh jantrik
```

[`restore-check.sh`](../deploy/backup/restore-check.sh) takes a fresh backup, restores it into a
scratch database it names itself (never `jantrik`, `jantrik_test` or `jantrik_e2e`), and compares
it with the live database: migrations, row counts per table, owners and grants of every table and
function, policies, constraints, triggers, extensions; forced row-level security on every table
with a `tenant_id`; and that `jantrik_app` and `jantrik_owner` see no student without a tenant
context. It drops the scratch database at the end, also on failure. It needs free disk space for
one more copy of the database. CI runs the same check on every pull request (job "Production
roles, backup and restore", on a fresh cluster set up by `create-roles.sh` with fresh random
passwords and demo data).

## 15. Monitoring

- **Health:** `https://api.<your-domain>/health` (200 with `"db":"up"`, 503 when the database is
  down) and `https://app.<your-domain>/login` (200). Point an external uptime checker at both,
  and a TCP check at `device.<your-domain>:4080`. `deploy/compose.sh ps` shows Docker's own health
  checks; Docker restarts a service that exits.
- **The worker** has no HTTP: watch `deploy/compose.sh logs --tail 100 worker` for errors, and
  queue growth in Redis (`deploy/compose.sh exec redis redis-cli --scan --pattern 'jantrik:*:wait'`
  then `LLEN` of each).
- **Logs:** `deploy/compose.sh logs -f api` (or `worker`, `receiver`, `caddy`). Each service keeps
  at most 5 × 10 MB.
- **Disk:** `df -h /` and `docker system df`; old images pile up after upgrades
  (`docker image prune` removes unused ones). Database size:
  `deploy/compose.sh exec postgres psql -U postgres -c "SELECT pg_size_pretty(pg_database_size('jantrik'))"`.
- **Redis memory:** `deploy/compose.sh exec redis redis-cli info memory` (`used_memory_human`
  against `maxmemory_human`). It never evicts a key: at `REDIS_MAXMEMORY` writes fail with an
  OOM error (logins, jobs and rate limits stop working) instead of silently losing sessions or
  jobs. Raise it, and the server's memory, before it gets close.
- **Backups:** alert when `LAST_SUCCESS` in the backup folder is older than a day, e.g. in cron:
  `0 9 * * * find /srv/jantrik-backups/LAST_SUCCESS -mmin -1500 | grep -q . || <send an alert>`.
- **Certificates:** Caddy renews them; `deploy/compose.sh logs caddy | grep -i error` if a site
  shows a certificate warning.

## A managed Postgres

To use a provider's Postgres 16 instead of the `postgres` service:

1. Run the roles script against it from any machine with `psql` 15 or newer, as the provider's
   admin user (it needs CREATEROLE and CREATEDB; it gives itself SET-only membership of the owner
   role to create the database):

   Put the passwords in a private file rather than on the command line (where they would land in
   the shell history and the process list):

   ```bash
   install -m 600 /dev/null roles.env
   nano roles.env      # PGHOST=..., PGPORT=5432, PGUSER=<admin>, PGPASSWORD=..., PGSSLMODE=require,
                       # DB_OWNER_PASSWORD=..., DB_APP_PASSWORD=..., DB_PLATFORM_PASSWORD=..., DB_INGEST_PASSWORD=...
   (set -a && . ./roles.env && sh deploy/postgres/create-roles.sh)
   shred -u roles.env
   ```

2. Create `deploy/docker-compose.override.yml` on the server (git-ignored; `deploy/compose.sh`
   adds it). In it, give `migrate`, `api`, `worker` and `receiver` their `DATABASE_*_URL` with
   the provider's host and `?sslmode=require`, and replace each one's `depends_on` with a list
   without `postgres` (compose's `!override` tag). Then start the services by name, leaving out
   `postgres` and `backup`.
3. Backups: the provider's own (point-in-time recovery) are the main ones. `backup.sh` needs a
   login that bypasses row-level security; managed admins often cannot, so check before relying
   on it.

## Checklist

- [ ] DNS for `app.`, `platform.`, `api.`, `device.` points at the server (A records only).
- [ ] Firewall: only 22, 80, 443 (TCP and UDP) and 4080 open; Postgres and Redis not published.
- [ ] `deploy/.env.prod` filled with generated values, `chmod 600`, a copy in the password manager.
- [ ] `deploy/compose.sh ps`: everything healthy; `migrate` exited 0.
- [ ] `https://api.<domain>/health` is ok; the app and the platform log-in pages load over HTTPS.
- [ ] `https://app.<domain>/platform` redirects to `platform.`.
- [ ] The first platform admin enrolled their authenticator and stored the backup codes.
- [ ] A device (or `pnpm device:sim` from a laptop: [devices.md](devices.md)) reaches
      `device.<domain>:4080`.
- [ ] `/srv/jantrik-backups` exists, owned by the deploy user; the backup cron job ran; a backup
      is copied off the server; the restore drill passed.
- [ ] An uptime check watches the API, the app and port 4080; someone gets its alerts.

## What needs the owner

- **A provider and a server** (size above), the domain and its DNS.
- **Real secrets and passwords** (generated on the server, never in the repo).
- **An SMS gateway (a go-live blocker).** Until one is built, `SMS_PROVIDER=none` and every SMS
  fails. **No institute user can sign in**: guardians sign in with an OTP, and staff too, as no
  production path sets a staff member's password (invitations and first logins go through an OTP;
  only the demo seed and the tests set passwords). Only platform admins can sign in. A gateway, or
  a deliberate password-setting path, must exist before the first institute goes live.
- **The `Origin` check in `PlatformAuthGuard`** (deployment requirement 1): an auth code change.
  The Caddy rule above is the stopgap.
- **Off-site backup storage** and **an uptime monitor** of your choice.
- **Recorded, not built** (decisions-pending.md → Deployment readiness):
  - a Redis user for the receiver limited to its own keys (today it has full Redis rights, so code
    run in it could queue jobs the worker trusts);
  - a start-up check that fails when the app's database login is a superuser or BYPASSRLS (today
    the env checks refuse the known admin logins by name);
  - CI does not cover the compose Postgres's first start (initdb), the non-superuser branch of
    `create-roles.sh` or the image builds (all checked by hand for this release);
  - IPv6 end to end (an IPv6 compose network, then AAAA records for `app.`, `platform.`, `api.`).
- **Later:** images built by CI and pushed to a registry (instead of building on the server), and
  a smaller `migrate` image (the Prisma CLI is a devDependency, so it carries the dev tools).

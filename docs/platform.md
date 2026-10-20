# Platform area (Jantrik's own admins)

The platform area (`/platform` on the web, `/platform/*` on the API) is for Jantrik's own staff:
they onboard institutes, manage plans and invoices, and watch usage. Platform admins are **not**
institute users. They have their own table, login, session, guard and audit log, and the platform
API returns nothing about an institute's students, guardians or attendance beyond counts (see
"Database" below for what enforces that, and what is enforced only by code).

## Identity and login

- **`platform_admins`:** name, phone (E.164), optional email, argon2id password hash, the TOTP
  secret (AES-256-GCM encrypted), `is_active`, `last_login_at`. Never a `users` row.
- **Two factors, every time.**
  1. `POST /platform/auth/login {identifier, password}`.
     - The identifier is a phone (any BD format) or an email.
     - A wrong password, an unknown account and a disabled admin all get the same 401.
     - Rate-limited per IP and per account.
     - Returns a 5-minute challenge. On the first login it also returns a new TOTP secret and its
       `otpauth://` URI; the web shows a QR code and the key for typing in by hand.
  2. `POST /platform/auth/verify {challengeId, code}`: a 6-digit code from an authenticator app
     (RFC 6238: SHA-1, 30-second steps, ±1 step), or a backup code.
     - On the first login, the first valid code saves the secret and creates **10 one-time backup
       codes**. They are shown once and stored only as HMAC-SHA256 hashes.
     - **Each time step and each backup code is accepted once**
       (`platform_admins.totp_last_step`, `platform_admin_backup_codes.used_at`), checked
       atomically in `platform_complete_login`.
     - **Limits:** at most 5 tries per challenge (then sign in again), 10 per admin per
       15 minutes and 30 per day. Each failed code, and each wrong password on a real account,
       is audited (`LOGIN_FAILED` with the reason).
     - **Only the current step:** `platform_complete_login` itself refuses a step that is not
       now (±1), so nobody can claim an arbitrary step or lock an admin out with a huge one.
     - **Bound to the login's credentials:** if the password or the authenticator changes while
       a login is between its two steps (`password`, `reset-2fa`), that login is void.
  - **Enrolment window:** the authenticator can be set up only until `totp_enrol_by`. `create`
    and `reset-2fa` open the window for 24 hours; the development seed for 30 days. After that,
    a password alone gets nothing (403 `ENROLMENT_CLOSED`), so a leaked password cannot enrol a
    stranger's phone later. Hand the initial password over in person or by phone and sign in
    soon.
  - There is **no SMS** for platform login.
- **Keys:**
  - `PLATFORM_TOTP_KEY` (at least 32 characters) encrypts the TOTP secrets and keys the
    backup-code HMAC. It is required in production. In development and tests a key derived from
    `OTP_PEPPER` is used when it is unset.
  - Changing the key invalidates every enrolment; each admin then needs `reset-2fa`.

## Session

- **Token and cookie:**
  - An opaque 32-byte token. Only its SHA-256 is stored (`platform_sessions`).
  - It travels in the cookie `jantrik_ps`: httpOnly, Secure, SameSite=Strict, `Path=/platform`.
  - The browser never holds a token.
- **Every request sends `X-Jantrik-Client: platform`** (otherwise 403). With SameSite=Strict this
  is the CSRF defence, the same as for the institute refresh cookie.
- **Short:** 30 minutes idle, 8 hours at most.
  - Every request checks the session in the database and renews the idle time, never past the
    8-hour end.
  - Logging out, `disable`, `password` and `reset-2fa` end sessions at once.
- **Separate in both directions:**
  - Institute bearer tokens are ignored on `/platform/*` (401).
  - The platform cookie is ignored on institute routes (401).
  - `@PlatformRoute()` makes the institute guards skip a route. `PlatformAuthGuard` checks the
    header and the session. `PlatformContextInterceptor` runs the handler in one transaction with
    `app.platform_session` (the token hash) set.

## Database access

- **Grants, not RLS.** The platform tables (`platform_admins`, `platform_admin_backup_codes`,
  `platform_sessions`, `platform_audit_logs`) hold nothing that belongs to an institute, so they
  have no RLS; grants protect them.
  - `jantrik_app` has **no** grants on them.
  - The owner role (migrations, the CLI) owns them.
- **The API reaches them only through `SECURITY DEFINER` functions** owned by the role
  `jantrik_platform` (NOLOGIN, NOBYPASSRLS; `jantrik_owner` may `SET ROLE` to it but does not
  inherit it).
- **Only the platform module may run those functions.** It connects with its own login role,
  `jantrik_platform_app` (`DATABASE_PLATFORM_URL`, `PlatformPrismaService`); `jantrik_app`, which
  the rest of the API uses, has no EXECUTE on any `platform_*` function. An SQL injection anywhere
  in the institute API therefore cannot reach platform logins, sessions or the audit log.
  - `jantrik_platform_app` is an ordinary runtime role (LOGIN, NOSUPERUSER, NOBYPASSRLS, owns
    nothing, no grants on the platform tables).
  - **It is also a member of `jantrik_app`**, so it has every right `jantrik_app` has, under the
    same RLS. With `app.tenant_id` set, it could read that institute's rows, as `jantrik_app` can.
    The database does not stop that; the code does: platform code opens no institute context
    and reads institute data only through the `platform_*` functions.
    `platform-isolation.spec.ts` fails if a file in `src/platform` opens a tenant or user
    context, or if a file outside it uses the platform login or calls a platform function.
  - At startup the API refuses to run when the two URLs are mixed up (the platform login must be
    able to run `platform_me()`, the main login must not).
  - Tested: `jantrik_app` gets "permission denied" on every platform function; the platform role
    owns nothing and cannot read the platform tables. `schema-safety.test.ts` checks, by owner,
    that only `jantrik_platform_app` may run any function owned by `jantrik_platform`.
  - **Before a session exists (login):**
    - `platform_find_admin_for_login(phone, email)`
    - `platform_complete_login(...)`: consumes the code, enrols, opens the session, audits
    - `platform_audit_login_failure(admin, reason, ip)`
    - `platform_session_admin(token_hash, idle_seconds)`: the guard's lookup and touch
  - Every function pins `search_path = pg_catalog, public, pg_temp` and names its tables with
    `public.`: `pg_temp` searched last means a temporary table cannot stand in for a platform
    table (tested). The older definer functions (login, memberships, refresh token, find-or-create
    user, student search) were moved to the same `search_path`, and `schema-safety.test.ts` fails
    if any `SECURITY DEFINER` function lacks it.
  - **Everything else** needs `app_current_platform_admin_id()`. It resolves `app.platform_session`
    to a live, unrevoked session of an active admin, and raises otherwise. So even a wrong context
    gets nothing without a real session token. The functions are:
    - `platform_me()`
    - `platform_end_session()`
    - `platform_audit(...)`
    - `platform_list_audit(before, before_id, limit)`: newest first, keyset paging
- **What `jantrik_platform` may read:**
  - Institute names (for the audit log). More metadata comes in part 2.
  - **Never** student, guardian or attendance rows.
- **`schema-safety.test.ts`:**
  - It checks that every `platform_*` function is owned by `jantrik_platform`, and that all but
    the four login functions call `app_current_platform_admin_id()`.
  - These are the only definer functions allowed to take an id parameter.

## What remains trusted

- The login functions run before a session exists, and the platform module checks the password
  and the authenticator code itself. So SQL access as `jantrik_platform_app` (a bug in the
  platform module, not the institute API) could open a platform session. The database still
  limits it to the current time step, an active admin, the credentials of the login, and an audit
  entry.
- The platform UI shares an origin with the institute app for now; its own subdomain is a
  deployment requirement (`docs/decisions-pending.md`, deployment section).

## Audit log

`platform_audit_logs` is append-only, also for `jantrik_platform`.

| Action                                                                                     | Written by                                         |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `LOGIN` (with the method: ENROL, TOTP, BACKUP), `LOGIN_FAILED` (with the reason), `LOGOUT` | the login functions                                |
| `ADMIN_CREATE`, `ADMIN_PASSWORD`, `ADMIN_DISABLE`, `ADMIN_ENABLE`, `ADMIN_RESET_2FA`       | the CLI (`actor = CLI`, with the OS user and host) |

Platform actions on institutes (part 2 onwards) are written in the same transaction as the action.
The web shows the log at `/platform/audit`.

## Managing platform admins: `pnpm platform:admin`

Platform admins are created from the server shell. There is no admin screen yet. The command:

- works in production (unlike the seed);
- connects with the owner role (`DATABASE_MIGRATION_URL`);
- needs explicit flags;
- never accepts a password as an argument and never prints a password or a 2FA secret;
- records every change in `platform_audit_logs`.

```bash
# The db package must be built (it is, after `pnpm build`).
pnpm platform:admin create --phone 01712345678 --name "Rahim Uddin" --email rahim@example.com
#   asks for the password (hidden), at least 12 characters; or pipe it:
printf '%s' "$PASSWORD" | pnpm platform:admin create --phone 01712345678 --name "Rahim Uddin" --password-stdin

pnpm platform:admin password  --phone 01712345678                       # new password, ends sessions
pnpm platform:admin disable   --phone 01712345678 --reason "left the team"  # ends sessions
pnpm platform:admin enable    --phone 01712345678 --reason "back from leave"
pnpm platform:admin reset-2fa --phone 01712345678 --reason "lost phone"     # re-enrol at next login
pnpm platform:admin list                                                # masked phones, 2FA state
```

- Without pnpm, run `node packages/db/dist/cli/main.js <command> …` with
  `DATABASE_MIGRATION_URL` set.
- A new admin signs in at `/platform/login` with the password. The first sign-in sets up the
  authenticator app (QR code) and shows the 10 backup codes once.
- **`reset-2fa` is the only way to replace a lost authenticator.** It removes the secret and the
  backup codes and ends all sessions.

## Development

- `pnpm db:seed` creates the development platform admin (see
  [demo-accounts.md](demo-accounts.md)) without an authenticator. The first sign-in enrols it.
- The seed refuses `NODE_ENV=production`.

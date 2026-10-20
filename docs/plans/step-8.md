# Step 8: platform super admin panel and institute onboarding

Branch `feature/step-8-platform` (from main at `fbf478b`, step 7 merged). One commit per phase
after all gates pass (lint, typecheck, format, unit/API/DB tests, build, Playwright), a review
subagent before each commit, push, CI watched to green. New tenant tables follow the
add-tenant-table skill.

## What exists today

- **Institute sessions are bound to `users`:**
  - `sessions` and `refresh_tokens` have FKs to `users` and RLS on `app.user_id`.
  - `OtpService` looks up `users`, and its Redis keys are per phone.
  - `JwtAuthGuard` accepts any token signed with `JWT_ACCESS_SECRET` that has the right issuer, audience and `typ`.
- **No role can list all institutes:** `tenants` RLS is `id = app_current_tenant_id()`. `schema-safety.test.ts` allows exactly 6 SECURITY DEFINER functions and forbids tenant or uuid parameters.
- **The audit log can't record platform actions:** `audit_logs` needs a tenant and a `users` actor. `AuditService` needs a selected tenant.
- **No owner is ever created by product code** (seed only). `StaffService.add` can invite an OWNER only when the caller is already an OWNER in that institute.
- **No platform-side data yet:** no plan, trial end, student limit, invoices, or cost data. `platform_sms_logs` logs OTP SMS but the app can only INSERT it, and it has no cost column.
- **Suspension already cuts access on the next request:** the interceptor checks the tenant status on every tenant-scoped request.
- **Anyone in a tenant context can change their own status:** nothing in institute code updates `tenants`, but the app role could set its own institute's status or modules.
- **Dashboard checklist:** computed in the browser from 4 queries; there is no endpoint.

## Design

### Platform identity: its own principal, never a `users` row

**Global tables.** No `tenant_id`, no grants to `jantrik_app`; reached only through definer functions owned by a new role `jantrik_platform`.

| Table                         | Columns                                                                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform_admins`             | id, name, phone (BD, unique), email (unique, optional), password_hash, is_active, created_at, last_login_at                                                                |
| `platform_sessions`           | id, admin_id, token_hash (unique), ip, user_agent, created_at, last_used_at, expires_at, revoked_at, revoke_reason                                                         |
| `platform_admin_backup_codes` | id, admin_id, code_hash, used_at, created_at                                                                                                                               |
| `platform_audit_logs`         | id, admin_id (null for CLI), actor (`admin` or `cli`), action, target_tenant_id (so it is not treated as a tenant table), entity, entity_id, details jsonb, ip, created_at |
| `platform_settings`           | one row: `sms_cost_per_segment_paisa` (default 30), updated_at, updated_by; edited in a platform settings screen, audited (part 4)                                         |

There is no UPDATE or DELETE path on the audit log.

**Role `jantrik_platform`.** NOLOGIN NOBYPASSRLS, `GRANT … TO jantrik_owner WITH INHERIT FALSE, SET TRUE`, the same pattern as `jantrik_search`.

- It gets SELECT policies `TO jantrik_platform` only on what platform reads need:
  - tenants, tenant_modules, institute_types
  - memberships, staff_profiles (owner name and phone)
  - students, sms_logs, student_imports, audit_logs, attendance_sessions (aggregates only)
  - the billing tables
- It gets UPDATE/INSERT where platform writes need them.
- `docker/postgres/init/01-roles.sh` and the upgrade snippet in `docs/database.md` get the role.

**Login is two-factor: password, then TOTP** (authenticator app, RFC 6238; approved change A). No SMS for platform login.

1. `POST /platform/auth/login {identifier, password}`:
   - Rate-limited per IP and per identifier; argon2 check with dummy-hash timing. A wrong password returns the same 401 as an unknown account.
   - Creates a 5-minute challenge in Redis (`platform:challenge:<id>`, at most 5 code attempts).
   - **First login (not enrolled):** the response also carries a new TOTP secret and its `otpauth://` URI. The web shows a QR code and the key for manual entry.
2. `POST /platform/auth/verify {challengeId, code}` checks a 6-digit TOTP code (30 s steps, ±1 step), or one of the backup codes, and opens a session.
   - **Enrolment:** the first valid code saves the secret, encrypted with AES-256-GCM under `PLATFORM_TOTP_KEY`. It creates **10 one-time backup codes**, stored as HMAC hashes and shown once.
   - **Replay:** a used time step can't be used again (`totp_last_step`). A backup code works once.
   - **Rate limits:** per challenge, per admin (15 min) and per IP. Failed attempts are audited.
   - **Reset 2FA:** only through the CLI (below). It is audited and ends the admin's sessions.
3. **CLI** `pnpm platform:admin` (approved change B), run from the server shell. It works in production, unlike the seed.
   - Commands, each with required flags: `create`, `password`, `disable`, `enable`, `reset-2fa` (the last three need `--reason`), and `list`.
   - Passwords come from stdin or a hidden prompt, never from argv. Nothing secret is printed.
   - Every command writes `platform_audit_logs` (actor `cli`, with the OS user).
   - It connects with the owner role (`DATABASE_MIGRATION_URL`). Documented in `docs/platform.md`.

**Session.**

- An opaque 32-byte token in an httpOnly, Secure, SameSite=Strict cookie `jantrik_ps` on path `/platform`. Only the hash is stored.
- Every platform request must send `X-Jantrik-Client: platform`. That forces a preflight, and it is the same CSRF approach as the institute refresh cookie.
- **Short sessions:** 30 minutes idle and 8 hours at most, checked in the database on every request. Logout and deactivating an admin end it at once.
- There are no JWTs and no refresh tokens. The browser never sees a token.

**Pipeline.**

- A `@Platform()` decorator makes the institute `JwtAuthGuard` and `TenantHeaderGuard` skip the route.
- A global `PlatformAuthGuard`, placed before the rate-limit guard, validates the cookie session and rate-limits per admin.
- A `PlatformContextInterceptor` runs the handler in a transaction with `app.platform_session` (the token hash) set.
- **Isolation in both directions:**
  - An institute bearer token on `/platform/*` gets 401.
  - The platform cookie is ignored on institute routes, which need a bearer token.
  - Platform definer functions refuse to run unless `app_current_platform_admin_id()` resolves a live, unrevoked session of an active admin. So even a bug that sets the context wrongly gets nothing without a real session token.

**Audit.**

- Every platform write function inserts its `platform_audit_logs` row inside the same function, so a write without an audit row is impossible.
- Login and logout events are audited too.
- Actions on an institute also leave an entry in that institute's own `audit_logs`, with no actor and `via: 'platform'`.

### Platform admins never read tenant data

- **Reads go only through definer functions** that return institute metadata and numbers:
  - name, slug, type, status, plan, trial end, created
  - owner name and phone (from `staff_profiles`)
  - modules and limits
  - counts: active students, SMS sent and segments this month, imports, last activity
  - billing
- No function returns students, guardians or attendance rows.
- **Writes:**
  - Billing tables, limits, status and modules change only through definer functions, which also audit.
  - Provisioning reuses `provisionTenant`. It runs, with the owner invitation and the institute's own audit entry, in one transaction of the API's main role (`jantrik_app`, in the new institute's context), through a small service in `src/tenancy/`. The platform login cannot do it: it reaches nothing but the `platform_*` functions (decision 9).
  - After that transaction commits, the platform request's own transaction records the plan and limits and the platform audit entry, through a definer function. If that step fails, the institute exists without a plan (shown as such, and the plan can be set later) and without a platform audit entry; its institute-side audit entry, written in the first transaction, names the platform admin who created it.
- **Hardening:**
  - Revoke `jantrik_app`'s UPDATE on `tenants` and its UPDATE/DELETE on `tenant_modules`. Provisioning still INSERTs.
  - Result: an institute can't un-suspend itself or switch modules on, even through a bug.
  - Tests that suspend through the app role move to the platform path or a test helper that uses `jantrik_platform`.
- **`schema-safety.test.ts`** gets an explicit allowlist of `platform_*` functions. Each must call `app_current_platform_admin_id()`, except 3 pre-session lookups: find admin for login, open session, find session by token hash. Tenant-id parameters are allowed only for these platform functions; this is the documented exception.

### Institutes (part 2)

**List.**

- Search by name or slug. Filter by type, status, plan, and "trial ended / overdue".
- Columns: name, type, status, plan, created, owner (name and phone), active students, SMS used this month. Paged.

**Create** (`POST /platform/institutes`).

- Fields: name, slug, institute type, owner name and phone, modules, plan (pricing), trial end date. Optionally the first academic year, which defaults to the current calendar year.
- Steps:
  1. `provisionTenant` with status TRIAL.
  2. The owner gets an **OWNER invitation** through the staff flow: find-or-create the person, an INVITED OWNER membership, a staff profile with the typed name, 14 days.
  3. After their next login they see "<institute> added you as Owner: accept / decline".
  4. A subscription row and an onboarding row are created.
- The response is the same whether or not the owner's phone already exists. Slug clash returns 409.
- The platform can re-send an expired owner invitation and cancel a pending one.

**Suspend / reactivate.**

- Status SUSPENDED. Access ends on the very next request (the interceptor already checks). Data is kept.
- Reactivating sets ACTIVE (or back to TRIAL if still in trial).
- A reason is required and audited.

**Modules.** Turn ATTENDANCE, FEES and EXAMS on or off (CORE always on). The institute's modules cache is invalidated after commit.

**Limits** (platform-only, in `tenant_subscriptions`).

- **Student limit:** admissions and imports refuse with 422 `STUDENT_LIMIT` once active students reach it. This is checked under a per-institute lock so two admissions can't both pass. Import rows get `STUDENT_LIMIT` in the report.
- **SMS daily cap override:** a ceiling. The effective cap is the lower of the institute's own cap (or its automatic 2 × students) and the platform ceiling. The attendance settings page says "limited to N by the platform".

### Subscriptions and billing (part 3)

**Tenant tables** (add-tenant-table skill).

- The institute can SELECT its own rows. Only `jantrik_platform` functions write.

| Table                    | Contents                                                                                                                                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant_subscriptions`   | 1 per institute: plan_name, pricing `PER_STUDENT` (paisa per active student per month per module: CORE/ATTENDANCE/FEES/EXAMS) or `FLAT` (paisa per month), cycle MONTHLY/YEARLY, yearly_discount_percent (default 0), trial_ends_on, due_days (default 10), student_limit, sms_daily_cap |
| `platform_invoices`      | tenant_id, period_start, period_end, issued_on, due_on, status ISSUED/PAID/VOID, total_paisa, paid_paisa; unique (tenant_id, period_start)                                                                                                                                               |
| `platform_invoice_lines` | invoice_id, module or FLAT, active_students, unit_paisa, months, amount_paisa                                                                                                                                                                                                            |
| `platform_payments`      | invoice_id, amount_paisa, method CASH/BKASH/BANK, reference, paid_on, recorded_by (platform admin)                                                                                                                                                                                       |

**Generate invoices for a month** (platform action).

- Idempotent per institute and period.
- Uses the active-student count at generation time (stored on the line).
- Skips institutes still in trial for that month, and suspended or archived ones.
- **Amounts:**
  - PER_STUDENT: active students × the sum of enabled modules' prices.
  - FLAT: the flat price.
  - YEARLY: 12 × the monthly amount minus the plan's yearly discount %, issued in the month the year starts.
- All amounts are integer paisa.

**Payments.**

- Record amount, method, reference and date. The invoice becomes PAID when payments reach the total; partial payments are fine.
- An invoice can be voided with a reason.

**Overdue** = ISSUED and past `due_on` (computed, not stored).

- Platform list and detail show warnings.
- The institute **owner** sees a gentle banner on the dashboard ("Invoice of ৳… was due on …; please contact Jantrik"), from `GET /me/billing-notice`.
- No automatic suspension.

### Usage and cost (part 4)

- **Per institute:** active students, SMS sent and segments this month and their cost, imports (this month / total), last activity (latest of audit log, attendance save, SMS, import).
- **Platform totals:** OTP SMS (count, segments, cost) from `platform_sms_logs`, plus institute SMS totals.
- **Cost rate:** `platform_settings.sms_cost_per_segment_paisa`, ৳0.30 as a placeholder, edited in a platform settings screen (audited).
  - The rate is copied onto each SMS log row when it is sent, so changing the rate later does not change past costs.
  - This adds a `cost_paisa` column to `sms_logs` and `platform_sms_logs`.

### New owner onboarding (part 5)

- **Tenant table `onboarding_progress`:**
  - Columns: tenant_id unique, steps jsonb `{year, classes, shifts, teachers, students, attendance: 'done'|'skipped'}`, completed_at.
  - Created at provisioning. Demo institutes have none, so their dashboards are unchanged.
- **Wizard at `/setup/welcome`:**
  - The owner lands there after accepting while it is unfinished.
  - Steps:
    1. Confirm the academic year (edit dates).
    2. Review classes from the template and add sections.
    3. Add shifts if needed.
    4. Invite teachers.
    5. Import students (the import page opens and returns to the wizard).
    6. Attendance settings (mode, absent SMS on or off).
  - Each step can be skipped; progress is saved per step.
  - The existing dialogs (year, section, shift, add staff) are reused by extracting them into shared components.
- **Dashboard:** the "Getting started" checklist moves into a shared hook. While the wizard is unfinished it shows "Continue setup" and opens the next step.

### Web

- **Route group `(platform)`** with its own layout, auth provider and shell:
  - Sidebar: Institutes, Billing, Usage, Audit log.
  - Bangla and English, same design system.
  - Mobile first: lists are cards on phones and tables on desktop.
  - The institute `AuthProvider` does not start on `/platform/*`.
- **Pages:**
  - `/platform/login` (password, then the code)
  - `/platform` (institutes)
  - `/platform/institutes/new`
  - `/platform/institutes/[id]` (details, usage, modules, limits, status, plan, invoices, owner invitation)
  - `/platform/billing` (generate for a month, all invoices, overdue, record payment)
  - `/platform/usage`
  - `/platform/audit`

### Seed and docs

- A dev platform admin (phone `01700000001`, password `Jantrik@2026`) is created by the seed as the owner role, without TOTP: the first login enrols it. The seed refuses `NODE_ENV=production`, as it already does; production uses the CLI.
- New `docs/demo-accounts.md` lists every demo account: institute staff, guardians, platform admin.
- `docs/auth.md` gets a platform section; `docs/database.md` gets the role, tables and functions. Plus a new `docs/platform.md`.

## Phases (one commit each)

1. **Platform foundation:** role, platform tables, session and audit functions, auth API (password + TOTP, backup codes), guard and interceptor, CLI, web login (QR enrolment) and shell, seed, demo-accounts doc.
2. **Institutes:** list and detail functions, create with owner invitation, suspend and reactivate, modules, student limit and SMS ceiling (enforced), tenant/module write hardening.
3. **Subscriptions and billing:** tables, plan editing, monthly invoices, payments, overdue warnings, owner banner.
4. **Usage and cost:** cost columns, the settings screen for the SMS rate, per-institute usage, platform OTP cost, usage page.
5. **Onboarding wizard:** progress table, API, extracted dialogs, wizard UI, dashboard integration.

## Tests

- **Guard isolation:**
  - Institute token on `/platform/*` gets 401; platform cookie on institute routes gets 401.
  - Missing `X-Jantrik-Client: platform` header refused.
  - Platform functions without a session raise (DB test).
  - The app role can't read or write `platform_*` tables (DB test).
- **2FA:**
  - Password alone gives no session.
  - Wrong, expired, reused and another challenge's codes are refused; 5 attempts at most.
  - Rate limits apply.
  - Idle and absolute expiry; logout and deactivation end the session at once.
- **No tenant data:** with students, guardians and attendance seeded, the raw JSON of every platform endpoint contains no student or guardian names or guardian phones.
- **Provisioning:** tenant and template created; an INVITED OWNER membership plus staff profile; the owner logs in by OTP, accepts, and becomes OWNER; an existing phone gives the same response; audited.
- **Suspend:**
  - The owner's next request gets 403; reactivate restores access.
  - The institute can't change its own status or modules (DB test).
- **Invoices:** per-student × modules, flat, yearly, trial skipped, idempotent, partial then full payment marks PAID, overdue, owner banner only for the owner.
- **Limits:** student limit at admission and in imports; SMS ceiling lowers the effective cap.
- **Playwright (360px and 1440px, bn and en):**
  - platform login (password + code), create institute;
  - owner OTP login, accept, wizard (skip a step, continue later from the dashboard, finish);
  - platform suspend, after which the owner is blocked.

## Decisions (approved 2026-10-20)

1. SMS cost ৳0.30 per segment as a placeholder, editable in a platform settings screen (audited).
2. The SMS daily cap override is a ceiling (the lower of the institute's cap and the platform's).
3. Yearly = 12 × monthly minus an optional yearly discount % on the plan (default 0). Invoices are due in 10 days.
4. Platform sessions: 30 minutes idle, 8 hours at most. Second factor TOTP (change A).
5. Platform admins: the seed for dev, the CLI (change B) for production. No admin screen yet.
6. When the trial ends, the institute stays in trial with a warning.
7. Billing per enabled module; CORE has its own price (can be 0).
8. The wizard appears only for institutes created through the platform.
9. (After the part 1 review) The platform module's login `jantrik_platform_app` is not a member of `jantrik_app`: it can run the `platform_*` functions and nothing else.

## Part 2 notes

- `tenant_subscriptions` is created in part 2 (create takes the plan, and the limits live there); part 3 adds plan editing, invoices and payments.
- `jantrik_platform` reads institute tables through column grants only (counting columns, owner names and phones), so no platform function can return a student's or guardian's data.
- Suspension remembers the status to return to (`tenants.suspended_from`): a suspended trial goes back to TRIAL (decision 6).
- Moving an institute from TRIAL to ACTIVE comes with billing (part 3).

## Part 3 notes (details settled while building, within the approved plan)

- **Activate** is its own action (TRIAL → ACTIVE, reason required). Billing then starts with the next month (`tenant_subscriptions.billing_starts_on`), editable in the plan.
- **Yearly plans:** an invoice covers 12 months from any month not invoiced yet (no live invoice may overlap its range), so after a year the next one follows, and a skipped month only moves the year. The discount is its own (negative) DISCOUNT line.
- **Issue date:** today by default; the admin may pick an earlier one (invoices issued late), never a future one.
- **Payments** may not exceed what is left; a partial payment is fine.
- **Void** only an invoice nobody has paid on; that month can then be invoiced again.
- **A total of 0** (free plan) issues no invoice.

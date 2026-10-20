# Step 8 report: platform admin panel and institute onboarding

Branch `feature/step-8-platform` (pushed, not merged). Plan: [docs/plans/step-8.md](../plans/step-8.md).
How the platform area works: [docs/platform.md](../platform.md).

## Commits

| Part | Commit    | What                                                                                    |
| ---- | --------- | --------------------------------------------------------------------------------------- |
| 1    | `8957659` | Platform foundation: admins, password + authenticator login, sessions, audit log, CLI   |
| 1    | `0cdd31c` | The platform's database login reaches only the platform functions (your decision 9)     |
| 2    | `140e79b` | Institutes: list, create with an owner invitation, suspend, modules, limits             |
| 3    | `2c43aa4` | Billing: plans, activation, monthly invoices, payments, overdue notice for the owner    |
| 4    | `d64f7ee` | Usage and cost: the SMS rate setting, a cost on every SMS sent, the usage page          |
| 5    | `73390b6` | Onboarding: the new owner's setup wizard                                                |
| 5    | `4dc02a0` | The wizard's checklist hook, left out of `73390b6` by mistake (CI ran on both together) |
| -    | (this)    | this report                                                                             |

Each part was committed only after lint, typecheck, format check, all unit, database and API
tests, the build and the full Playwright suite passed locally, and after a separate review agent
had checked it (tenant isolation, RLS, roles, input validation) and its findings were fixed.
Each was then pushed, and CI passed both jobs (lint/typecheck/test/build, and Playwright) before
the next part started.

## Tests

Tests passing after each part:

| Suite                       | Part 1 | Part 2 | Part 3 | Part 4 | Part 5 |
| --------------------------- | -----: | -----: | -----: | -----: | -----: |
| `@jantrik/shared` (Vitest)  |    164 |    164 |    164 |    164 |    167 |
| `@jantrik/db` (Vitest, RLS) |    130 |    141 |    153 |    157 |    161 |
| `@jantrik/api` (Vitest e2e) |    226 |    237 |    242 |    246 |    253 |
| Playwright e2e              |     40 |     40 |     40 |     40 |     41 |

The Playwright count stays at 40 through parts 2 to 4 because each part's screens were added as
steps inside the platform tests, not as new tests. Part 5 adds one: the owner finishing the wizard
at 1440 px in English (the first steps run at 360 px in Bangla inside the existing test).
Screens new in part 5 were also checked by screenshot at 360 px and 1440 px in both languages.

## What was built

### Part 1: platform foundation

- **Platform admins are not institute users.** They have their own table, login, session, guard
  and audit log. The platform API returns nothing about an institute's students, guardians or
  attendance beyond counts.
- **Login is two factors every time.** First the password (phone or email), then a 6-digit code
  from an authenticator app (TOTP).
  - The first sign-in shows a QR code to scan, then 10 one-time backup codes, shown once.
  - Each code and each backup code works once; tries are limited per login, per admin and per day,
    and failures are audited.
  - There is no SMS for platform login.
- **Sessions:** a cookie holding an opaque token (only its hash is stored), 30 minutes idle and
  8 hours at most. Logging out, disabling an admin, a new password or a 2FA reset end sessions at
  once.
- **Separate in both directions:** an institute token is refused on `/platform/*`, and the platform
  cookie on institute routes.
- **Database:** the API reaches the platform tables only through definer functions owned by a new
  role `jantrik_platform`. Only a separate database login, `jantrik_platform_app`, may run them.
  After the review that login was also removed from `jantrik_app` (your decision 9), so it can run
  the platform functions and nothing else.
- **CLI** `pnpm platform:admin` (create, password, disable, enable, reset-2fa, list) for real
  admins. Passwords are never taken as arguments; every change is audited.
- **Web:** `/platform/login` (password, then code or QR enrolment), its own shell in Bangla and
  English, an overview and the activity log.

### Part 2: institutes

- **List and detail** of every institute: type, status, plan, trial end, owner and invitation
  state, active students, SMS this month, imports, last activity.
- **Create an institute:** the type's template, the first academic year, a TRIAL status and an
  owner invitation (14 days, no SMS: the owner sees it after an OTP sign-in). The platform can
  cancel, re-send or replace the owner invitation until an owner accepts.
- **Suspend and reactivate**, with a reason: access ends or returns on the institute's next
  request; data is kept.
- **Modules** on and off (CORE always on).
- **Limits:** a student limit (admissions and import rows refused at the limit) and a ceiling on
  the daily SMS cap.
- **Hardening:** an institute cannot change its own status or modules, even through a bug (no
  UPDATE grant, and module rows can only be inserted at provisioning).

### Part 3: subscriptions and billing

- **Plans** per institute: per active student per module, or a flat monthly price; monthly or
  yearly with an optional discount; days to pay.
- **Activate** a trial (TRIAL → ACTIVE). Billing starts the next month.
- **Invoices for a month,** all institutes in one action. It is idempotent, and every institute
  that is skipped is counted with its reason.
- **Payments** (cash, bKash, bank), partial or full, and **void** for an unpaid invoice.
- **Overdue** warnings on the platform side, and a gentle notice on the owner's dashboard. There
  is no automatic suspension.

### Part 4: usage and cost

- **The SMS rate** (৳0.30 per segment to start) is a platform setting, changed on
  `/platform/settings` and audited.
- **Every SMS gets its cost when it is sent** (institute SMS and login codes), so changing the rate
  never changes past costs.
- **`/platform/usage`:** per month, institute SMS and login-code SMS (count, segments, cost) and
  every institute by cost.

### Part 5: the new owner's setup wizard

- **Only institutes the platform creates get a wizard** (decision 8). A new tenant table
  `onboarding_progress` (RLS, no DELETE) is written at provisioning; demo institutes have none,
  so they never see the wizard.
- **The owner lands in the wizard right after accepting** the invitation, at `/setup/welcome`.
  There are six steps:
  1. check the academic year (edit its name or dates);
  2. the template's classes, with "add section" per class;
  3. shifts, if there is more than one;
  4. invite teachers;
  5. import students (the import page keeps a "Back to setup" link);
  6. attendance: how often, and absent SMS on or off.
- **Every step can be skipped,** and each answer is saved on its own. "Continue later" goes to the
  dashboard, whose "Getting started" card shows **Continue setup** (to the next open step) until
  the wizard is finished. Answering the last open step finishes it (the buttons then say so);
  finishing is audited.
- **A small fix on the way:** for institutes without the attendance module, the "Getting started"
  card never disappeared, even with every step done; it now does.
- **The setup dialogs were extracted** for reuse: year, section, shift and add staff.
- **API** (owner and admin): `GET /onboarding`, `PUT /onboarding/steps/:step`,
  `POST /onboarding/finish`.

## Decisions taken

You approved these with the plan (see the plan for the full text):

1. The SMS cost is ৳0.30 per segment, as a placeholder, editable and audited.
2. The SMS cap set by the platform is a ceiling: the lower of the institute's cap and the
   platform's applies.
3. Yearly price = 12 × monthly, minus an optional discount. Invoices are due in 10 days.
4. Platform sessions last 30 minutes idle and 8 hours at most. The second factor is an
   authenticator app (your change A).
5. Platform admins come from the seed in development and the CLI in production (your change B).
   There is no admin screen.
6. When a trial ends, the institute stays in trial with a warning.
7. Billing is per enabled module, and CORE has its own price, which can be 0.
8. The wizard appears only for institutes created through the platform.
9. (Your answer after the part 1 review) `jantrik_platform_app` is not a member of `jantrik_app`.

These details were settled while building, within the plan:

- **Billing:**
  - Activation starts billing the next month.
  - A yearly invoice covers 12 months from any month not invoiced yet, so a skipped month only
    moves the year.
  - The issue date can be earlier than today (for invoices issued late) but never in the future.
  - A payment may not exceed what is left on the invoice.
  - Only an invoice nobody has paid on can be voided; that month can then be invoiced again.
  - A free plan (a total of 0) issues no invoice.
- **SMS costs:** the cost is stored when an SMS is sent. Held, cancelled and failed SMS cost
  nothing.
- **Wording:** the owner role is called "প্রতিষ্ঠান প্রধান" in Bangla.
- **Onboarding:** owners and admins may both use the wizard. Finishing marks unanswered steps as
  skipped. A finished wizard is not reopened, but every step's work stays available in Setup,
  Staff, Import and Attendance settings.
- **Migrations:** fixes found in review were added as follow-up migrations instead of editing
  applied ones, so your development database never needs a reset. That is why part 5 has three
  small migrations for one table: the step-value check was tightened twice.
- **The test database:** while building part 5, one of my failing tests left an invalid row in
  the long-lived `jantrik_test` database, and the next migration then half-applied there. I fixed
  that row and marked the migration rolled back, so it applied cleanly on the next run. This was
  only `jantrik_test`; your `jantrik` database was not affected.

## Skipped or left for later

- **The platform on its own subdomain:** not now, as you said. It is recorded as a deployment
  requirement (step 11) in `docs/decisions-pending.md`, together with Redis `noeviction`, the
  order of the deploy (database roles before `migrate deploy`) and a note on rolling deploys.
- **TRIAL → ACTIVE is a manual platform action.** Nothing suspends an institute automatically,
  for an ended trial or an overdue invoice.
- **No backfill of SMS costs:** SMS sent before part 4 have no cost, and no real institute had
  sent any.
- **Not fixed:** the institute picker's subtitle still says it is for people with "একাধিক
  প্রতিষ্ঠান" (more than one institute), even when someone has exactly one institute plus an
  invitation.
- **No platform admin screen:** admins are managed with the CLI (decision 5).

## Your `.env`

Add this line (I have not touched `.env`):

```
DATABASE_PLATFORM_URL=postgresql://jantrik_platform_app:platform_dev_password@localhost:5432/jantrik
```

The API refuses to start without it. `DB_PLATFORM_PASSWORD=platform_dev_password`
only matters when the Postgres volume is created from scratch, which creates the role with that
password. Your existing volume already has the role, and its membership in `jantrik_app` was
already removed there.

Then apply the part 2 to 5 migrations to your database with `pnpm db:deploy`. I have already
applied them to your local `jantrik` database while building, so it prints "No pending
migrations" unless you reset it.

## Logging in as the platform admin in development

1. `pnpm db:seed` creates (or keeps) the development platform admin on your local database: phone
   `01700000001` (or `platform@jantrik.local`), password `Jantrik@2026`. It has no authenticator
   yet, and the seed lets it enrol one for 30 days.
2. Start the app (`pnpm dev`) and open `http://localhost:3000/platform/login`.
3. Enter the phone (or email) and the password.
4. The first time, a QR code appears. Scan it with an authenticator app on your phone (Google
   Authenticator, Microsoft Authenticator, Aegis…), or type the key shown under it.
5. Type the 6-digit code from the app.
6. Save the 10 backup codes shown once (each works once, in place of a code), tick the box and
   continue.
7. From then on, every sign-in is the password, then the current code from the app.

- **The 30 days passed before you enrolled?** Run `pnpm db:seed` again; it reopens the window
  while no authenticator is set up.
- **Lost the authenticator** (or want to set it up again)? Run
  `pnpm platform:admin reset-2fa --phone 01700000001 --reason "dev reset"` (after `pnpm build`),
  then sign in again: it shows a new QR code.

`PLATFORM_TOTP_KEY` is optional in development: without it, the key that encrypts the
authenticator secret is derived from `OTP_PEPPER`. If you change either one, enrol again with
`reset-2fa`.

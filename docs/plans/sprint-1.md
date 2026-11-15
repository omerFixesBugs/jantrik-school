# Sprint 1: admission, online payments, new session, notices, documents (a plan for the owner's review)

**Status: approved by the owner on 2026-11-14.** The approval covers every default in S1–S32, with
the owner's additions to S3, S4, S7, S22 and S23, now written into the phases and the decisions
table. If the sprint runs late, P8 and P9 move to Sprint 2; tests are never reduced to save time.
Nothing is built yet. Every phase touches the database, and three touch auth or money. CLAUDE.md asks for a plan and the owner's approval first. This document is
the sprint-level plan: the phase order, new tables, decisions and outside accounts. Each phase also
gets its own detailed plan (`docs/plans/sprint-1-pN-<name>.md`: exact columns, migrations, task by
task with tests) at its start. That detailed plan is approved before any code is written
(decision S1).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement each phase's detailed plan task by task.

**Goal:** institutes take admissions online, collect fees online through SSLCommerz (sandbox), roll
over to a new session, message guardians and staff, and print their own ID cards and certificates.

**Architecture:** each item is a set of new tenant tables (forced RLS, composite keys) behind its
own Nest module and web area. The two no-login surfaces are the admission form and document
verification. They reach the database only through narrow `SECURITY DEFINER` functions keyed by the
institute's slug or a code, never through a tenant transaction (decision S4). Payments sit behind a
`PaymentProvider` interface with per-institute encrypted credentials. Every gateway HTTP call runs in
a queue job, never inside a transaction.

**Tech stack:** the existing stack (NestJS, Next.js, Prisma/PostgreSQL 16, Redis/BullMQ). New
dependencies need approval (decision S8): `sharp` (API, image re-encoding) and Cloudflare Turnstile
(script only, no npm package).

**Spec:** the owner's sprint brief of 2026-11-14, restated in "Scope as asked" below.

## Scope as asked

1. **Online admission per institute:** a public form (no login), guardian phone OTP, spam
   protection, an applications list, an optional admission test and merit list. Approving an
   application creates the student and guardian.
2. **Online payment via SSLCommerz (sandbox only):** bKash, Nagad, Rocket and cards through
   SSLCommerz. It sits behind a provider interface, so direct bKash tokenized checkout can be added
   later as an institute setting (not in this sprint). Each institute has its own merchant
   credentials, encrypted. The IPN is validated server-side, with reconciliation and a review queue.
   Manual TrxID stays as the fallback. The `.env` names for the sandbox Store ID and Password are in
   "Environment variables" below.
3. **Promotion and new session:** bulk promote, rolls by merit, name or by hand, leavers, carry
   forward dues, copy the fee setup.
4. **Notices and broadcast:** SMS and in-app, a cost preview, a cap, scheduled sending, a notice
   board.
5. **Document template designer:** ID card (CR80 and A4 sheet), admit card, TC, testimonial,
   marksheet layout, QR verification, presets per institute type.
6. **Staff set their own password after OTP;** guardians stay OTP only.
7. **Security follow-ups:**
   - an `Origin` check in `PlatformAuthGuard`;
   - a Redis ACL user for the receiver;
   - a fail-closed check that the app's database login is not a superuser and not BYPASSRLS;
   - a receiver query `statement_timeout` of 5 s (decision #79).

## What exists today (the plan builds on this)

- **Admitting a student:** `StudentAdminService.admit()` (`apps/api/src/students/student-admin.service.ts:104`)
  - It checks the student limit, the section and roll, and duplicates.
  - `GuardianLinker.findOrCreate` returns 409 `GUARDIAN_CHOICE_REQUIRED` when the phone already
    has guardians.
  - It needs a signed-in principal: public requests get no transaction (`TenantContextInterceptor`
    skips `@Public()`).
  - Rolls are never assigned automatically.
- **Years and enrolments:**
  - `academic_years.is_current` (one per tenant); `createYear` can copy sections. There is no
    closed state.
  - `enrolments` has no status column.
  - Statuses `GRADUATED | TRANSFERRED | DROPPED_OUT` exist, but only `deactivate()` writes a status:
    it soft-deletes and sets INACTIVE.
  - No promotion code exists.
- **Fees across years:**
  - The ledger reads dues from every year. The due list shows OPEN dues from any year for students
    enrolled this year, so arrears already carry into the new year once a student is enrolled.
  - `copyAmounts` exists; there is no copy for terms or concessions.
  - Dues are generated for the current year only, and use `student.createdAt` as the admission date.
- **SMS:**
  - `TenantSmsService.queue()` handles dedupe, the daily cap (`HOLD`/`SKIP`), the advisory lock and
    relevance checks.
  - The preview → send pattern returns 409 `PREVIEW_CHANGED` (`FeeRemindersService`).
  - `smsLength()` counts GSM-7 (160/153) and Bangla UCS-2 (70/67).
  - The rate is `platform_settings.sms_cost_per_segment_paisa`.
  - No real gateway exists (`SMS_PROVIDER=none` in production).
- **Printing:** everything is browser print (`@page` in `globals.css`).
  - Admit cards are two per A4; there are report cards and receipts.
  - `qrcode` is in apps/web only. There is no server PDF library.
- **Files and branding:**
  - There is no file storage. `students.photo_url` exists but is always null.
  - `tenants` has one `name`, and no logo, EIIN, address or signature.
- **Modules:**
  - `ModuleKey` is `CORE, ATTENDANCE, FEES, EXAMS`.
  - Adding a key means changing the enum, `platform_set_module`, the price columns, `InvoiceLineKind`,
    the billing SQL and backfilling `tenant_modules` (decision S3).
- **Security items:**
  - The Caddy rule `@platformFromElsewhere` is the stopgap for the Origin check (D9).
  - The receiver uses the full Redis user: keys `rl:ingest-*`, `ingest:*`, `<QUEUE_PREFIX>:devices:*`.
  - The env checks refuse known admin logins by name only.
  - The receiver pool (`INGEST_POOL`) has no query limit (#79).

## Phase order

Each phase is its own branch from `main` and its own PR into `main`, with tests and green CI. The
order puts the season first: Bangladeshi schools admit for January in November and December, and
promote after the annual exams in December. Payments are sandbox-only this sprint, so they cannot go
live this season anyway, and they come after the public-surface groundwork they reuse.

| #   | Phase                                        | Scope item | Size | Needs           | Review subagent       | Outside account                            |
| --- | -------------------------------------------- | ---------- | ---- | --------------- | --------------------- | ------------------------------------------ |
| P0  | Security follow-ups                          | 7          | S    | —               | yes (auth, DB, Redis) | —                                          |
| P1  | Staff set own password                       | 6          | S    | —               | yes (auth)            | — (real OTPs need an SMS gateway)          |
| P2  | Institute profile, file storage, photos      | 1, 5       | M    | —               | yes (DB, uploads)     | — (bucket only if S7 = S3)                 |
| P3  | Admission: form, OTP, applications, approve  | 1          | L    | P0, P2          | yes (public, DB, OTP) | Turnstile keys (test keys for dev/CI)      |
| P4  | Admission test and merit list                | 1          | M    | P3              | yes (DB)              | —                                          |
| P5  | Promotion and new session                    | 3          | L    | P3 (new admits) | yes (DB, fees)        | —                                          |
| P6  | Notices and broadcast                        | 4          | M    | —               | yes (SMS money, DB)   | — (real sends need an SMS gateway)         |
| P7a | Online payments: checkout, IPN, recording    | 2          | L    | P0              | yes (money, security) | SSLCommerz sandbox store (smoke test only) |
| P7b | Online payments: reconciliation, review      | 2          | M    | P7a             | yes (money)           | —                                          |
| P8  | Documents: designer, presets, ID cards       | 5          | L    | P2              | yes (DB)              | —                                          |
| P9  | Documents: register, QR verify, TC, the rest | 5          | L    | P5, P8          | yes (public, DB)      | —                                          |

P0, P1 and P6 do not depend on the others. If the owner wants (decision S2), they can run in parallel
in worktrees with scratch databases, as on 2026-11-13. Migration folders then need rebasing in merge
order.

## Global constraints

Every phase's requirements include these.

- **New tenant tables:** each follows the database.md checklist.
  - `tenant_id NOT NULL`, `@@unique([tenantId, id])`, composite foreign keys (optional ones too),
    every foreign key `ON UPDATE RESTRICT`, an index leading with `tenant_id`.
  - Enabled and forced RLS with the `tenant_isolation` policy, and explicit grants.
  - History tables get no DELETE.
  - The table goes into `schema-safety.test.ts`, and an isolation test goes in `packages/db/test/<area>-rls.test.ts`.
- **Migrations:**
  - CHECKs test nullable columns with `IS [NOT] NULL` first.
  - No tenant backfill in a migration.
  - A new enum value goes in its own migration.
  - `migrate dev --create-only` applies pending migrations first: run it once, then find the folder
    with `ls -t`.
- **Definer functions:**
  - Owned by a NOLOGIN role and pinned to `search_path = pg_catalog, public, pg_temp`.
  - EXECUTE for exactly one login role, and never a tenant id parameter.
  - Each new exception to that rule is listed in `schema-safety.test.ts` with a reason.
- **Money:** integer paisa. Gateway amounts are parsed from strings into exact paisa, never through
  floats.
- **Dates:** stored in UTC, shown in Asia/Dhaka. "Today" comes from the server (`todayIn`). Admission
  windows, scheduled sends and quiet hours use the institute's timezone.
- **Data, not types:** no `if (type === …)`. Presets and labels are data keyed by
  `institute_types.key`.
- **Modules and roles:** every route has `@RequireModule` and `@Roles`. Every page belongs to a module.
- **Slow work and transactions:**
  - Slow work goes to a queue.
  - No HTTP call inside a transaction.
  - Request and job transactions time out at 15 s, so bulk work runs in chunks.
- **Audit:** every create, update and delete on applications, admissions, promotions, notices,
  broadcasts, payment intents, gateway accounts (field names only) and issued documents.
- **Strings and digits:**
  - All strings bn and en, through translation keys and route namespaces (`route-messages.ts`).
  - Bangla digits for dates, counts and amounts in the bn UI. ASCII digits for phones, application
    numbers, serials, TrxIDs and rolls.
  - Bangla digits are accepted in every number input (`toAsciiDigits`, `normalizeBdPhone`).
- **Screens:**
  - New screens use the v3 kit and are light-first.
  - Public pages (admission form, verification) meet the budget: ≤ 3 s to interactive at 390 px,
    4× CPU, slow 4G.
  - Screenshot checks are bn at 1366 and 390 px.
- **Secrets:**
  - Secrets only in `.env`, which Claude never edits. New variables go into `.env.example` and
    deploy.md.
  - Credentials never appear in responses, logs, `audit_logs`, `sms_logs`, Redis or job payloads.
- **Gates:**
  - During a phase, run only the affected tests.
  - At the end of a phase, run `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, `pnpm test`,
    `pnpm build` and `pnpm e2e`. Then the review subagent runs, then the PR, with CI green before
    asking to merge.
- **Local data:** no local `pnpm db:seed` without the owner's yes. Reseeding `jantrik_e2e` is fine.
  No `migrate reset`: use a scratch database.

## Review focus

The five failure modes most likely to bite, which the brief implies but no single feature test
covers. Each one's test is listed in the phase that owns the code.

1. **One payment, three signals.** The IPN, the payer's browser return and a reconciliation query
   can arrive for the same transaction at the same moment. Expected: exactly one fee payment and one
   receipt (P7a: concurrent IPN + return test; unique `fee_payments.payment_intent_id`).
2. **Dues paid at the counter while the guardian is paying online.** Expected: the online money is
   recorded and never lost. It is never applied twice. The excess shows as unapplied in the review
   queue (P7a: counter payment between checkout and validation).
3. **SMS pumping through the admission OTP.** Many phones from rotating addresses. Expected: the
   per-institute daily OTP ceiling holds whatever the addresses, and no SMS goes out without a
   Turnstile pass (P3: ceiling test across 50 phones and 10 addresses).
4. **Promotion interrupted or run twice.** The worker dies after chunk 3 of 6, or two admins press
   apply. Expected: a re-run finishes without duplicate enrolments or roll clashes, and the current
   year does not switch by itself (P5: kill-and-resume test, concurrent apply test).
5. **Students admitted in December for January.** `student.createdAt` is the admission date today,
   so a one-time admission due generated on 1 January would already be late, with fines from
   December. Expected: a due for a student admitted for next year counts from the year's start or
   the admission date, whichever is later (P3: dues test for an early admit, a fees rule change in
   that phase's plan).

---

## P0: Security follow-ups (scope 7)

**Goal:** close the four items deploy.md lists as owner decisions.

- **`Origin` allowlist in `PlatformAuthGuard`** (`apps/api/src/platform/platform-auth.guard.ts`).
  - New env `PLATFORM_ORIGINS` (comma-separated). It is required in production, where each entry
    must be `https://`. Development defaults to `http://localhost:3000`.
  - Both `login` and `session` routes refuse a missing or unlisted `Origin` with 403
    `PLATFORM_ORIGIN_REFUSED`, before the rate limiter and the database lookup.
  - The Caddy rule stays as a second layer (decision S27).
- **Fail-closed privilege check of every database login**: `DATABASE_URL` (API and worker),
  `DATABASE_PLATFORM_URL` and `DATABASE_INGEST_URL`.
  - A helper in `packages/db`, `loginPrivileges(client)`, reads `rolsuper` and `rolbypassrls` of
    `current_user`. It also checks whether the login can become a role that has either
    (`pg_has_role(current_user, r.oid, 'MEMBER')`).
  - Each Prisma service's `onModuleInit` refuses to start when any of these is true.
  - It also refuses when the check itself keeps failing, after the receiver's existing
    retry/backoff pattern.
- **Receiver `statement_timeout` 5 s.**
  - `statement_timeout: 5000` in `INGEST_POOL`: node-postgres sends it at connect, so the server
    enforces it.
  - `ALTER ROLE jantrik_ingest_app SET statement_timeout = '5s'` in `create-roles.sh` and the local
    init script. Not in a migration: `jantrik_owner` cannot alter another role.
  - The receiver's start-up check also requires `current_setting('statement_timeout') = '5s'`.
  - Risk noted in #79: a 10 000-line upload takes about 2 s to store. A timeout returns 500 and the
    device resends, so nothing is lost.
- **Redis ACL user for the receiver.**
  - The production compose defines `jantrik_ingest` from the new env `REDIS_INGEST_PASSWORD`.
  - Keys `~rl:ingest-*`, `~ingest:*` and `~<QUEUE_PREFIX>:devices:*`, and only the commands the rate
    limiter and BullMQ's producer need. The exact list is pinned by a CI test against a Redis
    started with the ACL.
  - The receiver's `REDIS_URL` names that user. `receiverProductionProblems` refuses the default
    user.
- **Tests:**
  - The guard: listed, unlisted, missing and `null` Origin, on both modes.
  - The privilege check: unit tests with fake rows. One integration test refuses the Postgres
    superuser login, which CI has, and passes `jantrik_app`.
  - The receiver: the timeout setting present, and a `pg_sleep(6)` probe cancelled.
  - ACL: the receiver's real calls pass, and `FLUSHALL`, `KEYS *` and adding to the `sms` queue are
    refused.
- **Docs:** auth.md, platform.md, deploy.md, `.env.example`, decisions-pending (#79 and the
  "recorded, not built" list) and devices.md.

## P1: Staff set their own password (scope 6)

**Goal:** staff can add a password after proving their phone. Guardians cannot.

- **Endpoints:**
  - `GET /me/password` → `{allowed, hasPassword, changedAt}`.
  - `POST /me/password/code` sends an OTP to the signed-in user's own phone. It uses the existing
    OTP limits under a separate key.
  - `PUT /me/password {code, password}`.
- **Who may set one:** a user with at least one ACTIVE membership holding a staff role (anything but
  GUARDIAN) in any institute. Anyone else gets 403 `PASSWORD_NOT_ALLOWED`.
- **Password login:** `loginWithPassword` also refuses, with the same 401, a user with no such
  membership left.
- **Setting and changing** both need a fresh OTP (decision S26). On success:
  - every other session of the user is revoked; the current one stays;
  - `users.password_changed_at` is set (new column, global table);
  - an audit row is written in the current institute (no values).
- **Policy (S26):** 10–128 characters, not the phone number, and not in a bundled common-password
  list. Argon2id as today.
- **Hardening:** a code-scan test makes sure only `PasswordService` writes `passwordHash`.
- **People who are both staff and guardian** (decision S28): by default, a password login reaches
  all of the person's memberships.
- **Web:** a "Password" page under the staff member's own settings. The login page's password tab
  links to "Sign in with a code first".
- **Tests:**
  - A guardian-only user gets refused.
  - A wrong, expired or reused code fails.
  - Other sessions die and the current one survives.
  - A staff member removed everywhere can no longer use the password.
  - Rate limits hold.
  - No timing difference in login.
- **Docs:** auth.md (remove "Password set/reset endpoints" from "Not built yet") and deploy.md (the
  go-live note: the first OTP still needs an SMS gateway).

## P2: Institute profile, file storage, student photos (groundwork for scope 1 and 5)

**Goal:** institute branding, and a safe place for photos, logos and signatures.

- **Tables:**
  - `institute_profiles` (≤ 1 per tenant; S I U):
    - names: `name_bn`, `name_en`, `short_name`;
    - contact: `eiin` (digits, optional), addresses bn/en, `phone`, `email`, `website`;
    - head of institute: `head_title_bn/en`, `head_name_bn/en`;
    - `established_year`, `logo_file_id`, `head_signature_file_id`, `seal_file_id`.
  - `stored_files` (S I D, no UPDATE):
    - `kind` (`STUDENT_PHOTO | APPLICANT_PHOTO | LOGO | SIGNATURE | SEAL | DOCUMENT_ASSET`);
    - `mime` (CHECK jpeg, png or webp), `bytes bytea` (CHECK ≤ 256 KB), `sha256`, `width`,
      `height`;
    - `created_by`.
  - `students.photo_file_id` (composite foreign key). The unused `photo_url` column is dropped.
- **Storage** (decision S7, approved: Postgres): files live in the database under the same RLS, and
  `pg_dump` backups already cover them.
  - Callers use only the `FileStore` interface (`put`, `get`, `delete`), never `stored_files`
    directly; a code-scan test enforces it.
  - A later move to R2/S3 is a new `FileStore` backend plus a copy job. No caller changes.
- **Uploads** (server-side resize and compression always; the uploaded bytes are never stored):
  - multipart, ≤ 5 MB in;
  - `sharp` with `limitInputPixels`, EXIF stripped and re-encoded;
  - photo: resized to ≤ 600×800 and compressed to JPEG ≤ 200 KB; logo and seal: PNG or WebP;
    signature: PNG.
- **Size caps** (S7):
  - **Per file, by kind:** photo 200 KB, logo, seal and signature 100 KB, document asset 256 KB.
    Checked in code and by a CHECK.
  - **Per institute:** a total, default 1 GB (`FILE_STORAGE_PER_TENANT_MB`). It is kept in a usage
    row (`stored_file_usage`) updated in the same transaction as each `put` and `delete`, under the
    tenant's lock. Over the cap: 413 `STORAGE_FULL`. A platform-set limit can come later.
- **Serving:**
  - Entity routes, never a generic `/files/:id`: `GET /students/:id/photo` (whoever may see the
    student), `GET /me/children/:id/photo`, `GET /institute/profile/{logo|signature|seal}`.
  - Responses carry `ETag` and `Cache-Control: private`.
  - The web fetches them with the bearer token and shows object URLs. No signed URLs, so there is no
    new auth mechanism.
- **Web:**
  - Settings → Institute profile (OWNER/ADMIN).
  - Photo upload and replace on the student page.
  - The photo shows on the report card, as today.
- **Tests:**
  - RLS isolation of files.
  - An oversized file, a non-image, a decompression bomb and a PNG with EXIF GPS (stripped).
  - Another institute's student photo returns 404.
  - A guardian sees only their own children's photos.
- **Docs:** database.md, a new `docs/files.md`, deploy.md (backup size note).

## P3: Admission: public form, OTP, applications, approve (scope 1)

**Goal:** a guardian applies from a phone without an account. Staff review and approve into a
student and guardian.

- **Tables** (all tenant tables):
  - `admission_cycles` (S I U):
    - `academic_year_id`, names bn/en, `opens_at`, `closes_at`;
    - status `DRAFT | OPEN | CLOSED`, a public note bn/en;
    - `requires_test`, `collect_photo`, and which optional fields are shown or required (jsonb with
      a CHECKed key set).
  - `admission_cycle_classes` (S I U D): cycle, `class_level_id`, `study_group_id?`, `seats`,
    `is_open`.
  - `admission_applications` (S I, UPDATE by column, no DELETE):
    - `application_no` (`<year>-<NNNN>` per cycle, from `admission_counters`);
    - the student fields that `admit()` takes: names, DOB, gender, religion, birth registration,
      previous institute, addresses, parents;
    - guardian name, relation and verified `phone`;
    - `photo_file_id?`;
    - status `SUBMITTED | SHORTLISTED | SELECTED | WAITLISTED | REJECTED | ADMITTED | WITHDRAWN`,
      with reason, who and when;
    - staff notes, `student_id?` (unique, set on approval), `submitted_at`.
  - `admission_counters` (S I U).
- **Public access** (decision S4, approved with the owner's rule):
  - The public endpoint may only create an application and read back its own application, through
    a narrow path, never general tenant access.
  - Every public route has rate limits per address and per phone: the OTP request, OTP verify,
    submit and the status lookup.
  - The one read beyond the applicant's own application is the form itself (the institute's open
    cycles and classes: public information, no person data).
  - The new NOLOGIN role `jantrik_admission` owns three definer functions, executable by
    `jantrik_app` only:
    - `admission_public_form(slug)`: the open cycles and classes, only for an ACTIVE or TRIAL
      institute inside the window;
    - `admission_submit(slug, cycle_class_id, payload, phone, now)`: re-checks the window, refuses
      duplicates (birth registration number, or phone + name + DOB, in the cycle), caps 3
      applications per phone per cycle, and stores the photo bytes;
    - `admission_lookup(slug, application_no, phone)`: the status page.
  - Policies `TO jantrik_admission` allow only what these need. The slug and the `cycle_class_id`
    are checked against each other inside the function, and `schema-safety.test.ts` lists the
    exception.
- **OTP for applicants** (applicants are not users):
  - Redis HMAC codes (`OTP_PEPPER`), 5 minutes, 5 attempts.
  - A verified phone gets a 30-minute signed token (`typ: admission-phone`, audience the institute).
    Submitting needs it.
  - Limits: per phone 1 per 60 s and 5 per day; per address 20 per hour; per institute
    `ADMISSION_OTP_PER_TENANT_PER_DAY` (default 300).
  - The SMS costs the institute (decision S5). An `sms_logs` row (`ADMISSION_OTP`, its own enum
    migration) stores the body with the code masked. The code travels only in the short-lived
    queue job, as the login OTP does today.
- **Spam protection** (decision S6): a Turnstile token is required for the OTP request and for the
  submit, checked server-side. Also a honeypot field and a minimum fill time.
- **Staff screens** (OWNER/ADMIN; module per decision S3):
  - Cycles setup.
  - The applications list: filters, search by name, phone or number, CSV.
  - Application detail and edit (audited), shortlist and reject with a reason, a duplicate warning
    against existing students (birth registration).
  - **Approve:** runs in the staff member's own signed-in request, so `admit()` is reused unchanged
    with the application's fields. The approve dialog handles `GUARDIAN_CHOICE_REQUIRED`. The
    section and roll are optional, and the photo moves to the student.
  - **Bulk approve** for SELECTED rows into one section, as a job. Rows that need a guardian choice
    are skipped and listed.
  - After submit, one SMS with the application number (decision S11).
- **Fees rule** (review focus 5): a student admitted before their enrolment year starts gets
  one-time and first-period due dates counted from that year's start. Money rule: it gets its own
  test and review.
- **Web public pages** in the `(public)` group:
  - `/apply/[slug]` and `/apply/[slug]/status`: mobile-first, bn by default with an en switch.
  - A printable acknowledgement slip.
  - Turnstile is loaded only at the OTP step.
  - The perf budget is checked.
- **Tests:**
  - The definer functions: wrong slug, closed window, another institute's class id, duplicates and
    the cap.
  - OTP limits, including review focus 3.
  - The token's audience, other institutes and expiry.
  - Approval: the guardian choice, the student limit, double approve (409), and RLS of every table.
  - e2e: apply → approve → the student appears; Bangla digits in the phone and birth registration
    number.
- **Docs:** a new `docs/admission.md`, database.md, auth.md (a no-login surface) and
  `.env.example`.

## P4: Admission test and merit list (scope 1, optional per cycle)

- **Columns** on `admission_cycle_classes`: test date, time and venue, `full_marks`, `pass_marks`,
  `select_count`, `waitlist_count`.
- **Columns** on applications: `test_roll`, `test_score_h` (hundredths, one total per applicant:
  decision S12), `test_absent`, `merit_position`, `waitlist_position`.
- **Flow:**
  - Issue test rolls (sequential per class, from a start number).
  - Print applicant admit cards with a fixed design, two per A4, reusing the exams print CSS. The
    designer takes them over in P9.
  - Marks entry: a grid with Bangla digits accepted.
  - Build the merit list. Order: score, then the tie-break chosen per cycle (older or younger by
    DOB, then submission time). Ties share a place, as in `meritPositions()`. The top
    `select_count` become SELECTED and the next ones WAITLISTED.
  - Publish. Applicants check their result on `/apply/[slug]/status` (application number plus a
    phone OTP: decision S13) and can be told by SMS, with the reminders' preview → send pattern
    (`PREVIEW_CHANGED`, cost, cap).
  - Move up the waitlist when a selected applicant withdraws.
- **Tests:** merit ties, absent applicants unranked, republishing after a correction, the SMS cap
  (SKIP), and that a public lookup shows nothing before publishing.

## P5: Promotion and new session (scope 3)

**Goal:** move a whole institute into the next year in one guided flow, safely re-runnable.

- **Tables:**
  - `promotion_runs` (S I U): `from_year`, `to_year`, `class_level_id`, `roll_strategy`
    (`MERIT | NAME_BN | NAME_EN | MANUAL | KEEP`), `merit_exam_id?`, status
    `DRAFT | APPLYING | APPLIED`, who and when.
  - `promotion_run_students` (S I U D while DRAFT): student, from section and roll (snapshot),
    `decision` (`PROMOTE | REPEAT | LEAVE`), target class, section and roll, leaving status and
    reason, the merit place snapshot.
  - `students` gains `left_on` and `leave_reason`.
- **Leavers** (decision S14): the student's status becomes GRADUATED, TRANSFERRED, DROPPED_OUT or
  INACTIVE with a date and reason. There is no soft delete: `deleted_at` stays for real removal.
- **Wizard:**
  1. Create the next year (copy sections: exists).
  2. Copy the fee setup (decision S16):
     - amounts (exists);
     - terms with dates moved one year;
     - optionally concessions still running, per student, off by default.
  3. Optionally copy section teachers and subject teachers.
  4. Promote class by class:
     - defaults: PROMOTE for passed students in the published annual exam; REPEAT for failed; LEAVE
       (GRADUATED) for the highest class level by `sort_order`, which is data, not type;
     - the admin overrides any row;
     - the target section defaults to the same section name (decision S15).
  5. Apply: a job, one section per transaction, idempotent on `enrolments (year, student)`.
  6. Switch the current year (exists): it warns about unpublished annual results and unapplied
     classes.
- **Rolls:** `assignRolls(students, strategy)` in `packages/shared`, a pure function. MERIT uses the
  published annual `class_position` (ties → lower old roll). Students without a place come after,
  by name. NAME uses Bangla or English collation (`Intl.Collator('bn')`). The order is promoted,
  then repeaters, then new admits (S15).
- **Dues** (decision S17, default):
  - No money rows move. Old-year OPEN dues stay as they are and already show on the ledger and due
    list once the student is enrolled in the new year.
  - The plan adds a "previous years" marker on the ledger and due list.
  - It adds a "leavers with dues" report, and tests that pin the carry-over.
- **Tests:**
  - Review focus 4 (kill-and-resume, concurrent apply).
  - Rolls per strategy with ties and Bangla names.
  - A repeater keeps their dues.
  - A leaver drops out of due lists but keeps the ledger.
  - The copy is idempotent.
  - RLS of the new tables.
- **Docs:** a new `docs/promotion.md`, fees.md (carry-over and copy) and database.md.

## P6: Notices and broadcast (scope 4)

- **Tables:**
  - `notices` (S I U): title, body (plain text with line breaks), audience
    `ALL | STAFF | GUARDIANS`, `publish_at`, `expires_at`, `pinned`, status
    `DRAFT | SCHEDULED | PUBLISHED | WITHDRAWN`, who.
  - `notice_targets` (S I D): an optional class level or section, with composite foreign keys.
  - `notice_reads` (S I): notice, user, `read_at`.
  - `sms_broadcasts` (S I U):
    - body, an optional `notice_id`, recipients (`PRIMARY_GUARDIANS | ALL_GUARDIANS | STAFF`)
      plus targets;
    - `scheduled_at`, status `DRAFT | SCHEDULED | SENDING | SENT | CANCELLED | FAILED_OVER_CAP`;
    - preview count, segments, estimated cost, and sent, failed and cancelled counts.
  - `sms_broadcast_targets` (S I D).
  - `sms_purpose` gains `BROADCAST` (its own migration).
- **Sending:**
  - Reuses `TenantSmsService.queue()` with the dedupe `broadcast:<id>:<phone>`, so siblings' shared
    phones get one SMS.
  - The preview → send pattern: count, segments, cost, today's cap left; 409 `PREVIEW_CHANGED`.
  - Over the cap left at send time, nothing is sent and the status is `FAILED_OVER_CAP`, with the
    admin told in-app (decision S18).
  - Quiet hours, 21:00–08:00 by default, refuse scheduling and delay a due send to 08:00.
  - At most 3 segments.
- **Scheduling:**
  - A delayed BullMQ job (`jobId` = the broadcast or notice id) in a new `notices` queue.
  - A 5-minute sweep of a Redis zset `notices:due` re-queues anything Redis lost, with no
    cross-tenant SQL.
  - The audience is resolved at send time (decision S19). The actor must still be OWNER or ADMIN.
- **In-app:**
  - Notice board `/notices` for staff and guardians: guardians see notices for their children's
    current classes and sections.
  - An unread count in the shell (one cheap endpoint, cached per user) and a dashboard card.
  - No push notifications: the mobile app is later.
- **Who:** OWNER/ADMIN create and send (decision S20).
- **Tests:** audience resolution (siblings, other institutes, expired), the cap (all-or-nothing),
  quiet hours across midnight, cancelling a scheduled send, Redis-lost recovery, Bangla segment
  counts and unread counts.

## P7a: Online payments, checkout to receipt (scope 2)

**Goal:** a guardian pays chosen dues through SSLCommerz (sandbox), and the receipt appears only
after server-side validation.

- **Provider interface** (`apps/api/src/payments/provider.ts`):

  ```ts
  interface PaymentProvider {
    readonly key: 'SSLCOMMERZ'; // 'BKASH_TOKENIZED' later, as an institute setting
    readonly credentialsSchema: ZodType; // provider-specific secret fields
    testConnection(creds): Promise<ProviderTestResult>;
    createCheckout(
      creds,
      intent: CheckoutRequest,
    ): Promise<{ redirectUrl: string; sessionRef: string }>;
    // SSLCommerz: the validation API by val_id (or a query by tran_id); bKash later: execute, then query
    confirm(creds, ref: { tranId: string; valId?: string }): Promise<ProviderOutcome>;
    query(creds, tranId: string): Promise<ProviderOutcome>;
  }
  type ProviderOutcome =
    | {
        kind: 'PAID';
        amountPaisa: number;
        currency: 'BDT';
        bankTranId: string;
        instrument: string;
        risk: 'LOW' | 'HIGH';
      }
    | { kind: 'PENDING' }
    | { kind: 'FAILED' | 'CANCELLED' | 'EXPIRED' }
    | { kind: 'ERROR'; code: ProviderErrorCode };
  ```

- **Tables:**
  - `payment_gateway_accounts` (S I, UPDATE by column):
    - `provider`, `mode` (CHECK `'SANDBOX'`), `enabled`;
    - `credentials_ciphertext`: AES-256-GCM of the provider's credential JSON, with AAD
      `payments:<provider>:<tenantId>:<accountId>` and the key from `PAYMENT_CREDENTIALS_KEY`;
    - `credentials_hint` (the store id's last 4 characters), `key_version`, last test result, who.
    - One per provider per institute.
  - `payment_intents` (S I, UPDATE by column, no DELETE):
    - account, student, payer user, `amount_paisa`, `currency` (CHECK `BDT`);
    - `tran_id` (ours, unique), `client_request_id`;
    - status `CREATED | REDIRECTED | PAID | FAILED | CANCELLED | EXPIRED | NEEDS_REVIEW`;
    - `session_ref`, `val_id`, `bank_tran_id`, `instrument`, `validated_amount_paisa`, `risk`;
    - `fee_payment_id` (unique), `expires_at`, review fields.
  - `payment_intent_dues` (S I): intent, due and student (in the composite key), planned principal
    and fine.
  - `payment_gateway_events` (S I only):
    - intent, kind (`INIT | RETURN | IPN | VALIDATE | QUERY`), outcome;
    - whitelisted fields only (never credentials, never `card_no`).
  - Fees:
    - `fee_payment_channel` gains `GATEWAY`;
    - `fee_payment_method` gains `ROCKET`, `CARD` and `OTHER_ONLINE` (decision S21);
    - `fee_payments.payment_intent_id` (composite, unique).
- **Flow** (adapted from the backlog's bKash plan):
  1. The guardian picks dues on `/children/[id]/fees`; online payments pay those dues in full
     (decision S22). `POST /me/children/:id/fees/online-payments` computes the amount as the
     counter does and creates the intent.
  2. Job `init`: SSLCommerz session API, outside any transaction. The page polls, then redirects to
     the gateway.
  3. The payer's browser comes back by POST to
     `POST /public/payments/sslcommerz/:slug/return/:tranId/(success|fail|cancel)`. The API stores
     the event, queues `confirm` and answers 303 to `/children/[id]/fees/pay/[intentId]`, which
     polls. The status in the URL is never trusted.
  4. `POST /public/payments/sslcommerz/:slug/ipn` stores the event, queues `confirm` and answers 200.
     IPN fields are never trusted. `verify_sign` is not relied on.
  5. Job `confirm` (row lock on the intent):
     - the validation API, with the institute's own credentials;
     - it requires `VALID` or `VALIDATED`, our `tran_id`, BDT and the exact amount.
     - Then `FeeCollectionService.recordPayment` with channel GATEWAY, the method from the
       instrument, `bank_tran_id` as the TrxID, and the guardian as the actor. The receipt and SMS
       follow as today.
     - **Never posted automatically** (decision S23, the owner's rule): a payment SSLCommerz flags
       as risky, or any mismatch in amount, currency or transaction ID, goes to NEEDS_REVIEW with
       no payment and no receipt. Dues already paid meanwhile also go to review.
     - A notification whose transaction ID matches no intent of that institute is kept as an
       unmatched event and listed in the review queue.
- **Settings:** OWNER only.
  - Write-only credentials form; `GET` returns `{configured, enabled, hint, lastTest}`.
  - Test connection and enable/disable.
  - The audit stores field names only.
- **Guardian UI:** "Pay online" appears only when an enabled account exists. The manual
  "I paid by bKash/Nagad" stays beside it as the fallback.
- **Hardening:**
  - The base URL is fixed to the sandbox, and an override is refused in production.
  - 30 s timeout. Fixed error codes, never response bodies, in logs.
  - Jobs carry ids only.
  - A code-scan test checks that only `PaymentCredentialsService` reads the ciphertext.
  - Return and IPN routes are rate-limited per address.
- **Tests** (a fake SSLCommerz server for the API and Playwright; CI never calls the real sandbox):
  - the happy path, cancel and fail;
  - review focus 1 and 2;
  - an amount, currency or transaction ID mismatch, and a risky payment: each goes to
    NEEDS_REVIEW with no `fee_payments` row and no receipt;
  - another institute's `tran_id` posts nothing there and is listed as unmatched;
  - another guardian → 404;
  - a sentinel credential never appears in any response, log, audit row, `sms_logs`, Redis key or
    failed job;
  - amounts parsed from strings (`"1250.50"` → 125050).
- **Opt-in smoke:** `pnpm --filter @jantrik/api payments:sandbox-smoke` against the real sandbox,
  using the owner's sandbox variables. Not in CI.

## P7b: Reconciliation and review queue (scope 2)

- **Reconciliation jobs** at +5 min, +30 min, +2 h and +25 h after `init`: query by `tran_id`.
  - A PAID transaction not yet recorded is confirmed.
  - A transaction still pending after 25 h becomes EXPIRED.
  - A success that arrives after EXPIRED becomes NEEDS_REVIEW, never a silent receipt.
- **Review queue** (OWNER/ADMIN, plus ACCOUNTANT to view):
  - Reasons: `AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`, `TRAN_ID_MISMATCH`, `HIGH_RISK`,
    `DUES_CHANGED`, `LATE_SUCCESS`, `DUPLICATE`, `UNMATCHED`.
  - Actions: apply to chosen dues, mark refunded outside the app (with a reason), resolve with a
    note. All audited.
- **Reports:**
  - Online payments by day and status (initiated, paid, failed, expired, under review) with CSV.
  - Daily closing gains an "online (SSLCommerz)" line.
  - The dashboard's "to check" count includes NEEDS_REVIEW.
- **Tests:** each reconciliation step with fake time, late success, every review action, the closing
  totals.
- **Docs:**
  - a new `docs/payments.md`;
  - fees.md (the gateway channel);
  - backlog.md: the bKash tokenized plan becomes "a second `PaymentProvider`";
  - deploy.md (public URLs, the IPN URL to set in each store's panel).

## P8: Documents: designer, presets, ID cards (scope 5)

- **Tables:**
  - `document_templates` (S I U; archived, not deleted):
    - `kind` (`ID_CARD | ADMIT_CARD | TC | TESTIMONIAL | MARKSHEET`), name;
    - `page` (`CR80 | A4 | A5`) and orientation;
    - `sheet` (for CR80 on A4: columns, rows, gaps, crop marks);
    - `front` and `back` layouts as jsonb, validated by a versioned zod schema in `packages/shared`
      (CHECK size ≤ 64 KB);
    - `is_default` per kind, `version`, `source_preset_key`.
  - `document_template_presets`: global, `GRANT SELECT`, seeded in `templates.ts` keyed by
    institute type (null = every type). Presets for the three launch types: ID card (portrait,
    landscape), admit card, TC, testimonial, marksheet header.
- **Layout model:** elements are positioned in 0.1 mm units.
  - **text:** static bn/en, or a bound field from a per-kind whitelist (`student.name_bn`,
    `enrolment.roll`, `institute.name_bn`, …), with font (Noto Sans Bengali, Anek Bangla, Plus
    Jakarta), size, weight, colour and alignment;
  - **image:** student photo, logo, signature, seal, or an uploaded asset;
  - **qr:** the verification URL;
  - **rect** and **line**.
- **Designer:**
  - desktop (≥ 1024 px): drag, resize, a 0.5 mm snap, a property panel;
  - a live preview with a real student;
  - undo, and duplicating a preset into an editable template;
  - phones get a read-only preview.
- **ID cards:**
  - pick sections or students and a template;
  - print CR80 (one card per page, for card printers) or an A4 sheet (2 × 5, crop marks, back pages
    mirrored for duplex);
  - photos come by authenticated fetch (P2);
  - the QR holds a stable per-student code (decision S31).
- **Tests:** layout schema validation (unknown field, off-page element, oversize), presets seeded per
  type with no type check in code, the print geometry (CR80 85.6 × 54 mm, A4 sheet positions), and
  RLS.

## P9: Documents: issued register, QR verification, TC, testimonial, admit card, marksheet (scope 5)

- **Tables:**
  - `issued_documents` (S I, UPDATE by column for revoke, no DELETE):
    - kind, template id and version, student;
    - `serial_no` per kind and year, gap-free from `document_serial_counters`, like receipts;
    - `verify_code_hash`: SHA-256 of a random 128-bit code. The code itself is only in the QR.
    - `data` (a snapshot of what was printed), who and when;
    - revoked by, when and why; `reissue_of`.
  - `document_serial_counters` (S I U).
  - ID cards use one `issued_documents` row per student code, so a lost card is revoked by issuing
    a new one.
- **TC:**
  - for a leaver (from P5), or an active student who is leaving, which sets the leaving status;
  - date and reason of leaving, conduct, last class and exam;
  - a dues check: a warning plus a reason when dues are unpaid (decision S25);
  - the serial number and signatures.
- **Testimonial:** board exam details (exam, board, roll, registration, GPA, session) are typed at
  issue and kept in the snapshot.
- **Verification:**
  - `GET /public/verify/:code` calls `document_verify(code_hash)`, a definer function owned by the
    new NOLOGIN role `jantrik_verify`, with SELECT-only policies on `issued_documents`, the profile
    and student names.
  - It returns the institute, kind, serial, student name, class at issue, issue date, and
    VALID or REVOKED (decision S32 on privacy).
  - The web page `/v/[code]` is public, rate-limited per address and within the perf budget.
- **Admit cards (exams) and marksheet:**
  - Exam admit cards move to the designer (the data from the existing `admitCards` API).
  - The marksheet "layout" covers the header, footer, signatures and watermark. The marks table
    stays the data-driven component (decision S29).
- **Tests:**
  - serials gap-free under concurrency and rollback;
  - verification: unknown, revoked, another institute, and the rate limit;
  - a code never stored in plain text;
  - a TC for a student with dues needs a reason;
  - a snapshot unchanged after the student is edited.
- **Docs:** a new `docs/documents.md` and database.md.

---

## New tables at a glance

All tenant tables have forced RLS, `tenant_isolation` and composite keys. The detailed plan of each
phase gives the columns, CHECKs and column-level grants.

| Table                       | Phase | Grants (jantrik_app)         | Note                                                            |
| --------------------------- | ----- | ---------------------------- | --------------------------------------------------------------- |
| `institute_profiles`        | P2    | S I U                        | ≤ 1 per tenant                                                  |
| `stored_files`              | P2    | S I D                        | bytea, per-kind caps (S7)                                       |
| `stored_file_usage`         | P2    | S I U                        | ≤ 1 per tenant; bytes used, for the per-institute cap           |
| `admission_cycles`          | P3    | S I U                        |                                                                 |
| `admission_cycle_classes`   | P3    | S I U D                      | D restricted by applications                                    |
| `admission_applications`    | P3    | S I, U by column             | history; inserts from the public go through `jantrik_admission` |
| `admission_counters`        | P3    | S I U                        |                                                                 |
| `promotion_runs`            | P5    | S I U                        |                                                                 |
| `promotion_run_students`    | P5    | S I U D (D only while DRAFT) |                                                                 |
| `notices`                   | P6    | S I U                        | withdrawn, never deleted                                        |
| `notice_targets`            | P6    | S I D                        |                                                                 |
| `notice_reads`              | P6    | S I                          |                                                                 |
| `sms_broadcasts`            | P6    | S I U                        |                                                                 |
| `sms_broadcast_targets`     | P6    | S I D                        |                                                                 |
| `payment_gateway_accounts`  | P7a   | S I, U by column             | ciphertext read by one service only                             |
| `payment_intents`           | P7a   | S I, U by column             | history                                                         |
| `payment_intent_dues`       | P7a   | S I                          |                                                                 |
| `payment_gateway_events`    | P7a   | S I                          | append-only                                                     |
| `document_templates`        | P8    | S I U                        |                                                                 |
| `document_template_presets` | P8    | S (global)                   | seeded, keyed by institute type                                 |
| `issued_documents`          | P9    | S I, U by column             | history; read by `jantrik_verify` for verification              |
| `document_serial_counters`  | P9    | S I U                        |                                                                 |

**Changed tables:**

- `users.password_changed_at` (P1).
- `students`: `photo_file_id` and dropping `photo_url` (P2); `left_on` and `leave_reason` (P5).
- Fees: new `fee_payment_channel` and `fee_payment_method` values, and
  `fee_payments.payment_intent_id` (P7a).
- New `sms_purpose` values: `ADMISSION_OTP`, `ADMISSION_RESULT`, `BROADCAST`.

**New database roles** (NOLOGIN, NOBYPASSRLS; `jantrik_owner` may SET ROLE without inheriting):

- `jantrik_admission` (P3) and `jantrik_verify` (P9).
- Both go into `create-roles.sh`, the local init script, database.md's role table and the
  "existing local volume" commands.

**New module keys:** none by default (decision S3). Admission, promotion, notices and documents sit
under CORE. Online payments sit under FEES. Exam admit cards and the marksheet sit under EXAMS.

## Environment variables

Claude adds these to `.env.example` and deploy.md. **The owner fills `.env`; values never go in chat
or code.**

| Variable                                | Phase | Read by            | Notes                                                                                                                                                                      |
| --------------------------------------- | ----- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLATFORM_ORIGINS`                      | P0    | API                | comma-separated; required in production (`https://platform.<domain>`); default `http://localhost:3000`                                                                     |
| `REDIS_INGEST_PASSWORD`                 | P0    | production compose | the receiver's Redis ACL user `jantrik_ingest`; its `REDIS_URL` becomes `redis://jantrik_ingest:<password>@redis:6379`                                                     |
| `FILE_STORAGE_PER_TENANT_MB`            | P2    | API, worker        | optional, default 1024: the per-institute storage cap                                                                                                                      |
| `TURNSTILE_SECRET_KEY`                  | P3    | API                | Cloudflare's published test keys are used in development and CI                                                                                                            |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY`        | P3    | web (build)        | ditto                                                                                                                                                                      |
| `ADMISSION_OTP_PER_TENANT_PER_DAY`      | P3    | API                | optional, default 300                                                                                                                                                      |
| `WEB_PUBLIC_URL`                        | P3    | API                | links in SMS, the payer's return page, verification URLs; required in production                                                                                           |
| `API_PUBLIC_URL`                        | P7a   | API                | the return and IPN URLs given to SSLCommerz; required when a gateway account is enabled                                                                                    |
| `PAYMENT_CREDENTIALS_KEY`               | P7a   | API, worker        | ≥ 32 characters, required in production (development derives one from `OTP_PEPPER`, like `PLATFORM_TOTP_KEY`); changing it means re-entering every institute's credentials |
| **`SSLCOMMERZ_SANDBOX_STORE_ID`**       | P7a   | dev tools only     | the sandbox Store ID                                                                                                                                                       |
| **`SSLCOMMERZ_SANDBOX_STORE_PASSWORD`** | P7a   | dev tools only     | the sandbox Store Password                                                                                                                                                 |

**How the two sandbox variables are used.** Put both in the root `.env` (all apps read that one
file). They are not how institutes are configured: each institute's credentials live encrypted in
`payment_gateway_accounts` and are entered on its OWNER-only settings page. The two variables are
read only by:

- the opt-in smoke script;
- a development command, `pnpm --filter @jantrik/api payments:load-sandbox -- --tenant shapla-school`.
  The owner runs it themselves. It encrypts the two values onto the demo institute's account in
  the local database.

The API refuses to start in production with either variable set.

## What needs real accounts

| What                                       | Needed for                                                              | Without it                                                                                | Who                                                                                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **SSLCommerz sandbox store**               | P7a's opt-in smoke and trying a real sandbox payment by hand            | everything is built and tested against a fake server in CI                                | Owner: register a sandbox store on SSLCommerz's developer site (the official docs also point to their helpline), then fill the two variables |
| **A public HTTPS URL to the API**          | receiving the sandbox IPN (SSLCommerz cannot reach `localhost`)         | the browser return plus reconciliation still complete sandbox payments locally            | Owner: a tunnel (e.g. cloudflared) or the staging server                                                                                     |
| **Each institute's live merchant account** | going live (not this sprint)                                            | sandbox only                                                                              | Each institute, with SSLCommerz                                                                                                              |
| **An SMS gateway**                         | real OTPs (admission, staff password, every login), broadcasts, all SMS | development uses `console`/`outbox`; production sends nothing (a go-live blocker already) | Owner picks a gateway; the adapter is a small separate PR (decision S10)                                                                     |
| **Cloudflare Turnstile**                   | spam protection in production (P3)                                      | development and CI use Cloudflare's test keys                                             | Owner: a free Cloudflare account, one site                                                                                                   |
| **Object storage bucket**                  | only if S7 picks S3-compatible storage                                  | files in Postgres (default)                                                               | Owner                                                                                                                                        |
| bKash tokenized merchant                   | later sprint                                                            | —                                                                                         | —                                                                                                                                            |

## Decisions for the owner

**All 32 approved on 2026-11-14 as written below.** The owner's additions are folded into S3, S4,
S7, S22 and S23. The **blocks** column names the first phase that needs the answer.

| #   | Decision                                                       | Recommended default                                                                                                                                                                                                        | Blocks |
| --- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| S1  | Approval rhythm                                                | A short detailed plan per phase, approved before its code (CLAUDE.md: DB/auth/API need a plan)                                                                                                                             | P0     |
| S2  | Phase order and PR flow                                        | As in the table; each phase branched from `main` after the previous merge; P0/P1/P6 may run in parallel worktrees                                                                                                          | P0     |
| S3  | New billable module keys (ADMISSION, NOTICES, DOCUMENTS)?      | None now (CORE/FEES/EXAMS as above). Backlog: module keys (admission, notices, documents, online payments) must exist before the first paid invoice to any institute                                                       | P3     |
| S4  | How the public admission form reaches the database             | Definer functions under a new role `jantrik_admission` (DB-enforced): create and read back only the applicant's own application (plus the public form), never general tenant access; rate limits per address and per phone | P3     |
| S5  | Who pays admission OTP and notification SMS                    | The institute (its `sms_logs`, its daily cap)                                                                                                                                                                              | P3     |
| S6  | Spam protection                                                | Cloudflare Turnstile + honeypot + limits; alternative without an account: honeypot + timing + limits only (weaker against SMS pumping)                                                                                     | P3     |
| S7  | File storage                                                   | Postgres `stored_files` (RLS, existing backups) behind `FileStore`; server-side resize and compression; caps per file and per institute; R2/S3 later without changing callers                                              | P2     |
| S8  | New dependencies                                               | `sharp` (API); Turnstile script                                                                                                                                                                                            | P2     |
| S9  | Applicant photo online                                         | Optional per cycle (`collect_photo`), re-encoded, ≤ 200 KB stored                                                                                                                                                          | P3     |
| S10 | SMS gateway adapter this sprint                                | Only once you pick a gateway and have an account; a separate small PR                                                                                                                                                      | —      |
| S11 | SMS to the applicant after submit                              | Yes, one SMS with the application number (plus the on-screen slip)                                                                                                                                                         | P3     |
| S12 | Admission test marks                                           | One total per applicant (per-subject later)                                                                                                                                                                                | P4     |
| S13 | Applicant result lookup                                        | Application number + phone OTP; alternative: + date of birth (no SMS cost, guessable)                                                                                                                                      | P4     |
| S14 | Leavers                                                        | A status (GRADUATED/TRANSFERRED/DROPPED_OUT/INACTIVE) with date and reason; never soft-deleted                                                                                                                             | P5     |
| S15 | Sections and roll order in the new year                        | Same section name; rolls: promoted (by strategy), then repeaters, then new admits                                                                                                                                          | P5     |
| S16 | What "copy fee setup" copies                                   | Amounts + terms moved one year; running concessions optional, off by default                                                                                                                                               | P5     |
| S17 | Carrying dues forward                                          | Nothing moves: old-year dues stay and show as "previous years"; plus a leavers-with-dues report                                                                                                                            | P5     |
| S18 | Broadcast over the cap left                                    | All or nothing: refused at preview, failed at send time with nothing sent; quiet hours 21:00–08:00                                                                                                                         | P6     |
| S19 | Broadcast audience for a scheduled send                        | Resolved at send time (the preview count is an estimate)                                                                                                                                                                   | P6     |
| S20 | Who may publish notices and send broadcasts                    | OWNER/ADMIN; teachers to their own sections later                                                                                                                                                                          | P6     |
| S21 | Payment methods for gateway payments                           | Add `ROCKET`, `CARD`, `OTHER_ONLINE` to `fee_payment_method`; channel `GATEWAY` (reports by method keep working)                                                                                                           | P7a    |
| S22 | Online amounts                                                 | Guardians pay selected dues in full only, computed by the server; no free-typed amount; no staff payment links                                                                                                             | P7a    |
| S23 | Risky payments and mismatches                                  | Flagged as risky by SSLCommerz, or any mismatch in amount, currency or transaction ID: review queue, never posted automatically                                                                                            | P7a    |
| S24 | Gateway charges                                                | The institute bears them (a surcharge is a pricing/legal question for later)                                                                                                                                               | P7a    |
| S25 | A TC for a student with unpaid dues                            | Allowed with a warning and a required reason (not blocked)                                                                                                                                                                 | P9     |
| S26 | Staff password rules                                           | 10–128 characters, not the phone number, not in a common-password list; a fresh OTP to set or change; other sessions revoked                                                                                               | P1     |
| S27 | Keep the Caddy `Origin` rule after the guard check             | Keep (two layers)                                                                                                                                                                                                          | P0     |
| S28 | A person who is staff and guardian, signing in with a password | The password reaches all their memberships (same person)                                                                                                                                                                   | P1     |
| S29 | Marksheet "layout"                                             | Header, footer, signatures, watermark; the marks table stays data-driven                                                                                                                                                   | P9     |
| S30 | Rejected applications' personal data                           | Kept 12 months after the cycle closes, then cleared by a job (later in the sprint or next)                                                                                                                                 | P3     |
| S31 | ID card QR                                                     | A stable code per student, revoked on reissue; cards print front and back                                                                                                                                                  | P8     |
| S32 | What the public verification page shows                        | Institute, kind, serial, student name, class at issue, issue date, VALID/REVOKED; no photo, DOB or phone                                                                                                                   | P9     |

## How each phase runs

1. Branch `feature/sprint-1-pN-<name>` from an up-to-date `main`.
2. Write `docs/plans/sprint-1-pN-<name>.md` (the writing-plans format, TDD tasks), then wait for
   approval.
3. Build task by task. Each task: a failing test, the code, a passing test, a commit. Run only the
   affected tests.
4. Run the full gates: `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, `pnpm test`, `pnpm build`
   and `pnpm e2e` (Docker up; stop the dev servers on 3000/4000 first).
5. The review subagent (security, auth, RLS, money, DB). Fix what it finds and run the gates again.
6. Open the PR (push with the gh credential helper). CI must be green.
7. Report: files changed, how to run it, what is left, and new decisions (decisions-pending.md).

## Risks

- **Running late.** If the sprint runs late, P8 and P9 move to Sprint 2 (the owner's rule). Tests
  are never reduced to save time.
- **Size.** P3, P5, P7a, P8 and P9 are each a large PR. If a detailed plan shows one is bigger than
  a reviewer can hold, it splits before building.
- **The admission season.** If P3 slips, the fallback is today's staff-entered admission. Nothing
  else changes.
- **No SMS gateway.** OTP-based features work only in development and CI until there is one, so
  P1 and P3 cannot be used in production before the gateway exists. This blocker exists today too.
- **SSLCommerz specifics** (session API fields, IPN behaviour, validation statuses, the per-session
  `ipn_url`) were taken from the developer docs on 2026-11-14 and are re-checked against the docs
  and the sandbox at P7a's start.
- **`statement_timeout` of 5 s** leaves about 2.5× the measured time of the largest upload. A slow
  database turns big uploads into device retries (no loss); watch the receiver's 500s after deploy.
- **Postgres file storage** grows backups (about 100 MB per 2 000 photos). If it grows past what
  the backup window allows, `FileStore` moves to a bucket.

## Sources

- SSLCommerz developer documentation: [docs v3.5](https://developer.sslcommerz.com/docs.html),
  [v4](https://developer.sslcommerz.com/doc/v4/), [order validation](https://sandbox-gw.sslcommerz.com/doc/v4/order-validation.html).
- In this repository: CLAUDE.md, database.md, auth.md, platform.md, fees.md, backlog.md (the bKash
  plan this payment design follows), deploy.md ("What needs the owner") and decisions-pending.md
  (#79, D9, "recorded, not built").

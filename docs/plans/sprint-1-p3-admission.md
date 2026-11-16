# Sprint 1, P3: online admission (implementation plan)

**Status: plan only (day run 2026-11-16), not approved, no code yet.** Written while the owner was
away. The sprint plan's P3 section ([sprint-1.md](sprint-1.md) → "P3: Admission") and decisions
S1–S32 are approved and binding; this plan does not reopen them. What this plan adds is listed in
"Decisions for the owner" at the end, each with a recommended default. Nothing here is built until
the owner approves it (S1).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.
> One review subagent per PR (public surface, database, OTP).

**Goal:** a guardian applies for a child from a phone, without an account, during an institute's
admission window. Staff see the applications, shortlist or reject them, and approve them into a
student and guardian with today's `admit()`. A child admitted in December for January is not
charged a late admission fee.

**Architecture:**

- **Staff side (P3a):** five new tenant tables behind a `AdmissionModule` under `CORE` (S3),
  OWNER/ADMIN only. Approval runs in the staff member's own request transaction and calls
  `StudentAdminService.admit()` unchanged. Bulk approval is a queue job acting as that admin.
- **Public side (P3b):** `@Public()` routes under `/public/admission/:slug`. They never open a tenant
  transaction. The database is reached only through three `SECURITY DEFINER` functions owned by
  the new NOLOGIN role `jantrik_admission`, executable by `jantrik_app` only (S4). The applicant's
  phone is proved by a code (Redis, HMAC) and then carried in a 30-minute signed token. Turnstile,
  a honeypot and a minimum fill time guard the two SMS-costing or writing steps (S6).
- **SMS:** the admission code and the "application received" SMS are sent by worker jobs that open
  the institute's context themselves (`TenantJobRunner`), from ids our own code resolved; they
  are logged in that institute's `sms_logs` (S5).

**Tech stack:** NestJS, Prisma/PostgreSQL 16, Redis + BullMQ, `sharp` (from P2), Next.js (v3 kit,
`(public)` route group), next-intl, Vitest, Playwright. Cloudflare Turnstile as a script only.

**Spec:** sprint-1.md → P3; S3, S4 (with the owner's rule), S5, S6, S9, S11, S30; review focus 3
and 5.

**Branches:** `feature/sprint-1-p3a-admission-staff` from `main` after P2 is merged, then
`feature/sprint-1-p3b-admission-public` from `main` after P3a is merged (decision P3-A).

## What exists today (verified 2026-11-16 on `main` at `7de4f5a`)

- **Admission by staff:** `StudentAdminService.admit()` at
  `apps/api/src/students/student-admin.service.ts:104`.
  - It runs in the request transaction (`Db.tx`), checks the student limit under a per-institute
    advisory lock (`assertStudentLimit`, `:159`, lock class 4201), the year, class, section,
    capacity and roll (`checkEnrolment`, `:177`), and that the birth registration number and
    student code are unused (`checkUnique`, `:251`).
  - It takes `StudentFieldsInput & { guardians, enrolment }` (`:12-61`). There is **no
    "previous institute" field** in `admit()` or in `students` (`schema.prisma:998-1043`), although
    the sprint plan lists it among "the student fields that `admit()` takes" (decision P3-I).
  - `students.photo_url` (`schema.prisma:1007`) is unused; P2 replaces it with `photo_file_id`.
- **Guardians:** `GuardianLinker.findOrCreate()` (`apps/api/src/students/guardian-linker.service.ts:82`)
  throws 409 `GUARDIAN_CHOICE_REQUIRED` (`:112`) when guardians of the institute already have the
  phone and the caller chose neither `guardianId` nor `createNew`. `GET /guardians?phone=` lists
  the matches (`apps/api/src/students/students.module.ts:430-440`). The approve dialog reuses both.
- **Public requests:** `TenantContextInterceptor` opens no transaction without a principal
  (`apps/api/src/tenancy/tenant-context.interceptor.ts:33`), so `Db.tx`, `admit()` and
  `TenantSmsService` cannot run in a `@Public()` route.
- **Background work for a tenant:** `TenantJobRunner.run(tenantId, fn, { actorUserId })`
  (`apps/api/src/tenancy/tenant-job-runner.service.ts:32`) runs a job exactly like a request; the
  tenant id must come from our own enqueued value. The student import job runs chunk by chunk as
  the admin who started it (`apps/api/src/imports/imports.module.ts:150-176`, `CHUNK = 25` at `:50`).
- **OTP:** `OtpService` (`apps/api/src/auth/otp.service.ts`) keeps codes in Redis as
  HMAC-SHA256(`OTP_PEPPER`, purpose:phone:code) (`:129`), 5 minutes, 5 attempts, single use even
  under races (`:119`). Its limits use `RateLimiter.consume` (`apps/api/src/redis/rate-limiter.service.ts:53`,
  keys `rl:<key>`, 429 with `Retry-After`). It only sends to phones that belong to a user, so it
  cannot be reused for applicants as is.
- **SMS:**
  - `SmsService.send()` (`apps/api/src/sms/sms.service.ts:38`) queues platform SMS (the login code)
    with the text in the job, `removeOnComplete`/`removeOnFail`; logged in `platform_sms_logs`
    without the body.
  - `TenantSmsService.queue()` (`apps/api/src/sms/tenant-sms.service.ts:91`) needs `Db.tx`; it takes a
    per-tenant advisory lock, dedupes by key, counts today's QUEUED/SENT rows against `dailyCap`
    (`HOLD` or `SKIP`, `:35`), stores the body in `sms_logs`, and its job carries only
    `{ tenantId, smsLogId }` (`:11-16`): the worker sends the stored body
    (`sms.service.ts:151-170`). A masked OTP body therefore cannot go through that job as is.
  - The cap comes from `AttendanceSettingsService.smsDailyCap()`
    (`apps/api/src/attendance/attendance-settings.service.ts:195`).
  - `sms_purpose` has `ATTENDANCE_ABSENT, FEE_RECEIPT, FEE_REMINDER, EXAM_RESULT, ATTENDANCE_ENTRY,
ATTENDANCE_EXIT` (`schema.prisma:306-319`).
- **Definer functions:**
  - `auth_resolve_tenant(p_slug)` resolves a slug before any context
    (`packages/db/prisma/migrations/20261017054031_auth_sessions_and_definer_functions/migration.sql:154`).
  - The device receiver's functions are the model for a no-context surface: owned by NOLOGIN
    `jantrik_ingest`, which sees rows only through `TO jantrik_ingest` policies with column grants
    (`…/20261029000000_devices/migration.sql:381-421`), take a serial and `p_now`, resolve the tenant
    themselves, and hand ownership over after granting EXECUTE
    (`…/20261029000100_devices_ingest_functions/migration.sql:318-335`).
  - `packages/db/test/schema-safety.test.ts` enforces: search_path pinned with `pg_temp` last and no
    PUBLIC execute (`:140`); **no definer function takes a tenant id or any `uuid` parameter**
    (`:163-172`, platform functions excepted); every other definer function is scoped by
    `app_current_tenant_id()`/`app_current_user_id()` except listed pre-context lookups (`:131`,
    `:174-188`); ingest functions have their own ownership and EXECUTE checks (`:256-322`).
    `admission_submit` takes a `uuid` (the cycle class), so it is a listed exception, as the sprint
    plan says.
- **Fees and the admission date:** dues are generated for the current year only
  (`apps/api/src/fees/dues/fee-dues.service.ts:98`); the admission date is
  `todayIn(timezone, students.created_at)` (`:230`). In `planStudentDues`
  (`packages/shared/src/fees.ts:379`) a ONE_TIME head is charged only when
  `admittedOn >= one_time_from` and is due `admittedOn + due_offset_days` (`:392-407`); a recurring
  period gets 7 extra days only when `admittedOn > periodStart` (`:417-419`). A one-time due is
  unique per student and head, ever (`fee_dues_one_time_once`, `schema.prisma:2515`).
  - So a child admitted on 10 December 2026 into the 2027 year gets, once 2027 is current, an
    admission fee due on 25 December 2026 (already late, fined from then), or none at all when
    `one_time_from` is 1 January 2027. This is review focus 5.
- **Web:** the `(public)` group holds only `/login` (`apps/web/src/app/(public)/layout.tsx`, route
  namespace `login`). The size budget is in `apps/web/perf/budget.json` (`/login`: 246 KB). There is
  no Content-Security-Policy header, so the Turnstile script needs no CSP change.
- **P0 (merged, #12):** the API refuses a database login that can become a superuser, a BYPASSRLS
  role or the `pg_*` data roles (`packages/db/src/login-privileges.ts:40-49`). The new role is
  NOLOGIN and NOBYPASSRLS, so nothing changes there, but `jantrik_app` must never be granted it
  (tested in Task 7).

## What P3 needs from P2

- `ImageProcessor` (or whatever P2 names its `sharp` pipeline): re-encode an upload to a JPEG
  ≤ 600×800 and ≤ 200 KB with EXIF stripped and `limitInputPixels`. P3 uses it for the applicant
  photo before the bytes reach the database.
- `FileStore.put({ kind: 'STUDENT_PHOTO', … })` and the "set a student's photo" service, used at
  approval to move the applicant's photo to the new student (decision P3-B).
- `institute_profiles.name_bn/name_en` for the public form's heading (falls back to
  `tenants.name`).
- If P2 is not merged when P3a starts, P3a still builds; Task 6's photo move is the only part that
  waits.

## Global constraints

- **Module and roles:** staff routes `@RequireModule('CORE')`, `@Roles('OWNER','ADMIN')` (S3). Public
  routes `@Public()`; the definer functions check the institute is `ACTIVE` or `TRIAL`.
- **Tables:** the database.md checklist for every table (see "Database"). History stays: no DELETE
  on applications; statuses change with who, when and why.
- **No tenant transaction on a public route.** Public services use `PrismaService.client` only to
  call the three functions, outside any transaction. A code-scan test enforces that files under
  `apps/api/src/admission/public/` never import `Db`, `TenantJobRunner` or `TenantSmsService`.
- **Times:** `p_now` comes from the API's clock (`Clock`, which honours `JANTRIK_TEST_TODAY` in
  tests); windows are `opens_at <= now < closes_at`. "Today" for SMS and counters is the
  institute's local date.
- **Money (review focus 5):** the dues rule change has its own unit and API tests and is reviewed
  as a money change.
- **Personal data:** phones, names and birth registration numbers never appear in logs, job
  payloads (except the code job's phone, as the login code's job has today), Redis keys other than
  rate-limit keys (which already hold phones today) or error messages.
- **Strings:** bn and en through route namespaces (`admission` for staff, `apply` for the public
  pages). Bangla digits accepted in phone, birth registration, code and roll inputs
  (`toAsciiDigits`, `normalizeBdPhone`); ASCII digits shown for phones, application numbers, rolls
  and birth registration numbers.
- **Gates:** affected tests during the work; at the end of each PR the full gates (lint, typecheck,
  format, all tests, build, Playwright), then the review subagent, then the PR with CI green.

## Review focus

1. **SMS pumping through the admission code** (sprint review focus 3). Many phones from rotating
   addresses. Expected: the per-institute daily ceiling holds whatever the addresses; no code is
   sent without a Turnstile pass. Test: Task 9 (50 phones from 10 addresses against a ceiling of
   20).
2. **Students admitted in December for January** (sprint review focus 5). Expected: the one-time
   and first-period due dates count from the year's start; a promoted student is never charged a
   one-time fee again. Test: Task 2.
3. **Cross-institute.** A `cycle_class_id` of institute B sent with institute A's slug, A's phone
   token used at B, B's application number looked up at A. Expected: refused with the same answer
   as an unknown class, nothing written, nothing read. Test: Tasks 8 and 9.
4. **The new role cannot widen anyone's view.** `jantrik_app` and `jantrik_platform_app` are not
   members of `jantrik_admission`; `jantrik_owner` may SET ROLE to it but does not inherit it; the
   `TO jantrik_admission` policies never apply to `jantrik_app`. Test: Task 7.
5. **One application, one student.** Two admins approve the same application, or approve one while
   bulk approval runs. Expected: one student, the other request 409. Test: Tasks 5 and 6.
6. **Token confusion.** An admission token presented as an access token, an access token presented
   as an admission token, a token for another institute, an expired token. Expected: 401 each.
   Test: Task 9.
7. **Image upload on a public route.** A 5 MB upload, a decompression bomb, a non-image, many
   uploads at once. Expected: refused before decoding where possible, decoding bounded, at most two
   decodes at a time per API process. Test: Task 10.

## Database

### New enums

- `admission_cycle_status`: `DRAFT | OPEN | CLOSED`.
- `admission_application_status`: `SUBMITTED | SHORTLISTED | SELECTED | WAITLISTED | REJECTED |
ADMITTED | WITHDRAWN`.
- `admission_source`: `ONLINE | STAFF` (decision P3-J).
- `sms_purpose` gains `ADMISSION_OTP` and `ADMISSION_SUBMITTED` (decision P3-E), in their own
  migration (a new value cannot be used in the transaction that adds it).

### `admission_cycles` (tenant table; jantrik_app S I U)

| Column                              | Type                    | Rule                                                                                           |
| ----------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| `id`                                | uuid (v7)               | PK                                                                                             |
| `tenant_id`                         | uuid NOT NULL           | FK tenants                                                                                     |
| `academic_year_id`                  | uuid NOT NULL           | composite FK `(tenant_id, academic_year_id)` → academic_years, ON UPDATE/DELETE RESTRICT       |
| `name_bn` / `name_en`               | text / text NULL        | CHECK `char_length(name_bn) BETWEEN 1 AND 80`, `name_en IS NULL OR char_length(name_en) <= 80` |
| `status`                            | admission_cycle_status  | default DRAFT                                                                                  |
| `opens_at` / `closes_at`            | timestamptz(3) NOT NULL | CHECK `closes_at > opens_at`                                                                   |
| `public_note_bn` / `public_note_en` | text NULL               | CHECK each `IS NULL OR char_length(…) <= 1000`                                                 |
| `requires_test`                     | boolean NOT NULL        | default false (P4 uses it)                                                                     |
| `collect_photo`                     | boolean NOT NULL        | default false (S9)                                                                             |
| `fields`                            | jsonb NOT NULL          | default `'{}'`; CHECK below                                                                    |
| `created_by`                        | uuid NULL               | the admin (no FK to users: users are global, as `audit_logs.user_id`)                          |
| `created_at` / `updated_at`         | timestamptz(3)          | as usual                                                                                       |

- `fields` CHECK: `jsonb_typeof(fields) = 'object' AND (fields - ARRAY['photo','religion',
'blood_group','birth_registration_no','previous_institute','present_address',
'permanent_address','father_name','mother_name','guardian_occupation']) = '{}'::jsonb AND NOT
jsonb_path_exists(fields, '$.* ? (@ != "HIDDEN" && @ != "OPTIONAL" && @ != "REQUIRED")')`
  (`jsonb_path_exists` is immutable, so it may sit in a CHECK). Defaults per key are in
  `packages/shared/src/admission.ts` (decision P3-Q).
- `@@unique([tenantId, id])`; index `(tenant_id, academic_year_id, status)`.
- Checklist: tenant_id NOT NULL ✓, `(tenant_id, id)` unique ✓, composite FKs ✓, ON UPDATE RESTRICT ✓,
  leading index ✓, RLS enabled + forced + `tenant_isolation` ✓, explicit grants ✓,
  schema-safety list ✓, isolation test ✓.

### `admission_cycle_classes` (tenant table; jantrik_app S I U D)

| Column           | Type             | Rule                                                                |
| ---------------- | ---------------- | ------------------------------------------------------------------- |
| `id`             | uuid (v7)        | PK                                                                  |
| `tenant_id`      | uuid NOT NULL    |                                                                     |
| `cycle_id`       | uuid NOT NULL    | composite FK → admission_cycles, RESTRICT                           |
| `class_level_id` | uuid NOT NULL    | composite FK → class_levels, RESTRICT                               |
| `study_group_id` | uuid NULL        | composite FK `(tenant_id, study_group_id)` → study_groups, RESTRICT |
| `seats`          | int NULL         | CHECK `seats IS NULL OR seats BETWEEN 1 AND 5000`                   |
| `is_open`        | boolean NOT NULL | default true                                                        |
| timestamps       |                  |                                                                     |

- `@@unique([tenantId, id])`, `@@unique([tenantId, id, cycleId])` (target of the applications'
  composite FK, so an application's class always belongs to its cycle), UNIQUE
  `(tenant_id, cycle_id, class_level_id, study_group_id) NULLS NOT DISTINCT`, index
  `(tenant_id, cycle_id)`.
- DELETE is granted; the applications' FK (RESTRICT) refuses deleting a class that has any.
- Checklist ✓ as above.

### `admission_applications` (tenant table; jantrik_app S I, UPDATE by column, no DELETE)

| Column                                    | Type                         | Rule                                                                                            |
| ----------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `id`                                      | uuid (v7)                    | PK                                                                                              |
| `tenant_id`                               | uuid NOT NULL                |                                                                                                 |
| `cycle_id`, `cycle_class_id`              | uuid NOT NULL                | composite FK `(tenant_id, cycle_class_id, cycle_id)` → admission_cycle_classes, RESTRICT        |
| `application_no`                          | text NOT NULL                | CHECK `~ '^[0-9]{4}-[0-9]{4,6}$'`; UNIQUE `(tenant_id, application_no)` (decision P3-G)         |
| `source`                                  | admission_source NOT NULL    |                                                                                                 |
| `name_bn`, `name_en`                      | text NULL                    | CHECK at least one IS NOT NULL; each ≤ 100                                                      |
| `name_key`                                | text NOT NULL                | lower-cased NFC name without spaces, for duplicate checks (written by the function and the API) |
| `date_of_birth`                           | date NOT NULL                | CHECK `date_of_birth BETWEEN '1990-01-01' AND '2100-01-01'`                                     |
| `gender`                                  | gender NOT NULL              |                                                                                                 |
| `religion`, `blood_group`                 | enums NULL                   |                                                                                                 |
| `birth_registration_no`                   | text NULL                    | CHECK `IS NULL OR ~ '^[0-9]{17}$'`                                                              |
| `previous_institute`                      | text NULL                    | ≤ 150 (decision P3-I)                                                                           |
| `present_address`, `permanent_address`    | text NULL                    | ≤ 500 each                                                                                      |
| `father_name_bn/en`, `mother_name_bn/en`  | text NULL                    | ≤ 100 each                                                                                      |
| `guardian_name_bn`, `guardian_name_en`    | text NULL                    | at least one IS NOT NULL                                                                        |
| `guardian_relation`                       | guardian_relation NOT NULL   |                                                                                                 |
| `guardian_occupation`                     | text NULL                    | ≤ 100                                                                                           |
| `phone`                                   | text NOT NULL                | CHECK `~ '^\+8801[3-9][0-9]{8}$'` (E.164, as `normalizeBdPhone` returns)                        |
| `status`                                  | admission_application_status | default SUBMITTED                                                                               |
| `status_reason`                           | text NULL                    | ≤ 500; CHECK `status NOT IN ('REJECTED','WITHDRAWN') OR status_reason IS NOT NULL`              |
| `status_by`, `status_at`                  | uuid NULL, timestamptz NULL  | CHECK both NULL or both set                                                                     |
| `staff_note`                              | text NULL                    | ≤ 2000                                                                                          |
| `student_id`                              | uuid NULL                    | composite FK → students, RESTRICT; UNIQUE `(tenant_id, student_id)`                             |
| `approval_problem`, `approval_problem_at` | text NULL, timestamptz NULL  | CHECK `IN ('GUARDIAN_CHOICE_REQUIRED','STUDENT_LIMIT','SECTION_FULL','DUPLICATE','INACTIVE')`   |
| `submitted_at`                            | timestamptz(3) NOT NULL      |                                                                                                 |
| timestamps                                |                              |                                                                                                 |

- CHECK `(status = 'ADMITTED') = (student_id IS NOT NULL)`.
- Indexes: `(tenant_id, cycle_id, status)`, `(tenant_id, phone)`,
  `(tenant_id, cycle_id, birth_registration_no) WHERE birth_registration_no IS NOT NULL`,
  `(tenant_id, cycle_class_id)`, and a trigram index on `name_key` only if the list's search is
  slow at 2 000 rows (measured in Task 4, not assumed).
- Grants: `SELECT, INSERT` and `UPDATE (name_bn, name_en, name_key, date_of_birth, gender,
religion, blood_group, birth_registration_no, previous_institute, present_address,
permanent_address, father_name_bn, father_name_en, mother_name_bn, mother_name_en,
guardian_name_bn, guardian_name_en, guardian_relation, guardian_occupation, phone,
cycle_class_id, status, status_reason, status_by, status_at, staff_note, student_id,
approval_problem, approval_problem_at, updated_at)`. Not `application_no`, `source`, `cycle_id`,
  `submitted_at`, `tenant_id`.
- Checklist ✓ as above, plus "history table: no DELETE" ✓.

### `admission_application_photos` (tenant table; jantrik_app S I D) (decision P3-B)

| Column           | Type              | Rule                                             |
| ---------------- | ----------------- | ------------------------------------------------ |
| `tenant_id`      | uuid NOT NULL     | PK `(tenant_id, application_id)`                 |
| `application_id` | uuid NOT NULL     | composite FK → admission_applications, RESTRICT  |
| `mime`           | text NOT NULL     | CHECK `= 'image/jpeg'`                           |
| `bytes`          | bytea NOT NULL    | CHECK `octet_length(bytes) BETWEEN 1 AND 204800` |
| `sha256`         | text NOT NULL     | CHECK `~ '^[0-9a-f]{64}$'`                       |
| `width`/`height` | smallint NOT NULL | CHECK `BETWEEN 1 AND 800`                        |
| `created_at`     | timestamptz(3)    |                                                  |

- The composite primary key doubles as the `(tenant_id, …)` unique key and the leading index.
- Inserted by `admission_submit` (as `jantrik_admission`) and by the staff-entered path (Task 5, as
  `jantrik_app`, after the same re-encoding); deleted when the photo moves to the student.
- Checklist ✓ (no `id` column: the application is the key).

### `admission_counters` (tenant table; jantrik_app S I U)

- `tenant_id`, `year smallint` (CHECK 2000–2100), `last_no int NOT NULL DEFAULT 0` (CHECK 0–999999),
  PK `(tenant_id, year)`, timestamps. Numbers are `<year>-<NNNN>` (four digits, more past 9999).
- Checklist ✓.

### Database roles and the public functions (P3b)

- **Role** (outside migrations; `jantrik_owner` cannot create roles):
  `CREATE ROLE jantrik_admission NOLOGIN NOSUPERUSER NOBYPASSRLS;
GRANT jantrik_admission TO jantrik_owner WITH INHERIT FALSE, SET TRUE;` in
  `docker/postgres/init/01-roles.sh`, `deploy/postgres/create-roles.sh` (idempotent, like the
  others), database.md's role table and its "existing local volume" commands. The first P3b
  migration starts with a guard that raises "create the role first (docs/database.md)" when the
  role is missing (decision P3-P).
- **Grants and policies** (all `USING (true)` / `WITH CHECK (true)` for that role only, as the
  receiver's; the functions scope every statement by the tenant they resolved):

  | Table                          | Column grants to `jantrik_admission`                                                                                                                                                                                                            | Policies TO jantrik_admission |
  | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
  | `tenants`                      | SELECT `(id, slug, name, status, timezone, default_locale)`                                                                                                                                                                                     | read                          |
  | `institute_profiles` (P2)      | SELECT `(tenant_id, name_bn, name_en)`                                                                                                                                                                                                          | read                          |
  | `academic_years`               | SELECT `(tenant_id, id, start_date)`                                                                                                                                                                                                            | read                          |
  | `class_levels`, `study_groups` | SELECT `(tenant_id, id, name_bn, name_en, is_active)`                                                                                                                                                                                           | read                          |
  | `admission_cycles`             | SELECT (all)                                                                                                                                                                                                                                    | read                          |
  | `admission_cycle_classes`      | SELECT (all)                                                                                                                                                                                                                                    | read                          |
  | `admission_applications`       | SELECT `(tenant_id, id, cycle_id, cycle_class_id, application_no, phone, name_key, name_bn, name_en, date_of_birth, birth_registration_no, status, submitted_at)`, INSERT (all but `student_id`, `status_*`, `staff_note`, `approval_problem*`) | read, insert                  |
  | `admission_application_photos` | INSERT (all)                                                                                                                                                                                                                                    | insert                        |
  | `admission_counters`           | SELECT, INSERT, UPDATE `(last_no, updated_at)`                                                                                                                                                                                                  | read, insert, update          |

- **Functions** (owned by `jantrik_admission`, `SECURITY DEFINER`, `SET search_path = pg_catalog,
public, pg_temp`, `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO jantrik_app` before
  `OWNER TO`):
  1. `admission_public_form(p_slug text, p_now timestamptz) RETURNS jsonb`
     - NULL for an unknown slug or an institute not `ACTIVE`/`TRIAL`.
     - Otherwise `{ institute: { nameBn, nameEn, locale }, cycles: [ { nameBn, nameEn, closesAt,
noteBn, noteEn, collectPhoto, fields, classes: [ { cycleClassId, classNameBn, classNameEn,
groupNameBn, groupNameEn } ] } ] }` with only cycles `OPEN` and inside the window at
       `p_now`, and only classes `is_open` whose class level (and group) is active. No person
       data. An empty `cycles` means "not open now".
  2. `admission_submit(p_slug text, p_cycle_class_id uuid, p_phone text, p_payload jsonb,
p_photo bytea, p_photo_sha256 text, p_photo_width int, p_photo_height int, p_now timestamptz)
RETURNS TABLE (outcome text, application_no text, tenant_id uuid, application_id uuid)`.
     Always one row. In order:
     - resolve the slug (`ACTIVE`/`TRIAL`, else `UNKNOWN`);
     - the class must be this tenant's, open, in an `OPEN` cycle inside the window at `p_now`
       (else `CLOSED`, the same for another institute's class id);
     - `p_phone` must match the E.164 pattern; `p_payload` keys must be in the whitelist and the
       cycle's `REQUIRED` fields present (else `INVALID`); a photo only when `collect_photo`, and
       required when `fields.photo = 'REQUIRED'`;
     - `pg_advisory_xact_lock(hashtextextended('admission:' || tenant || ':' || phone, 0))`;
     - duplicates in the cycle (status not `WITHDRAWN`): the same birth registration number, or
       the same phone + `name_key` + date of birth → `DUPLICATE` with that application's number
       (decision P3-S);
     - more than 2 live applications of this phone in the cycle → `PHONE_CAP` (3 per phone per
       cycle);
     - the next number: `INSERT INTO admission_counters … ON CONFLICT (tenant_id, year) DO UPDATE
SET last_no = admission_counters.last_no + 1 RETURNING last_no`, year = the cycle's
       academic year's start year;
     - insert the application (`source ONLINE`, `status SUBMITTED`, `submitted_at = p_now`) and
       the photo row; `CREATED`.
  3. `admission_lookup(p_slug text, p_application_no text, p_phone text) RETURNS jsonb`
     - NULL unless the slug resolves and an application with that number has exactly that phone.
     - Otherwise `{ applicationNo, status, nameBn, nameEn, classNameBn, classNameEn,
groupNameBn, groupNameEn, cycleNameBn, cycleNameEn, submittedAt }`. `jsonb`, so P4 adds the
       published result without changing the signature.
- **schema-safety additions:** an `isAdmission` group like `isIngest`: owned by
  `jantrik_admission`; EXECUTE for `jantrik_app` only (not `jantrik_platform_app`, not
  `jantrik_ingest_app`, not PUBLIC); `ADMISSION_UUID_ARGS = ['admission_submit']` with the reason
  ("the cycle class is checked against the slug inside"); the group is excluded from the
  "scoped by context" list with that reason; `jantrik_admission`'s table and column privileges
  equal exactly the table above (a snapshot test, so any widening fails CI).

### Migrations, in order

P3a:

1. `…_sms_purpose_admission`: `ALTER TYPE sms_purpose ADD VALUE 'ADMISSION_OTP';` and
   `'ADMISSION_SUBMITTED'` (nothing else).
2. `…_admission_tables`: the three enums, the five tables, CHECKs, indexes, RLS, grants.

P3b:

3. `…_admission_public_access`: the role guard, `GRANT USAGE, CREATE ON SCHEMA public TO
jantrik_admission`, the column grants and policies above.
4. `…_admission_public_functions`: the three functions, `REVOKE`/`GRANT EXECUTE`, `OWNER TO
jantrik_admission`.

Each is written by hand (or with `migrate dev --create-only` once against a scratch database),
checked for drift with `prisma migrate diff`, and applied to a scratch test database only.

## API

### Staff (P3a), all `@RequireModule('CORE')`, `@Roles('OWNER','ADMIN')`

| Route                                            | Does                                                                      | Errors                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GET /admission/cycles`                          | cycles with counts per status                                             |                                                                                                               |
| `POST /admission/cycles`                         | create (DRAFT)                                                            | 422 validation; 404 year                                                                                      |
| `PATCH /admission/cycles/:id`                    | edit (names, window, notes, flags, fields)                                | 409 `CYCLE_HAS_APPLICATIONS` when turning `requires_test` or the year after applications exist                |
| `POST /admission/cycles/:id/status`              | `{status: OPEN \| CLOSED \| DRAFT}`                                       | 422 `CYCLE_HAS_NO_CLASSES` (opening without classes)                                                          |
| `PUT /admission/cycles/:id/classes`              | replace the class list (add, edit seats/open, remove empty ones)          | 409 `CLASS_HAS_APPLICATIONS`; 422 inactive class/group                                                        |
| `GET /admission/applications`                    | filters cycle, class, status, source; search name, phone, number; pages   |                                                                                                               |
| `GET /admission/applications.csv`                | the same filter as CSV (UTF-8 with BOM, ASCII digits for ids)             |                                                                                                               |
| `POST /admission/applications`                   | staff-entered application (decision P3-J), multipart with optional photo  | 409 `ADMISSION_DUPLICATE` (shows the number); 422 `ADMISSION_PHONE_CAP`                                       |
| `GET /admission/applications/:id`                | detail + `possibleDuplicates` (students with the same birth registration) | 404                                                                                                           |
| `PATCH /admission/applications/:id`              | edit fields (audited old/new)                                             | 409 `APPLICATION_ADMITTED` (no edits after approval)                                                          |
| `POST /admission/applications/:id/status`        | `{status: SUBMITTED \| SHORTLISTED \| REJECTED \| WITHDRAWN, reason?}`    | 422 `REASON_REQUIRED`; 409 `APPLICATION_ADMITTED`                                                             |
| `GET /admission/applications/:id/photo`          | the applicant photo (`ETag`, `Cache-Control: private`)                    | 404                                                                                                           |
| `POST /admission/applications/:id/approve`       | `{sectionId?, roll?, studentCode?, guardianId?, createNew?}` → `admit()`  | 409 `APPLICATION_NOT_APPROVABLE`, `ALREADY_ADMITTED`, `GUARDIAN_CHOICE_REQUIRED`; `admit()`'s own 404/409/422 |
| `POST /admission/cycle-classes/:id/bulk-approve` | `{sectionId}`: queue the job for this class's approvable rows             | 409 `BULK_RUNNING`; 422 `SECTION_MISMATCH`                                                                    |
| `GET /admission/cycle-classes/:id/bulk-approve`  | `{running, admitted, problems: [{applicationId, code}]}`                  |                                                                                                               |

### Public (P3b), all `@Public()`, prefix `/public/admission/:slug`

| Route                | Body / headers                                                                                                        | Limits (Redis keys under `rl:adm-*`)                                                                    | Answers                                                                                                                                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /`              | —                                                                                                                     | 60/min per address                                                                                      | 200 form (+ a signed `formTicket`), 404 `ADMISSION_UNKNOWN`                                                                                                                                                                          |
| `POST /otp`          | `{phone, turnstileToken}`                                                                                             | per phone 1/60 s and 5/day; per address 20/hour; per institute `ADMISSION_OTP_PER_TENANT_PER_DAY` (300) | 202 `{expiresIn}`; 403 `TURNSTILE_FAILED`; 503 `TURNSTILE_UNAVAILABLE`; 404 when not open; 429                                                                                                                                       |
| `POST /otp/verify`   | `{phone, code}`                                                                                                       | per address 30/15 min; 5 attempts per code                                                              | 200 `{phoneToken, expiresIn: 1800}`; 422 `ADMISSION_CODE_INVALID`                                                                                                                                                                    |
| `POST /applications` | multipart: `payload` JSON, `photo?`, `turnstileToken`, `formTicket`, `website` (honeypot); header `X-Admission-Token` | per address 10/hour; per phone 10/day                                                                   | 201 `{applicationNo}`; 401 `ADMISSION_TOKEN_INVALID`; 409 `ADMISSION_DUPLICATE {applicationNo}`; 422 `ADMISSION_CLOSED`, `ADMISSION_PHONE_CAP`, `ADMISSION_INVALID`, `ADMISSION_REJECTED` (honeypot or too fast, deliberately vague) |
| `POST /status`       | `{applicationNo}`; header `X-Admission-Token`                                                                         | per address 30/hour; per phone 20/day                                                                   | 200 lookup; 404 `APPLICATION_NOT_FOUND` (also for a phone mismatch) (decision P3-F)                                                                                                                                                  |

- **The code:** 6 digits, 5 minutes, 5 attempts, single use (delete-wins as `OtpService`), key
  `otp:admission:<tenantId>:<phone>`, HMAC input `admission:<tenantId>:<phone>:<code>`. Sent to any
  valid Bangladeshi mobile (applicants have no account). Texts:
  - bn: `{institute} ভর্তির আবেদনের কোড: {code}। ৫ মিনিটের মধ্যে ব্যবহার করুন।`
  - en: `{institute} admission code: {code}. It expires in 5 minutes.`
- **The phone token:** HS256, key = HKDF-SHA256(`JWT_ACCESS_SECRET`, info `jantrik/admission-phone/v1`)
  (decision P3-N); claims `typ: 'admission-phone'`, `aud: <tenantId>`, `sub: <phone>`, `exp` 30 min.
  The access-token guard refuses it (different key and `typ`); the admission routes refuse an
  access token.
- **The form ticket:** HMAC-signed `{t: issuedAt}` from `GET /`; the submit refuses it younger than
  15 s or older than 2 h (decision P3-L).
- **Turnstile:** a `TurnstileVerifier` interface; `CloudflareTurnstile` posts to `siteverify` with
  a 5 s timeout and checks `success`, `hostname` and `action`; it fails closed (decision P3-M). A
  token is single use, so the OTP step and the submit each need their own.
- **SMS jobs** (queue `sms`, ids and the code only):
  - `admission-otp` `{tenantId, phone, code, locale}` (`removeOnComplete`, `removeOnFail`, as the
    login code): the worker, in `TenantJobRunner.run(tenantId)`, inserts an `sms_logs` row
    (`ADMISSION_OTP`, body with the code as `••••••`, no dedupe key) outside the institute's
    general cap (decision P3-D), then sends the real text outside the transaction and marks the
    row SENT or FAILED as `processTenant` does.
  - `admission-submitted` `{tenantId, applicationId}`: the worker reads the application in the
    institute's context and calls `TenantSmsService.queue({ purpose: 'ADMISSION_SUBMITTED',
dedupeKey: 'admission-submitted:<applicationId>', overCap: 'SKIP' })` (S11).
- **Upload:** multipart ≤ 5 MB (rejected while streaming); the photo goes through P2's pipeline
  (≤ 600×800 JPEG ≤ 200 KB, EXIF stripped, `limitInputPixels`), at most two decodes at a time per
  process (a small semaphore); only the re-encoded bytes reach `admission_submit`.

### Environment

| Variable                           | Read by     | Notes                                                                                                       |
| ---------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------- |
| `TURNSTILE_SECRET_KEY`             | API         | required in production and not one of Cloudflare's published test secrets; dev and CI use the fake verifier |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY`   | web (build) | empty in CI and e2e: the form shows a test stand-in that yields the fake verifier's token                   |
| `ADMISSION_OTP_PER_TENANT_PER_DAY` | API         | optional, default 300                                                                                       |
| `WEB_PUBLIC_URL`                   | API         | required in production (links in SMS later; the status page link in the submitted SMS)                      |

`TURNSTILE_PROVIDER=fake` is accepted only with `NODE_ENV=test` (the env check refuses it
elsewhere). Added to `.env.example` and deploy.md; `.env` is the owner's.

## Web

- **Staff (P3a)**, route namespace `admission`, menu "ভর্তি" / "Admission" for OWNER/ADMIN:
  - `/admission`: cycles (status chip, window, counts), "New cycle".
  - `/admission/cycles/[id]`: setup (names, window in the institute's time, notes, photo, the field
    switches, classes with seats).
  - `/admission/applications`: the list with filters, search, CSV, select rows → bulk approve.
  - `/admission/applications/[id]`: detail and edit, duplicate warning, shortlist/reject/withdraw
    with a reason, approve dialog (section, roll, student code; the guardian choice from
    `GET /guardians?phone=` when the API answers `GUARDIAN_CHOICE_REQUIRED`).
  - `/admission/applications/new`: staff entry for walk-ins (decision P3-J).
- **Public (P3b)**, `(public)` group, route namespace `apply`, bn by default with an en switch, no
  session boot (the page never calls `/auth/refresh`):
  - `/apply/[slug]`: class → phone → code → form → review → submitted, with the acknowledgement
    slip (print: A5 portrait, the receipt print rules' isolation). Turnstile's script
    (`https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit`) loads only at the
    phone step and again for the submit.
  - `/apply/[slug]/status`: application number → phone → code → status.
  - Budget: an entry for `/apply/[slug]` in `apps/web/perf/budget.json` (start at `/login`'s 246 KB);
    ≤ 3 s to interactive at 390 px, 4× CPU, slow 4G, measured with `perf/measure.mjs` extended to
    public pages (decision P3-U on fetching the form from the browser).

## Files

| File                                                                                                                                                                         | Change                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `packages/db/prisma/schema.prisma` + 4 migrations                                                                                                                            | enums, tables, role grants, functions             |
| `packages/db/test/admission-rls.test.ts`, `admission-functions.test.ts`, `schema-safety.test.ts`                                                                             | isolation, functions, role checks                 |
| `docker/postgres/init/01-roles.sh`, `deploy/postgres/create-roles.sh`                                                                                                        | `jantrik_admission`                               |
| `packages/shared/src/admission.ts` (+ `.test.ts`), `index.ts`                                                                                                                | schemas, field defaults, number format, `nameKey` |
| `packages/shared/src/fees.ts` (+ `fees.test.ts`)                                                                                                                             | `admissionDateForYear` (review focus 5)           |
| `apps/api/src/fees/dues/fee-dues.service.ts`                                                                                                                                 | uses it                                           |
| `apps/api/src/admission/` (`admission.module.ts`, `cycles.service.ts`, `applications.service.ts`, `approval.service.ts`, `approval.processor.ts`, `admission.controller.ts`) | staff side                                        |
| `apps/api/src/admission/public/` (`public.controller.ts`, `public.service.ts`, `admission-otp.service.ts`, `phone-token.ts`, `form-ticket.ts`, `turnstile.ts`)               | public side                                       |
| `apps/api/src/sms/sms.service.ts`                                                                                                                                            | the two job names                                 |
| `apps/api/src/config/env.ts` (+ spec)                                                                                                                                        | the variables and production checks               |
| `apps/api/test/admission-*.e2e-spec.ts`                                                                                                                                      | API tests                                         |
| `apps/web/src/app/(app)/admission/**`, `apps/web/src/app/(public)/apply/**`                                                                                                  | pages                                             |
| `apps/web/messages/admission/*`, `messages/apply/*`, `i18n/route-messages.ts`, `load-messages.ts`                                                                            | strings                                           |
| `apps/web/e2e/admission.spec.ts`, `apply.spec.ts`                                                                                                                            | Playwright                                        |
| `docs/admission.md` (new), `database.md`, `auth.md`, `fees.md`, `deploy.md`, `.env.example`, `decisions-pending.md`                                                          | docs                                              |

---

## P3a: the staff side

### Task 1: The tables

**Files:** `schema.prisma`; migrations 1 and 2; `packages/db/test/admission-rls.test.ts`;
`schema-safety.test.ts` (the five tables in the list).

- [ ] **Step 1: Write the failing tests** (`admission-rls.test.ts`), in the pattern of
      `fees-setup-rls.test.ts`:
  - each table: institute A's rows invisible in B's context and with no context;
  - an application whose `cycle_class_id` belongs to another cycle → FK error;
  - `status = 'ADMITTED'` without `student_id`, `REJECTED` without a reason, a 16-digit birth
    registration number, a phone `01711000000` (not E.164), `fields` with an unknown key or the
    value `"YES"` → each a CHECK error;
  - the app cannot `DELETE` an application, and cannot `UPDATE` `application_no`, `source`,
    `cycle_id` or `submitted_at`; a 300 KB photo row → CHECK error;
  - a class with an application cannot be deleted.
- [ ] **Step 2: Run them** (`pnpm --filter @jantrik/db exec vitest run test/admission-rls.test.ts`).
      Expected: FAIL (no tables).
- [ ] **Step 3: Write the schema and the two migrations**; drift check empty.
- [ ] **Step 4: Run them and `schema-safety.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit:** "Admission tables: cycles, classes, applications, applicant photos and
      numbers, with RLS and column grants (sprint 1 P3)".

### Task 2: The December admission rule (review focus 5, money)

**Files:** `packages/shared/src/fees.ts`, `fees.test.ts`, `apps/api/src/fees/dues/fee-dues.service.ts`,
`apps/api/test/fees-dues.e2e-spec.ts` (or the existing dues spec).

**Interface:** `admissionDateForYear(input: { createdOn: IsoDate; yearStart: IsoDate;
enrolledBefore: boolean }): IsoDate` = `enrolledBefore ? createdOn : maxDate(createdOn, yearStart)`
(decision P3-K). `fee-dues.service.ts` asks, in the same query, whether the student has an enrolment
in a year that starts before this one.

- [ ] **Step 1: Write the failing tests.**
  - Unit (`fees.test.ts`), year 2027-01-01..2027-12-31, a ONE_TIME head (`one_time_from`
    2027-01-01, offset 15) and a MONTHLY head (day 10):
    - created 2026-12-10, not enrolled before → ONE_TIME due 2027-01-16; January due 2027-01-10
      without the late-joiner extension; no fine accrued on 2027-01-05;
    - created 2025-03-01 and enrolled in 2026 (a promoted student) → no ONE_TIME due in 2027;
    - created 2027-03-15 (mid-year) → unchanged from today's behaviour (due 2027-03-30, March
      due extended to 2027-03-22).
  - API: with `JANTRIK_TEST_TODAY=2026-12-10`, admit a student into the next year; switch the
    current year; with today 2027-01-05 open the ledger → the admission due is dated 2027-01-16
    with no fine.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement**, the call site only (`fee-dues.service.ts:230`); sibling ranks keep
      `created_at` (they only order).
- [ ] **Step 4: Run them, then the whole fees suites** (`fees*.e2e-spec.ts`, `fees.test.ts`).
- [ ] **Step 5: Commit:** "A student admitted before their year starts owes from the year's start,
      not from the admission day; promoted students are never charged a one-time fee again
      (review focus 5)".

### Task 3: Shared schemas

**Files:** `packages/shared/src/admission.ts`, `admission.test.ts`, `index.ts`.

**Produces:** `ADMISSION_FIELDS` and their defaults (P3-Q); `admissionApplicationSchema` (zod;
Bangla digits made ASCII; phone through `normalizeBdPhone`; the birth registration number 17
digits; lengths as the CHECKs); `nameKey(name)`; `formatApplicationNo(year, n)`;
`APPROVABLE_STATUSES(requiresTest)` (P3-H).

- [ ] Steps 1–5 as usual (tests: Bangla digits in phone and birth registration, an unknown key
      refused, `nameKey('  Rahim  Uddin ')` = `nameKey('rahimuddin')`, numbers `2027-0001` and
      `2027-10000`). Commit: "Admission schemas and rules shared by the API and the web".

### Task 4: Cycles and the applications list (API)

**Files:** `apps/api/src/admission/*`, `apps/api/test/admission-setup.e2e-spec.ts`,
`admission-applications.e2e-spec.ts`.

- [ ] **Step 1: Write the failing tests:**
  - create, edit, open and close a cycle; opening with no classes → 422; another institute's year
    → 404; a teacher → 403;
  - the class list: a duplicate class → 422; removing a class with applications → 409;
  - the list: filters, search by name (Bangla and English), phone (typed `০১৭…`) and number; CSV
    has a BOM and ASCII digits; 2 000 applications list in under 300 ms (if not, add the trigram
    index);
  - status changes with and without a reason; each audited.
- [ ] **Steps 2–5.** Commit: "Admission cycles, classes and the applications list (staff)".

### Task 5: Staff-entered applications and editing

**Files:** as Task 4 (decision P3-J).

- [ ] **Step 1: Tests:** a walk-in application gets the next number and `source STAFF`; the
      duplicate rules and the 3-per-phone cap hold as for online ones (one shared function in the
      service, the same SQL as `admission_submit`'s checks); edits are audited with old and new
      values; an admitted application cannot be edited (409).
- [ ] **Steps 2–5.** Commit: "Staff enter applications for walk-ins and correct them (audited)".

### Task 6: Approve one, and bulk approve

**Files:** `approval.service.ts`, `approval.processor.ts` (queue `admission`), `admission.module.ts`,
`apps/api/test/admission-approve.e2e-spec.ts`.

**Approve, in the staff member's request transaction:**

1. `SELECT … FOR UPDATE` the application; refuse unless its status is approvable (P3-H) and
   `student_id` is null.
2. `admit()` with the application's fields, the cycle's year, its class and group, the chosen
   section and roll, and one guardian `{phone, names, relation, isPrimary: true, occupation,
guardianId?, createNew?}`.
3. The photo (when there is one and P2 is merged): `FileStore.put(STUDENT_PHOTO)` and set the
   student's photo; on `STORAGE_FULL` the approval still succeeds without the photo and says so
   (decision P3-V).
4. The application becomes `ADMITTED` with `student_id`; its photo row is deleted; audit
   `admission_application` UPDATE.

**Bulk approve:** one job per class at a time (`jobId = admission-approve:<cycleClassId>`), acting
as the admin (`actorUserId`), re-checking their role at the start; each application in its own
`TenantJobRunner.run` transaction; a `GUARDIAN_CHOICE_REQUIRED` row gets `approval_problem` and is
skipped; `STUDENT_LIMIT` or `SECTION_FULL` stops the run and marks the rest (decision P3-T).

- [ ] **Step 1: Write the failing tests:**
  - approve → a student with the application's fields, the guardian with the phone (a login and a
    GUARDIAN membership), the photo moved, the application ADMITTED;
  - a phone known to the institute → 409 `GUARDIAN_CHOICE_REQUIRED`, nothing written; again with
    `guardianId` → linked to that guardian;
  - review focus 5: two approves at once → one student, one 409;
    an approve during a bulk run on the same row → one student;
  - the student limit (`STUDENT_LIMIT` 422) and a full section stop a bulk run, marking the rest;
  - a WAITLISTED or REJECTED application → 409 `APPLICATION_NOT_APPROVABLE`;
  - bulk: 30 SELECTED rows, 2 needing a guardian choice → 28 students, 2 problems listed.
- [ ] **Steps 2–5.** Commit: "Approve an application into a student with admit(), one at a time or
      in bulk as a job".

### Task 7: Staff pages

**Files:** `apps/web/src/app/(app)/admission/**`, messages, `route-messages.ts`, `app-shell.tsx`,
`apps/web/e2e/admission.spec.ts`.

- [ ] **Step 1: Playwright (CI):** an owner creates a cycle with two classes, opens it, enters a
      walk-in application with Bangla digits in the phone and birth registration number, shortlists
      it, approves it into section A with roll 41 → the student page shows the student and the
      guardian. A teacher has no menu item.
- [ ] **Steps 2–4**, screenshots bn at 1366 and 390 px.
- [ ] **Step 5: Commit:** "Admission pages for owners and admins".

### Task 8: P3a docs, gates, review, PR

- [ ] `docs/admission.md` (staff side), `database.md` (tables, grants), `fees.md` (the admission
      date rule), `decisions-pending.md` (P3 section).
- [ ] Full gates; review subagent (database, money rule, approval races); PR; CI green.

## P3b: the public side

### Task 9: Role, grants and the three functions

**Files:** migrations 3 and 4; `01-roles.sh`, `create-roles.sh`;
`packages/db/test/admission-functions.test.ts`; `schema-safety.test.ts`.

- [ ] **Step 1: Write the failing tests** (`admission-functions.test.ts`, as `jantrik_app` with no
      context, like `ingest-functions.test.ts`):
  - `admission_public_form`: unknown slug → NULL; SUSPENDED institute → NULL; DRAFT, CLOSED or
    out-of-window cycle → empty `cycles`; a closed class and an inactive class level are left out;
    no field of any application appears;
  - `admission_submit`: `CREATED` with `2027-0001` then `2027-0002`; another institute's cycle
    class with A's slug → `CLOSED` and no row anywhere; out of window → `CLOSED`; an unknown key
    or a missing required field → `INVALID`; a photo when the cycle does not collect photos →
    `INVALID`; the same birth registration number → `DUPLICATE` with the first number; the same
    phone + name + DOB → `DUPLICATE`; the 4th live application of a phone → `PHONE_CAP`; 20
    parallel submits of different phones → 20 distinct numbers, no gap;
  - `admission_lookup`: the right phone → the status; a wrong phone, another institute's slug or
    an unknown number → NULL;
  - roles (review focus 4): `jantrik_app` is not a member of `jantrik_admission`
    (`pg_has_role('jantrik_app','jantrik_admission','MEMBER')` false), `jantrik_owner` has SET
    without INHERIT, `jantrik_app` sees no other institute's applications without context (the
    `TO jantrik_admission` policies do not apply to it), `jantrik_platform_app` and
    `jantrik_ingest_app` cannot execute the functions.
  - `schema-safety.test.ts`: the `isAdmission` checks and the privilege snapshot.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Create the role on the scratch test cluster** (the owner's one-time command for
      existing volumes is in database.md; CI's `01-roles.sh` creates it), then write migrations 3
      and 4.
- [ ] **Step 4: Run the db suite.**
- [ ] **Step 5: Commit:** "The public admission functions under the jantrik_admission role (S4)".

### Task 10: The public API

**Files:** `apps/api/src/admission/public/*`, `sms.service.ts`, `env.ts`,
`apps/api/test/admission-public.e2e-spec.ts`, `admission-otp.e2e-spec.ts`,
`apps/api/src/admission/public/no-tenant-access.spec.ts` (code scan).

- [ ] **Step 1: Write the failing tests** (fake Turnstile, `MemorySmsProvider`):
  - the happy path: form → code → verify → submit with a photo → 201 `2027-0001`; one
    `ADMISSION_OTP` and one `ADMISSION_SUBMITTED` row in the institute's `sms_logs`, the OTP row's
    body masked; the photo stored re-encoded (JPEG, ≤ 200 KB, no EXIF);
  - **review focus 1:** ceiling 20, 50 phones from 10 addresses → exactly 20 codes sent, the rest
    429; no code without a Turnstile pass (fake verifier says no → 403, no SMS, no counter used);
    Turnstile unreachable → 503, nothing sent;
  - per phone: a second code within 60 s → 429; the 6th in a day → 429;
  - **review focus 6:** the phone token as `Authorization: Bearer` on `/students` → 401; an access
    token in `X-Admission-Token` → 401; A's token at B → 401; an expired token → 401;
  - **review focus 3:** B's cycle class with A's slug → 422 `ADMISSION_CLOSED`, nothing written;
  - the form ticket: a submit 5 s after `GET /` → 422 `ADMISSION_REJECTED`; the honeypot filled →
    the same 422; neither tells which;
  - **review focus 7:** a 6 MB upload → 413 before decoding; a 20 000 × 20 000 PNG bomb → 422
    without exhausting memory; a text file named `.jpg` → 422; a PNG with GPS EXIF → stored without
    it; 10 parallel uploads → at most 2 decoding at once (a counter in the test hook);
  - the status lookup: with a token for that phone → the status; another phone → 404;
  - code scan: nothing under `admission/public/` imports `Db`, `TenantJobRunner` or
    `TenantSmsService`; codes and tokens never appear in captured logs.
- [ ] **Steps 2–5.** Commit: "Public admission API: codes, phone tokens, Turnstile, the form,
      submit and status (S4–S6, S9, S11)".

### Task 11: The public pages

**Files:** `apps/web/src/app/(public)/apply/**`, `messages/apply/*`, `route-messages.ts`,
`apps/web/perf/budget.json`, `apps/web/perf/measure.mjs`, `apps/web/e2e/apply.spec.ts`.

- [ ] **Step 1: Playwright (CI, the test stand-in for Turnstile, the SMS outbox):** at 390 px in bn,
      a guardian picks a class, types the phone in Bangla digits, takes the code from the outbox,
      fills the form (birth registration in Bangla digits), adds a photo, submits, sees and prints
      the slip, then checks the status. An owner then approves it (sprint e2e: apply → approve →
      the student appears).
- [ ] **Steps 2–4:** the pages; then measure `/apply/[slug]` (six interleaved runs on a quiet
      machine): ≤ 3 s to interactive; the size budget entry.
- [ ] **Step 5: Commit:** "The public admission form and status pages (mobile first, bn default)".

### Task 12: P3b docs, gates, review, PR

- [ ] `docs/admission.md` (public side, limits, the role), `database.md` (role table, functions,
      existing-volume command), `auth.md` (a no-login surface and its tokens), `deploy.md` (the
      role in `create-roles.sh`, Turnstile account and keys, the env checks), `.env.example`.
- [ ] Full gates; review subagent (public surface, definer functions, OTP, uploads) with review
      focus 1, 3, 4, 6 and 7; PR; CI green.

## Risks

- **The season.** Schools admit for January in November and December. P3a alone already helps
  (walk-in entry, approvals). If P3b slips, the fallback is staff entry.
- **No SMS gateway yet.** The public form cannot be used in production until there is one (as for
  every login). Development and CI use the console/outbox providers.
- **Turnstile needs a Cloudflare account** (free) before production. Failing closed means a
  Cloudflare outage stops new codes; existing phone tokens keep working for 30 minutes.
- **Applicant photos grow the database** before approval: at most 3 per phone per cycle and 300
  verified phones a day per institute (≈ 180 MB a day at the extreme). Rejected ones stay until the
  S30 clean-up job, which is not in this phase.
- **Decoding images in a public route costs CPU.** Bounded by size, pixels, two decodes at a time
  and the rate limits; watch the API's CPU in the first season.
- **Application numbers are guessable** (`2027-0001`…), which is why every lookup needs the phone's
  code (P3-F).

## Size

**L.** About 4 migrations, 5 tables, 3 definer functions, ~20 routes, 7 pages, ~12 test files.
Recommended as **two PRs** (decision P3-A): P3a (staff side, the dues rule; reviewable as a
database and money change, useful on its own) and P3b (the public surface; reviewed as a security
change with its own focus).

## Self-review

- **Sprint plan coverage:** tables (Tasks 1, 9); the public access rule S4 (Task 9; the three
  functions, the role, the limits); OTP and the per-institute ceiling (Task 10); Turnstile,
  honeypot and fill time S6 (Task 10); staff screens (Tasks 4–7); approve with `admit()` unchanged
  and the guardian choice (Task 6); bulk approve as a job (Task 6); the submit SMS S11 (Task 10);
  the fees rule (Task 2); the public pages and the budget (Task 11); docs (Tasks 8, 12).
- **Not in P3:** the S30 clean-up job (12 months after the cycle closes), the admission test and
  merit list (P4), a logo on the public form (P3-O).
- **Names used consistently:** `admission_public_form`, `admission_submit`, `admission_lookup`,
  `jantrik_admission`, `admissionDateForYear`, `nameKey`, `APPROVABLE_STATUSES`,
  `ADMISSION_OTP`, `ADMISSION_SUBMITTED`, `TurnstileVerifier`.

## Decisions for the owner

The approved S-decisions stand. These are new, each with the recommended default.

| #    | Decision                                                                | Recommended default                                                                                                                                                                                                                                                                                                                                                     |
| ---- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P3-A | One PR or two                                                           | Two: P3a staff side + dues rule, then P3b public surface                                                                                                                                                                                                                                                                                                                |
| P3-B | Where an applicant's photo lives before approval                        | Its own table (`admission_application_photos`), moved into `FileStore` as the student's photo at approval. The sprint plan has `admission_submit` "store the photo bytes", but P2 makes `FileStore` the only writer of `stored_files`; a definer function writing there would bypass it and tie P3 to the Postgres backend. P2's `APPLICANT_PHOTO` kind is then unused. |
| P3-C | How the admission code and the "received" SMS reach the institute's log | Worker jobs that open the institute's context from ids our own code resolved; the public request itself never opens a tenant transaction                                                                                                                                                                                                                                |
| P3-D | Admission codes and the institute's daily SMS cap                       | Codes are always sent (bounded by their own ceiling, 300 a day) and count toward the day's total; the "received" SMS is skipped over the cap (the slip is on screen)                                                                                                                                                                                                    |
| P3-E | The purpose of the S11 SMS                                              | A new `sms_purpose` `ADMISSION_SUBMITTED` (the sprint plan listed only `ADMISSION_OTP`, `ADMISSION_RESULT`, `BROADCAST`)                                                                                                                                                                                                                                                |
| P3-F | What the P3 status page needs                                           | The application number plus a phone code, as S13 for results (number + phone alone would show a child's name to anyone who knows the family's phone)                                                                                                                                                                                                                    |
| P3-G | Application number scope                                                | Unique per institute per year (`2027-0001`), not per cycle: two cycles in one year would otherwise repeat numbers and make the lookup ambiguous                                                                                                                                                                                                                         |
| P3-H | Which applications can be approved                                      | Without a test: SUBMITTED, SHORTLISTED or SELECTED. With a test: SELECTED only (a waitlisted one is moved up first, P4)                                                                                                                                                                                                                                                 |
| P3-I | "Previous institute" and the guardian's occupation                      | Kept on the application only (shown to staff); `students` gets no new column. `admit()` has no such field today                                                                                                                                                                                                                                                         |
| P3-J | Staff-entered applications (walk-ins, paper forms)                      | Yes, in P3a, without a code; the same duplicate rules and phone cap                                                                                                                                                                                                                                                                                                     |
| P3-K | The admission date for dues                                             | The later of the created date and the year's start, only for a student with no enrolment in an earlier year; applies to staff admissions too                                                                                                                                                                                                                            |
| P3-L | Form timing                                                             | A server-signed ticket; a submit under 15 s or over 2 h after opening the form is refused with a vague 422, as is a filled honeypot (never a fake success, so a real guardian whose browser filled the hidden field learns to retry)                                                                                                                                    |
| P3-M | Turnstile failures and tests                                            | Fail closed (503) when Cloudflare cannot be reached in 5 s; tests and CI use a fake verifier (`TURNSTILE_PROVIDER=fake`, test mode only) and never call Cloudflare                                                                                                                                                                                                      |
| P3-N | The phone token's key                                                   | Derived from `JWT_ACCESS_SECRET` by HKDF with its own label (no new secret); `typ` and audience checked both ways                                                                                                                                                                                                                                                       |
| P3-O | Logo on the public form                                                 | Not in P3 (the name only); later through a fourth function if wanted                                                                                                                                                                                                                                                                                                    |
| P3-P | Creating `jantrik_admission` on existing installs                       | The owner runs one documented command once on each existing Postgres (local volume, staging); the migration refuses with a clear message until then. New volumes, CI and `create-roles.sh` create it                                                                                                                                                                    |
| P3-Q | Default form fields                                                     | Required: names (one language at least), date of birth, gender, guardian name, relation, phone. Optional: birth registration, religion, parents' names, addresses, previous institute, occupation. Photo: hidden unless the cycle collects it                                                                                                                           |
| P3-R | The S30 clean-up job                                                    | Not in P3; a small follow-up before the first cycle is 12 months closed                                                                                                                                                                                                                                                                                                 |
| P3-S | A duplicate online submit                                               | Refused with the existing application's number (the phone was verified, so it is the same family)                                                                                                                                                                                                                                                                       |
| P3-T | Where bulk approval's skipped rows are kept                             | On the application (`approval_problem`), not a new runs table; a re-run picks up what is left                                                                                                                                                                                                                                                                           |
| P3-U | Loading the public form                                                 | From the browser, as every other page; a server-side fetch would make all applicants share the web server's address in the per-address limits                                                                                                                                                                                                                           |
| P3-V | Approving when the institute's storage is full                          | The student is created without the photo, and the dialog says so; the photo stays on the application                                                                                                                                                                                                                                                                    |

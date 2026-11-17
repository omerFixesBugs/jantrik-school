# Sprint 1, P9: documents — the issued register, QR verification, TC, testimonial, admit card, marksheet (implementation plan)

**Status: plan only (day run 2026-11-18), not approved, no code yet.** Written while the owner was
away. It details [sprint-1.md](sprint-1.md) → "P9: Documents: issued register, QR verification,
TC, testimonial, admit card, marksheet", approved by the owner on 2026-11-14 with decisions S25 (a
TC with unpaid dues is allowed with a warning and a required reason), S29 (the marksheet's layout
is its header, footer, signatures and watermark; the marks table stays data-driven), S31 (the ID
card QR is a stable code per student, revoked on reissue) and S32 (the public page shows the
institute, kind, serial, student name, class at issue, issue date and VALID/REVOKED, never a
photo, date of birth or phone). Nothing here reopens those. The new decisions are P9-A to P9-V at
the end, each with a recommended default. It builds on the P8 plan
([sprint-1-p8-documents.md](sprint-1-p8-documents.md)). If the sprint runs late, P8 and P9 move
to Sprint 2 together; tests are never reduced.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.
> One review subagent per PR (public surface, database, money rule for the TC).

**Goal:** every certificate an institute hands out is recorded with a gap-free serial and a QR
that anyone can scan to see, on a public page, whether it is genuine and still valid. Owners and
admins issue ID cards (one live card per student), transfer certificates (with the leaving
status and a dues check), testimonials (board exam details typed at issue) and marksheets (the
published report card with the institute's header, footer and watermark), reprint them exactly,
and revoke or reissue them. Exam admit cards print through the designer.

**Architecture:**

- **One register for every issued document** (`issued_documents`): kind, student, the exact
  template version (P8-B), a serial from `document_serial_counters` (gap-free, rolled back with
  the issue, like receipts), the SHA-256 of the verification code, and `data`, a snapshot of
  everything printed. Rows are insert-only except printing counters and a one-way revocation
  (column grants plus a restrictive policy); no DELETE.
- **Two numbers, two jobs.** The **serial** (`TC-2026-0007`) is for people: sequential, printed,
  never accepted by the public page. The **verification code** is for the QR: 128 bits that cannot
  be guessed, derived from the row's id with a server key (decision P9-C) so the same QR can be
  reprinted, while the database keeps only its hash.
- **Public verification follows P3b's proven pattern** (#24): `GET /public/verify/:code` is
  `@Public()`, opens no tenant transaction, and calls one `SECURITY DEFINER` function,
  `document_verify(code_hash)`, owned by the new NOLOGIN role `jantrik_verify` (the sprint plan's
  role), executable by `jantrik_app` only, which sees exactly the columns it needs through
  `TO jantrik_verify` policies (a privilege snapshot test pins them). Answers are the same for a
  malformed and an unknown code, carry `Cache-Control: no-store`, and are rate-limited per address
  with no budget shared between addresses.
- **Validity is computed, not copied** (decision P9-I): a live ID card is VALID only while its
  student is ACTIVE; a live TC only while the student has left. A revoked document is REVOKED.
  One SQL function and one shared TypeScript function hold the rule; a test checks they agree.
- **Kinds through their owners' services** (CLAUDE.md rule 4): leaving through P5's
  `StudentAdminService.leave()`, dues through a new `FeeBalanceReader` exported by `FeesModule`,
  published report cards through an exported exams reader. The documents module never reads fee or
  exam tables itself.
- **Printing stays in the browser** (P8-D): the API returns the snapshot, the template version and
  the verification URL; the web renders the QR as an SVG from `qrcode`'s module matrix.

**Tech stack:** NestJS, Prisma/PostgreSQL 16, Redis (rate limits), Next.js, next-intl, zod, Vitest,
Playwright. Existing dependencies only (`qrcode` in the web; `node:crypto` for HMAC and SHA-256).

**Spec:** sprint-1.md → P9; S25, S29, S31, S32; "New tables at a glance" (`issued_documents` S I,
U by column, read by `jantrik_verify`; `document_serial_counters` S I U; the role
`jantrik_verify`); global constraints (definer functions, audit of issued documents, public pages
in the performance budget).

**Branches:** `feature/sprint-1-p9a-documents-register` from `main` after P8a and P5a (#21) are
merged, then `feature/sprint-1-p9b-documents-certificates` after P9a and P8b (decision P9-A). P9a
also leans on P3b (#24: `WEB_PUBLIC_URL`, the session-free public layout,
`RateLimiter.consumeIfAllowed`) and P1-J8 (#20: the signed context); if either is not merged
first, P9a carries the small part it needs and the later merge reconciles it.

## What exists today (verified in the code on 2026-11-18)

On `integration/sprint-1` (`c8571025`) unless a PR is named.

- **Nothing registers a document today.** Report cards, admit cards and receipts print in the
  browser with no serial or QR except the receipt number (`apps/web/src/app/globals.css:504-700`).
- **Gap-free numbers, the receipt pattern:** `FeeCollectionService.nextReceiptNo(year)`
  (`apps/api/src/fees/collection/fee-collection.service.ts:101-110`):
  `INSERT INTO fee_receipt_counters … ON CONFLICT (tenant_id, year) DO UPDATE SET next_value =
next_value + 1 RETURNING next_value - 1`, in the payment's transaction, so a rolled-back payment
  leaves no gap; the year is the recorded date's calendar year (`:246`); printed as
  `receiptNumber(year, seq)` = `2026-000123` (`packages/shared/src/fees.ts:455`).
- **Fees:** `FeesModule` exports only `FeeCollectionService` (`apps/api/src/fees/fees.module.ts:510`).
  `balanceToday(studentId, today)` (`fee-collection.service.ts:113`) sums `dueBalance` over OPEN
  dues; dues are generated per student by `FeeDuesService.ensureForStudents`
  (`apps/api/src/fees/dues/fee-dues.service.ts:273`), which the ledger calls when opened
  ("correctness never depends on the nightly job", docs/fees.md).
- **Exams:**
  - Report cards: `ExamResultsService.reportCards(examId, {sectionId, studentId})`
    (`apps/api/src/exams/results/exam-results.service.ts:391`), published classes only, behind
    `ExamResultsController` (OWNER/ADMIN/TEACHER, section-checked, `exams.module.ts:298-300`);
    the guardian's own child's card under `/me/children/:id/results/:examClassId`. Typed
    `ReportCards` (`packages/shared/src/exams-api.ts:847`): `institute: {name}` only.
  - Publishing stores a snapshot (`exam_results`) and bumps `exam_classes.published_version`
    (`schema.prisma:1537-1550`); publish takes the exam class `FOR UPDATE`, marks writes take it
    `FOR SHARE` (docs/exams.md → Lock order).
  - Admit cards: `GET /exams/:id/admit-cards` (`exams.module.ts:528`, OWNER/ADMIN), two per A4 in
    `AdmitCardsPrint` (`apps/web/src/components/exams/print-pages.tsx:210`).
  - `ExamsModule` exports only `MarkSheetService` (`exams.module.ts:583`).
- **Leaving (P5, #21/#22, verified on `feature/sprint-1-p5b-promotion-wizard` at `4f35469e`):**
  `students.left_on`, `leave_reason`; `POST /students/:id/leave {status, leftOn, reason?}`
  (OWNER/ADMIN, `students.module.ts:484-489`) calls `StudentAdminService.leave()`
  (`student-admin.service.ts:739`): a conditional update from ACTIVE (a second leave gets 422
  `ALREADY_LEFT`), audited; `POST /students/:id/return` brings a leaver back (P5-J). Statuses
  `GRADUATED | TRANSFERRED | DROPPED_OUT | INACTIVE` (`leaveSchema`,
  `packages/shared/src/promotion-schema.ts:26`). Promotion's apply marks leavers in bulk (P5-C).
  `StudentsModule` already exports `StudentAdminService` (`students.module.ts:488`).
- **The public pattern (P3b, #24, verified on `feature/sprint-1-p3b-admission-public` at
  `faefd06e`):** the NOLOGIN role `jantrik_admission` owns exactly the public definer functions,
  EXECUTE for `jantrik_app` only, `TO jantrik_admission` policies with column grants pinned by a
  privilege snapshot in `schema-safety.test.ts`; the role is created outside migrations
  (`docker/postgres/init/01-roles.sh`, `deploy/postgres/create-roles.sh`) and a migration guard
  refuses to run without it; replacing a function needs `GRANT CREATE … SET ROLE … REVOKE CREATE`
  (docs/admission.md on that branch). Public answers carry `Cache-Control: no-store`
  (`public.controller.ts:45-106`). `RateLimiter.consumeIfAllowed` and `tryConsume` count a hit
  only when every rule has room, so refused requests never spend a shared budget. `WEB_PUBLIC_URL`
  (`apps/api/src/config/env.ts:161` there) is required in production.
- **Signed context (P1-J8, #20):** new policies call `(SELECT app_current_tenant_id())`; context
  only through `withContext`; raw SQL names `public.` functions explicitly.
- **Rate limits here:** `RateLimiter.consume` only (`apps/api/src/redis/rate-limiter.service.ts:53`);
  unauthenticated requests 600 a minute per IP (docs/auth.md); `addressBucket(ip)` counts an IPv6
  address by its /64 (`apps/api/src/ingest/ingest.service.ts:125`); `TRUST_PROXY` makes `req.ip`
  the client (`app.setup.ts:14`), and Caddy replaces any client `X-Forwarded-For`
  (`deploy/Caddyfile`). Caddy has no access log, and the API logs no request paths, so a code in a
  URL is not written to a log by us.
- **Who the institute is:** `tenants.name` is set by Jantrik's platform at creation and the app
  cannot change it (`REVOKE UPDATE … ON tenants FROM jantrik_app`,
  `migrations/20261022000000_platform_institutes:84`); the profile's names and EIIN (P2) are typed
  by the institute itself. Institutes are created only by the platform (platform.md, decision 8).
  Tenant statuses `TRIAL | ACTIVE | SUSPENDED | ARCHIVED` (`schema.prisma:30`).
- **Audit:** `AuditService.record` writes `audit_logs` in the request transaction; actions are
  `CREATE | UPDATE | DELETE` (`schema.prisma:253`).
- **schema-safety:** definer functions are pinned, never PUBLIC, never take a tenant id or `uuid`,
  and are scoped by context except listed groups (`packages/db/test/schema-safety.test.ts:148-199`).
- **From P8 (planned, not built):** templates with immutable versions, the layout model with
  `qr` elements and `document.*` fields, `DocumentData`, the ID card print page, the renderer.

## Global constraints

- **Modules and roles:** ID cards, TC, testimonial, the register: `@RequireModule('CORE')`.
  Admit cards and marksheets: `@RequireModule('EXAMS')`. Issuing, reprinting, revoking and the
  register: `@Roles('OWNER', 'ADMIN')` (decision P9-B). The public route: `@Public()`.
- **No tenant transaction on the public route.** `apps/api/src/documents/public/` never imports
  `Db`, `TenantJobRunner` or `AuditService`; a code scan enforces it (as P3b's).
- **Codes are secrets:** the verification code is never stored, logged, audited, put in Redis or
  in a job payload; only its SHA-256 is stored. Tested (Task 3).
- **History:** `issued_documents` has no DELETE; a revoked row never changes again.
- **Money (S25):** the TC's dues check reads the fees module's own balance, after generating the
  student's dues as the ledger does; it never writes a due or a payment beyond that generation.
- **Dates:** `issued_on` and `left_on` are the institute's calendar dates (`todayIn`); the serial
  year is `issued_on`'s year.
- **Strings and digits:** route namespaces `documents` (staff) and `verify` (public); serials,
  codes, rolls, registration numbers and phones in ASCII; dates and counts in Bangla digits in bn;
  Bangla digits accepted in every typed number (`toAsciiDigits`).
- **Transactions:** at most 100 documents issued per request (one section), measured under 2 s.
- **Audit:** every issue (kind, serial, student, template version, reissue-of; for a TC whether
  dues were overridden and the balance), revocation (reason) and print (count). Never the code,
  never the snapshot (it is the row).
- **Screens:** v3 kit, light first; the public page meets the budget (≤ 3 s to interactive at
  390 px, 4× CPU, slow 4G); screenshots bn at 1366 and 390 px.
- **Gates:** as P8.

## Review focus

1. **Forging or harvesting through the public page.** Guessing codes, trying serials, telling an
   unknown code from a malformed one, scraping from many addresses, an impostor institute naming
   itself after a famous school. Expected: codes are 128-bit and only hashed in the database; the
   page never takes a serial; malformed and unknown answer identically; per-address limits with no
   shared budget; the answer has exactly the S32 fields; the institute shown is Jantrik's
   registered name (P9-G). Tests: Tasks 5 and 6.
2. **The new role widens nothing.** `jantrik_app` and the other logins are not members of
   `jantrik_verify`; `jantrik_owner` may SET ROLE but does not inherit it; the `TO jantrik_verify`
   policies never apply to `jantrik_app`; the role's privileges equal the table below exactly.
   Test: Task 5.
3. **Issued means immutable.** Editing the student, the profile or the template never changes an
   issued document's data, serial or what a reprint shows (images excepted, P9-J); no DELETE;
   only revocation and print counters change, and nothing after revocation. Tests: Tasks 1 and 3.
4. **Serials stay gap-free** under 20 concurrent issues, a rollback after the serial was taken,
   and a bulk issue of 100. Test: Task 3.
5. **The code never leaks in plain text** (database columns, audit, logs, Redis, job payloads).
   Test: Task 3.
6. **TC rules.** Unpaid dues need a reason (S25) and the balance the admin saw must still be the
   balance; leaving and the TC commit together or not at all; one live TC per student; a returned
   student's TC reads REVOKED; a leaver's ID card reads REVOKED. Tests: Tasks 4 and 11.
7. **Races.** Two admins revoke or reissue the same document; two ID card issues for one student;
   marksheets issued while the class is republished. Expected: one wins, the other gets 409; the
   marksheet snapshot is one published version. Tests: Tasks 3, 4 and 14.

---

## Codes, serials and what the QR holds

- **The code** (decision P9-C): `code = HMAC-SHA256(DOCUMENT_CODE_KEY, "jantrik/doc-code/v1:" +
issued_document.id)[0..16]`, 128 bits, computed by `DocumentCodes` in the API when the row is
  created and again for each reprint. The row stores `verify_code_hash = SHA-256(code)` (32
  bytes, globally unique) and `code_key_fp`, the first 8 hex characters of
  `HMAC(DOCUMENT_CODE_KEY, "jantrik/doc-code/fingerprint")`, so a reprint after the key changed is
  refused (409 `CODE_KEY_CHANGED`: reissue instead) rather than printing a QR that does not
  verify. Verification never needs the key: it hashes the presented code and looks the hash up.
- **The code's text form:** Crockford base32, 26 characters, upper case
  (`7KQ2M9XD4HTP0ZRAC1VWE8N3FB`); typed input is normalised (case, spaces, dashes, `O`→`0`,
  `I`/`L`→`1`). Printed in groups of four under the QR on A4 documents; off by default on ID cards
  (decision P9-R).
- **The QR** holds `WEB_PUBLIC_URL + "/v/" + code` (decision P9-D), byte mode, error correction M.
  For a base address up to 40 characters (69 bytes in all) it is at most version 5 (37 × 37
  modules plus a 2-module quiet zone: about 0.39 mm per module at 16 mm, which phone cameras read
  easily), tested. It is drawn as an `<svg>` of the matrix from `QRCode.create()`.
- **The serial** (decision P9-E): per institute, kind and the calendar year of `issued_on`,
  gap-free from `document_serial_counters` in the issuing transaction; a bulk issue reserves a
  block in one statement (`next_value = next_value + n RETURNING next_value - n`). Printed by
  `formatDocumentSerial(kind, year, no)`: `ID-2026-0412`, `TC-2026-0007`, `TM-2026-0003`,
  `MS-2026-1203` (four digits at least, ASCII always). The public page never accepts a serial.

### Which kinds are registered (decision P9-F)

| Kind          | Registered | Issued by                                            | One live per                 | VALID while (P9-I)                                  |
| ------------- | ---------- | ---------------------------------------------------- | ---------------------------- | --------------------------------------------------- |
| `ID_CARD`     | yes        | ID card page (bulk, ≤ 100) or the student page       | student                      | not revoked, the student ACTIVE and not deactivated |
| `TC`          | yes        | the TC wizard                                        | student                      | not revoked, the student left and not deactivated   |
| `TESTIMONIAL` | yes        | the testimonial form                                 | student, board exam and year | not revoked, the student not deactivated            |
| `MARKSHEET`   | yes        | "Issue marksheets" on a published exam class (≤ 100) | student and exam             | not revoked, the student not deactivated            |
| `ADMIT_CARD`  | no         | printed from the exam's admit card page as today     | —                            | — (no serial, no QR)                                |

## Database

### New enum

- `document_revoke_reason`: `LOST`, `DAMAGED`, `WRONG_DATA`, `REPLACED`, `CANCELLED`, `OTHER`
  (decision P9-L). No value is added to an existing enum.

### `issued_documents` (tenant; jantrik_app S I, UPDATE by column, no DELETE)

| Column                                  | Type                        | Rule                                                                                                      |
| --------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `id`                                    | uuid v7                     | PK; generated by the API before insert (the code is derived from it)                                      |
| `tenant_id`                             | uuid NOT NULL               |                                                                                                           |
| `kind`                                  | document_kind               | never `ADMIT_CARD` (CHECK)                                                                                |
| `student_id`                            | uuid NOT NULL               | composite FK → students, RESTRICT                                                                         |
| `template_id`, `template_version`       | uuid, int NOT NULL          | composite FK `(tenant_id, template_id, template_version)` → `document_template_versions`, RESTRICT (P8-B) |
| `serial_year`                           | smallint NOT NULL           | CHECK `BETWEEN 2000 AND 2100`                                                                             |
| `serial_no`                             | int NOT NULL                | CHECK `BETWEEN 1 AND 99999999`; UNIQUE `(tenant_id, kind, serial_year, serial_no)`                        |
| `verify_code_hash`                      | bytea NOT NULL              | CHECK `octet_length(verify_code_hash) = 32`; UNIQUE (global)                                              |
| `code_key_fp`                           | char(8) NOT NULL            | CHECK `~ '^[0-9a-f]{8}$'`                                                                                 |
| `exam_id`                               | uuid NULL                   | composite FK → exams, RESTRICT; CHECK `(kind = 'MARKSHEET') = (exam_id IS NOT NULL)`                      |
| `data`                                  | jsonb NOT NULL              | the snapshot; CHECK `jsonb_typeof(data) = 'object' AND octet_length(data::text) <= 131072`                |
| `student_name_bn`, `student_name_en`    | text NULL                   | the public fields (S32), copied at issue; CHECK at least one; each ≤ 200                                  |
| `class_label_bn`, `class_label_en`      | text NULL                   | "class at issue" (S32); each ≤ 120                                                                        |
| `issued_on`                             | date NOT NULL               | the institute's date; CHECK `extract(year FROM issued_on) = serial_year`                                  |
| `issued_by_id`                          | uuid NULL                   | FK users ON DELETE SET NULL                                                                               |
| `print_count`                           | int NOT NULL                | default 1; CHECK `>= 1`                                                                                   |
| `last_printed_at`, `last_printed_by_id` | timestamptz(3), uuid NULL   |                                                                                                           |
| `revoked_at`                            | timestamptz(3) NULL         | CHECK `(revoked_at IS NULL) = (revoke_reason IS NULL)`                                                    |
| `revoke_reason`                         | document_revoke_reason NULL |                                                                                                           |
| `revoke_note`                           | text NULL                   | CHECK `revoke_note IS NULL OR (revoked_at IS NOT NULL AND char_length(revoke_note) <= 500)`               |
| `revoked_by_id`                         | uuid NULL                   | FK users ON DELETE SET NULL                                                                               |
| `reissue_of_id`                         | uuid NULL                   | composite FK → issued_documents `(tenant_id, id)`; UNIQUE `(tenant_id, reissue_of_id)`; CHECK `<> id`     |
| `created_at`, `updated_at`              | timestamptz(3)              |                                                                                                           |

- **One live document** (partial unique indexes): `(tenant_id, student_id) WHERE kind = 'ID_CARD'
AND revoked_at IS NULL`; the same for `'TC'`; `(tenant_id, student_id, exam_id) WHERE kind =
'MARKSHEET' AND revoked_at IS NULL`. Testimonials: in the service, under the student's row lock
  (the exam is in `data`).
- Indexes: `(tenant_id, kind, serial_year, serial_no)` (the unique), `(tenant_id, student_id, kind)`,
  `(tenant_id, issued_on DESC)`; `verify_code_hash` unique.
- Grants: `SELECT, INSERT, UPDATE (print_count, last_printed_at, last_printed_by_id, revoked_at,
revoke_reason, revoke_note, revoked_by_id, updated_at)`. No DELETE.
- Policies: `tenant_isolation` (`(SELECT app_current_tenant_id())`), and
  `issued_documents_frozen_when_revoked` AS RESTRICTIVE FOR UPDATE USING `(revoked_at IS NULL)`
  WITH CHECK `(true)`: a revoked row never changes again, while the revocation itself can still
  be written (P5's pattern for applied rows).
- Checklist: ☐ tenant_id NOT NULL ☐ `(tenant_id, id)` unique ☐ composite FKs (optional ones too)
  ☐ ON UPDATE RESTRICT ☐ leading index ☐ ENABLE + FORCE RLS ☐ `tenant_isolation` ☐ explicit
  grants ☐ schema-safety list ☐ isolation test ☐ history table: no DELETE.

### `document_serial_counters` (tenant; jantrik_app S I U)

`id`, `tenant_id`, `kind document_kind`, `year smallint` (CHECK 2000–2100), `next_value int`
(CHECK ≥ 2), timestamps; UNIQUE `(tenant_id, id)`, `(tenant_id, kind, year)`. Checklist ✓.

### The role, grants and the verification function (P9a)

- **Role** (outside migrations): `CREATE ROLE jantrik_verify NOLOGIN NOSUPERUSER NOBYPASSRLS;
GRANT jantrik_verify TO jantrik_owner WITH INHERIT FALSE, SET TRUE;` in `01-roles.sh`,
  `create-roles.sh` (idempotent), database.md's role table and its existing-volume commands. The
  first P9a role migration starts with a guard that raises "create the role first
  (docs/database.md)" when it is missing (decision P9-T).
- **Grants and policies** (all `FOR SELECT TO jantrik_verify USING (true)`; the function scopes
  every read to the one row it found):

  | Table              | Column grants to `jantrik_verify`                                                                                                                                         |
  | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `issued_documents` | SELECT `(tenant_id, student_id, kind, serial_year, serial_no, verify_code_hash, student_name_bn, student_name_en, class_label_bn, class_label_en, issued_on, revoked_at)` |
  | `tenants`          | SELECT `(id, name, status)`                                                                                                                                               |
  | `students`         | SELECT `(tenant_id, id, status, deleted_at)` (for P9-I; never returned)                                                                                                   |

  Not `data`, not the profile, not any other student column: the S32 fields are copied into the
  register row at issue, so the role needs no access to names elsewhere (decision P9-G).

- **Function** `public.document_verify(p_code_hash bytea) RETURNS jsonb`, `STABLE SECURITY
DEFINER SET search_path = pg_catalog, public, pg_temp`, owned by `jantrik_verify`, `REVOKE ALL …
FROM PUBLIC`, `GRANT EXECUTE … TO jantrik_app` (the ownership hand-over as P3b's functions
  migration: `GRANT CREATE ON SCHEMA public TO jantrik_verify` around `ALTER FUNCTION … OWNER TO`,
  then `REVOKE CREATE`):
  - NULL unless `octet_length(p_code_hash) = 32`, a row has that hash, and its institute's status
    is `TRIAL`, `ACTIVE` or `SUSPENDED` (decision P9-H);
  - otherwise `{instituteName, kind, serialYear, serialNo, studentNameBn, studentNameEn,
classLabelBn, classLabelEn, issuedOn, status}` and nothing else, `status` = `VALID` or
    `REVOKED` by the rule in "Which kinds are registered".
  - No `uuid` parameter and no tenant parameter, so it needs no schema-safety exception for those;
    it is listed as a group (`isVerify`) excluded from "scoped by context" with the reason "public
    verification: one document by the hash of its unguessable code".
- **schema-safety additions:** owned by `jantrik_verify`; EXECUTE for `jantrik_app` only (not
  `jantrik_platform_app`, `jantrik_ingest_app`, `jantrik_login_app`, PUBLIC); `jantrik_verify`'s
  table and column privileges equal the table above exactly (a snapshot, so any widening fails
  CI); the function's result keys equal the S32 list (a db test).

### Migrations, in order

P9a:

1. `<ts>_issued_documents`: the enum, the two tables, CHECKs, indexes, RLS, grants, the
   restrictive policy.
2. `<ts>_document_verify_access`: the role guard, `GRANT USAGE ON SCHEMA public TO
jantrik_verify`, the column grants and policies.
3. `<ts>_document_verify_function`: the function and its hand-over.

P9b: none (TC, testimonial and marksheets use the same tables).

Timestamps are assigned when written, after every Sprint 1 migration merged before them. Each is
checked for drift and applied to a scratch database only.

## API

### Register and ID cards (P9a), `@RequireModule('CORE')`, `@Roles('OWNER', 'ADMIN')`

| Route                                                                        | Does                                                                                                                                                                                                            | Errors                                                                                        |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET /documents/issued?kind&year&state&q&page`                               | the register: serial, kind, student, class at issue, issued on and by, state (`VALID`, `REVOKED`, `NOT_VALID` with why: left, returned, deactivated), prints; search by serial, name or student code; 50 a page |                                                                                               |
| `GET /documents/issued/:id`                                                  | the row, its snapshot, the template version, the chain (`reissue_of` both ways)                                                                                                                                 | 404                                                                                           |
| `POST /documents/issued/:id/print`                                           | one more print: `print_count + 1`; returns the snapshot, the version's layout, serial, `verifyUrl`, `duplicate` (P9-J), and each image with `unchanged` (its current file's SHA-256 equals the snapshot's)      | 409 `DOCUMENT_REVOKED`, 409 `DOCUMENT_NOT_VALID`, 409 `CODE_KEY_CHANGED`                      |
| `POST /documents/issued/:id/revoke` `{reason, note?}`                        | revokes (not `REPLACED`, which only a reissue sets)                                                                                                                                                             | 409 `ALREADY_REVOKED`                                                                         |
| `POST /documents/issued/:id/reissue` `{reason, note?}` (ID card, marksheet)  | revokes with the reason and issues a new row from current data (new serial and code, `reissue_of`); TC and testimonial reissue through their own routes                                                         | 409 `ALREADY_REVOKED`; the kind's own errors                                                  |
| `POST /documents/id-cards/print-data` (P8's route, extended)                 | each student now comes as `issued` (live card: its snapshot, template version, serial, `verifyUrl`; counted as a print) or `notIssued` (live data, QR empty)                                                    | as P8                                                                                         |
| `POST /documents/id-cards/issue` `{templateId, studentIds (≤ 100), replace}` | issues cards to students without a live one; with `replace`, also revokes live ones (`REPLACED`) and issues new; returns the print payload                                                                      | 422 `TOO_MANY`; 409 `TEMPLATE_ARCHIVED`; deactivated or non-ACTIVE students reported, skipped |

### TC and testimonial (P9b), CORE, OWNER/ADMIN

| Route                                                                                                                                                          | Does                                                                                                                                                           | Errors                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /documents/tc/check?studentId`                                                                                                                            | status, `leftOn`, reason; the last enrolment (year, class, section, roll); published exams of that year; `balance {paisa, asOf}` or null (FEES off); a live TC | 404                                                                                                                                              |
| `POST /documents/tc` `{studentId, templateId, leaving?: {status, leftOn, reason}, conduct, lastClass, lastExam?, remarks?, expectedBalancePaisa, duesReason?}` | one transaction: checks, leaving (if ACTIVE), dues, issue                                                                                                      | 422 `LEAVING_REQUIRED`, 422 `ALREADY_LEFT`; 409 `TC_EXISTS {serial}`; 409 `TC_DUES_UNPAID {balancePaisa}`; 409 `DUES_CHANGED`; 409 `DEACTIVATED` |
| `POST /documents/tc/:id/reissue` `{reason, …the same fields}`                                                                                                  | revokes the live TC with the reason and issues the corrected one (dues checked again)                                                                          | as above, 409 `ALREADY_REVOKED`                                                                                                                  |
| `POST /documents/testimonials` `{studentId, templateId, board: {exam, board, roll, registrationNo, session, year, gpaH?, resultText?}, conduct, remarks?}`     | issue                                                                                                                                                          | 409 `TESTIMONIAL_EXISTS` (live one for that exam and year); 422 validation                                                                       |
| `POST /documents/testimonials/:id/reissue` `{reason, …}`                                                                                                       | revoke and issue                                                                                                                                               | as above                                                                                                                                         |

**The TC transaction, in order** (decision P9-M, P9-N):

1. `SELECT … FOR UPDATE` the student; deactivated → 409 `DEACTIVATED`; a live TC → 409
   `TC_EXISTS`.
2. ACTIVE needs `leaving` (422 `LEAVING_REQUIRED`); a leaver must not send it (422
   `ALREADY_LEFT`).
3. With FEES on: `FeeBalanceReader.owedToday(studentId)` (generates the student's dues as the
   ledger does, then sums `dueBalance`). A balance different from `expectedBalancePaisa` → 409
   `DUES_CHANGED` (the warning the admin answered must be the truth, as the counter's
   `DUES_CHANGED`); a balance above 0 without `duesReason` (10–500 characters) → 409
   `TC_DUES_UNPAID {balancePaisa}` (S25).
4. ACTIVE: `StudentAdminService.leave(studentId, leaving)` (P5) in the same transaction.
5. Issue (serial, code, snapshot with `tc: {leftOn, leaveStatus, leaveReason, conduct, lastClass,
lastExam, remarks, balancePaisa, duesReason}`); `tc.dues_note` prints "সকল পাওনা পরিশোধিত" /
   "All dues paid" only at a zero balance, and nothing otherwise (the paper never claims what is
   not true).
6. Audit `issued_document` CREATE with `{kind, serial, duesOverridden, balancePaisa}`; P5's leave
   writes its own audit row.

Any refusal rolls back everything, the leaving status included.

### Admit cards and marksheets (P9b), `@RequireModule('EXAMS')`

| Route                                                                                 | Roles        | Does                                                                                                                                                                                                                                                    | Errors                              |
| ------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `GET /exams/:id/admit-cards` (exists)                                                 | OWNER, ADMIN | gains `layout` (the default ADMIT_CARD template's current version, or the preset when none) and the profile's header fields and logo id                                                                                                                 |                                     |
| `GET /exams/:id/report-cards`, `GET /me/children/:id/results/:examClassId` (exist)    | as today     | gain `layout` (the default MARKSHEET template's current version, or null = today's header) and the profile's fields; signature and seal ids only for OWNER/ADMIN (F1)                                                                                   |                                     |
| `POST /exams/:id/classes/:examClassId/marksheets` `{sectionId?, templateId, replace}` | OWNER, ADMIN | ≤ 100 students with a published result: takes the exam class `FOR SHARE` (publish takes it FOR UPDATE), snapshots each card at `published_version`, issues; students with a live marksheet are skipped, or replaced with `replace`; returns the payload | 422 `NOT_PUBLISHED`; 422 `TOO_MANY` |

- The register shows an issued marksheet as "changed since issue" when the class's
  `published_version` has moved past the snapshot's (computed; decision P9-O).
- Exams data reaches documents only through an `ExamDocumentsReader` exported by `ExamsModule`
  (published report cards for a class or section, the published version, a student's published
  exams for the TC's "last exam"), extending P5's `ExamResultsReader` when that is merged.

### Public (P9a), `@Public()`

| Route                      | Limits (Redis keys `rl:verify-*`, per address bucket: IPv4 as is, IPv6 by /64)                                                               | Answers                                                                                                                                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /public/verify/:code` | 30 a minute and 300 an hour per address; 50 not-found answers an hour per address, after which the address gets 429 for the rest of the hour | 200 `{institute: {name}, kind, serial, student: {nameBn, nameEn}, classAtIssue: {bn, en}, issuedOn, status: 'VALID' \| 'REVOKED'}`; 404 `DOCUMENT_NOT_FOUND` (malformed and unknown alike); 429 with `Retry-After` |

- **Order:** the address limits first (no database before them); the not-found budget is read
  (a new read-only `RateLimiter.count(key)`) before the lookup and counted only after a miss, so
  a found document never spends it and one address's misses never limit another's (decision
  P9-Q). Then normalise and decode the code; malformed → counted as a miss and the same 404 as an
  unknown code, without the database. Then `SELECT public.document_verify($1)` through
  `PrismaService.client`, outside any transaction.
- **Headers:** `Cache-Control: no-store` on every answer (P3b).
- **Logs:** the code is never logged; an error logs the hash's first 8 hex characters only.
- **Serial formatting** happens in the API (`formatDocumentSerial`), the function returns the
  parts.

## Environment

| Variable                                                                               | Read by | Notes                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DOCUMENT_CODE_KEY`                                                                    | API     | ≥ 32 characters, required in production (decision P9-S); development and tests derive one from `OTP_PEPPER` (as `platformKeys()` does for `PLATFORM_TOTP_KEY`). Changing it never breaks verification; reprints of older documents are refused and need a reissue. Back it up with `.env`. |
| `WEB_PUBLIC_URL`                                                                       | API     | from P3: the QR's base address; required in production; must stay valid for as long as the papers do (P9-D)                                                                                                                                                                                |
| `DOCUMENT_VERIFY_PER_ADDRESS_PER_MIN`, `…_PER_HOUR`, `DOCUMENT_VERIFY_MISSES_PER_HOUR` | API     | optional, defaults 30, 300, 50                                                                                                                                                                                                                                                             |

Added to `.env.example` and deploy.md (with the "existing install" role command); `.env` is the
owner's.

## Web

- **Register** (`/documents/register`, P9a): filters (kind, year, state), search, the table above;
  a row opens a side panel with the document as printed (rendered from the snapshot and the
  template version), its chain, and actions: Print again (with the "images changed since issue"
  notice), Revoke (reason, note), Reissue.
- **ID cards** (P8's page, P9a): "Prepare" shows each student as issued or not; buttons "Issue
  cards for the 12 without one" and "Issue new cards for everyone (the old ones stop being
  valid)"; the QR prints on issued cards.
- **Student page** (P9a): a "Documents" card: the live ID card, TCs, testimonials and marksheets
  with their state; actions "Issue TC", "Issue testimonial", "ID card".
- **TC wizard** (`/documents/tc/new?studentId=`, P9b): student → leaving (status, date in the
  institute's time, reason) when ACTIVE → conduct, last class (prefilled), last exam (a published
  exam or typed), remarks → the dues step (the balance; with dues, a warning and the required
  reason) → preview → issue → print. A 409 `DUES_CHANGED` reloads the dues step.
- **Testimonial form** (`/documents/testimonials/new?studentId=`, P9b): board exam details (Bangla
  digits accepted), conduct → preview → issue → print.
- **Exams** (P9b): admit cards render through the template (the `exam_routine` block draws the
  student's routine); report cards render with the MARKSHEET layout's header, footer and
  watermark around today's body (S29) for staff, teachers and guardians (signature and seal
  images only for OWNER/ADMIN); "Issue marksheets" on a published class's results tab (OWNER/ADMIN)
  prints the issued cards with serial and QR from their snapshots.
- **Public page** `/v/[code]` and `/v` (P9a), `(public)` group, route namespace `verify`, bn by
  default with an en switch, no session restored (as P3b's `/apply`):
  - one card: a large VALID (check, success colour) or REVOKED (cross, destructive colour) or
    "No document with this code"; then the institute's registered name, the kind, serial,
    student name, class at issue and issue date; a line "Check that the name and class match the
    paper in your hand";
  - `/v` without a code: a box to type the code from the paper;
  - fetched from the browser (as P3-U: a server-side fetch would put every visitor behind the web
    server's address in the per-address limits);
  - `next.config.ts` gains `headers()` for `/v` and `/v/:code*`: `Referrer-Policy: no-referrer`,
    `X-Robots-Tag: noindex`;
  - budget: an entry for `/v/[code]` in `apps/web/perf/budget.json` (start at `/login`'s 246 KB);
    ≤ 3 s to interactive at 390 px, 4× CPU, slow 4G (`perf/measure.mjs` extended as P3b did).

## Files

| File                                                                                                                                                                                          | Change                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `packages/db/prisma/schema.prisma` + 3 migrations                                                                                                                                             | enum, two tables, role grants, the function               |
| `packages/db/test/documents-register-rls.test.ts`, `document-verify.test.ts`, `schema-safety.test.ts`                                                                                         | isolation, immutability, the role and function            |
| `docker/postgres/init/01-roles.sh`, `deploy/postgres/create-roles.sh`                                                                                                                         | `jantrik_verify`                                          |
| `packages/shared/src/documents/` (`serial.ts`, `code-text.ts`, `state.ts`, `register-api.ts`, `tc.ts`, `testimonial.ts`) + tests                                                              | formats, the validity rule, schemas                       |
| `apps/api/src/documents/` (`issued-documents.service.ts`, `document-codes.ts`, `serials.ts`, `id-card-issue.service.ts`, `tc.service.ts`, `testimonial.service.ts`, `register.controller.ts`) | staff side                                                |
| `apps/api/src/documents/public/` (`verify.controller.ts`, `verify.service.ts`, `no-tenant-access.spec.ts`)                                                                                    | public side                                               |
| `apps/api/src/fees/fee-balance-reader.ts`, `fees.module.ts`                                                                                                                                   | `FeeBalanceReader` exported                               |
| `apps/api/src/exams/exam-documents-reader.ts`, `exams.module.ts`, `results/exam-results.service.ts`, `seats/seat-plan.service.ts`                                                             | the reader, layouts on report and admit cards, marksheets |
| `apps/api/src/redis/rate-limiter.service.ts`                                                                                                                                                  | `count(key)` (read-only)                                  |
| `apps/api/src/config/env.ts`, `production-env.ts` (+ specs)                                                                                                                                   | the variables and production checks                       |
| `apps/api/test/documents-register.e2e-spec.ts`, `documents-verify.e2e-spec.ts`, `documents-tc.e2e-spec.ts`, `documents-testimonial.e2e-spec.ts`, `exams-marksheets.e2e-spec.ts`               | API tests                                                 |
| `apps/web/src/app/(app)/documents/**`, `apps/web/src/app/(public)/v/**`, `apps/web/src/components/documents/**`, `components/exams/print-pages.tsx`, `report-card.tsx`                        | pages and renderers                                       |
| `apps/web/messages/documents/*`, `messages/verify/*`, `i18n/route-messages.ts`, `next.config.ts`, `perf/budget.json`, `perf/measure.mjs`                                                      | strings, headers, budget                                  |
| `apps/web/e2e/documents-register.spec.ts`, `verify.spec.ts`, `exams.spec.ts` (admit cards, report cards)                                                                                      | Playwright                                                |
| `docs/documents.md`, `database.md`, `auth.md` (a second no-login surface), `exams.md`, `fees.md` (the TC's dues check), `deploy.md`, `.env.example`, `decisions-pending.md`                   | docs                                                      |

---

## P9a: the register, codes, ID cards and public verification

### Task 1: The register tables

**Files:** `schema.prisma`, migration 1, `packages/db/test/documents-register-rls.test.ts`,
`schema-safety.test.ts`.

- [ ] **Step 1: Write the failing tests:**
  - isolation: A's rows invisible in B's context and with no context;
  - FKs: B's student, B's template version, B's exam, a reissue of B's row → errors;
  - CHECKs: `ADMIT_CARD` kind; a 31-byte hash; `revoked_at` without a reason and the reverse; a
    note without revocation; a MARKSHEET without `exam_id` and an ID card with one; no student
    name; `serial_year` ≠ the issue date's year; `data` over 128 KB → each refused;
  - uniques: the same hash twice (also across institutes); the same serial twice; a second live
    ID card and a second live TC for one student; a second reissue of one row; a revoked card does
    not block a new live one;
  - the app cannot DELETE a row, cannot UPDATE `data`, `serial_no`, `verify_code_hash`,
    `student_name_bn` or `issued_on`; it can revoke a live row; after that, even `print_count`
    cannot change (the restrictive policy: zero rows updated);
  - counters: S I U, no DELETE.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Schema and migration**; drift check empty.
- [ ] **Step 4: Run them and `schema-safety.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit:** "The issued documents register and its serial counters: insert-only
      history, one-way revocation, one live card or TC per student (sprint 1 P9)".

### Task 2: Codes, serials and the validity rule

**Files:** `packages/shared/src/documents/serial.ts`, `code-text.ts`, `state.ts` (+ tests);
`apps/api/src/documents/document-codes.ts` (+ spec); `env.ts` and `production-env.ts` (+ specs).

- [ ] **Step 1: Tests:**
  - `formatDocumentSerial('TC', 2026, 7)` = `TC-2026-0007`; 12345 → `TC-2026-12345`;
  - code text: 16 bytes ↔ 26 characters round trip; `7kq2-m9xd …` with spaces, dashes, `o` and `l`
    normalises to the same bytes; 25 or 27 characters, `U` or `*` → invalid;
  - `DocumentCodes`: the same id and key give the same code; another key another code and another
    fingerprint; `hash(code)` is SHA-256; the URL is `WEB_PUBLIC_URL/v/<code>`; for a 40-character
    base the QR (`QRCode.create`, ECC M) is at most version 5;
  - `documentState` matrix: each kind × revoked or not × student ACTIVE, left, deactivated →
    VALID, REVOKED or NOT_VALID (the register's word for a computed REVOKED, with why);
  - env: production without `DOCUMENT_CODE_KEY` or with 31 characters refuses to start;
    development derives one.
- [ ] **Steps 2–5.** Commit: "Verification codes derived from the row with a server key (only
      their hash is stored), serial formats and the validity rule".

### Task 3: The issue engine and the register API

**Files:** `issued-documents.service.ts`, `serials.ts`, `register.controller.ts`,
`apps/api/test/documents-register.e2e-spec.ts`.

**`issue({kind, template, items: [{studentId, data, examId?}], reissueOf?})`:** reserves
`items.length` serials in one statement, creates ids, derives codes, inserts rows (snapshot and
public fields), audits each, returns rows with `verifyUrl` (computed, never stored).

- [ ] **Step 1: Write the failing tests** (review focus 3, 4, 5, 7):
  - 20 concurrent single issues of one kind → serials 1–20, no gap, no duplicate; one issue that
    fails after its serial was reserved (a forced error in the test hook) → the next issue gets
    that number; a bulk of 100 → 100 consecutive serials; a new year starts at 1;
  - **plain text:** after issuing, the code (base32 and hex) appears in no column of any table
    (a scan of every text, jsonb and bytea column in the scratch database), in no `audit_logs` row,
    in no captured log line, in no Redis key or value, in no job payload;
  - **snapshot:** after renaming the student, moving their section, editing the profile and saving
    the template, `GET /documents/issued/:id` and `POST …/print` return the original data and the
    original template version; the public answer keeps the issued name;
  - print: `print_count` 2, `last_printed_*` set, `duplicate` false the same day and true the
    next (`JANTRIK_TEST_TODAY`); a changed photo → `unchanged: false` for it;
  - revoke: reason stored, audited; a second revoke → 409 `ALREADY_REVOKED`; two revokes at once →
    one 200, one 409; a revoked document's print → 409 `DOCUMENT_REVOKED`;
  - reissue: the old revoked with the reason, a new serial and code, `reissue_of` set; two
    reissues at once → one new row;
  - a reprint after changing `DOCUMENT_CODE_KEY` (a second app instance) → 409 `CODE_KEY_CHANGED`;
  - B's document id → 404; TEACHER → 403.
- [ ] **Steps 2–5.** Commit: "Issue, print, revoke and reissue documents with gap-free serials and
      snapshots; codes never stored".

### Task 4: ID cards with their QR

**Files:** `id-card-issue.service.ts`, P8's `id-cards.service.ts`, the ID card pages and
renderer (QR as SVG), `apps/api/test/documents-register.e2e-spec.ts`, `documents.spec.ts`.

- [ ] **Step 1: Write the failing tests:**
  - issue for a section of 30 → 30 live cards; again without `replace` → 0 new, 30 reported as
    already issued; with `replace` → 30 revoked `REPLACED` and 30 new;
  - two issues for one student at once → one live card, the other 409 (the partial unique index);
  - print data: issued students carry the snapshot and `verifyUrl` and count a print; others are
    `notIssued`;
  - a student who leaves (P5's leave) → the card's state NOT_VALID in the register and REVOKED
    on the public page; after P5's return → VALID again;
  - Playwright: issue and print class 6 A; each card's QR `<svg>` draws exactly the module matrix
    of `QRCode.create(verifyUrl)` for that card's URL from the API (no QR decoder dependency), and
    that URL verifies as VALID.
- [ ] **Steps 2–5.** Commit: "ID cards get their stable verification QR: one live card per
      student, reprinted with the same code, replaced by a new one (S31)".

### Task 5: The verification role, grants and function

**Files:** migrations 2 and 3, `01-roles.sh`, `create-roles.sh`,
`packages/db/test/document-verify.test.ts`, `schema-safety.test.ts`.

- [ ] **Step 1: Write the failing tests** (as `jantrik_app` with no context):
  - a live ID card of an ACTIVE student → VALID with exactly the S32 keys; revoked → REVOKED; a
    left student's card → REVOKED; a left student's TC → VALID; after return → REVOKED;
    deactivated → REVOKED;
  - an unknown hash, a 31-byte input, NULL → NULL; an ARCHIVED institute → NULL; SUSPENDED →
    answers;
  - B's document → B's registered `tenants.name` even when B's profile names itself after A;
  - roles (review focus 2): `pg_has_role('jantrik_app', 'jantrik_verify', 'MEMBER')` false;
    `jantrik_owner` has SET without INHERIT; `jantrik_app` with no context still sees no
    `issued_documents` row (the `TO jantrik_verify` policies do not apply to it);
    `jantrik_platform_app`, `jantrik_ingest_app` and `jantrik_login_app` cannot execute the
    function; `SET ROLE jantrik_verify; SELECT data FROM issued_documents` → permission denied;
  - `schema-safety.test.ts`: `isVerify` checks and the privilege snapshot.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Create the role on the scratch cluster** (CI's `01-roles.sh` creates it), write
      migrations 2 and 3.
- [ ] **Step 4: Run the db suite.**
- [ ] **Step 5: Commit:** "Public document verification through one definer function under the
      jantrik_verify role (S32 fields only)".

### Task 6: The public verification API

**Files:** `apps/api/src/documents/public/*`, `rate-limiter.service.ts` (`count`),
`apps/api/test/documents-verify.e2e-spec.ts`.

- [ ] **Step 1: Write the failing tests:**
  - a valid code → 200 with the S32 fields, `Cache-Control: no-store`, serial formatted;
  - malformed (`abc`), unknown (26 valid characters) → byte-identical 404 bodies and the same
    headers;
  - a typed code in lower case with dashes → found;
  - limits: the 31st request in a minute from one address → 429 with `Retry-After`; another
    address unaffected; two IPv6 addresses in one /64 share a bucket;
  - 50 misses from one address → the 51st request (even with a valid code) 429; another address
    with a valid code → 200 (no shared budget); valid lookups never count as misses;
  - no database call before the address limits (a spy on the client); none for a malformed code;
  - code scan: nothing under `documents/public/` imports `Db`, `TenantJobRunner` or
    `AuditService`; the code never appears in captured logs.
- [ ] **Steps 2–5.** Commit: "GET /public/verify/:code: identical answers for unknown and
      malformed codes, per-address limits with no shared budget".

### Task 7: The public page

**Files:** `apps/web/src/app/(public)/v/**`, `messages/verify/*`, `route-messages.ts`,
`next.config.ts`, `perf/budget.json`, `perf/measure.mjs`, `apps/web/e2e/verify.spec.ts`.

- [ ] **Step 1: Playwright (CI):** at 390 px in bn, open a valid card's URL → VALID, the
      registered name, Bangla-digit date, ASCII serial; a revoked TC → REVOKED; a made-up code →
      not found; `/v` with the code typed in lower case with spaces → found; the language switch; the response headers `Referrer-Policy: no-referrer`
      and `X-Robots-Tag: noindex`; no request to `/auth/refresh`; no photo, date of birth or
      phone anywhere in the DOM.
- [ ] **Steps 2–4:** the page; measure `/v/[code]` (six interleaved runs on a quiet machine):
      ≤ 3 s to interactive; the size budget entry.
- [ ] **Step 5: Commit:** "The public verification page (mobile first, bn default, within the
      budget)".

### Task 8: The register pages and the student's documents

**Files:** `apps/web/src/app/(app)/documents/register/**`, the student page's card, messages,
`apps/web/e2e/documents-register.spec.ts`.

- [ ] **Step 1: Playwright (CI):** an owner opens the register, filters ID cards of 2026, opens
      one, prints it again (count 2), revokes it with "lost" → REVOKED; reissues another → the
      chain shows both; the student page lists the documents; a teacher has no menu item.
- [ ] **Steps 2–4**, screenshots bn at 1366 and 390 px.
- [ ] **Step 5: Commit:** "The issued documents register: search, reprint, revoke, reissue".

### Task 9: P9a docs, gates, review, PR

- [ ] `docs/documents.md` (register, codes, serials, validity, verification, limits),
      `database.md` (tables, the role and its exact grants, the function, the existing-volume
      command), `auth.md` (the second no-login surface), `deploy.md` (the role in
      `create-roles.sh`, `DOCUMENT_CODE_KEY` and its backup, `WEB_PUBLIC_URL` permanence),
      `.env.example`, `decisions-pending.md` (a "Sprint 1, P9" section).
- [ ] Full gates; review subagent (public surface, definer function, immutability, codes) with
      review focus 1–5 and 7; PR; CI green.

## P9b: TC, testimonial, admit cards and marksheets

### Task 10: The readers

**Files:** `apps/api/src/fees/fee-balance-reader.ts` (+ spec), `fees.module.ts`;
`apps/api/src/exams/exam-documents-reader.ts` (+ spec), `exams.module.ts`.

- [ ] **Step 1: Tests:** `owedToday` for a student whose current month's due was never generated
      → generates it and counts it (the ledger's answer); for a paid-up student 0; it writes no
      payment and no due beyond generation; the exams reader returns only published classes and
      the version; a student's published exams of a year in date order.
- [ ] **Steps 2–5.** Commit: "Fee balance and published report cards for documents, through
      their modules' own readers".

### Task 11: Transfer certificates

**Files:** `tc.service.ts`, `packages/shared/src/documents/tc.ts`,
`apps/api/test/documents-tc.e2e-spec.ts`.

- [ ] **Step 1: Write the failing tests** (review focus 6, money):
  - an ACTIVE student, no dues: `leaving` given → the student TRANSFERRED with the date and
    reason, a TC `TC-2026-0001`, "All dues paid" in the snapshot; both audited;
  - without `leaving` → 422 `LEAVING_REQUIRED`, nothing written;
  - a leaver (from promotion) → no `leaving` needed; with it → 422 `ALREADY_LEFT`;
  - 1 500 taka due: no reason → 409 `TC_DUES_UNPAID {balancePaisa: 150000}` and the student still
    ACTIVE (rolled back); with a reason → issued, the balance and reason in the snapshot and the
    audit, no "dues paid" line; `expectedBalancePaisa` stale (a payment at the counter meanwhile)
    → 409 `DUES_CHANGED`;
  - FEES off → no check;
  - a live TC → 409 `TC_EXISTS`; reissue → the old REVOKED, a new serial;
  - a returned student's TC → NOT_VALID / REVOKED publicly;
  - a deactivated student → 409; B's student → 404; TEACHER → 403;
  - the snapshot is unchanged after editing the student's name.
- [ ] **Steps 2–5.** Commit: "Transfer certificates: leaving and the TC in one transaction, a
      dues warning with a required reason (S25)".

### Task 12: Testimonials

**Files:** `testimonial.service.ts`, `packages/shared/src/documents/testimonial.ts`,
`apps/api/test/documents-testimonial.e2e-spec.ts`.

- [ ] **Step 1: Tests:** board details with Bangla digits in roll, registration, GPA and year →
      stored ASCII, GPA in hundredths (`5.00` → 500); GPA or result text required; a second live
      testimonial for the same exam and year → 409 `TESTIMONIAL_EXISTS`, for another exam → issued;
      the details in the snapshot; reissue; validation lengths.
- [ ] **Steps 2–5.** Commit: "Testimonials with the board exam details typed at issue and kept in
      the snapshot".

### Task 13: Admit cards through the designer

**Files:** `seat-plan.service.ts`, `packages/shared/src/documents/admit-card-data.ts` (+ test),
`components/exams/print-pages.tsx`, `apps/web/e2e/exams.spec.ts`.

- [ ] **Step 1: Tests:** the mapping from an `AdmitCards` entry to `DocumentData` (seat, routine,
      exam); the API returns the default template's layout or the preset's; Playwright: the admit
      cards page prints two per A4 through the template, each with name, roll, seat and routine
      (the existing assertions keep passing, `data-testid="admit-card"` kept); an edited template
      (a moved logo) shows on the cards.
- [ ] **Steps 2–5.** Commit: "Exam admit cards print through the institute's template (the preset
      reproduces today's card)".

### Task 14: Marksheets

**Files:** `exam-results.service.ts`, `exams.module.ts`, the marksheet issue service,
`report-card.tsx`, `apps/api/test/exams-marksheets.e2e-spec.ts`, `exams.spec.ts`.

- [ ] **Step 1: Write the failing tests:**
  - report cards with a MARKSHEET template: the header and footer elements around the unchanged
    body; a teacher's and a guardian's response has no signature or seal ids; without a template,
    today's header;
  - issue for a published section of 30 → 30 marksheets with serials and QRs, each snapshot the
    published card at the current version; an unpublished class → 422 `NOT_PUBLISHED`; a second
    issue → all skipped; with `replace` → revoked and new;
  - republish (a corrected mark) → the register marks the issued ones "changed since issue"; the
    reprint still shows the issued marks;
  - an issue while a publish runs → the issue waits for the publish's lock and snapshots the new
    version (never a mix);
  - Playwright: an owner issues marksheets for a section and prints them; the QR verifies.
- [ ] **Steps 2–5.** Commit: "Marksheets: the institute's header, footer and watermark around the
      data-driven marks table (S29), issued with serials and QR".

### Task 15: TC and testimonial pages

**Files:** `apps/web/src/app/(app)/documents/tc/**`, `testimonials/**`, messages,
`documents-register.spec.ts`.

- [ ] **Step 1: Playwright (CI):** an admin issues a TC for an ACTIVE student with dues: the dues
      step shows the balance in Bangla digits and refuses to continue without a reason; with it,
      the TC prints with ASCII serial and the QR; the student page now shows them as left. A
      testimonial with Bangla-digit GPA prints `5.00` in the bn format the template uses.
- [ ] **Steps 2–4**, screenshots bn at 1366 and 390 px.
- [ ] **Step 5: Commit:** "TC and testimonial pages".

### Task 16: P9b docs, gates, review, PR

- [ ] `docs/documents.md` (TC, testimonial, admit cards, marksheets), `exams.md` (admit cards and
      report cards through templates, marksheet issue), `fees.md` (the TC's dues check),
      `decisions-pending.md`.
- [ ] Full gates; review subagent (money rule of the TC, leaving atomicity, marksheet locking,
      review focus 3, 6, 7); PR; CI green.

## Madrasa pack overlap (Sprint 2)

- **Testimonials:** the board details are typed now; M6's `board_registrations` pre-fill them later
  (its plan already tests "the student's board details reaching P9's testimonial"). Qawmi boards
  and Dawrah/Takmil exams are typed text; a DIVISION result (M1) goes in `resultText`.
- **New registered kinds:** `HIFZ_COMPLETION` (M3, from `hifz_assessments`) uses this engine, its
  serial prefix and its validity rule ("not revoked, student not deactivated") as data in
  `serial.ts` and `state.ts`; `BOARD_FORM` (M6) is printed, not registered, like admit cards.
- **Hijri dates** on documents (M2's `date.hijri` field) are part of the snapshot like any field.
- **The marksheet body** under DIVISION mode is the report card's own (exams), unchanged here.

## Risks

- **The QR's address is permanent.** A TC is kept for decades; if `WEB_PUBLIC_URL` ever changes,
  `/v/*` on the old domain must redirect for good (deploy.md says so; decision P9-D offers a
  separate short domain).
- **A copied QR on a forged paper.** The page proves that a document with this name, class and
  serial exists, not that the paper in hand is unaltered; the page tells the verifier to compare
  them (S32 deliberately shows no photo).
- **`DOCUMENT_CODE_KEY` lost or changed:** verification keeps working; reprints of older
  documents need a reissue (a new serial and QR).
- **Public endpoint load:** one indexed read per request, bounded per address and by the global
  unauthenticated limit; a distributed flood is Caddy's and the host's problem as for every
  public page.
- **Register size:** about 1 KB per ID card and 10 KB per marksheet; an institute of 1 000
  students issuing cards and two marksheets a year adds about 21 MB a year.
- **P5 and P3b not merged when P9 starts:** P9a needs P5's leaving statuses only for the validity
  rule's tests and TC (P9b); `WEB_PUBLIC_URL` and the rate limiter additions are small and can be
  carried.
- **Wording of TC and testimonial** is a draft until checked with the owner (P8-P).
- **The admit card's move** changes a working print; the e2e assertions are kept to catch
  regressions.

## Size and split

**Large.** 3 migrations, 2 tables, 1 role, 1 definer function, ~16 routes, 6 pages, ~10 test files.
Recommended as **two PRs** (decision P9-A):

- **P9a** (Tasks 1–9): the register, codes, ID card QR, verification role, function, API and page.
  Reviewed as a security change (public surface, definer function).
- **P9b** (Tasks 10–16): TC, testimonial, admit cards, marksheets. Reviewed for the money rule and
  exams locking.

## Self-review

- **Sprint plan coverage (P9):** `issued_documents` with kind, template id and version, student,
  serial per kind and year gap-free from `document_serial_counters`, `verify_code_hash` of a
  128-bit code only in the QR, the snapshot, who and when, revoked by/when/why, `reissue_of`
  (Tasks 1–3); ID cards one row per student code, lost card revoked by a new one (Task 4); TC for
  a leaver or an active student who is leaving, date and reason, conduct, last class and exam,
  dues warning plus reason (S25), serial and signatures (Task 11); testimonial with board details
  typed and snapshotted (Task 12); verification through `document_verify(code_hash)` owned by
  `jantrik_verify`, S32 fields, public `/v/[code]`, rate-limited, within the budget (Tasks 5–7);
  admit cards through the designer with the existing API's data (Task 13); the marksheet layout
  and the data-driven table (S29, Task 14); the sprint's tests: gap-free serials under concurrency
  and rollback (Task 3), verification unknown/revoked/another institute/rate limit (Tasks 5, 6),
  no plain-text code (Task 3), TC dues reason (Task 11), snapshot after an edit (Tasks 3, 11);
  docs (Tasks 9, 16).
- **Departures from the sprint plan, each a decision:** the code is derived from the row with a
  key rather than drawn at random, so reprints keep the QR (P9-C); `jantrik_verify` reads the
  public names from the register row instead of the profile and students (P9-G) and the
  student's status for validity (P9-I); admit cards are not registered (P9-F).
- **Names used the same everywhere:** `issued_documents`, `document_serial_counters`,
  `document_verify`, `jantrik_verify`, `DocumentCodes`, `DOCUMENT_CODE_KEY`,
  `formatDocumentSerial`, `documentState`, `FeeBalanceReader`, `ExamDocumentsReader`,
  `DOCUMENT_NOT_FOUND`, `TC_DUES_UNPAID`, `DUES_CHANGED`, `TC_EXISTS`, `CODE_KEY_CHANGED`.

## Decisions for the owner

The approved S25, S29, S31 and S32 stand. These are new; each default is what the plan builds
unless you change it.

| #    | Decision                                       | Recommended default                                                                                                                                                                                                                                    | Alternative                                                                               |
| ---- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| P9-A | One PR or two                                  | Two: P9a (register, codes, ID card QR, public verification), P9b (TC, testimonial, admit cards, marksheets)                                                                                                                                            | One large PR                                                                              |
| P9-B | Who issues, reprints and revokes               | OWNER/ADMIN for every kind and the register; teachers and guardians keep printing unserialized report cards (now with the institute's header)                                                                                                          | OWNER only for TC, testimonial and revocation                                             |
| P9-C | How the verification code is made              | 128 bits derived from the row's id with `DOCUMENT_CODE_KEY` (HMAC); only its SHA-256 is stored; a reprint rebuilds the same QR                                                                                                                         | A random code shown once; every reprint is a reissue with a new serial                    |
| P9-D | What the QR holds                              | `WEB_PUBLIC_URL/v/<code>`; that address must stay valid for as long as the papers (a permanent redirect if it ever moves)                                                                                                                              | A separate short verification domain in its own variable                                  |
| P9-E | Serial format and scope                        | Per kind and calendar year of the issue date, gap-free: `ID-2026-0412`, `TC-2026-0007`, `TM-…`, `MS-…`; ASCII digits                                                                                                                                   | Per academic year; an institute-chosen prefix                                             |
| P9-F | Which kinds are registered                     | ID cards, TCs, testimonials and issued marksheets; admit cards are printed without serial or QR (reprinted every exam)                                                                                                                                 | Register admit cards too                                                                  |
| P9-G | Which institute name the public page shows     | Jantrik's registered name (`tenants.name`, which institutes cannot change), so an impostor cannot borrow a famous school's name; no EIIN (typed by the institute, unverified); S32's student fields copied into the register row at issue              | The profile's own names and EIIN                                                          |
| P9-H | Institutes whose documents verify              | TRIAL, ACTIVE and SUSPENDED (a student's papers stay valid when the institute stops paying); ARCHIVED answers "not found"                                                                                                                              | ACTIVE and TRIAL only                                                                     |
| P9-I | Validity beyond revocation                     | Computed: a live ID card is VALID only while the student is ACTIVE; a live TC only while the student has left; a deactivated student's documents are REVOKED                                                                                           | Only explicit revocation (a leaver's card stays VALID until someone revokes it)           |
| P9-J | Reprints                                       | Allowed for OWNER/ADMIN (not when revoked or not valid), counted and audited, same serial and QR; prints after the issue day show "অনুলিপি / Duplicate" where the template places that field; images print only if unchanged since issue               | Every reprint is a reissue                                                                |
| P9-K | Reissue                                        | Revokes the old with its reason and issues a new serial and QR from current (or corrected) data, linked by `reissue_of`                                                                                                                                | —                                                                                         |
| P9-L | Revocation reasons                             | Lost, damaged, wrong data, replaced, cancelled, other (+ a note); never shown publicly                                                                                                                                                                 | Free text only                                                                            |
| P9-M | The TC's dues check (S25 details)              | With FEES on: today's balance after generating the student's dues; above zero needs a reason (10–500 characters), kept with the balance in the snapshot and audit; a stale balance → `DUES_CHANGED`; "All dues paid" prints only at zero               | Count only dues already generated                                                         |
| P9-N | A TC for an ACTIVE student                     | The wizard sets the leaving status (P5's leave) in the TC's own transaction; one live TC per student, corrections by reissue                                                                                                                           | Leave first in the student page, then issue                                               |
| P9-O | Marksheets                                     | Every report card print gets the institute's MARKSHEET header, footer and watermark; OWNER/ADMIN may also "issue" a published class's marksheets with serial and QR (snapshot of that published version; a republish flags them "changed since issue") | Marksheets always issued (a serial for every print)                                       |
| P9-P | Testimonials                                   | Board details typed at issue; several per student allowed, one live per exam and year                                                                                                                                                                  | One live testimonial per student                                                          |
| P9-Q | Public page limits                             | Per address (IPv6 by /64) 30 a minute, 300 an hour, and 50 not-found answers an hour; nothing shared between addresses                                                                                                                                 | Turnstile on the page (an outside script on every scan)                                   |
| P9-R | The code as text on paper                      | Printed under the QR on A4 documents, so anyone can type it at `/v`; off by default on ID cards (no room)                                                                                                                                              | QR only                                                                                   |
| P9-S | The code key                                   | A new secret `DOCUMENT_CODE_KEY` (required in production, backed up with `.env`); development derives one                                                                                                                                              | Derive it from `JWT_ACCESS_SECRET` (rotating that after a leak would break every reprint) |
| P9-T | Creating `jantrik_verify` on existing installs | As P3-P: one documented command per existing Postgres; the migration refuses with a clear message until then                                                                                                                                           | —                                                                                         |
| P9-U | The public page's language and indexing        | bn by default with an en switch; `noindex` and `no-referrer`; no session, no app shell                                                                                                                                                                 | Follow the browser's language                                                             |
| P9-V | Today's admit card component                   | Replaced by the template renderer once the preset reproduces it (the e2e assertions kept)                                                                                                                                                              | Keep both, the template optional                                                          |

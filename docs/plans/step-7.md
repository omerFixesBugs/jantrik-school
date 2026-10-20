# Step 7 plan: institute setup, staff, students, import

Branch `feature/step-7-setup-students`. Pre-approved for this overnight run (see the brief); the
owner reviews in the morning. Decisions that need the owner are recorded in
[docs/decisions-pending.md](../decisions-pending.md), each with the default taken.

Every phase ends with: lint, typecheck, format:check, unit + API + db tests, Playwright e2e, a
review by a fresh subagent (tenant isolation, RLS, roles, input validation), fixes, commit, push.
New screens are checked at 360px and 1440px in bn and en, with the overflow check.

## Phase A: project skill

`.claude/skills/add-tenant-table/SKILL.md`: the docs/database.md checklist as a step-by-step
procedure (model, composite FKs, leading index, migration `--create-only`, RLS + grants + CHECKs
appended, apply, drift check, schema-safety test, isolation test). Used for every new table below.

Also: CI currently runs only on pushes to `main` and on PRs, so a pushed feature branch would not
be checked. Add `feature/**` to the push trigger (reversible; recorded as a decision).

## Phase B: institute setup (OWNER/ADMIN, module CORE)

**Schema** (existing tables, one migration): `is_active boolean NOT NULL DEFAULT true` on
`class_levels`, `sections`, `shifts`, `subjects`, `study_groups`. No new tables.

**API** `/setup/*`, `@RequireModule('CORE') @Roles('OWNER','ADMIN')`, zod DTOs in
`@jantrik/shared` (`setup.ts`), every write audited:

| Resource       | Endpoints                                                 | Rules                                                                                                                                                                                                                         |
| -------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Academic years | list, create, update, `POST :id/current`, `POST :id/next` | one current (partial unique index; unset + set in one tx). "Next year" creates the following year (name +1, dates +1 year) and copies the sections of the source year (no students). Delete only when no sections/enrolments. |
| Class levels   | list, create, update, delete                              | code unique; delete only if unused (sections, subjects, enrolments), else 409 `IN_USE` and the UI offers deactivate.                                                                                                          |
| Sections       | list by year, create, update, delete                      | per year + class level; optional shift; capacity ≥ 1; name unique per year+class.                                                                                                                                             |
| Shifts         | list, create, update, delete                              | start < end (local wall-clock times).                                                                                                                                                                                         |
| Subjects       | list by class level, create, update, delete               | optional study group; optional flag; code unique per class level.                                                                                                                                                             |
| Study groups   | list, create, update, delete                              | code unique.                                                                                                                                                                                                                  |
| Labels         | list, `PUT` all                                           | known keys only (`class_level`, `section`, …); 1–40 chars; the roles cache is unaffected; `GET /me/context` labels refresh.                                                                                                   |

`IN_USE` (409) is returned with the counts so the UI can say why. Deactivate = `PATCH {isActive:false}`.
Inactive items stay visible in setup (badge) and in existing records, but are hidden from pickers
for new admissions, transfers and imports.

**Web** `/setup` (nav "প্রতিষ্ঠান সেটআপ", OWNER/ADMIN): tabs for years, classes & sections,
shifts, subjects, groups, labels (with a live preview of sample sentences). The existing
`/sections` placeholder becomes a redirect to `/setup?tab=classes`.

## Phase C: staff (OWNER/ADMIN, module CORE)

**Schema:** migration replacing `app_find_or_create_user(phone, name)` with
`app_find_or_create_user(phone, name, name_bn)`: `DROP FUNCTION app_find_or_create_user(text, text)`
first (no lingering overload), same checks (tenant context required, REVOKE/GRANT before
`OWNER TO jantrik_auth`, EXECUTE for `jantrik_app` only; ACL tests updated); `name_bn` is written
only when the person is new, never on an existing user (they may belong to other tenants).

**API** `/staff`:

- `GET /staff`: users with at least one staff role here (OWNER, ADMIN, TEACHER, ACCOUNTANT,
  STAFF), their staff roles, status, phone, assigned sections (current year).
- `POST /staff`: phone (+ Bangla digits), name, name_bn, roles. find-or-create the user, create
  the memberships. If the person is already staff here: 409 `ALREADY_STAFF`. No SMS.
- `PUT /staff/:userId/roles`: replaces the **staff** roles only (GUARDIAN/STUDENT memberships of
  the same person are untouched). Roles cache invalidated after commit.
- `POST /staff/:userId/deactivate` / `.../activate`: all staff memberships DISABLED/ACTIVE; roles
  cache invalidated; the per-request membership check ends access on the next request.
- `PUT /staff/:userId/sections`: the sections (current year) this person teaches.
- Rules: only an OWNER may change anything about a person who holds (or held) OWNER here: roles,
  deactivate, activate; only an OWNER may grant OWNER. Never remove/deactivate the last active
  OWNER: **all** the tenant's active OWNER rows are locked `FOR UPDATE` before the check, so two
  concurrent removals are serialised. Nobody changes their own roles or status. `:userId` must have
  a staff membership here (else 404); assigned sections must be in the current year.
  Everything audited (`membership`).

**Web** `/staff`: list (cards on phones, table on desktop), add dialog with the "they can log in
with OTP on this number" note, role editor, deactivate/activate with confirm, sections picker.

## Phase D: students

**Schema:**

- New tenant table `student_settings` (one row per tenant): `code_prefix`, `code_pattern`
  (default `{PREFIX}-{YEAR}-{NNNN}`), defaults in code until saved (no backfill).
- New tenant table `student_code_counters` (`tenant_id`, `year`, `next_value`): atomic
  `INSERT … ON CONFLICT DO UPDATE … RETURNING`, skipping codes already taken.
- Both via the add-tenant-table skill (RLS, grants, schema-safety).

**API** (`students` controller, OWNER/ADMIN for writes, staff for reads as today):

- `POST /students`: all fields incl. board registration ones; Bangla digits normalised;
  `birth_registration_no` exactly 17 digits; BD mobile for guardians; at least one name.
  Guardians: create, or link an existing guardian of this tenant by phone; exactly one primary;
  each guardian gets a login (user + GUARDIAN membership) like the seed, no SMS.
  Enrolment: year, class level, section (must belong to both), optional group, roll (unique in
  the section, 409 `ROLL_TAKEN`). `student_code` generated unless given.
- `GET /students/:id` (profile), `PATCH /students/:id`, guardians add/link/update/unlink,
  `POST /students/:id/transfer` (another section of the same year and class, new roll),
  `POST /students/:id/deactivate` (soft delete: `deleted_at`, status INACTIVE, roll released so
  the number can be reused; old roll kept in the audit log).
- `GET/PUT /students/settings` (code prefix/pattern, with a preview).
- Every change audited.

**Web:** `/students/new` (admission form, sections: student, board registration, guardians,
enrolment), `/students/[id]` profile (details, guardians, enrolment, attendance link, edit,
transfer, deactivate), list rows link to the profile.

## Phase E: import

**Libraries** (exact versions, all maintained, published ≥ 2 weeks ago): `read-excel-file@9.3.10`
(reads stored cell values, never evaluates formulas), `write-excel-file@4.1.1` (template),
`csv-parse@7.0.3`. Upload through Nest's multer, memory storage, 5 MB limit; `.xlsx` is checked
for its unpacked size before parsing (zip bomb guard, 50 MB).

**Schema:** new tenant table `student_imports`: status (UPLOADED → VALIDATED → RUNNING → DONE /
FAILED), file name, headers, rows (jsonb, ≤ 5000), mapping, per-row results (jsonb),
progress counters, created_by. Via the skill. The raw rows hold phones and birth registration
numbers, so they are cleared (`rows = NULL`) when the import finishes or after 7 days unfinished;
the per-row results keep only row numbers, status and messages. Grants: SELECT, INSERT, UPDATE
(no DELETE: the import history stays).

**Flow** (`/students/imports`, OWNER/ADMIN):

1. `GET template.xlsx|csv`: Bangla + English header rows.
2. `POST` upload → parsed server-side, stored; auto-detected mapping (Bangla/English headers,
   case/space-insensitive).
3. `PUT :id/mapping` → every row validated: OK or exact errors (bad phone, unknown
   class/section, duplicate roll in file or in DB, duplicate birth registration in file or DB,
   missing name, bad date…). Bangla digits accepted.
4. `POST :id/run` → BullMQ job (`TenantJobRunner`, per-tenant RLS; the job carries only the import
   id and tenant set server-side, never client input), progress in the row, polled by the UI.
   VALIDATED → RUNNING is a conditional update, so a double POST cannot start two runs. Rows matching an existing student (student_code, then birth registration no.) are
   skipped as "already exists", so re-importing a file creates no duplicates. Creates guardians
   (linked by phone) and enrolments too.
5. `GET :id/report.csv`: per row imported / skipped / error with reasons.

**CSV safety:** one shared `csvCell()` (quotes, and prefixes `'` to cells starting with
`= + - @ \t \r`), used by every CSV export (attendance register, import template and report).
Phones are exported in local `01…` form.

**Web** `/students/import`: steps (download template → upload → mapping → preview with filters
for errors → run with progress → result + report download).

## Not in this run

Fees, bKash, deployment, photo upload (needs file storage), invite SMS.

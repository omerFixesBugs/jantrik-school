# Sprint 1, P5: promotion and new session (implementation plan)

**Status: plan only (day run 2026-11-16), not approved, no code yet.** It details
[sprint-1.md](sprint-1.md) → "P5: Promotion and new session", which the owner approved on
2026-11-14 with decisions S14 (leavers), S15 (sections and roll order), S16 (copying the fee setup)
and S17 (dues carry over by not moving). Nothing here reopens those. The new decisions this plan
needs are P5-A to P5-Q at the end; each has a recommended default.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an admin moves the whole institute into the next academic year in one guided flow:
create the year, copy the fee setup and teachers, decide class by class who is promoted, who
repeats and who leaves, apply it safely (a re-run never duplicates anything), number the rolls,
then switch the current year with clear warnings. Old dues stay where they are and stay visible.

**Architecture:**

- **Leaving is a student status, not a deletion** (S14): `students.left_on` and `leave_reason`
  join the existing `status` (`GRADUATED | TRANSFERRED | DROPPED_OUT | INACTIVE`). A leaver keeps
  `deleted_at` NULL, so the ledger, the counter and history still find them.
- **A promotion run per class** (`promotion_runs`, one per from-year, to-year and from-class) holds
  one row per student (`promotion_run_students`) with the decision `PROMOTE | REPEAT | LEAVE` and
  the target. Rows are edited while pending.
- **Apply is a queue job** (`promotions` queue, job id `promotion-apply-<runId>`), one target
  section per transaction. Each row is applied once (`applied_at`), new enrolments rely on the
  existing unique `enrolments (tenant_id, academic_year_id, student_id)`, and every chunk takes a
  per-run advisory lock. A killed job resumes where it stopped.
- **Rolls are numbered after apply, per target class** (decision P5-A), by a pure
  `assignRolls()` in `@jantrik/shared`: promoted students, then repeaters, then new admits (S15),
  each group in its strategy's order. Rolls already set are never changed.
- **The current year never switches by itself.** The existing switch
  (`POST /setup/academic-years/:id/current`) stays; a new check lists what is not finished.
- **Exams and fees are reached through their services** (CLAUDE.md rule 4): the promotion module
  reads published results through an `ExamResultsReader` exported by `ExamsModule`, and the fee
  copies live in the fees module behind `@RequireModule('FEES')`.

**Tech stack:** NestJS, Prisma/PostgreSQL 16, BullMQ, Next.js (v3 kit), next-intl, Vitest and
Playwright. No new dependency.

**Branch:** `feature/sprint-1-p5-promotion` from `main` (after P3 is merged: new admits for next
year come from P3's approve; P5 works without P3, with fewer new admits).

## What exists today (verified in the code on 2026-11-16)

- **Years.** `academic_years` has `start_date`, `end_date`, `is_current`, one current per tenant
  (partial unique index `academic_years_one_current_per_tenant`, `packages/db/prisma/schema.prisma:745-770`).
  - `SetupService.createYear` (`apps/api/src/setup/setup.service.ts:105`) copies the active
    sections of a year (`copySectionsFrom`), names and capacities included, but no teachers.
  - `setCurrentYear` (`setup.service.ts:190`) flips `is_current` with an audit row; route
    `POST /setup/academic-years/:id/current` (`setup.module.ts:85`, OWNER/ADMIN, CORE). It checks
    nothing about the old year.
- **Enrolments** (`schema.prisma:1099-1128`): one per student per year
  (`@@unique([tenantId, academicYearId, studentId])`), rolls unique per section
  (`@@unique([tenantId, sectionId, roll])`), no status column. `StudentAdminService.checkEnrolment`
  (`apps/api/src/students/student-admin.service.ts:177`) enforces section year/class, capacity
  (with a `FOR UPDATE` on the section) and free rolls; `enrol()` (`:567`) adds an enrolment in a
  year the student has none in.
- **Student statuses** (`schema.prisma:212`): `ACTIVE | INACTIVE | GRADUATED | TRANSFERRED |
DROPPED_OUT`. Only `deactivate()` (`student-admin.service.ts:592`) writes one: it soft-deletes
  (`deleted_at`), sets INACTIVE and clears the current year's rolls.
- **Who counts as "still here":**
  - the student limit counts `status = ACTIVE AND deleted_at IS NULL` (`student-admin.service.ts:164`);
  - dues are generated only for ACTIVE students enrolled in the current year
    (`apps/api/src/fees/dues/fee-dues.service.ts:197-205`, `:305-322`);
  - the due list covers students enrolled in the current year who are ACTIVE and not deleted
    (`STILL_HERE`, `apps/api/src/fees/reports/fee-reports.service.ts:36`, `:64-70`), with their
    OPEN dues **of every year** (`:88-90`): arrears already follow an enrolled student;
  - the ledger reads every due of the student, each with its `academicYear {id, name}`
    (`apps/api/src/fees/dues/fee-ledger.service.ts:37-101`);
  - the counter finds any student not deleted, whatever their status
    (`apps/api/src/fees/fee-students.service.ts:51`; `fee-collection.service.ts:136`), so a leaver
    can still pay;
  - attendance and the device roster use current-year enrolments of ACTIVE students
    (`apps/api/src/devices/device-people-roster.ts:165`).
- **Fees across years:**
  - `FeeSetupService.copyAmounts` (`apps/api/src/fees/setup/fee-setup.service.ts:449`,
    `POST /fees/amounts/copy`, OWNER/ADMIN) copies missing amount rows; idempotent.
  - Terms (`fee_terms`, per year, unique name per year) and concessions (`fee_concessions`, per
    student, head and year, one open per head and year) have no copy.
  - ONE_TIME dues use period key `ONCE`, unique per student and head across all years
    (`fee_dues_one_time_once`), so a promoted student is never charged the admission fee again;
    YEARLY dues (`Y`) are per year.
  - The due planner takes `admittedOn = student.createdAt` (`fee-dues.service.ts:230`).
- **Exams:** `exam_classes.is_published` and `published_version`; `exam_results` keeps `passed`,
  `class_position` (NULL when unranked) and `section_position` per student
  (`schema.prisma:2771-2818`), written at publish (`apps/api/src/exams/results/exam-results.service.ts:90-195`).
  `ExamKind` has `ANNUAL` (`schema.prisma:126`). `meritPositions()` gives shared places
  (1, 2, 2, 4) (`packages/shared/src/exams-results.ts:68`).
- **Teachers:** `section_teachers` and `section_subject_teachers` hang off a year's sections
  (`schema.prisma:1351`, `:1420`); nothing copies them.
- **Subject choices** (`student_subject_choices`) belong to an enrolment (year and student) and to
  subjects of one class level (`schema.prisma:1446`).
- **Queues:** BullMQ queues are registered per module (`BullModule.registerQueue`), processors are
  `WorkerHost` classes started by `QueueWorkers` (`apps/api/src/queue-workers.ts`); a job works in
  a tenant through `TenantJobRunner.run(tenantId, fn, {actorUserId})`, one RLS transaction with a
  15 s limit (`apps/api/src/tenancy/tenant-job-runner.service.ts:8-55`). The fee jobs check that
  the actor is still OWNER/ADMIN (`fee-dues.processor.ts: actorMayStill`).
- **Web:** the years card is `apps/web/src/app/(app)/setup/page.tsx` (it already offers "next
  year, copy sections"); fee setup pages under `apps/web/src/app/(app)/fees/setup/`; the due list
  and reports under `fees/reports`; the guardian ledger `children/[id]/fees`.

## Global constraints

- **Roles and modules:** every promotion route is `@RequireModule('CORE')`,
  `@Roles('OWNER', 'ADMIN')`. Fee copies are `@RequireModule('FEES')`, OWNER/ADMIN. The leavers
  report is FEES, OWNER/ADMIN/ACCOUNTANT. Merit needs EXAMS: without it, the MERIT strategy answers
  422 `MERIT_NEEDS_EXAMS` and defaults do not use results.
- **Transactions:** request and job transactions stay under 15 s: apply works one target section
  (at most ~200 rows) per transaction; leavers in chunks of 200; numbering one class per
  transaction (a class is at most a few thousand rows of a cheap UPDATE).
- **Dates:** `left_on` is a calendar date in the institute's timezone; "today" from `todayIn`.
- **Audit:** every create, update and apply of runs and rows, every leave and return, every roll
  numbering and every copy (CLAUDE.md rule 6; sprint plan → Audit).
- **Strings:** bn and en through a new route namespace `promotion` (`route-messages.ts`); Bangla
  digits for counts and dates in bn, ASCII for rolls and student codes; Bangla digits accepted in
  roll inputs (`toAsciiDigits`).
- **Screens:** v3 kit, light-first; screenshots bn at 1366 and 390 px.
- **Errors (new codes):** 409 `RUN_APPLYING`, 409 `RUN_EXISTS`, 409 `PREVIEW_CHANGED`,
  409 `ROLL_TAKEN` (existing code), 422 `YEAR_ORDER`, 422 `TARGET_INVALID`, 422 `SECTION_FULL`
  (existing code, with a list), 422 `MERIT_NEEDS_EXAMS`, 422 `ALREADY_LEFT`, 422 `NOT_LEFT`,
  422 `STUDENT_LIMIT` (existing), 409 `DEACTIVATED` (existing).
- **Gates:** affected tests during the phase; at its end `pnpm lint`, `pnpm typecheck`,
  `pnpm format:check`, `pnpm test`, `pnpm build`, Playwright (CI, or a scratch database), then the
  review subagent (DB, fees), then the PR.

## Review focus

1. **Promotion interrupted** (sprint review focus 4): the worker dies after the 3rd of 6 sections.
   Expected: resuming finishes the run with exactly one new-year enrolment per promoted or
   repeating student, no roll written, leavers marked once, and the current year unchanged.
   Test: Task 5, "kill and resume".
2. **Apply pressed twice** (two admins, or a double click). Expected: one job, the second request
   gets 409 `RUN_APPLYING`; no duplicate enrolments even if two job executions overlap (a stalled
   job re-run). Test: Task 5, "concurrent apply" and "two executions".
3. **The year switched too early.** Expected: never automatic; the switch check lists classes
   without a run, unapplied runs, unpublished annual results and ACTIVE students not carried
   over. Test: Task 8.
4. **Dues carry over by not moving** (S17). Expected: a repeater and a promoted student keep their
   old OPEN dues on the ledger and on the due list once enrolled in the new year, marked "previous
   years"; a leaver drops out of the due list and of new dues but keeps the ledger and can pay at
   the counter. Test: Task 9.
5. **Rolls never clash and never move.** Expected: numbering skips rolls already set (new admits
   given a roll at approval, hand edits), never changes one, and a second numbering after a
   change answers 409 `PREVIEW_CHANGED`. Test: Tasks 2 and 6.
6. **Cross-tenant and cross-year targets.** Expected: a run row cannot name another institute's
   student or section, nor a section of another year or class (composite foreign keys). Test:
   Task 1.

---

## Database

All new tenant tables follow the [database.md](../database.md) checklist. Migrations, in order
(timestamps assigned when created; hand-written SQL appended to Prisma's output):

1. `<ts>_student_leaving`: `students.left_on`, `students.leave_reason`, two CHECKs.
2. `<ts>_promotion_runs`: four enums, two composite unique indexes on existing tables (targets for
   the new foreign keys), the two tables, RLS, grants, policies, CHECKs.

No migration adds a value to an existing enum, so nothing needs its own enum migration. No
tenant backfill.

### `students` (changed)

| Column         | Type   | Notes                        |
| -------------- | ------ | ---------------------------- |
| `left_on`      | `date` | NULL while the student stays |
| `leave_reason` | `text` | optional free text, ≤ 500    |

- CHECK `students_left_on_only_when_gone`: `left_on IS NULL OR status <> 'ACTIVE'`.
- CHECK `students_leave_reason_needs_date`: `leave_reason IS NULL OR left_on IS NOT NULL`.
- CHECK `students_leave_reason_length`: `leave_reason IS NULL OR char_length(leave_reason) <= 500`.
- Existing rows all have NULLs, so the new CHECKs pass on every row (database.md → a new CHECK is
  checked against every row). The app's table-level grants on `students` already cover the new
  columns.

### `promotion_runs` (S I U)

| Column                     | Type                      | Notes                                                      |
| -------------------------- | ------------------------- | ---------------------------------------------------------- |
| `id`                       | uuid v7                   |                                                            |
| `tenant_id`                | uuid                      |                                                            |
| `from_year_id`             | uuid                      | → `academic_years (tenant_id, id)`                         |
| `to_year_id`               | uuid                      | → `academic_years (tenant_id, id)`                         |
| `class_level_id`           | uuid                      | the from-class → `class_levels (tenant_id, id)`            |
| `roll_strategy`            | `promotion_roll_strategy` | `MERIT \| NAME_BN \| NAME_EN \| MANUAL \| KEEP`            |
| `merit_exam_id`            | uuid?                     | → `exams (tenant_id, id, academic_year_id)` with from-year |
| `status`                   | `promotion_run_status`    | `DRAFT \| APPLYING \| APPLIED`                             |
| `created_by_id`            | uuid                      | → `users (id)`                                             |
| `applied_by_id`            | uuid?                     | the admin who pressed apply last                           |
| `apply_started_at`         | timestamptz(3)?           |                                                            |
| `applied_at`               | timestamptz(3)?           | set when no pending row is left                            |
| `last_error`               | text?                     | a fixed code (`SECTION_FULL`, `TIMEOUT`…), never a message |
| `created_at`, `updated_at` | timestamptz(3)            |                                                            |

- Unique: `(tenant_id, id)`; `(tenant_id, id, to_year_id)` (target for the rows);
  `(tenant_id, from_year_id, to_year_id, class_level_id)` → 409 `RUN_EXISTS`.
- Index: `(tenant_id, to_year_id)`.
- Foreign keys: all composite, `ON UPDATE RESTRICT ON DELETE RESTRICT`. `merit_exam_id` is
  checked against the from-year through `(tenant_id, merit_exam_id, from_year_id) → exams
(tenant_id, id, academic_year_id)`; MATCH SIMPLE skips it when `merit_exam_id` is NULL.
  This needs a new unique index `exams (tenant_id, id, academic_year_id)`.
- CHECKs:
  - `from_year_id <> to_year_id`;
  - `roll_strategy <> 'MERIT' OR merit_exam_id IS NOT NULL`;
  - `(status = 'APPLIED') = (applied_at IS NOT NULL)`;
  - `status = 'DRAFT' OR (apply_started_at IS NOT NULL AND applied_by_id IS NOT NULL)`.
- Grants: `SELECT, INSERT` and `UPDATE (roll_strategy, merit_exam_id, status, applied_by_id,
apply_started_at, applied_at, last_error, updated_at)`. No DELETE: a run is history once
  applied, and a draft with no applied row is emptied rather than deleted (P5-L).
- RLS checklist: ☐ `tenant_id NOT NULL` ☐ `@@unique([tenantId, id])` ☐ composite FKs, optional
  `merit_exam_id` too ☐ `ON UPDATE RESTRICT` ☐ index leading with `tenant_id` ☐ ENABLE + FORCE RLS
  ☐ `tenant_isolation` ☐ explicit grants ☐ in `schema-safety.test.ts` ☐ isolation test in
  `packages/db/test/promotion-rls.test.ts`.

### `promotion_run_students` (S I U D, D and U only while pending)

| Column                     | Type                       | Notes                                                                                                                              |
| -------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `id`                       | uuid v7                    |                                                                                                                                    |
| `tenant_id`                | uuid                       |                                                                                                                                    |
| `run_id`                   | uuid                       | `(tenant_id, run_id, to_year_id)` → `promotion_runs (tenant_id, id, to_year_id)`                                                   |
| `to_year_id`               | uuid                       | copied from the run, so the targets can be checked by foreign keys                                                                 |
| `student_id`               | uuid                       | → `students (tenant_id, id)`                                                                                                       |
| `from_enrolment_id`        | uuid                       | → `enrolments (tenant_id, id)` (snapshot source)                                                                                   |
| `from_section_id`          | uuid?                      | snapshot → `sections (tenant_id, id)`                                                                                              |
| `from_roll`                | int?                       | snapshot                                                                                                                           |
| `result_passed`            | boolean?                   | snapshot from the merit exam; NULL = no result                                                                                     |
| `merit_position`           | int?                       | snapshot of `class_position`; NULL = unranked or no result                                                                         |
| `decision`                 | `promotion_decision`       | `PROMOTE \| REPEAT \| LEAVE`                                                                                                       |
| `target_class_level_id`    | uuid?                      |                                                                                                                                    |
| `target_section_id`        | uuid?                      | `(tenant_id, target_section_id, to_year_id, target_class_level_id)` → `sections (tenant_id, id, academic_year_id, class_level_id)` |
| `target_study_group_id`    | uuid?                      | → `study_groups (tenant_id, id)`                                                                                                   |
| `leave_status`             | `student_status`?          | `GRADUATED \| TRANSFERRED \| DROPPED_OUT \| INACTIVE`                                                                              |
| `left_on`                  | date?                      |                                                                                                                                    |
| `leave_reason`             | text?                      | ≤ 500                                                                                                                              |
| `applied_at`               | timestamptz(3)?            |                                                                                                                                    |
| `apply_outcome`            | `promotion_apply_outcome`? | `ENROLLED \| ALREADY_ENROLLED \| LEFT \| SKIPPED_DEACTIVATED`                                                                      |
| `to_enrolment_id`          | uuid?                      | → `enrolments (tenant_id, id)`                                                                                                     |
| `created_at`, `updated_at` | timestamptz(3)             |                                                                                                                                    |

- Unique: `(tenant_id, id)`; `(tenant_id, run_id, student_id)`; `(tenant_id, to_year_id,
student_id)`: a student is in at most one run into a given year (moving class mid-December is
  handled by editing the row, not a second run).
- Indexes: `(tenant_id, run_id, target_section_id)` (apply chunks),
  `(tenant_id, to_year_id, target_class_level_id)` (numbering).
- New unique index on `sections (tenant_id, id, academic_year_id, class_level_id)` (the target of
  the section foreign key; a superset of the primary key, so it cannot fail).
- CHECKs (each tests nullable columns with `IS [NOT] NULL` first):
  - `decision = 'LEAVE'` ⇒ `leave_status IS NOT NULL AND left_on IS NOT NULL AND
target_class_level_id IS NULL AND target_section_id IS NULL AND target_study_group_id IS NULL`;
  - `decision <> 'LEAVE'` ⇒ `target_class_level_id IS NOT NULL AND leave_status IS NULL AND
left_on IS NULL AND leave_reason IS NULL`;
  - `leave_status IS NULL OR leave_status IN ('GRADUATED','TRANSFERRED','DROPPED_OUT','INACTIVE')`;
  - `(applied_at IS NULL) = (apply_outcome IS NULL)`;
  - `apply_outcome IS NULL OR apply_outcome NOT IN ('ENROLLED','ALREADY_ENROLLED') OR
to_enrolment_id IS NOT NULL`;
  - `leave_reason IS NULL OR char_length(leave_reason) <= 500`.
  - REPEAT keeps the class (`target_class_level_id` = the run's class): checked in the service
    (it needs the parent row) and by a test.
- Grants: `SELECT, INSERT, DELETE` and `UPDATE (decision, target_class_level_id,
target_section_id, target_study_group_id, leave_status, left_on, leave_reason, applied_at,
apply_outcome, to_enrolment_id, updated_at)`.
- Policies, besides `tenant_isolation`:
  - `promotion_rows_delete_pending` AS RESTRICTIVE FOR DELETE USING `(applied_at IS NULL)`;
  - `promotion_rows_update_pending` AS RESTRICTIVE FOR UPDATE USING `(applied_at IS NULL)` WITH
    CHECK `(true)`: an applied row never changes again, while apply itself can still set
    `applied_at` on a pending row (a restrictive UPDATE policy without its own WITH CHECK would
    reuse USING and refuse that write).
- RLS checklist: as for `promotion_runs`, plus the two restrictive policies, tested.

### Enums

- `promotion_roll_strategy`: `MERIT`, `NAME_BN`, `NAME_EN`, `MANUAL`, `KEEP`.
- `promotion_run_status`: `DRAFT`, `APPLYING`, `APPLIED`.
- `promotion_decision`: `PROMOTE`, `REPEAT`, `LEAVE`.
- `promotion_apply_outcome`: `ENROLLED`, `ALREADY_ENROLLED`, `LEFT`, `SKIPPED_DEACTIVATED`.

---

## API

All under `PromotionController` (`apps/api/src/promotion/`), CORE, OWNER/ADMIN, unless noted.

| Route                                                                                                                                                  | Purpose                                                                                                                                           | Errors                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `POST /students/:id/leave` `{status, leftOn, reason?}`                                                                                                 | one student leaves now (also used by P9's TC)                                                                                                     | 409 `DEACTIVATED`, 422 `ALREADY_LEFT`, 422 validation         |
| `POST /students/:id/return`                                                                                                                            | back to ACTIVE (P5-J); student limit checked                                                                                                      | 422 `NOT_LEFT`, 422 `STUDENT_LIMIT`                           |
| `GET /promotions?toYearId`                                                                                                                             | the runs into a year, with counts per decision and status, plus classes without a run                                                             |                                                               |
| `POST /promotions` `{fromYearId, toYearId, classLevelId, rollStrategy, meritExamId?}`                                                                  | creates the run and its rows with defaults (P5-F)                                                                                                 | 409 `RUN_EXISTS`, 422 `YEAR_ORDER`, 422 `MERIT_NEEDS_EXAMS`   |
| `GET /promotions/:id`                                                                                                                                  | the run with every row (student, snapshot, decision, target, outcome)                                                                             | 404                                                           |
| `PATCH /promotions/:id` `{rollStrategy?, meritExamId?}`                                                                                                | change strategy; a new merit exam re-snapshots results of pending rows only                                                                       | 409 `RUN_APPLYING`                                            |
| `PUT /promotions/:id/rows` `{rows: [{id, decision, targetClassLevelId?, targetSectionId?, targetStudyGroupId?, leaveStatus?, leftOn?, leaveReason?}]}` | bulk edit of pending rows (≤ 500 per call)                                                                                                        | 422 `TARGET_INVALID` (with row ids), 409 `RUN_APPLYING`       |
| `POST /promotions/:id/refresh`                                                                                                                         | adds rows for students enrolled in the from-class since the run was made; removes pending rows of students who left or were deactivated meanwhile | 409 `RUN_APPLYING`                                            |
| `GET /promotions/:id/apply-check`                                                                                                                      | capacity per target section, rows without a section, counts; `version`                                                                            |                                                               |
| `POST /promotions/:id/apply` `{version}`                                                                                                               | DRAFT (or APPLIED with new pending rows) → APPLYING, queues the job                                                                               | 409 `RUN_APPLYING`, 409 `PREVIEW_CHANGED`, 422 `SECTION_FULL` |
| `POST /promotions/:id/resume`                                                                                                                          | APPLYING with no live job: queues it again                                                                                                        | 409 when the job is running                                   |
| `GET /promotions/rolls?toYearId&classLevelId`                                                                                                          | numbering preview per section: kept rolls, proposed rolls by group, `version`                                                                     |                                                               |
| `PUT /promotions/rolls` `{toYearId, classLevelId, version, sections: [{sectionId, rolls: [{enrolmentId, roll}]}]}`                                     | writes rolls of enrolments that have none                                                                                                         | 409 `PREVIEW_CHANGED`, 409 `ROLL_TAKEN`                       |
| `GET /promotions/switch-check?toYearId`                                                                                                                | the warnings before switching (Task 8)                                                                                                            |                                                               |
| `POST /setup/academic-years/:id/copy-teachers` `{fromAcademicYearId, classTeachers, subjectTeachers}`                                                  | copies section and subject teachers by (class, section name)                                                                                      | 404                                                           |
| `POST /fees/terms/copy` `{fromAcademicYearId, toAcademicYearId}` (FEES)                                                                                | terms moved one year (S16)                                                                                                                        | 404                                                           |
| `POST /fees/concessions/copy` `{fromAcademicYearId, toAcademicYearId}` (FEES)                                                                          | running concessions of students enrolled in the target year (off by default in the wizard)                                                        | 404                                                           |
| `GET /fees/reports/leavers-with-dues` (+ `/csv`) (FEES, OWNER/ADMIN/ACCOUNTANT)                                                                        | leavers and students not carried over who still owe                                                                                               |                                                               |

Existing routes changed:

- `GET /fees/reports/dues` (and `/csv`): each row gains `previousYearsPaisa` (balance of OPEN dues
  of other years than the current one), the totals too.
- `GET /fees/students/:id/ledger` and `GET /me/children/:id/fees`: each due already carries its
  year; the response gains `currentYearId` so the web marks "previous year" without a second call.

### Defaults when a run is created (P5-F, P5-G)

- The merit exam, if none is given: the from-year's `ANNUAL` exam whose class is published,
  latest `ends_on` first. None → no merit exam and every row PROMOTE with a "no result" flag (the
  wizard shows it). `ANNUAL` is an exam kind (data), not an institute type.
- With a merit exam: `passed` → PROMOTE; failed → REPEAT; no result row (absent, withdrawn) →
  PROMOTE with the "no result" flag.
- The highest active class level by `sort_order` → LEAVE with `GRADUATED`, `left_on` = the
  from-year's `end_date`. The next class of any other class is the active class level with the
  next higher `sort_order` (data; a coaching centre whose batches do not progress simply sets
  every row to REPEAT or LEAVE).
- Target section (S15): the section of the target class in the to-year with the same name as the
  from-section, else none (the admin picks one; apply-check lists rows without one).
- Study group: kept (P5-I).

### Apply job (`promotions` queue)

- Job `promotion-apply`, data `{tenantId, runId, actorUserId}` (ids only), job id
  `promotion-apply-<runId>`, `attempts: 5`, exponential backoff from 10 s, `removeOnComplete:
true`, `removeOnFail: 50`.
- The job checks the actor is still OWNER/ADMIN (as the fee jobs do); otherwise it stops with
  `last_error = 'ACTOR_NOT_ADMIN'` and the run stays APPLYING for another admin to resume.
- It lists the pending rows' target sections (one read transaction), then for each section one
  transaction:
  1. `pg_advisory_xact_lock(hashtextextended('promotion:' || run_id, 0))`;
  2. the section's pending rows `FOR UPDATE`;
  3. the section's capacity check (as `checkEnrolment`, with the same `FOR UPDATE` on the
     section);
  4. per row: student deactivated meanwhile → `SKIPPED_DEACTIVATED`; already enrolled in the
     to-year → `ALREADY_ENROLLED` with that enrolment; else `enrolment.create` (no roll) →
     `ENROLLED`. A unique violation on `(year, student)` is treated as `ALREADY_ENROLLED`;
  5. repeaters' subject choices are copied (P5-H);
  6. rows get `applied_at`, `apply_outcome`, `to_enrolment_id`; one audit row per chunk
     (`promotion_apply`, the run, the section, the counts).
- Then the leavers in chunks of 200: `status`, `left_on`, `leave_reason` set where the student is
  still ACTIVE and not deleted (otherwise the outcome records what was there), rolls of the
  current year untouched (history); one audit row per student (`student`, UPDATE, old and new
  status).
- Finally, when no pending row is left: the run → APPLIED, `applied_at`, `last_error` NULL.
- A section that fails (`SECTION_FULL`, a timeout) stops the job with `last_error` set; BullMQ
  retries, and after the last attempt the run stays APPLYING with the error shown; the admin
  fixes the cause and presses resume.
- The job never touches `academic_years.is_current`.

### Numbering (`assignRolls`, P5-A, P5-B)

`packages/shared/src/promotion.ts`:

```ts
export type RollStrategy = 'MERIT' | 'NAME_BN' | 'NAME_EN' | 'MANUAL' | 'KEEP';
export type RollGroup = 'PROMOTED' | 'REPEATER' | 'NEW';
export interface RollCandidate {
  id: string; // the enrolment
  group: RollGroup;
  nameBn: string | null;
  nameEn: string | null;
  studentCode: string;
  oldRoll: number | null;
  meritPosition: number | null;
}
/** Proposed rolls for one section: S15 group order, each group sorted by its strategy; numbers
 * in `taken` (rolls already set) are skipped and never reassigned. Pure, deterministic. */
export function assignRolls(
  candidates: readonly RollCandidate[],
  strategy: Record<RollGroup, RollStrategy>,
  taken: ReadonlySet<number>,
): Map<string, number>;
```

- MERIT: `meritPosition` ascending, unranked after; ties → lower old roll; then NAME_BN.
- NAME_BN: `Intl.Collator('bn', {sensitivity: 'base'})` on `nameBn ?? nameEn ?? ''`, then
  `studentCode`. NAME_EN: `Intl.Collator('en', …)` on `nameEn ?? nameBn`.
- KEEP: a student keeps the old roll when it is free in the target section; the others follow
  after the highest kept number, by NAME_BN (P5-B).
- MANUAL: proposes NAME_BN; the admin edits the numbers in the preview before saving.
- Group strategies: PROMOTED uses the run from the class below; REPEATER uses this class's own run;
  NEW (enrolled in the to-year by admission or by hand) uses NAME_BN (P3's merit order later, P4).
- The preview's `version` is a hash of the class's to-year enrolment ids and rolls; saving with an
  old version → 409 `PREVIEW_CHANGED`.

---

## Web

- **Wizard `/setup/new-year`** (OWNER/ADMIN; linked from the years card on `/setup`):
  1. **Year:** pick or create the next year (existing endpoint, sections copied).
  2. **Fees** (only with FEES): copy amounts (exists), terms (moved one year), running concessions
     (off by default, S16); each shows how many were copied or already there.
  3. **Teachers:** copy class teachers and subject teachers (two ticks).
  4. **Promote:** the class list with each run's state (no run, draft with counts, applying with
     progress, applied); "start" creates a run with defaults. The class page
     `/setup/new-year/[runId]` is a grid: student, old section and roll, result (passed, place),
     decision, target section, group, leaving status and reason. Bulk actions: "all passed →
     promote", "select → repeat", "select → leave as …". Filters: decision, no result, no section.
     On phones (390 px) the same data is a list and each row opens a sheet (P5-Q).
  5. **Apply:** the apply-check (capacity, rows without a section), then apply; progress polls
     `GET /promotions/:id`; resume when stopped.
  6. **Rolls:** per class of the new year, the numbering preview grouped by section; strategy per
     group; MANUAL edits; save.
  7. **Switch:** the switch-check warnings, a tick "I understand", then the existing switch.
- **Students:** the profile gets "Leave" (status, date, reason) and "Return"; the list's status
  filter shows leavers (`GRADUATED`, `TRANSFERRED`, `DROPPED_OUT`, `INACTIVE` without deletion).
- **Fees:** the due list gains a "previous years" column (and the CSV); the staff ledger and the
  guardian's fees page mark dues of other years with a "previous year" chip and a subtotal; the
  reports page gains a "Leavers with dues" tab with CSV and print.

---

## Files

| File                                                                                                | Change                                                                                                                   |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `packages/db/prisma/schema.prisma` + 2 migrations                                                   | students' leaving columns; runs, rows, enums, the two target unique indexes                                              |
| `packages/db/test/promotion-rls.test.ts`, `schema-safety.test.ts`, `students-leaving.test.ts`       | DB tests                                                                                                                 |
| `packages/shared/src/promotion.ts` (+ `.test.ts`), `index.ts`                                       | `assignRolls`, schemas (`promotionRowsSchema`, `leaveSchema`, `numberRollsSchema`), defaults helper `nextClassLevel`     |
| `apps/api/src/promotion/*`                                                                          | module, controller, `PromotionService`, `PromotionApplyService`, `RollNumberingService`, `SwitchCheckService`, processor |
| `apps/api/src/students/student-admin.service.ts`, `students.module.ts`                              | `leave`, `return`                                                                                                        |
| `apps/api/src/exams/results/exam-results-reader.ts`, `exams.module.ts`                              | `ExamResultsReader` (exported)                                                                                           |
| `apps/api/src/setup/setup.service.ts`, `setup.module.ts`                                            | `copyTeachers`                                                                                                           |
| `apps/api/src/fees/setup/fee-setup.service.ts`, `fees.module.ts`                                    | `copyTerms`, `copyConcessions`                                                                                           |
| `apps/api/src/fees/reports/fee-reports.service.ts`, `dues/fee-ledger.service.ts`                    | previous-years figures, the leavers report                                                                               |
| `apps/api/test/promotion*.e2e-spec.ts`, `students-leave.e2e-spec.ts`, `fees-carry-over.e2e-spec.ts` | API tests                                                                                                                |
| `apps/web/src/app/(app)/setup/new-year/**`, `components/promotion/*`                                | the wizard                                                                                                               |
| `apps/web/src/app/(app)/students/[id]/page.tsx`, fees pages                                         | leave/return, markers, report tab                                                                                        |
| `apps/web/messages/promotion/*.json`, `route-messages.ts`, `load-messages.ts`                       | strings                                                                                                                  |
| `apps/web/e2e/promotion.spec.ts`                                                                    | Playwright                                                                                                               |
| `docs/promotion.md` (new), `docs/fees.md`, `docs/database.md`, `docs/decisions-pending.md`          | docs                                                                                                                     |

---

### Task 1: Database

**Files:** schema, the two migrations, `packages/db/test/promotion-rls.test.ts`,
`packages/db/test/students-leaving.test.ts`, `schema-safety.test.ts`.

- [ ] **Step 1: Write the failing tests.**
  - `students-leaving.test.ts`: an ACTIVE student with `left_on` → CHECK violation; a GRADUATED
    student with `left_on` and a reason → ok; a reason without a date → violation.
  - `promotion-rls.test.ts`:
    - isolation: institute B sees none of A's runs and rows; inserting a row with B's student or
      section under A's context → foreign key violation;
    - a row whose target section belongs to another year or class → foreign key violation;
    - a run with a merit exam of another year → foreign key violation;
    - the LEAVE/PROMOTE CHECKs (each forbidden combination);
    - a pending row may be updated and deleted; an applied row → 0 rows updated and 0 deleted
      (the restrictive policies), while setting `applied_at` on a pending row succeeds;
    - the app cannot DELETE a run, cannot UPDATE `from_year_id` (column grants);
    - a second run for the same from-year, to-year and class → unique violation; the same student
      in two runs into one year → unique violation.
  - `schema-safety.test.ts`: the two tables in the tenant table list.
- [ ] **Step 2: Run them and see them fail**
      (`pnpm --filter @jantrik/db exec vitest run test/promotion-rls.test.ts test/students-leaving.test.ts`).
- [ ] **Step 3: Write the schema and the two migrations** (`migrate dev --create-only` once, then
      `ls -t`; append the RLS, policies, grants and CHECKs; partial or composite indexes declared
      in Prisma so `migrate diff` stays empty).
- [ ] **Step 4: Run them and see them pass**, then the whole db suite.
- [ ] **Step 5: Commit:** "Leaving columns on students and the promotion tables (runs, rows) with
      forced RLS, composite targets and pending-only edits (P5)".

### Task 2: `assignRolls` and the shared schemas

**Files:** `packages/shared/src/promotion.ts`, `promotion.test.ts`, `index.ts`.

- [ ] **Step 1: Write the failing tests:**
  - MERIT with ties (places 1, 2, 2, 4) → lower old roll first; unranked after, by Bangla name;
  - NAME_BN orders `অমিত, আরিফ, ইমরান, ঋতু, কবির, খাদিজা` as the Bangla collator does, ties by
    student code; a student with only an English name sorts by it;
  - S15 groups: promoted, then repeaters, then new admits, each by its own strategy;
  - `taken = {1, 4}` → numbers 2, 3, 5, … and never 1 or 4;
  - KEEP: free old rolls kept, clashing and missing ones after the highest kept, by name;
  - deterministic: shuffled input gives the same map;
  - `leaveSchema` refuses `ACTIVE`, takes ISO dates only and trims the reason;
  - `promotionRowsSchema` refuses a LEAVE row with a target.
- [ ] **Step 2: Run** `pnpm --filter @jantrik/shared exec vitest run src/promotion.test.ts`: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Pass**; check the web bundle budget is unchanged (only the web wizard imports it).
- [ ] **Step 5: Commit:** "assignRolls: S15 order with merit, Bangla or English name, keep and
      manual strategies; rolls already set are never reused (P5)".

### Task 3: Leave and return a student

**Files:** `student-admin.service.ts`, `students.module.ts`, `apps/api/test/students-leave.e2e-spec.ts`.

- [ ] **Step 1: Failing tests:**
  - leave as TRANSFERRED with a date and reason → 200; the student is not deleted, drops out of
    the student list's default (ACTIVE) view, out of the due list and of new dues; their ledger
    still answers; the counter still finds them and can take a payment on an old due;
  - the student limit frees a place (a new admission that failed with `STUDENT_LIMIT` now works);
  - leaving twice → 422 `ALREADY_LEFT`; a deactivated student → 409 `DEACTIVATED`;
  - return → ACTIVE, `left_on` and reason cleared; with the limit reached → 422 `STUDENT_LIMIT`;
  - audit rows with the old and new status; a teacher → 403.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit:** "Students can leave (graduated, transferred, dropped out, inactive) with a
      date and reason, without deletion, and return (S14, P5-J)".

### Task 4: Runs and rows (create, defaults, edit, refresh)

**Files:** `apps/api/src/promotion/{promotion.module,promotion.controller,promotion.service}.ts`,
`apps/api/src/exams/results/exam-results-reader.ts`, `exams.module.ts`,
`apps/api/test/promotion-runs.e2e-spec.ts`.

- [ ] **Step 1: Failing tests** (fixture: a school with classes 6–10 by `sort_order`, 2026 and
      2027, sections ক/খ in both years, an annual exam published for class 6 with a failed and an
      absent student):
  - create for class 6 → passed PROMOTE into class 7 ক/খ by section name, failed REPEAT into
    class 6, absent PROMOTE with "no result"; class 10 → all LEAVE GRADUATED with `left_on` =
    2026's end;
  - no annual exam → all PROMOTE with "no result"; MERIT without EXAMS → 422 `MERIT_NEEDS_EXAMS`;
  - a second run for class 6 → 409 `RUN_EXISTS`; to-year before from-year → 422 `YEAR_ORDER`;
  - bulk edit: REPEAT into class 7 → 422 `TARGET_INVALID`; a section of class 8 for a class 7
    target → 422; a LEAVE row without a date → 422; 500 rows in one call fit in one transaction;
  - refresh adds a student enrolled in class 6 after the run was made and drops a pending row of
    a student who left;
  - another institute's run id → 404; a teacher → 403; every change audited.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit:** "Promotion runs per class with defaults from the published annual
      results: promote the passed, repeat the failed, graduate the top class (P5-F, P5-G)".

### Task 5: Apply (job, resume, concurrency)

**Files:** `promotion-apply.service.ts`, `promotion.processor.ts`, `apps/api/test/promotion-apply.e2e-spec.ts`.

- [ ] **Step 1: Failing tests:**
  - the happy path: 6 target sections + leavers → one enrolment per PROMOTE/REPEAT row (no roll),
    leavers GRADUATED with their date, run APPLIED, current year unchanged;
  - **kill and resume** (review focus 1): a test hook makes the 4th section's transaction throw
    once; the job stops with `last_error`; resume → APPLIED; enrolments = rows; no duplicate;
    leavers once (one audit row each);
  - **concurrent apply** (review focus 2): two `POST …/apply` at once → one 200, one 409
    `RUN_APPLYING`; exactly one job id in the queue;
  - **two executions**: the processor's section step called twice in parallel for the same run
    (as a stalled job would) → no duplicate enrolment, each row applied once;
  - a student enrolled by hand in 2027 meanwhile → `ALREADY_ENROLLED`, their enrolment untouched;
    a student deactivated meanwhile → `SKIPPED_DEACTIVATED`;
  - a section full at apply-check → 422 `SECTION_FULL` listing it; filled by an admission between
    check and apply → the job stops with `SECTION_FULL`, resumes after the capacity is raised;
  - an applied row cannot be edited (409) and rows added by refresh after APPLIED apply alone;
  - the actor lost ADMIN → the job stops with `ACTOR_NOT_ADMIN`;
  - repeaters' subject choices copied; promoted students' not.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit:** "Apply a promotion run in the background, one section per transaction,
      safely resumable and never twice (review focus 4)".

### Task 6: Numbering the rolls

**Files:** `roll-numbering.service.ts`, `apps/api/test/promotion-rolls.e2e-spec.ts`.

- [ ] **Step 1: Failing tests:** class 7 of 2027 gets promoted students from class 6's run (MERIT),
      repeaters from class 7's run (NAME_BN) and two new admits (one already given roll 3 by
      hand): the preview proposes 1, 2, 4, … in S15 order and keeps 3; saving writes them; a
      second preview proposes nothing; a new admit enrolled between preview and save → 409
      `PREVIEW_CHANGED`; a MANUAL edit with a duplicate number → 422; a number taken meanwhile →
      409 `ROLL_TAKEN`; audit row with the changes.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit:** "Rolls for the new year, numbered per class after promotion: promoted,
      repeaters, then new admits; rolls already set are kept (S15, P5-A)".

### Task 7: Copies (fees, teachers)

**Files:** `fee-setup.service.ts`, `fees.module.ts`, `setup.service.ts`, `setup.module.ts`,
`apps/api/test/promotion-copies.e2e-spec.ts`.

- [ ] **Step 1: Failing tests:**
  - terms: 2026's three terms → 2027 with dates one year later; 29 Feb 2028 → 28 Feb 2029; run
    twice → second copies 0; a term outside the to-year's dates is copied and counted in
    `outsideYear`;
  - concessions: a running FREE_HALF on tuition for a promoted student → copied with
    `valid_from` = 2027's start; an ended one → not copied; a leaver's → not copied; run twice →
    0; audit names the counts only;
  - teachers: class teacher of 6-ক in 2026 → 6-ক in 2027; a teacher whose membership is no
    longer ACTIVE → skipped; a deactivated subject → skipped; run twice → 0;
  - without FEES → 403 on the fee copies; teacher → 403.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit:** "Copy fee terms (moved one year), running concessions and section
      teachers into the new year (S16)".

### Task 8: The switch check

**Files:** `switch-check.service.ts`, `apps/api/test/promotion-switch.e2e-spec.ts`.

- [ ] **Step 1: Failing tests** (review focus 3): the check for 2027 lists class 8 without a run,
      class 7's run still DRAFT, class 9 without a published annual result, 12 ACTIVE students of
      2026 not enrolled in 2027 and not leavers, and 30 enrolments of 2027 without a roll; after
      everything is done it lists nothing; the check never switches the year, and switching still
      works through the existing route.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit:** "What is left before switching to the new year: classes without a run,
      unapplied runs, unpublished annual results, students not carried over, missing rolls".

### Task 9: Dues across the year (carry-over tests, markers, the leavers report)

**Files:** `fee-reports.service.ts`, `fee-ledger.service.ts`, `apps/api/test/fees-carry-over.e2e-spec.ts`.

- [ ] **Step 1: Failing tests** (review focus 4, S17):
  - a promoted student with an OPEN 2026 tuition due: after apply and switch, the due list shows
    them with `previousYearsPaisa` = that balance, the ledger shows the due with its 2026 year,
    and no money row moved (count of `fee_dues` and `fee_payments` unchanged by the promotion);
  - a repeater the same;
  - a leaver: absent from the due list, no 2027 dues generated, ledger still lists 2026 dues,
    counter payment allowed, listed in leavers-with-dues with status, `left_on` and total;
  - an ACTIVE student not enrolled in 2027 after the switch: listed in the report as "not carried
    over" (P5-K);
  - a deactivated student with dues: listed with `deactivated: true`;
  - the admission fee (ONE_TIME) is not charged again in 2027; the session fee (YEARLY) is;
  - CSV: BOM, ASCII digits for codes and rolls, formula-safe cells.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit:** "Old dues stay and show as previous years; a report of leavers and
      students not carried over who still owe (S17)".

### Task 10: The wizard and the student actions (web)

**Files:** `apps/web/src/app/(app)/setup/new-year/**`, `components/promotion/*`, student page,
fees pages, messages, `apps/web/e2e/promotion.spec.ts`.

- [ ] **Step 1: Failing Playwright spec** (bn, 1366 px; the decision grid also at 390 px):
      create 2027 with sections → copy terms → start class 6's run → change one row to REPEAT →
      apply → number rolls (MERIT) → switch-check shows the other classes → a student page shows
      "Leave" and the leaver disappears from the due list; Bangla digits typed in a MANUAL roll
      are saved as ASCII.
- [ ] **Step 2–4:** FAIL, implement with the v3 kit, PASS; screenshots bn 1366 and 390 px.
- [ ] **Step 5: Commit:** "The new-year wizard: copy, promote class by class, apply, number rolls,
      switch; leave and return on the student page".

### Task 11: Docs

- `docs/promotion.md` (new): the flow, defaults, apply and resume, numbering, the switch check,
  leavers, what is never automatic.
- `docs/fees.md`: carry-over (nothing moves), previous-years markers, the leavers report, term
  and concession copies.
- `docs/database.md`: the two tables, the restrictive pending-only policies, the new composite
  target indexes on `exams` and `sections`, the students columns and CHECKs.
- `docs/decisions-pending.md`: P5-A to P5-Q as approved or changed.
- [ ] `pnpm format:check`; commit "Docs for promotion and the new session (sprint 1 P5)".

### Task 12: Gates, review, PR

- [ ] Full gates (Playwright on a scratch database or in CI).
- [ ] Review subagent (database, fees): this plan's review focus plus the money rule that no due
      or payment row is created, changed or moved by a promotion.
- [ ] Fix, each with a failing test first; PR; CI green; not merged by Claude.

## Size and split

**Large** (about the size of step 9's fees setup). Recommended as **two PRs** (P5-split):

- **P5a, the engine:** Tasks 1–6 and 8 (database, leave/return, runs, apply job, numbering, switch
  check) with their API tests and the student page's leave/return. Reviewable on its own: it
  changes no fee code.
- **P5b, the wizard and fees:** Tasks 7, 9, 10 and 11 (copies, carry-over markers and the report,
  the wizard, docs).

## Risks

- **Switching early hides people.** After a switch, ACTIVE students not enrolled in the new year
  leave the due list, attendance and the device roster (all read the current year). The switch
  check warns; the report lists them; enrolling them later restores everything.
- **Leavers leave at apply** (P5-C): applying class 10's run in December removes the class from
  attendance and due lists from then on. The wizard says so before apply.
- **Big classes:** 600 students in one class and one section still fit one transaction (one
  `INSERT` each plus a lock); measured at Task 5 with a 600-student fixture, as the exams publish
  test does.
- **The year's dates:** a to-year that does not start one year after the from-year makes the term
  copy's dates odd (P5-M); the copy reports dates outside the year.
- **P3 not merged yet:** new admits for 2027 then come only from staff admission; numbering treats
  every enrolment that no run created as NEW.

## Self-review

- **Spec coverage (sprint-1.md P5):** tables (Task 1); leavers S14 (Tasks 3, 5); wizard steps 1–6
  (Tasks 4–8, 10); copy fee setup S16 (Task 7); copy teachers (Task 7); defaults by result and
  top class by `sort_order` (Task 4); target section S15 (Task 4); apply as a job, one section per
  transaction, idempotent (Task 5); switch warnings (Task 8); `assignRolls` with strategies and
  Bangla collation and S15 order (Tasks 2, 6); dues S17 with markers, the report and carry-over
  tests (Task 9); review focus 4 (Task 5); RLS of the new tables (Task 1); docs (Task 11).
- **Names used the same everywhere:** `assignRolls`, `RollStrategy`, `RollGroup`,
  `promotion-apply`, `promotion-apply-<runId>`, `RUN_APPLYING`, `PREVIEW_CHANGED`,
  `previousYearsPaisa`, `ExamResultsReader`.

## Decisions for the owner

The approved S14–S17 stand. These are new; each default is what the plan builds unless you
change it.

| #     | Decision                                                             | Recommended default                                                                                                                                                                                       | Alternative                                                                                                |
| ----- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| P5-A  | When rolls are written                                               | A separate "number the rolls" step per class of the new year, after the runs that feed it are applied (promoted and repeaters come from two different runs, so S15's order cannot be produced run by run) | Rolls written at apply, run by run (clashes between the class below's promoted and this class's repeaters) |
| P5-B  | What KEEP means                                                      | Each student keeps their old roll when it is free in the new section; the rest follow after the highest kept number, by Bangla name                                                                       | KEEP only within the promoted group, then S15 order for the rest                                           |
| P5-C  | When a leaver's status takes effect                                  | At apply; `left_on` defaults to the from-year's last day                                                                                                                                                  | At the year switch (needs a "pending leave" state)                                                         |
| P5-D  | A student already enrolled in the new year (by hand or by admission) | Left as is, recorded `ALREADY_ENROLLED`                                                                                                                                                                   | Moved to the run's target                                                                                  |
| P5-E  | Section capacity at apply                                            | Apply refuses to start while a target section would overflow (`SECTION_FULL` with the list)                                                                                                               | Ignore capacity during promotion                                                                           |
| P5-F  | Defaults without a result                                            | PROMOTE, flagged "no result"; failed → REPEAT; top class (highest `sort_order`) → LEAVE as GRADUATED                                                                                                      | REPEAT when no result                                                                                      |
| P5-G  | Which exam drives defaults and merit                                 | The from-year's latest published `ANNUAL` exam of the class; the admin may pick any published exam of that class                                                                                          | Always ask                                                                                                 |
| P5-H  | Subject choices in the new year                                      | Copied for repeaters (same class's subjects); promoted students choose again in the new class                                                                                                             | Map by subject code across classes                                                                         |
| P5-I  | Study group on promotion                                             | Kept; the admin sets one per row where the class starts using groups (e.g. 8 → 9)                                                                                                                         | Cleared                                                                                                    |
| P5-J  | Undoing a leave                                                      | "Return" for OWNER/ADMIN: back to ACTIVE, the student limit checked, audited                                                                                                                              | No undo (re-admit)                                                                                         |
| P5-K  | Who the leavers report lists                                         | Leavers, ACTIVE students not enrolled this year ("not carried over") and deactivated students, each flagged, all with a balance                                                                           | Leavers only                                                                                               |
| P5-L  | Undoing an applied run                                               | No undo: an applied row is final; fix single students afterwards (transfer, leave, return, edit enrolment). A draft run is emptied, not deleted                                                           | An "unapply" that deletes the new enrolments                                                               |
| P5-M  | Moving term dates                                                    | Exactly one year later (S16), 29 Feb → 28 Feb; dates outside the new year are copied and reported                                                                                                         | Shift by the difference between the two years' start dates                                                 |
| P5-N  | Which concessions are copied (when ticked)                           | Those still running at the from-year's end, for students enrolled in the new year; `valid_from` = the new year's start                                                                                    | All of the year's concessions                                                                              |
| P5-O  | The switch check                                                     | Advisory: the wizard needs a tick "I understand"; the switch endpoint stays as it is                                                                                                                      | The API refuses to switch until the check is clean or forced                                               |
| P5-P  | Roles                                                                | OWNER/ADMIN for everything; ACCOUNTANT may read the leavers report                                                                                                                                        | Also ACCOUNTANT for the fee copies                                                                         |
| P5-Q  | Editing on phones                                                    | The decision grid works at 390 px as a list with a sheet per row                                                                                                                                          | Phones read only; edit on a computer                                                                       |
| split | One PR or two                                                        | Two (P5a engine, P5b wizard and fees)                                                                                                                                                                     | One large PR                                                                                               |

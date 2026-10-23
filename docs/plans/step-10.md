# Step 10: EXAMS & RESULTS module

## Context

CLAUDE.md puts "Exams & results (marks entry, grading by scheme, report card PDF)" in the Phase 1 MVP. Some pieces already exist:

- `ModuleKey.EXAMS`. Every tenant has a `tenant_modules` EXAMS row, and it is on for both demo institutes.
- `grading_schemes` and `grade_bands`, copied from the `BD_GPA_5` template, with a `rounding_mode` (NONE | ROUND_HALF_UP | CEIL). `calculateGrade()` is in `packages/shared/src/grading.ts`. No API reads them yet.
- `subjects` are per class level, with `study_group_id` and `is_optional`. They have no marks or components.
- `section_teachers` has no subject.
- The web has a "soon" nav item, a ComingSoon `exams/page.tsx`, the `module-card-exams` placeholder, and the guardian `examsSoon` line.

This step builds the whole module behind `@RequireModule('EXAMS')`:

- **A.** Setup:
  - grading rules as data;
  - subject components with pass marks;
  - subject teachers;
  - 4th-subject choices;
  - rooms.
- **B.** Exams: classes covered, subjects, routine, roster, admit cards, seat plan.
- **C.** Phone-first marks entry with drafts, then submit, lock and corrections.
- **D.** Results: GPA, marks mode and merit; tabulation, report cards, remarks; publish.
- **E.** Guardian results, result SMS, dashboard, seed and docs.

### Owner decisions (2026-10-23)

| Topic          | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PDFs           | **Browser print / Save as PDF**, as for receipts and the register. Report cards and admit cards use a named A4 portrait page; tabulation and the seat plan use the default A4 landscape. A server-side bulk PDF goes to `docs/backlog.md`.                                                                                                                                                                                                                                                                                                    |
| 4th subject    | **Elective pool + a choice per student.** Subjects with `is_optional` form the pool. Per student, the admin ticks which pool subjects they take and which one is the 4th, so Biology can be compulsory with Higher Math as 4th, or the reverse.                                                                                                                                                                                                                                                                                               |
| 1st/2nd papers | **One subject, papers as components, with a pass rule as data.** Each subject has a `pass_rule`. `PER_COMPONENT`: every component meets its own pass mark. `COMBINED`: components of the same kind are summed across papers and checked against that kind's combined pass mark (P1_CQ + P2_CQ against the CQ mark, P1_MCQ + P2_MCQ against the MCQ mark). COMBINED is the NCTB 9–10 template default for BAN and ENG, and it is editable. Both paper teachers are assigned to the subject. You will check it against a real school marksheet. |
| GPA rounding   | **TRUNCATE stays the default for now.** It is listed, with the component defaults table, in docs/decisions-pending.md as "to verify with a real board/school marksheet".                                                                                                                                                                                                                                                                                                                                                                      |
| Resubmit       | **The teacher may fix and resubmit until the sheet is locked.** Editing a submitted sheet puts it back to draft until it is submitted again. Every save is audited. After lock, only ADMIN/OWNER change marks, with a reason.                                                                                                                                                                                                                                                                                                                 |
| Seeding        | **`pnpm db:reset` is approved for the walkthrough**, on the local `jantrik` database only (demo data). Before any other seeding, I ask. `pnpm e2e` reseeds only `jantrik_e2e`.                                                                                                                                                                                                                                                                                                                                                                |

### Decisions I made (recorded in docs/decisions-pending.md, open to change)

- **Results are a snapshot taken at publish** (`exam_results`). Guardians, report cards and SMS read the snapshot, so merit positions never shift silently.
  - A correction or remark change after publish shows the class as "changed since publish". This is computed, not stored. The admin then republishes, which bumps the version.
  - Before publish, the tabulation is computed live and marked "preview".
- **GPA display** is scheme data: `gpa_decimals` (2) and `gpa_rounding`, default **TRUNCATE** (it never shows more than was earned; ROUND_HALF_UP is the alternative).
  - The overall letter comes from the displayed GPA, using the bands ordered by grade point.
  - Grade points are multiples of 0.5, so rounding never lifts a GPA below 5 to 5.00 (a test covers this).
- **Fail band:** a band whose grade point is 0 is the fail band. Bands get no new flag, since forced RLS blocks a per-row backfill in a migration.
- **Pass checks** compare the raw marks with the pass mark, so 22.5 out of 70 against 23 fails.
  - Pass marks are prefilled as round-half-up(33% × full): 70→23, 30→10, 25→8, 50→17, 100→33. Combined marks are prefilled the same way from the summed full marks: CQ 140→46, MCQ 60→20, WRITTEN 200→66.
  - Under COMBINED, the components' own pass marks are not used. Being absent in any component still fails the subject, under either rule (to verify with the marksheet).
- **Merit:**
  - Configured per exam, prefilled from the last exam with the same result mode.
  - Default order: passed first, then GPA (GPA exams) or total marks, then total marks, then the lower roll.
  - Keys available: `GPA`, `GPA_WITHOUT_OPTIONAL`, `TOTAL_MARKS`, `PERCENT`, `FEWER_FAILED_SUBJECTS`, `SUBJECT:<subjectId>`, `ROLL`.
  - Students tied on every key share the position (1, 2, 2, 4); for example, the same roll in two sections in class merit.
  - Failed students are ranked after the passed ones (default) or left unranked.
  - Positions are given in the class and in the section.
  - Total marks include the 4th subject.
- **The 4th subject in GPA:**
  - It adds `max(0, point − optional_bonus_above)` to the compulsory points.
  - The sum is divided by the number of compulsory subjects and capped at `gpa_max`.
  - A failed 4th subject adds nothing and never fails the student.
  - In MARKS mode (coaching), every taken subject counts the same and no GPA or letter is shown.
- **Absent** is per component; the row's "Ab" button sets all components. Absent counts 0 and fails the subject; all components absent shows the subject as "absent". Blank means not entered, and a sheet cannot be submitted with blanks.
- **No implicit 4th subject.** A pool subject without a recorded choice is not taken. The choices screen has "set for the whole section", and the publish check warns about missing choices.
  - The NCTB 9–10 template also marks **BIO** as a pool subject in Science, next to HMATH.
- **Rosters are per exam** (`exam_candidates`):
  - Opening an exam snapshots the enrolled students.
  - **Sync** (preview, then apply) adds newcomers, withdraws leavers (their marks are kept but left out of results) and follows transfers.
  - Marks follow the student; the sheet that governs them is the one for the student's current section.
- **Class teachers** enter marks only for subjects they are assigned to. The subject-teachers screen has "assign the class teacher to every subject of this section".
  - Every teacher of a section (`section_teachers`) can print that section's tabulation and report cards.
  - Only the class teacher (or an admin) writes remarks.
- **Marks entry is not date-gated.** It is allowed while the exam is OPEN. Exams never use `currentSection`, so annual results for last year can still be published in January.
- **Attendance on the report card:**
  - The window is stored on the exam (`attendance_from/to`). The form prefills it with the day after the previous GPA exam (or the year start) up to this exam's end.
  - It uses the attendance module's present-% rule, and is left out when ATTENDANCE is off.
- **Report card contents:**
  - Institute, exam, student, ID, class/section/roll/group, and photo if any. Parents' names appear only under decision #19 rules (or to the guardian of their own child).
  - The subject table: components, total, letter, point, and the highest in the class.
  - Total, GPA with and without the 4th subject, letter, class and section position, attendance, remarks, the grading key, and signature lines.
  - Guardians see the merit position.
- **Admit cards:** two per A4 page (with the routine, room and seat), with a cut line.
- **Seat plan:** institute-wide rooms (rows × columns). For each exam, seats are allocated by alternating classes across columns, then printed per room as a grid and a door list. Manual seat moves go to the backlog.
- **Result SMS:**
  - A manual action after publish, never automatic. The preview shows recipients, those without a phone, those already informed, segments, cost, today's cap left and how many would be skipped. Sending needs a confirmation.
  - Dedupe `exam-result:<examClassId>:v<version>:<studentId>`.
  - Over the cap, a result SMS is **skipped**, not held (a held SMS's dedupe key could never be re-sent), so it can be sent another day.
  - Fixed Bangla text: GPA/letter or marks/%, plus the class position.
- **Grade bands are read-only in this step.** Admins edit the GPA rule columns and the rounding mode; a band editor goes to the backlog.
- **Decision #19 is unchanged:**
  - Mark sheets carry id, roll, name and student ID only.
  - Subject-only teachers get no tabulation or report cards.
  - CSV carries no sensitive fields.
  - Staff names come from `staffRef`.

## Workflow

- Branch: `git switch main && git pull --ff-only && git switch -c feature/step-10-exams`.
- Every tenant table goes through the **add-tenant-table skill**.
  - Each migration is created with `--create-only` and its folder renamed to `20261028…`, so it sorts after `20261027030100_fees_integrity`.
  - RLS, grants, CHECKs and triggers are appended, then `pnpm db:migrate` runs on the local DB (migrations only, no seed).
  - Then the drift check (empty), the schema-safety list, and the isolation tests.
- Pure rules are written test-first in `exams.test.ts`.
- During each part I run only the affected tests.
- A **review subagent** checks each DB part (0.3, A1, B1, C1, D1) and the permission parts (C2 marks access and corrections, D3 publish, E1 guardian routes and SMS).
- One or more commits per part, pushed as I go. At the end:
  1. The full gates: `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, `pnpm test`, `pnpm build` (after clearing `apps/web/.next/cache/turbopack`), then `pnpm e2e` with ports 3000/4000 checked free. I stop only processes I started.
  2. Then `gh pr create`, with the step report in the body.
- Screenshot checks: bn at 1366 and 390 px only.

## Core rules (`packages/shared/src/exams.ts` + `exams-api.ts`, unit-tested)

- **Marks are integer hundredths** (`score_h`), like paisa.
  - `parseMarks(text, fullMarks)`:
    - converts Bangla digits with `toAsciiDigits`, allows at most 2 decimals, and rejects values over the full marks;
    - `a`, `A`, `ab` or `অ` means absent; empty means blank;
    - it returns `{kind: 'blank' | 'absent' | 'marks' | 'invalid', reason?}`.
  - The API schema normalises the same way.
- **`gradeForMarks(obtained_h, full, bands, roundingMode)`** compares percentages exactly in integers.
  - `ROUND_HALF_UP` and `CEIL` work to whole percent, as `applyRounding` does.
  - `calculateGrade` is rebuilt on top of it, so `grading.test.ts` still passes.
- **`subjectResult(pass_rule, components, passGroups, marks, bands, rounding)`:**
  - Any absent component means F (the 0-point band).
  - `PER_COMPONENT`: any component below its pass mark means F.
  - `COMBINED`: for each component `kind`, the summed marks below that kind's combined pass mark means F. A kind without a pass group is not checked.
  - Otherwise the subject gets the band of the total percent.
  - All components absent gives status `ABSENT`; any blank gives `INCOMPLETE`.
- **`studentResult` (GPA mode):**
  - With `compulsory_fail_zero` and any compulsory F, the GPA is 0 with the fail letter.
  - Otherwise GPA = (Σ compulsory points + max(0, optional point − bonus_above)) / number of compulsory subjects. It is capped at `gpa_max`, then cut to `gpa_decimals` with `gpa_rounding`, all in integer arithmetic.
  - It also returns the GPA without the 4th subject, the total including the 4th, and the number of failed subjects.
- **`studentResult` (MARKS mode):** total, full marks and percent (2 decimals, half-up). A subject passes only if every component with a pass mark is passed; the student passes if every subject does.
- **`applicableSubjects(examSubjects, candidate, choices)`:** the subject's group is NULL or the student's group, and it is either not elective or chosen by the student. The 4th subject is the choice of kind OPTIONAL.
- **`meritPositions(rows, order, failedRanking)`** gives class and section positions with standard competition ranking. GPA keys are ignored in MARKS mode.
- **`resultSmsText(...)`:** fixed Bangla, at most 2 segments, checked with `smsLength`.

## Data model

**Changes to existing tables**

- `grading_schemes` and `grading_scheme_templates` gain:
  - `gpa_max dec(3,2)` DEFAULT 5.00;
  - `optional_bonus_above dec(3,2)`, NULL meaning no bonus, DEFAULT 2.00;
  - `gpa_decimals smallint`, 0–2, DEFAULT 2;
  - `gpa_rounding` (new enum `TRUNCATE|ROUND_HALF_UP`), DEFAULT TRUNCATE;
  - `compulsory_fail_zero bool` DEFAULT true.

  These are DDL defaults, so no backfill is needed. `provision.ts` copies them and `templates.ts` seeds them.

- `sections` and `subjects` gain a unique `(tenant_id, id, class_level_id)`, so child rows can carry the class level (the fees "carry the key" pattern).
- `subjects` and `template_subjects` gain `pass_rule`: a new enum `PassRule` with values `PER_COMPONENT|COMBINED`, DEFAULT `PER_COMPONENT`. The NCTB 9–10 template sets BAN and ENG to COMBINED.
- `SmsPurpose` gains `EXAM_RESULT`, in its own migration.
- **New global tables** `template_subject_components` and `template_subject_pass_groups` (`GRANT SELECT`):
  - Seeded for NCTB 6–10 and copied in `provisionTenant()` together with `pass_rule`.
  - Existing tenants get them through a "Load template defaults" action, which fills only subjects that have no components.
  - The template's combined pass groups are BAN 9–10 CQ 46 (of 140) and MCQ 20 (of 60), and ENG 9–10 WRITTEN 66 (of 200).
  - Defaults, for you to check:

    | Classes | Subjects                                           | Components (pass mark)                   |
    | ------- | -------------------------------------------------- | ---------------------------------------- |
    | 9–10    | BAN (COMBINED: CQ 46, MCQ 20)                      | P1_CQ 70, P1_MCQ 30, P2_CQ 70, P2_MCQ 30 |
    | 9–10    | ENG (COMBINED: WRITTEN 66)                         | P1 100, P2 100 (both kind WRITTEN)       |
    | 9–10    | ICT                                                | MCQ 25 (8), PRACTICAL 25 (8)             |
    | 9–10    | PHY, CHEM, BIO, HMATH (any subject with practical) | CQ 50 (17), MCQ 25 (8), PRACTICAL 25 (8) |
    | 9–10    | the rest                                           | CQ 70 (23), MCQ 30 (10)                  |
    | 6–8     | ENG                                                | WRITTEN 100 (33)                         |
    | 6–8     | the rest                                           | CQ 70 (23), MCQ 30 (10)                  |

  - Coaching gets none; it sets marks per exam.

**New tenant tables (14).** All have composite FKs, `ON UPDATE RESTRICT`, forced RLS and a leading tenant index.

| #   | Table                      | Key points                                                                                                                                                                                                                                                                                                                                                          | Grants                                                                   |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | `subject_components`       | subject (cascade); key `^[A-Z][A-Z0-9_]{0,19}$`; `kind` text CHECK in `CQ\|MCQ\|PRACTICAL\|WRITTEN\|ORAL\|OTHER`; name bn/en; `full_marks` 1–1000; `pass_marks` NULL or 0–full (used under PER_COMPONENT); sort; unique (subject, key)                                                                                                                              | S I U D                                                                  |
| 1b  | `subject_pass_groups`      | subject (cascade); `kind`; `pass_marks` ≥ 0; unique (subject, kind). Used under COMBINED. The service checks pass ≤ the summed full marks of that kind, and that every kind present has a group.                                                                                                                                                                    | S I U D                                                                  |
| 2   | `section_subject_teachers` | section and subject, both FK'd by `(id, class_level_id)` so the subject must belong to the section's class; user (plain FK; the service requires an ACTIVE TEACHER/ADMIN/OWNER membership); unique (section, subject, user); index (tenant, user)                                                                                                                   | S I U D                                                                  |
| 3   | `student_subject_choices`  | FK to enrolments `(year, student)` (cascade); subject; kind `COMPULSORY\|OPTIONAL`; unique (year, student, subject); partial unique (year, student) WHERE kind='OPTIONAL'; the service checks the subject is in the student's pool                                                                                                                                  | S I U D                                                                  |
| 4   | `exam_rooms`               | name (unique), `rows × cols ≤ 500`, active, sort                                                                                                                                                                                                                                                                                                                    | S I U D                                                                  |
| 5   | `exams`                    | year; kind `HALF_YEARLY\|ANNUAL\|PRE_TEST\|TEST\|CLASS_TEST\|MODEL_TEST\|OTHER`; name bn/en; `starts_on ≤ ends_on`; `result_mode GPA\|MARKS` (the form defaults MARKS for class and model tests; that is UI only); `merit_order text[]` (1–8 keys); `failed_ranking AFTER_PASSED\|UNRANKED`; `attendance_from/to` (NULL-safe CHECK); status `SETUP\|OPEN\|ARCHIVED` | S I U D (D only in SETUP; RESTRICT FKs stop it once rows exist)          |
| 6   | `exam_classes`             | exam × class level (unique); `is_published`, `published_version`, `published_at/by`, `unpublished_reason`; `grading_snapshot` jsonb (the scheme, bands and rules used); `subject_stats` jsonb (highest and average per subject)                                                                                                                                     | S I U D                                                                  |
| 7   | `exam_subjects`            | exam_class, exam, class, subject (FK by `(id, class_level_id)`); copied: `study_group_id`, `is_elective`, `pass_rule`; routine date and start time; sort; unique (exam_class, subject)                                                                                                                                                                              | S I U D                                                                  |
| 8   | `exam_subject_components`  | copied from `subject_components` (including `kind`), with the same CHECKs; editable only while that exam subject has no marks (409 `MARKS_EXIST`)                                                                                                                                                                                                                   | S I U D                                                                  |
| 8b  | `exam_subject_pass_groups` | copied from `subject_pass_groups`; same CHECKs and the same rule about marks                                                                                                                                                                                                                                                                                        | S I U D                                                                  |
| 9   | `exam_candidates`          | exam, student, class (FK to `exam_classes (exam_id, class_level_id)`), section (FK by `(id, class_level_id)`), group, roll (all snapshotted); status `ENROLLED\|WITHDRAWN`; `room_id` + `seat_no` (both set or both NULL; partial unique (exam, room, seat)); `remarks` ≤ 300 with by/at; unique (exam, student)                                                    | S I U                                                                    |
| 10  | `exam_mark_sheets`         | exam_subject × section (unique; class level carried); status `DRAFT\|SUBMITTED\|LOCKED` (CHECK that by/at are set for each); `version`; `last_submission_id`; `return_note`; submitted/locked by/at; created on the first save                                                                                                                                      | S I + UPDATE on the non-key columns                                      |
| 11  | `exam_marks`               | exam, exam_subject, component (FK `(id, exam_subject_id)`), student (FK to candidates `(exam_id, student_id)`); `score_h int NULL`; `absent`; updated_by; CHECK `absent → score_h IS NULL`, `score_h ≥ 0`; a BEFORE trigger (invoker, pinned `search_path`) refuses `score_h > full × 100`; unique (component, student)                                             | S I + UPDATE (score_h, absent, updated_by_id, updated_at); **no DELETE** |
| 12  | `exam_results`             | exam_class × student (unique) + index (tenant, student); section, roll, `total_h`, `full_marks`, `percent_h`, `gpa_h`, `gpa_wo_optional_h`, letter, passed, failed_subjects, class/section position (NULL = unranked), attendance present/total/`percent_h`, `remarks`, `subjects` jsonb, `published_version`                                                       | S I U D (a snapshot rebuilt on republish; every publish is audited)      |

**Migrations:**

- `20261028000000_exams_grading_rules`
- `…010000_exams_setup`
- `…020000_exams_structure`
- `…030000_exams_marks`
- `…040000_exams_results`
- `…040100_exams_sms_purpose`

**Lock order** (written down in `apps/api/src/exams/exam-locks.ts`):

1. The `exam_classes` row: FOR SHARE for sheet writes and remarks; FOR UPDATE for publish, unpublish and sync.
2. Sheet rows FOR UPDATE, in id order ("lock all").
3. The SMS advisory lock that `TenantSmsService.queue` already takes.

**Idempotency:**

- Sheet saves send `submissionId` and `baseVersion`, like attendance: a replay returns the saved state with no audit row; a stale version gets 409 `VERSION_CONFLICT` with the current state; a changed roster gets 409 `ROSTER_CHANGED`.
- Publish sends `baseVersion` (409 `PUBLISH_CHANGED`).
- SMS confirm sends `expectedRecipients` (409 `PREVIEW_CHANGED`).

**Publish is set-based.** One marks query and `createMany`, inside the 15 s transaction. I test it with 600 students and move it to a job if it does not fit.

## Parts (commit-sized, in order)

### Phase 0: groundwork

- **0.1 `AttendanceStatsService`** (`apps/api/src/attendance/attendance-stats.service.ts`, exported from `AttendanceModule`).
  - `percentByStudent(ids, from, to)`: one `DISTINCT ON (student_id, date)` query using the "first register of the day" rule, then `attendancePercent()` with `leave_counts_as_absent`.
  - Test: it matches the existing per-student report.
- **0.2 `TenantSmsService.queue`** gets `overCap: 'HOLD' | 'SKIP'`, default HOLD, so nothing changes for attendance or fees. SKIP writes no row and returns `OVER_CAP`. Tested.
- **0.3 DB:** the grading rule columns, `template_subjects.pass_rule`, `template_subject_components` and `template_subject_pass_groups`.
  - `templates.ts` gets the values, the BIO pool flag, and COMBINED for BAN/ENG 9–10.
  - `provision.ts` copies all of them.
  - Tests: `provision.test` (BAN 9–10 arrives COMBINED with its groups), `grading.test`.

### Phase A: setup (OWNER/ADMIN)

- **A1 DB:** tables 1, 1b and 2–4, `subjects.pass_rule`, and the two new uniques. Tests in `packages/db/test/exams-setup-rls.test.ts`, plus the schema-safety list.
- **A2 shared:** `parseMarks`, `gradeForMarks`, `subjectResult` (both pass rules), `studentResult`, `applicableSubjects`, with zod schemas in `exams-api.ts`. Tests in `exams.test.ts` (see Verification).
- **A3 API:** the `apps/api/src/exams/exams.module.ts` skeleton (registered in `app.module.ts`) and `setup/*.service.ts`.
  - Routes:
    - subject components, the pass rule and combined pass groups (+ load template defaults). Switching a subject to COMBINED prefills its groups; 422 if a kind is missing a group or a pass mark is above that kind's summed full marks;
    - subject teachers per section (+ assign the class teacher to all);
    - `GET /exams/staff` (`/attendance/staff` is gated by ATTENDANCE);
    - subject choices per section (+ bulk);
    - rooms;
    - grading scheme view, with the rule columns and rounding mode editable.
  - Everything is audited.
  - Tests in `apps/api/test/exams-setup.e2e-spec.ts`:
    - role matrix: TEACHER, ACCOUNTANT and GUARDIAN get 403;
    - module off gives 403; another institute's id gives 404; validation gives 422;
    - `NOT_STAFF` for a non-member or another institute's user;
    - a subject from another class is refused;
    - a second OPTIONAL choice is refused;
    - audit rows are written.
  - A new fixture, `test/support/exams.ts`.
- **A4 Web:** `/exams/setup` tabs (Subject marks, Subject teachers, Subject choices, Rooms, Grading), built from the v3 kit (`SetupPage`, `FormGrid`, `ActionBar`, `DataTable`, `Pill`). New `messages/exams/*.{bn,en}.json` and `EXAM_AREAS` in `i18n/request.ts`.

### Phase B: exams, roster, admit cards, seats

- **B1 DB:** tables 5–9 (including 8b). Tests in `exams-structure-rls.test.ts`.
- **B2 API:** `structure/exam.service.ts`, `seats/seat-plan.service.ts`.
  - Exam CRUD; classes and subjects (copying the components and electives); the routine.
  - Open: creates candidates. Archive. Candidate sync (`dryRun`).
  - `GET /exams/:id/admit-cards?sectionId`.
  - Seats:
    - `POST` allocates by alternating classes by column over the chosen rooms; 409 `CAPACITY_SHORT` with the shortfall.
    - `DELETE` clears them.
  - Tests in `exams-structure.e2e-spec.ts`:
    - CHECKs and 422s;
    - delete is only possible in SETUP;
    - sync adds, withdraws and follows a transfer;
    - seat interleaving and capacity;
    - admit cards carry no decision #19 fields.
- **B3 Web:**
  - `/exams` lists exams by year; a teacher sees "My mark sheets" first.
  - `/exams/new`.
  - `/exams/[id]` with `ExamTabs`: Overview, Setup, Candidates, Seats, Admit cards, Results.
  - Admit cards: named page `admit-a4`, 2 per page. The seat plan prints as A4 landscape.
  - The nav item gets `soon:false`, plus the Ctrl+K `g` shortcut.

### Phase C: marks entry, lock, corrections

- **C1 DB:** tables 10–11 and the trigger. Tests in `exams-marks-rls.test.ts`:
  - isolation;
  - FKs refuse a component from another exam subject and a student who isn't a candidate;
  - the app role cannot DELETE marks or update key columns;
  - the score ≤ full trigger.
- **C2 API:** `marks/mark-sheet.service.ts`, `marks/exam-access.service.ts`.
  - `GET /exams/my-sheets`; `GET /exams/sheets?examSubjectId&sectionId` (roster and components).
  - `PUT /exams/sheets` (`action: SAVE|SUBMIT`). Submit needs every applicable cell, otherwise 422 `INCOMPLETE` with the missing count.
  - Admin only: `return` (with a note), `lock`, `unlock` (with a reason), `lock-all` per class, `corrections` (with a reason), `history`.
  - Access: assigned subject teacher or OWNER/ADMIN, otherwise 403 `NOT_ASSIGNED`. A locked sheet gives 403 `SHEET_LOCKED` for teachers.
  - Each save writes one audit row with only the changed cells (old→new). Corrections also record the reason and the published version.
  - Tests in `exams-marks.e2e-spec.ts`:
    - a teacher on another subject, another section, or a class teacher who isn't assigned: 403;
    - Bangla-digit marks are accepted; over the full marks gives 422;
    - replay; 409 conflict and roster change;
    - editing a submitted sheet goes back to DRAFT;
    - after lock, a teacher gets 403 and a correction without a reason gives 422;
    - the audit row holds the changed cells and the reason;
    - a rollback (`TestController` "sheet-then-fail") leaves nothing.
- **C3 Web:** `/exams/[id]/sheets/[examSubjectId]/[sectionId]`, phone-first.
  - Pick a component (CQ / MCQ / Practical), then enter marks down the list: roll badge, name, a large `inputmode="decimal"` field, `enterkeyhint="next"` (Enter moves to the next student), and the Ab button.
  - A live total and grade preview; inline errors for invalid or over-full values; a progress chip.
  - At ≥1024 px, a grid with every component.
  - A sticky bar with the sync pill and Submit; the submit dialog lists blanks.
  - Drafts: `lib/exams/sheet-drafts.ts` + `sheet-controller.ts` mirror the attendance `RegisterController`:
    - localStorage `jantrik.marks:<user>:<tenant>:<sheetKey>`, holding ids, roll and name only;
    - debounced server save (≥3 s, and when the tab is hidden);
    - backoff retry; keep mine / keep theirs conflicts.
  - `countAllDrafts` users (the connection screen and the dashboard banner) count marks drafts too.
  - Admin: the sheets status grid (classes × sections × subjects) with lock-all, return, unlock, and the correction dialog with a reason.

### Phase D: results, tabulation, report cards, publish

- **D1 DB:** table 12, then the `EXAM_RESULT` migration. Tests in `exams-results-rls.test.ts`.
- **D2 shared:** `meritPositions`, a `computeClassResults()` orchestrator (pure, from the rows), `resultSmsText`, with tests.
- **D3 API:** `results/exam-results.service.ts`.
  - Tabulation: live before publish, the snapshot after. Plus CSV (`toCsv`, ASCII digits, BOM).
  - `publish-check`: unlocked sheets, missing marks, roster drift, missing choices; warnings vs blockers.
  - `publish` (needs every non-empty sheet LOCKED), `unpublish` (with a reason).
  - Report cards by section or student; remarks (class teacher or admin).
  - Access: OWNER/ADMIN, or the section's teachers (from that section's own `section_teachers`). Parents' names only with `StudentAccess.sees()`.
  - Tests in `exams-results.e2e-spec.ts`:
    - publish refuses unlocked sheets;
    - 5 concurrent publishes give one version bump;
    - a correction after publish shows as stale, then republish;
    - unpublish hides results;
    - with ATTENDANCE off, there is no attendance;
    - the CSV is formula-safe and has no phones or parents;
    - a subject-only teacher gets 403 on tabulation and report cards;
    - 600 students publish in under 15 s.
- **D4 Web:**
  - `…/classes/[ecId]/tabulation` (A4 landscape, `thead` repeats; CSV).
  - `…/results`: the merit list, publish check, and publish/unpublish dialogs.
  - `…/report-cards?section|student`: named page `report-a4` using the receipt's `body:has()` pattern, one card per page.
  - `…/remarks`: a phone list.

### Phase E: guardian, SMS, dashboard, seed, docs

- **E1 API:**
  - `GET /me/children/:id/results` and `/me/children/:id/results/:ecId`: own child only, published only. Otherwise 404, using the `assertChild` query from `fee-mobile.service.ts:155`.
  - Result SMS:
    - `POST …/sms/preview`, `POST …/sms` (202 + runId), `GET …/sms/:runId`;
    - queue `exams`, job `send-result-sms`, with an `actorUserId` and a role re-check, in chunks of 25 per `TenantJobRunner` transaction;
    - relevance check: still published at the same version.
  - `GET /exams/summary` for the dashboard.
  - Tests in `exams-guardian.e2e-spec.ts` and `exams-sms.e2e-spec.ts`:
    - guardian A gets 404 for B's child and for unpublished results;
    - a teacher gets 403 on `/me/children`;
    - dedupe; skipped over the cap and sendable the next day;
    - cancelled after unpublish.
  - The new endpoints are added to `no-global-names` and `student-privacy`.
- **E2 Web:**
  - `ChildResultsSummary` replaces `examsSoon` on the guardian `ChildCard`. Then `/children/[id]/results` and `/children/[id]/results/[ecId]` (the same report card component, printable).
  - The SMS dialog with cost.
  - Staff: a real `module-card-exams` tile (sheets locked of total) and a "submitted, waiting for lock" attention card.
  - Teacher: a "My mark sheets" card.
  - The TermTimeline shows real exams instead of `TYPICAL_EXAMS` once they exist.
  - The `module-card-exams` expectation in `e2e/auth.spec.ts` is updated.
- **E3 Seed** (`packages/db/src/seed/demo-exams.ts`, called from `demo.ts`):
  - Shapla, subject teachers and choices:
    - Nasrin teaches BAN and MATH in 6 ক.
    - Sharmin teaches 9 ক, including ENG.
    - Tahmid takes BIO compulsory and HMATH as 4th; Rafi has the Business pool.
  - Shapla, exams:
    - A **published half-yearly** (June) for classes 6 and 9, with deterministic marks: one component fail, one absent, one capped 5.00 with the 4th-subject bonus, a merit tie broken by total, and remarks.
    - An **open annual** (November):
      - 6 ক BAN is empty, for the bn Playwright run;
      - 9 ক ENG is empty, for the en run;
      - every other sheet is locked with marks.
    - Two rooms and a seat plan.
  - Alo: a published MARKS-mode model test with a tie.
  - Shapla's half-yearly includes a 9 ক BAN student who passes only under COMBINED, so the report card shows it.
  - `docs/demo-accounts.md` updated. I run `pnpm db:reset` (local `jantrik` only) at the walkthrough.
- **Closing (docs):**
  - New `docs/exams.md` (like `attendance.md`).
  - `database.md`: the tables, the marks history (no DELETE, column grants, the trigger), the results snapshot.
  - `auth.md`: subject teachers, guardian results routes, the SMS `overCap` option.
  - `decisions-pending.md`:
    - the decisions above as #31+, plus how #19 applies to exams;
    - a **"To verify with a real board/school marksheet"** entry: GPA TRUNCATE vs ROUND_HALF_UP, the component defaults table, the combined pass marks, and absence under COMBINED.
  - `backlog.md`:
    - combined results (class tests weighted into the annual);
    - server bulk PDFs;
    - the band editor;
    - an "exempt" marker;
    - holding admit cards back for unpaid fees;
    - next year's rolls from merit;
    - an editable result SMS template;
    - manual seat moves.
  - `CLAUDE.md` gets "Exams rules: docs/exams.md".

## Playwright (`apps/web/e2e/`)

`exams.spec.ts` runs the whole flow in a `CASES` loop, bn then en, each on its own seeded sheet:

1. **Teacher** at 360×780 touch: Nasrin (bn, 6 ক BAN) or Sharmin (en, 9 ক ENG).
   - Opens My mark sheets and types marks with Bangla digits, using Enter to move.
   - Marks one student `অ`/Ab, and sees an over-full value refused inline.
   - Reloads mid-way: the draft is kept and the sync pill shows the state.
   - Goes offline (`page.route` abort): "kept on this phone"; back online it is saved.
   - Submits.
   - Opening an unassigned subject's URL shows "not assigned".
2. **Admin** at 1366: lock-all for the class, publish check clean, publish, then the result SMS preview with the cost, and confirm.
   - The tabulation in `emulateMedia('print')` is a landscape A4 PDF; the CSV has a BOM and ASCII digits.
   - The report card PDF is 1 A4 portrait page.
3. **Guardian** 01811000101 at 390 touch, OTP from the outbox: the dashboard shows the child's result summary, then the report card (Tasnim in bn, Tahmid with the 4th subject in en), which prints as 1 A4 page.
   - The other guardian (01811000102) opening that URL gets not found.
   - Before publish, the annual is absent from the list.

The exam pages are added to `layout.spec.ts` (360 px overflow, 44 px targets), `themes.spec.ts` and `numerals.spec.ts`.

## Verification

1. **Per part:**
   - Drift check prints an empty migration.
   - `pnpm --filter @jantrik/shared test`, `pnpm --filter @jantrik/db test`, and `pnpm --filter @jantrik/api test -- exams-…`.
   - Shared `exams.test.ts` covers:
     - a component fail with a total ≥ 80 gives F; absent MCQ gives F;
     - a 4th subject at A+ adds 3.00 and caps at 5.00; at C it adds 0; a failed 4th adds 0 and doesn't fail the student;
     - a compulsory F with the 4th at A+ gives GPA 0;
     - 79.5 under NONE, HALF_UP and CEIL; 32.5; 22.5 out of 70 against 23;
     - COMBINED:
       - P1_CQ 20 + P2_CQ 26 = 46 passes, although P1_CQ is under 23; 45.5 fails;
       - MCQ is checked on its own, so a CQ pass with an MCQ fail gives F;
       - the same marks under PER_COMPONENT give F;
       - absent in one paper gives F;
       - a kind without a group is not checked;
       - the API refuses a missing group or a pass mark above the full marks;
       - template BAN/ENG 9–10 arrive COMBINED;
     - 4.958 truncated vs half-up; nothing below 5 rounds to 5.00;
     - ties on each key; ROLL across sections; failed ranked after vs unranked;
     - MARKS-mode percent;
     - `parseMarks` with Bangla digits, 3 decimals, over full, `অ`, empty.
2. **Final gates:** as in Workflow, including all of Playwright.
3. **Manual walkthrough** with `pnpm dev`, after `pnpm db:reset` on the local `jantrik` DB (approved; I check `--dry-run` first):
   - the owner sets up components, subject teachers and choices;
   - the teacher enters marks at 390 px;
   - the admin locks, corrects with a reason, and publishes;
   - tabulation and report card print;
   - SMS preview;
   - the guardian dashboard.
   - Screenshots in bn at 1366 and 390 px.
4. **Performance:** the marks page at 390 px, 4× CPU, slow 4G, interactive within 3 s. Measured with an interleaved A/B against main, reported as ranges.
5. **Report:** `docs/reports/step-10-report.md` (the files changed, how to run and test, and anything left undone), and the plan copied to `docs/plans/step-10.md`.

## Risks

- **Scope.** About 14 tables plus 2 template tables, 6 migrations, around 45 endpoints and around 14 screens. Committed part by part, like step 9.
- **Publish time** for very large classes within the 15 s transaction: tested at 600 students, with a fallback to a job.
- **Bangla in browser print-to-PDF.** Font shaping and page breaks are checked with `page.pdf()` in Playwright.
- **Component defaults, combined pass marks and the GPA rounding default** are my reading of NCTB practice. All are data you can change, and they are listed in decisions-pending for you to check against a real marksheet.
- **The BIO template change** only affects new institutes; the demo picks it up on reseed.

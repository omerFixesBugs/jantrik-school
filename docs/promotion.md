# Promotion and the new session (sprint 1 P5)

How an institute moves into the next academic year: students leave, runs promote or repeat them
class by class, the runs are applied in the background, rolls are numbered, and an admin switches
the current year after a check. Plan: `docs/plans/sprint-1-p5-promotion.md` (PR #15); approved
rules S14–S17 in [plans/sprint-1.md](plans/sprint-1.md). Open decisions:
[decisions-pending.md](decisions-pending.md) → "Sprint 1, P5".

Nothing here is automatic: the current year never switches by itself, and nothing moves money.

## Leaving (S14)

- **Leaving is a status, not a deletion.** `POST /students/:id/leave {status, leftOn, reason?}`
  (OWNER/ADMIN) sets `GRADUATED`, `TRANSFERRED`, `DROPPED_OUT` or `INACTIVE`, with `students.left_on`
  and `leave_reason`. `deleted_at` stays NULL, so the ledger, the counter and history still find the
  student. Only an ACTIVE student leaves (`422 ALREADY_LEFT`); a deactivated one answers `409
DEACTIVATED`.
- **What changes:** everything that reads ACTIVE students leaves them out: attendance registers,
  the device roster, the due list, new dues, and the student limit (a place is freed). The student
  list still shows them, marked with their status (the status filter shows only one kind).
- **Rolls are kept** (history; a return finds them in place).
- **Return** (`POST /students/:id/return`, P5-J): ACTIVE again, date and reason cleared, the
  student limit checked as for an admission (`422 STUDENT_LIMIT`).
- Both are conditional updates (two at once: the second gets `ALREADY_LEFT` / `NOT_LEFT`) and are
  audited (`student`, UPDATE, old and new status).
- CHECKs: no `left_on` while ACTIVE; a reason needs a date; at most 500 characters.

## Runs

A **run** moves one class of the from-year into the to-year: `POST /promotions {fromYearId,
toYearId, classLevelId, rollStrategy?, meritExamId?}` (OWNER/ADMIN, CORE). One run per from-year,
to-year and class (`409 RUN_EXISTS`); the to-year must start after the from-year (`422
YEAR_ORDER`). The overview (`GET /promotions?toYearId`) lists the runs with their counts and the
classes of the year before that have students but no run yet.

Each ACTIVE student of the class (not already in another run into that year) gets a **row** with a
snapshot (from-section, from-roll, the merit exam's `passed` and class position) and defaults:

| Case                                                   | Default                                           |
| ------------------------------------------------------ | ------------------------------------------------- |
| top class (no active class with a higher `sort_order`) | LEAVE as GRADUATED on the from-year's last day    |
| top class, failed in the merit exam                    | REPEAT (safer than graduating them)               |
| failed in the merit exam                               | REPEAT into the same class                        |
| passed, or no result (absent, no exam)                 | PROMOTE into the next class (flagged "no result") |

- **The merit exam** (P5-G): the given exam must be published for that class in the from-year
  (`422 MERIT_EXAM_INVALID`); without one, the latest published ANNUAL exam of the class is taken.
  The strategy defaults to MERIT when there is an exam, NAME_BN otherwise; MERIT without an exam is
  refused (`422 MERIT_NEEDS_EXAMS`, `reason: NO_EXAM`). Without the EXAMS module results are never
  used (`reason: MODULE` if MERIT or an exam is asked for). Results are read through
  `ExamResultsReader` (exams module), never from exam tables directly.
- **Target section** (S15): the section with the same name in the target class of the to-year,
  else none (the admin picks one; rows without one are enrolled without a section).
- **Study group** (P5-I): kept while the group is active.
- **"Next class"** is data: the active class level with the next higher `sort_order`. A coaching
  centre whose batches do not progress sets rows to REPEAT or LEAVE.

**Editing** (`PUT /promotions/:id/rows`, ≤ 500 rows): PROMOTE goes to another active class, REPEAT
stays in the run's class, a section must be an active one of the to-year and the target class, a
group must be active (`422 TARGET_INVALID` with the row ids; nothing is saved). An applied row
never changes (`409 ROW_APPLIED`; the database refuses it too). `PATCH /promotions/:id` changes the
strategy or the merit exam (a new exam takes the results of pending rows again; decisions stay).
`POST /promotions/:id/refresh` adds students enrolled in the class since, and removes pending rows
of students who left or were deactivated meanwhile. None of these while the run is being applied
(`409 RUN_APPLYING`). All of it is audited (`promotion_run`).

## Apply

1. `GET /promotions/:id/apply-check`: per target section its capacity, the students enrolled now
   and those arriving; rows without a section; pending counts; a `version`.
2. `POST /promotions/:id/apply {version}`: refused when the run is already applying (`409
RUN_APPLYING`; two admins at once take turns on the run's row lock), when nothing is pending
   (`422 NOTHING_TO_APPLY`), when anything in the check changed (`409 PREVIEW_CHANGED`: rows,
   capacities, the sections' enrolments, so another run being applied into the same sections
   changes it too), while a section would overflow (`422 SECTION_FULL` with the list, P5-E), and
   while a row goes into a deactivated class or section (`422 TARGET_INVALID`). The run becomes
   APPLYING and one job is queued after commit (`promotions` queue, job id
   `promotion-apply-<runId>`, data = ids only).
3. **The job** (acting as the admin who pressed apply; it stops with `ACTOR_NOT_ADMIN` if they lost
   OWNER/ADMIN):
   - one **target section per transaction** (and one for rows without a section), under a per-run
     advisory lock: the section locked and its capacity checked again (as an admission does); per
     row: deactivated → `SKIPPED_DEACTIVATED`; left another way → `SKIPPED_LEFT`; already enrolled
     in the to-year (by hand or by admission) → `ALREADY_ENROLLED`, left as is (P5-D); else a new
     enrolment **without a roll** → `ENROLLED`. A concurrent enrolment of the same student is
     skipped by the unique `(year, student)` and counts as `ALREADY_ENROLLED`. Repeaters' subject
     choices are copied (same class, still active subjects, P5-H). One audit row per section.
   - then the **leavers**, 200 per transaction: status, date and reason set where the student is
     still ACTIVE (one audit row each), rolls untouched.
   - then the run is APPLIED (no pending row left).
4. **Stopping and resuming:** a failure records a fixed code in `last_error` (never a message) and
   the run stays APPLYING. `SECTION_FULL`, `TARGET_INVALID` and `ACTOR_NOT_ADMIN` are not retried
   (the admin fixes the cause); anything else is retried by BullMQ (5 attempts, backoff from 10 s).
   `POST /promotions/:id/resume` queues it again as the caller, refused while the job is still in
   the queue. Every step skips rows already applied, so a retry, a resume or a second execution
   continues where the first stopped and never enrols anyone twice.
5. **After APPLIED**, a refresh can add rows (the run stays APPLIED with pending rows); applying
   again handles only those. There is no "unapply" (P5-L): fix single students afterwards (transfer,
   leave, return, edit the enrolment).

The job never touches `academic_years.is_current`. 600 students into one section apply in one
transaction well under the 15 s limit (test).

## Numbering the rolls (P5-A, P5-B, S15)

Rolls are numbered per class of the new year, after the runs that feed it are applied:
`GET /promotions/rolls?toYearId&classLevelId` proposes, `PUT /promotions/rolls` saves.

- **Groups, in this order:** promoted students (the strategy of the run that promoted most of
  them), then repeaters (this class's own run), then everyone else enrolled in the year (new
  admits: Bangla name). `assignRolls()` in `@jantrik/shared` (pure, deterministic).
- **Strategies:** MERIT (class position, unranked after; ties by the lower old roll, then Bangla
  name), NAME_BN (Bangla collator, ties by student code), NAME_EN, MANUAL (proposes NAME_BN; the
  admin edits the numbers), KEEP (an old roll is kept when free; the rest follow the highest kept
  number, by Bangla name).
- **Rolls already set are kept and skipped** (a new admit given roll 3 by hand keeps it; the
  proposal goes 1, 2, 4…). Nothing is ever renumbered.
- **Saving** writes only enrolments without a roll; it sends back the preview's `version` (`409
PREVIEW_CHANGED` when the class's enrolments or rolls changed), refuses a number taken in the
  section (`409 ROLL_TAKEN`) and a duplicate in the request (400). Bangla digits are accepted. One
  audit row (`class_level`, `step: number_rolls`).

## The switch check (P5-O)

`GET /promotions/switch-check?toYearId` lists what is not finished before switching: classes of
the year before with students but no run, runs not applied (or with pending rows), classes with
students whose ANNUAL exam is not published (with EXAMS), ACTIVE students not enrolled in the new
year, and enrolments of the new year without a roll. It is advisory: the switch itself (`POST
/setup/academic-years/:id/current`) is unchanged, and nothing switches the year automatically.

**After a switch**, ACTIVE students not enrolled in the new year drop out of the due list,
attendance and the device roster (all read the current year); enrolling them restores everything.
Leavers leave at apply (P5-C): applying class 10's run in December removes them from attendance
and the due list from then on.

## Tables

`promotion_runs` and `promotion_run_students`: see [database.md](database.md) → Promotion.

## Tests

- `packages/db/test/promotion-rls.test.ts`, `students-leaving.test.ts`, `schema-safety.test.ts`
- `packages/shared/src/promotion.test.ts` (`assignRolls`, schemas)
- `apps/api/test/students-leave.e2e-spec.ts`, `promotion-runs.e2e-spec.ts`,
  `promotion-apply.e2e-spec.ts` (resume, concurrency, two executions, 600 students),
  `promotion-rolls.e2e-spec.ts`, `promotion-switch.e2e-spec.ts`
- Playwright: `apps/web/e2e/students.spec.ts` (leave and return)

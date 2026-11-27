# Sprint 1, P4: admission test and merit list (implementation plan)

**Status: plan only (day run 2026-11-16), not approved, no code yet.** Written while the owner was
away. The sprint plan's P4 section ([sprint-1.md](sprint-1.md) → "P4: Admission test and merit
list") and decisions S12 and S13 are approved and binding. What this plan adds is in "Decisions for
the owner" at the end, each with a recommended default.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.
> One review subagent at the end (database, SMS money, public lookup).

**Goal:** for a cycle that requires a test (`admission_cycles.requires_test`, P3), staff issue test
rolls, print applicant admit cards, enter one total score per applicant (S12), build a merit list,
and publish it. Applicants see their result on the status page after a phone code (S13) and can be
told by SMS. A seat freed by a withdrawal goes to the next on the waitlist.

**Architecture:** columns on P3's `admission_cycle_classes` and `admission_applications`, a pure
`admissionMerit()` in `packages/shared` (the same place-sharing rule as `meritPositions()`), routes
in P3's `AdmissionModule` under `CORE` for OWNER/ADMIN, the result SMS through
`TenantSmsService` with the preview → send pattern, and P3's `admission_lookup` replaced (same
signature) to return the published result.

**Tech stack:** as P3 (NestJS, Prisma/PostgreSQL 16, BullMQ, Next.js v3 kit, Vitest, Playwright).

**Spec:** sprint-1.md → P4; S12 (one total per applicant), S13 (application number + phone code);
the exams print CSS and `meritPositions()` reused.

**Branch:** `feature/sprint-1-p4-admission-test` from `main` after P3b is merged (P4 needs P3's
tables, its public status page and its phone tokens).

## What exists today (verified 2026-11-16 on `main` at `7de4f5a`)

- **Merit places:** `meritPositions(rows, order, failedRanking, mode)`
  (`packages/shared/src/exams-results.ts:68`): passed rows
  first, then each key in turn; rows equal on every key share a place and the next place skips
  (1, 2, 2, 4); failed rows can be unranked (`UNRANKED` → null). Its rows are exam results
  (`MeritRow`: GPA, totals, roll, subject totals), so admission gets its own small function with the
  same tie rule rather than squeezing applicants into `MeritRow`.
- **Scores in hundredths:** exam marks are stored as `score_h` and kept within the full marks by a
  trigger (`packages/db/prisma/migrations/20261028030100_exams_marks_trigger/migration.sql`,
  `exam_marks_score_within_full`, `check_violation`). P4 copies that pattern for
  `test_score_h`.
- **Marks entry UI:** `MarkEntry` (`apps/web/src/components/exams/mark-entry.tsx:66`) is a grid with
  `inputMode="decimal"` (`:278`) and Bangla digits accepted; mark-sheet changes are audited
  (`apps/api/src/exams/marks/mark-sheet.service.ts:250`, `:304`, `:348`).
- **Admit cards:** the exam admit cards are served by `GET /exams/:id/admit-cards`
  (`apps/api/src/exams/exams.module.ts:528`) and printed by `AdmitCardsPrint`
  (`apps/web/src/components/exams/print-pages.tsx:210`) inside `.exam-print`, with
  `@page exam-a4` (A4 portrait, 10 mm, `apps/web/src/app/globals.css:634`) and the print-area
  isolation rules (`:638-660`). Two cards per A4.
- **Result SMS:** `ResultSmsService` (`apps/api/src/exams/results/result-sms.service.ts`) is the
  pattern: `preview()` counts recipients, segments, cost (`platform_settings.sms_cost_per_segment_paisa`)
  and the cap left today (`:75-101`); `send(expected)` answers 409 `PREVIEW_CHANGED` when the count
  moved (`:103-109`), records the run in an audit row, and a job queues each SMS with
  `overCap: 'SKIP'` and a dedupe key per version (`:151-180`); a relevance check drops SMS for a
  version that is no longer published (`:63-72`).
- **P3 (planned, [sprint-1-p3-admission.md](sprint-1-p3-admission.md)):** the applications and their
  statuses (`SELECTED`, `WAITLISTED`, `REJECTED`, `WITHDRAWN`, `ADMITTED`), `admission_lookup`
  returning `jsonb` (so P4 can add keys), the status page behind a phone code, the applicant photo
  in `admission_application_photos`, `APPROVABLE_STATUSES(requiresTest)` = `SELECTED` only.

## What P4 needs from P2 and P3

- **P3:** everything above. P4 cannot start before P3b is merged.
- **P2:** `institute_profiles` (name, and the logo through `GET /institute/profile/logo`) for the
  admit card header. The applicant photo comes from P3's photo table, not `FileStore`.

## Global constraints

- **Routes:** `@RequireModule('CORE')`, `@Roles('OWNER','ADMIN')` (decision P4-L).
- **Scores:** hundredths, `0 <= test_score_h <= full_marks * 100`, Bangla digits accepted, at most
  two decimals (`parseScore` from the exams code, reused). Every change is audited with old and new
  values (CLAUDE.md rule 6: marks).
- **Statuses change only at publish** (decision P4-E). Building the list writes the draft places and
  outcomes on the rows; applicants and their status are untouched until publish.
- **An admitted applicant is never demoted** by a republish (decision P4-F).
- **SMS:** `ADMISSION_RESULT` purpose (its own migration), `overCap: 'SKIP'`, dedupe
  `admission-result:<cycleClassId>:<version>:<applicationId>`, preview → send with
  `PREVIEW_CHANGED`. All-or-nothing is not required here (results, not a broadcast): over the cap,
  the rest are skipped and shown.
- **Public lookup:** nothing about the test or the merit list before publish; after publish, the
  applicant's own result only, behind P3's phone token (S13).
- **Strings, digits, gates:** as P3. Rolls and application numbers in ASCII digits; scores, places
  and dates in Bangla digits in the bn UI.

## Review focus

1. **Ties.** Two applicants with the same score and the same date of birth under the cycle's
   tie-break; a tie straddling the last selected place. Expected: the documented order; with
   `NONE`, shared places (1, 2, 2, 4) and every applicant tied at the boundary selected, with a
   warning before publish (P4-B). Test: Task 2.
2. **Correcting a published list.** A score changed after publish, then republished. Expected: the
   version goes up; only applicants whose outcome changed get an SMS; an admitted applicant keeps
   their place and status and is flagged instead. Test: Task 5.
3. **Nothing leaks before publish.** The status page and the public API show no score, place or
   outcome before publish, even when the list is built. Test: Task 6.
4. **The SMS cap.** More recipients than the cap left. Expected: the preview shows how many would be
   skipped; the send queues up to the cap and skips the rest (SKIP, not HOLD). Test: Task 5.
5. **Two admins.** One builds while the other enters scores; one publishes a list built before a
   score changed. Expected: publish refuses a stale build (409 `MERIT_STALE`). Test: Task 4.

## Database

### Changes to `admission_cycles`

- `merit_tie_break admission_tie_break NOT NULL DEFAULT 'OLDER_FIRST'`; enum
  `admission_tie_break`: `OLDER_FIRST | YOUNGER_FIRST | NONE` (decision P4-A). Grant UPDATE on the
  column to `jantrik_app`.

### Changes to `admission_cycle_classes`

| Column                            | Type             | Rule                                                                                           |
| --------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------- |
| `test_date`                       | date NULL        |                                                                                                |
| `test_time`                       | time NULL        | the institute's local time                                                                     |
| `test_venue_bn` / `test_venue_en` | text NULL        | ≤ 200 each                                                                                     |
| `full_marks`                      | int NULL         | CHECK `full_marks IS NULL OR full_marks BETWEEN 1 AND 1000`                                    |
| `pass_marks`                      | int NULL         | CHECK `pass_marks IS NULL OR (full_marks IS NOT NULL AND pass_marks BETWEEN 0 AND full_marks)` |
| `select_count`, `waitlist_count`  | int NULL         | CHECK each `IS NULL OR BETWEEN 0 AND 5000`                                                     |
| `merit_built_at`                  | timestamptz NULL | when the draft was built                                                                       |
| `scores_changed_at`               | timestamptz NULL | the latest score change (a publish refuses `merit_built_at < scores_changed_at`)               |
| `results_version`                 | int NOT NULL     | default 0; CHECK `>= 0`; the published version                                                 |
| `results_published_at`            | timestamptz NULL | CHECK `(results_version = 0) = (results_published_at IS NULL)`                                 |

UPDATE granted on these columns to `jantrik_app`. No new indexes (looked up by id).

### Changes to `admission_applications`

| Column              | Type                       | Rule                                                                                               |
| ------------------- | -------------------------- | -------------------------------------------------------------------------------------------------- |
| `test_roll`         | int NULL                   | CHECK `BETWEEN 1 AND 999999`; UNIQUE `(tenant_id, cycle_class_id, test_roll)` WHERE NOT NULL       |
| `test_score_h`      | int NULL                   | CHECK `>= 0`; trigger: `<= full_marks * 100` of its class (`admission_score_within_full`)          |
| `test_absent`       | boolean NOT NULL           | default false; CHECK `NOT test_absent OR test_score_h IS NULL`                                     |
| `test_result`       | admission_test_result NULL | the draft outcome from the last build: `SELECTED                                                   | WAITLISTED | NOT_SELECTED | FAILED | ABSENT` |
| `merit_position`    | int NULL                   | CHECK `>= 1`; NULL for FAILED and ABSENT                                                           |
| `waitlist_position` | int NULL                   | CHECK `>= 1`; set only with `test_result = 'WAITLISTED'`                                           |
| `result_version`    | int NULL                   | the published version this row's result belongs to; NULL before publish                            |
| `result_flag`       | text NULL                  | CHECK `IN ('ADMITTED_NOT_SELECTED')` (an admitted applicant a correction would have dropped; P4-F) |

- Indexes: `(tenant_id, cycle_class_id, merit_position)`.
- UPDATE granted on these columns to `jantrik_app`; `jantrik_admission` gets SELECT on
  `test_roll, test_score_h, test_absent, merit_position, waitlist_position, result_version` and on
  `admission_cycle_classes.results_version, results_published_at, test_date, test_time,
test_venue_bn, test_venue_en, full_marks` for the lookup.
- RLS: unchanged (existing tables). The checklist items that apply to new columns: composite keys
  (none new), CHECKs with `IS [NOT] NULL` first ✓, grants by column ✓, isolation tests extended ✓.

### `admission_lookup` (replaced, same signature)

`CREATE OR REPLACE` under `SET ROLE jantrik_admission` (only the owner can replace it), as earlier
migrations did for `jantrik_auth` functions. When `results_version > 0` for the application's class
it adds `result: { version, outcome, meritPosition, waitlistPosition, scoreH, fullMarks, absent,
publishedAt }` from the **published** columns (`result_version` must equal the class's
`results_version`); before that it adds `test: { roll, date, time, venueBn, venueEn }` once rolls
are issued, and nothing else. The `outcome` is the application's status (`SELECTED`, `WAITLISTED`,
`REJECTED`, `ADMITTED`, `WITHDRAWN`), never the draft `test_result`.

### Migrations, in order

1. `…_sms_purpose_admission_result`: `ALTER TYPE sms_purpose ADD VALUE 'ADMISSION_RESULT';` alone.
2. `…_admission_test`: the two enums, the columns, CHECKs, the trigger function and trigger, column
   grants, the extra `jantrik_admission` column grants.
3. `…_admission_lookup_results`: `admission_lookup` replaced (and the `schema-safety` privilege
   snapshot updated in the same PR).

## API

All under P3's controller, `@RequireModule('CORE')`, `@Roles('OWNER','ADMIN')`.

| Route                                                 | Does                                                                                        | Errors                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `PATCH /admission/cycles/:id`                         | also `meritTieBreak`                                                                        | 409 `RESULTS_PUBLISHED` (changing it after a publish)                                                          |
| `PATCH /admission/cycle-classes/:id/test`             | date, time, venue, full and pass marks, select and waitlist counts                          | 422 `TEST_NOT_REQUIRED` (cycle without a test); 409 `SCORES_ABOVE_FULL` when lowering full marks below a score |
| `POST /admission/cycle-classes/:id/test-rolls`        | `{startAt?}`: rolls for SUBMITTED and SHORTLISTED rows without one, by application number   | 422 `TEST_NOT_CONFIGURED`                                                                                      |
| `GET /admission/cycle-classes/:id/admit-cards`        | cards for the rows with rolls (`?from&to` roll range), photo URLs, the institute header     | 422 `ROLLS_NOT_ISSUED`                                                                                         |
| `GET /admission/cycle-classes/:id/scores`             | the grid: roll, number, name, score, absent                                                 |                                                                                                                |
| `PUT /admission/cycle-classes/:id/scores`             | `{rows: [{applicationId, score: string \| null, absent}]}`, up to 500 rows, one transaction | 422 `SCORE_OUT_OF_RANGE {applicationId}`; 422 `NO_ROLL`                                                        |
| `POST /admission/cycle-classes/:id/merit`             | build the draft: places, outcomes, waitlist positions; returns the list and warnings        | 422 `SCORES_MISSING {count}` (rows with neither a score nor absent)                                            |
| `POST /admission/cycle-classes/:id/publish`           | `{builtAt}`: apply the draft to statuses, version + 1                                       | 409 `MERIT_STALE`; 409 `MERIT_NOT_BUILT`                                                                       |
| `GET /admission/cycle-classes/:id/result-sms/preview` | recipients (changed since their last SMS), segments, cost, cap left, would be skipped       | 422 `NOT_PUBLISHED`                                                                                            |
| `POST /admission/cycle-classes/:id/result-sms`        | `{expected}` → a run (job)                                                                  | 409 `PREVIEW_CHANGED`                                                                                          |
| `POST /admission/applications/:id/withdraw`           | P3's status route with `WITHDRAWN` and a reason (a selected applicant gives up the seat)    | as P3                                                                                                          |
| `POST /admission/cycle-classes/:id/move-up`           | the first WAITLISTED by `waitlist_position` becomes SELECTED; optional single SMS           | 422 `WAITLIST_EMPTY`; 422 `NO_SEAT_FREE` (selected + admitted already at `select_count`)                       |

**Build (`admissionMerit`):**

```ts
export type AdmissionTieBreak = 'OLDER_FIRST' | 'YOUNGER_FIRST' | 'NONE';
export interface MeritApplicant {
  id: string;
  scoreH: number | null; // null with absent
  absent: boolean;
  dateOfBirth: IsoDate;
  submittedAt: string; // ISO instant
}
export interface MeritOutcome {
  result: 'SELECTED' | 'WAITLISTED' | 'NOT_SELECTED' | 'FAILED' | 'ABSENT';
  meritPosition: number | null;
  waitlistPosition: number | null;
}
export function admissionMerit(
  rows: readonly MeritApplicant[],
  opts: {
    tieBreak: AdmissionTieBreak;
    passMarksH: number | null;
    selectCount: number;
    waitlistCount: number;
  },
): { outcomes: Map<string, MeritOutcome>; boundaryTie: number /* extra selected by a tie */ };
```

- Absent → `ABSENT`, unranked. Below the pass marks → `FAILED`, unranked (decision P4-D).
- Ranked by score (higher first), then: `OLDER_FIRST` (earlier date of birth first) or
  `YOUNGER_FIRST`, then submission time (earlier first), as the sprint plan orders them; `NONE`
  uses score only. Rows equal on every key share a place, the next place skips (as
  `meritPositions`); with a DOB tie-break, submission time leaves no ties in practice.
- Places 1..`select_count` → `SELECTED`, including everyone sharing the last selected place
  (`boundaryTie` > 0 is shown as a warning before publish, P4-B); the next `waitlist_count`
  ranked rows → `WAITLISTED` with `waitlist_position` 1..n; the rest → `NOT_SELECTED`.

**Publish**, in one transaction under a row lock on the class:

- refuse when `merit_built_at` is null (409 `MERIT_NOT_BUILT`) or older than `scores_changed_at`
  or the given `builtAt` (409 `MERIT_STALE`);
- `results_version + 1`, `results_published_at = now`;
- each row not ADMITTED and not WITHDRAWN: `SELECTED` → status SELECTED; `WAITLISTED` → WAITLISTED;
  `NOT_SELECTED`, `FAILED`, `ABSENT` → REJECTED with the reason code (`NOT_SELECTED`, `FAILED`,
  `ABSENT`; decision P4-E); `result_version` = the new version;
- an ADMITTED row whose draft is not `SELECTED` keeps its status and gets
  `result_flag = 'ADMITTED_NOT_SELECTED'` (P4-F);
- one audit row with the version, counts and the ids by outcome.

**Result SMS:** recipients are rows of the published version whose status differs from the status
their last result SMS reported (first publish: everyone with a result); text from
`admissionResultSmsText({ institute, applicationNo, outcome, meritPosition, waitlistPosition,
statusUrl })` (decision P4-H), bn by the institute's default locale. Relevance check: still the
published version.

## Web

Inside P3's `/admission` area:

- `/admission/cycles/[id]`: the tie-break choice (with an example), per class the test fields.
- `/admission/cycle-classes/[id]/test`: tabs **Rolls** (issue, range), **Admit cards** (print),
  **Scores** (the grid, built on `MarkEntry`'s input and keyboard behaviour; absent toggle; Bangla
  digits), **Merit list** (build, the warnings, the draft table with outcomes, publish), **SMS**
  (preview with cost and cap, send, the run's status), **Waitlist** (move up).
- **Applicant admit card print:** two per A4 inside `.exam-print`, reusing `@page exam-a4` and the
  isolation rules: institute name (and logo when P2's profile has one), cycle and class, applicant
  name, application number, test roll (large, ASCII), photo when collected, test date, time and
  venue, "bring this card" note, a signature line (decision P4-K). Staff print only (P4-N).
- **Public status page** (P3's `/apply/[slug]/status`): after publish, the outcome, place or
  waitlist position, and the score out of full marks; before publish, the test roll, date, time and
  venue once rolls are issued.

## Files

| File                                                                                                          | Change                                     |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `packages/db/prisma/schema.prisma` + 3 migrations                                                             | enums, columns, trigger, lookup            |
| `packages/db/test/admission-rls.test.ts`, `admission-functions.test.ts`, `schema-safety.test.ts`              | new columns, trigger, lookup before/after  |
| `packages/shared/src/admission.ts` (+ `.test.ts`)                                                             | `admissionMerit`, `admissionResultSmsText` |
| `apps/api/src/admission/test.service.ts`, `merit.service.ts`, `result-sms.service.ts`, `admission.module.ts`  | routes and jobs                            |
| `apps/api/test/admission-test.e2e-spec.ts`, `admission-merit.e2e-spec.ts`, `admission-result-sms.e2e-spec.ts` | API tests                                  |
| `apps/web/src/app/(app)/admission/cycle-classes/[id]/test/**`, `components/admission/*`                       | pages and the admit card                   |
| `apps/web/src/app/(public)/apply/[slug]/status/*`                                                             | the result view                            |
| `apps/web/messages/admission/*`, `messages/apply/*`                                                           | strings                                    |
| `apps/web/e2e/admission-test.spec.ts`                                                                         | Playwright                                 |
| `docs/admission.md`, `database.md`, `decisions-pending.md`                                                    | docs                                       |

---

### Task 1: The columns, the trigger, the SMS purpose

**Files:** schema; migrations 1 and 2; `admission-rls.test.ts`.

- [ ] **Step 1: Write the failing tests:** a score above `full_marks * 100` → `check_violation`; an
      absent row with a score → CHECK error; `pass_marks > full_marks` → CHECK error; two rows with
      the same roll in a class → unique error; another institute's rows invisible (as P3); the app
      may not change `application_no` still.
- [ ] **Step 2: Run** (`pnpm --filter @jantrik/db exec vitest run test/admission-rls.test.ts`).
      Expected: FAIL.
- [ ] **Steps 3–4:** the schema and migrations; drift check; the db suite.
- [ ] **Step 5: Commit:** "Admission test columns: rolls, scores in hundredths within the full marks,
      merit places and published versions".

### Task 2: `admissionMerit` (pure)

**Files:** `packages/shared/src/admission.ts`, `admission.test.ts`.

- [ ] **Step 1: Write the failing tests** (review focus 1):
  - scores 90, 85, 85, 70 with `NONE` → places 1, 2, 2, 4;
  - the two 85s with `OLDER_FIRST` → the older one 2nd; with `YOUNGER_FIRST` → the younger 2nd;
    same date of birth → the earlier submission 2nd;
  - absent → `ABSENT`, no place; below pass marks → `FAILED`, no place; pass marks null → nobody
    fails;
  - `select_count` 2 with `NONE` and scores 90, 85, 85 → three SELECTED, `boundaryTie` 1;
  - `waitlist_count` 2 → positions 1 and 2, the rest `NOT_SELECTED`;
  - `select_count` 0 → everyone ranked is waitlisted or not selected;
  - the input order does not change the output (shuffled 100 times).
- [ ] **Steps 2–4.** **Step 5: Commit:** "The admission merit list: score, then the cycle's
      tie-break; shared places; the last selected place's ties all selected".

### Task 3: Test setup, rolls and admit cards

**Files:** `test.service.ts`, `admission.module.ts`, `apps/api/test/admission-test.e2e-spec.ts`; the
admit card component and page.

- [ ] **Step 1: Write the failing tests:**
  - setting the test on a cycle without `requires_test` → 422 `TEST_NOT_REQUIRED`;
  - rolls from 1001 for 3 SUBMITTED, 1 SHORTLISTED, 1 REJECTED → 1001–1004 by application number,
    the rejected one none; a late application then gets 1005; issuing again changes nothing
    (decision P4-C);
  - admit cards for a roll range, with the photo URL only when a photo exists; another
    institute's class → 404;
  - lowering full marks below an entered score → 409.
- [ ] **Steps 2–4**, plus the admit card print checked in Playwright's print emulation (two per
      page, A4) and a bn screenshot.
- [ ] **Step 5: Commit:** "Admission test setup, test rolls and printed applicant admit cards".

### Task 4: Scores and building the list

**Files:** `merit.service.ts`, `apps/api/test/admission-merit.e2e-spec.ts`, the Scores and Merit
tabs.

- [ ] **Step 1: Write the failing tests:**
  - scores typed as `৮৫.৫০` → 8550; `101` with full marks 100 → 422 `SCORE_OUT_OF_RANGE` and nothing
    saved in that request; a row without a roll → 422 `NO_ROLL`;
  - each change audited with old and new values (entity `admission_test_score`);
  - build with 2 rows missing → 422 `SCORES_MISSING {count: 2}`;
  - build writes `test_result`, places and waitlist positions, and **no status changes**;
  - review focus 5: build, then a score change, then publish with the old `builtAt` → 409
    `MERIT_STALE`.
- [ ] **Steps 2–4.** **Step 5: Commit:** "Admission test scores (audited) and the draft merit list".

### Task 5: Publish, the result SMS, the waitlist

**Files:** `merit.service.ts`, `result-sms.service.ts`, `apps/api/test/admission-result-sms.e2e-spec.ts`.

- [ ] **Step 1: Write the failing tests:**
  - publish → statuses as the draft, version 1, REJECTED rows carry their reason code; an audit
    row;
  - review focus 2: correct one score, rebuild, republish → version 2; the preview lists only the
    rows whose status changed; an ADMITTED applicant now below the line keeps ADMITTED and gets
    `result_flag`; a WITHDRAWN one is untouched;
  - review focus 4: 10 recipients, cap left 6 → preview `wouldBeSkipped: 4`; send → 6 QUEUED, 4
    skipped (no `HELD_OVER_LIMIT` rows); `PREVIEW_CHANGED` when a row changed between preview and
    send;
  - the relevance check: SMS of version 1 still queued after version 2 is published are cancelled;
  - move up: a SELECTED applicant withdraws → `move-up` makes waitlist 1 SELECTED, positions
    renumber, optional one SMS (preview count 1); with no free seat → 422 `NO_SEAT_FREE`; empty
    waitlist → 422 `WAITLIST_EMPTY` (decision P4-G);
  - a published SELECTED applicant can now be approved (P3's approve), a WAITLISTED one cannot.
- [ ] **Steps 2–4.** **Step 5: Commit:** "Publish the merit list, tell applicants by SMS (preview,
      cap, changed results only) and move the waitlist up".

### Task 6: The public result

**Files:** migration 3; `admission-functions.test.ts`; `schema-safety.test.ts` (snapshot);
`apps/web/src/app/(public)/apply/[slug]/status/*`.

- [ ] **Step 1: Write the failing tests** (review focus 3):
  - before rolls: the lookup has no `test` and no `result`;
  - after rolls, before publish (list built): `test` with roll, date, time, venue; no `result`, no
    score, no place;
  - after publish: `result` with the published outcome, place, score and full marks; after a
    correction is built but not republished: still version 1's values;
  - another institute's slug or a wrong phone → NULL (as P3);
  - `jantrik_admission` reads no column beyond the snapshot.
- [ ] **Steps 2–4**, the status page's result view (bn screenshot at 390 px).
- [ ] **Step 5: Commit:** "Applicants see their test details, then their published result, behind
      their phone code (S13)".

### Task 7: Pages, Playwright, docs, gates, review, PR

- [ ] **Playwright (CI):** an owner sets a test for a class, issues rolls, prints admit cards,
      enters scores with Bangla digits (one absent), builds, publishes, previews and sends the SMS
      (outbox), moves the waitlist up after a withdrawal; the applicant checks the result on the
      status page with a code.
- [ ] **Docs:** `docs/admission.md` (test, merit, publish, SMS, waitlist), `database.md`,
      `decisions-pending.md` (P4 section).
- [ ] Full gates; review subagent (database, SMS money, public lookup) with this plan's review
      focus; PR; CI green.

## Risks

- **Scores are entered by hand** for hundreds of applicants in a few hours after the test: the grid
  must be fast with a keyboard (`MarkEntry`'s behaviour) and save in chunks of 500.
- **A correction after SMS went out** means a second SMS to the affected applicants; the preview
  shows exactly who.
- **Seats exceeded by a boundary tie** (`NONE` only) are visible before publish, never silent.
- **Republishing after approvals** cannot undo an admission; staff resolve flagged rows by hand.

## Size

**M.** Three migrations (two tiny), one pure function, ~11 routes, one area of pages, five test
files. **One PR.**

## Self-review

- **Sprint plan coverage:** columns on classes and applications (Task 1); test rolls sequential per
  class from a start number (Task 3); admit cards with a fixed design, two per A4, the exams print
  CSS (Task 3); a marks grid with Bangla digits (Task 4); the merit order with the per-cycle
  tie-break, shared places, top `select_count` SELECTED and next WAITLISTED (Tasks 2, 5); publish
  and the public result with application number + phone code (Tasks 5, 6, S13); SMS with preview →
  send, `PREVIEW_CHANGED`, cost and cap (Task 5); waitlist move-up (Task 5); the sprint plan's tests
  (ties, absent unranked, republish after correction, the cap SKIP, nothing before publish).
- **Names:** `admissionMerit`, `admission_tie_break`, `admission_test_result`, `test_score_h`,
  `results_version`, `result_version`, `result_flag`, `ADMISSION_RESULT`, `MERIT_STALE`,
  `admissionResultSmsText`.

## Decisions for the owner

S12 and S13 stand. These are new, each with the recommended default.

| #    | Decision                                       | Recommended default                                                                                                                                                                    |
| ---- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P4-A | Tie-break choices per cycle                    | `OLDER_FIRST` (default), `YOUNGER_FIRST`, or `NONE` (shared places). With a date-of-birth tie-break, submission time comes next as the sprint plan says, so ties practically disappear |
| P4-B | A tie on the last selected place (`NONE` only) | Everyone tied there is SELECTED; seats are exceeded by that many and the build shows a warning before publish                                                                          |
| P4-C | Who gets a test roll, in what order            | SUBMITTED and SHORTLISTED applications, by application number; later applications get the next numbers; issued rolls are never renumbered                                              |
| P4-D | Below the pass marks, and absent               | Unranked: `FAILED` and `ABSENT`; pass marks empty means nobody fails                                                                                                                   |
| P4-E | When statuses change, and to what              | Only at publish: SELECTED, WAITLISTED, and REJECTED with the reason `NOT_SELECTED`, `FAILED` or `ABSENT`. Building is a draft                                                          |
| P4-F | Republishing after a correction                | Allowed; the version goes up; ADMITTED applicants are never demoted (flagged for staff instead); SMS only to those whose status changed                                                |
| P4-G | Filling a freed seat                           | A staff action ("offer the next seat") that moves waitlist 1 to SELECTED, with an optional single SMS; not automatic                                                                   |
| P4-H | The result SMS text                            | Outcome, merit place or waitlist position, application number and the status page link; no score (the score is on the status page, behind the code)                                    |
| P4-I | Score precision                                | Two decimals (hundredths), full marks up to 1 000, as the exams module                                                                                                                 |
| P4-J | Editing scores after publish                   | Allowed and audited; the list shows "changed since publish" until rebuilt and republished                                                                                              |
| P4-K | The applicant admit card                       | A fixed design: institute name and logo (P2), cycle, class, name, application number, roll, photo (when collected), test date, time and venue, a note, a signature line                |
| P4-L | Who runs the test                              | OWNER and ADMIN only (teachers entering scores can come later with a role choice)                                                                                                      |
| P4-M | What the status page shows before publish      | Nothing about results; the test roll, date, time and venue once rolls are issued                                                                                                       |
| P4-N | Printing admit cards                           | Staff print them; applicants cannot print their own from the status page in this phase                                                                                                 |

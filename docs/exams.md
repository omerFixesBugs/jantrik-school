# Exams and results

Module `EXAMS` (every route has `@RequireModule('EXAMS')`). API:
[`apps/api/src/exams`](../apps/api/src/exams). Pure rules:
[`packages/shared/src/exams.ts`](../packages/shared/src/exams.ts) and
[`exams-results.ts`](../packages/shared/src/exams-results.ts). Web:
[`apps/web/src/app/(app)/exams`](<../apps/web/src/app/(app)/exams>),
[`apps/web/src/components/exams`](../apps/web/src/components/exams) and
[`apps/web/src/lib/exams`](../apps/web/src/lib/exams). Tables and RLS: [database.md](database.md).
Choices that are still to be checked against a real marksheet:
[decisions-pending.md](decisions-pending.md) (#31–#38).

## Rules are data

Nothing Bangladesh-specific is an `if` in code. It lives in rows the institute can change:

- **Grading scheme** (`grading_schemes`, `grade_bands`): the bands, the percentage rounding
  (`rounding_mode`: NONE, ROUND_HALF_UP, CEIL), and the GPA rules: `gpa_max` (5.00),
  `optional_bonus_above` (2.00; NULL means the 4th subject adds nothing), `gpa_decimals` (2),
  `gpa_rounding` (TRUNCATE by default, or ROUND_HALF_UP) and `compulsory_fail_zero` (true). The
  band whose grade point is 0 is the fail band. Bands are read-only in this release.
- **Subject parts** (`subject_components`): key (`CQ`, `MCQ`, `PRACTICAL`, `P1_CQ`…), kind (`CQ`,
  `MCQ`, `PRACTICAL`, `WRITTEN`, `ORAL`, `OTHER`), full marks and pass marks.
- **Pass rule** per subject (`subjects.pass_rule`):
  - `PER_COMPONENT`: every part reaches its own pass mark.
  - `COMBINED`: parts of the same kind are added across papers and checked against that kind's
    combined pass mark (`subject_pass_groups`): P1_CQ + P2_CQ against the CQ mark, P1_MCQ +
    P2_MCQ against the MCQ mark. A kind without a group is not checked. The API refuses a kind
    with no group, and a combined pass mark above that kind's summed full marks.
  - Under either rule, being absent in any part fails the subject.
- **Templates:** the NCTB 6–10 template carries default parts, pass rules and combined marks;
  new institutes get them at provisioning, existing ones with **Fill in NCTB defaults** (fills only
  subjects that have no parts). The defaults table is in decisions-pending #38.

## Exams

An exam belongs to one academic year: kind (half-yearly, annual, pre-test, test, class test,
model test, other), a date range inside the year, a result mode (`GPA` or `MARKS`) and its merit
order. It covers some classes (`exam_classes`), each with its subjects (`exam_subjects`), which
copy the subject's parts, pass rule and elective flag when chosen. The copy is the exam's own:
changing the subject later never changes an exam that has marks.

- **States:** `SETUP` → `OPEN` (the roster is taken, marks can be entered) → `ARCHIVED` (nothing
  changes; published results stay). An archived exam can be reopened. Only a `SETUP` exam can be
  deleted.
- **Parts are fixed once marks exist** (409 `MARKS_EXIST`); a DB trigger also refuses lowering a
  part's full marks under a saved mark.
- **Roster** (`exam_candidates`): opening the exam takes every enrolled student of the covered
  classes, with their section, group and roll. **Sync** (preview, then apply) adds newcomers,
  withdraws leavers (their marks are kept but left out of results) and follows section changes.
  Exams never use `currentSection`, so last year's annual can be published in January.
- **4th subject:** subjects with `is_optional` form the class's elective pool. Per student and year
  (`student_subject_choices`) the admin records which pool subjects they take and which one is the
  4th (at most one `OPTIONAL`). A pool subject without a choice is not taken. The publish check
  warns about students with no choice.

## Who enters marks

- **Subject teachers** (`section_subject_teachers`): per section and subject, up to five people
  with an active TEACHER, ADMIN or OWNER membership. A teacher enters marks only for their own
  subject and section (403 `NOT_ASSIGNED`); being the class teacher is not enough. The setup
  screen can give every subject of a section to its class teacher in one step.
- **OWNER/ADMIN** can open and correct any sheet.
- **Printing:** every teacher of a section (`section_teachers`) can print its tabulation and report
  cards; only its class teacher (or OWNER/ADMIN) writes remarks. Subject-only teachers get neither.
  The web shows the results screens to OWNER/ADMIN in this release.

## Mark sheets

One sheet per exam subject and section (`exam_mark_sheets`), created on the first save.

- **Marks are integer hundredths** (`exam_marks.score_h`, like paisa); at most two decimals.
  `parseMarks()` accepts Bangla or ASCII digits; `a`, `ab` or `অ` means absent; empty means not
  entered. Absent counts 0 and fails the subject; all parts absent shows the subject as absent.
- **States:** `DRAFT` → `SUBMITTED` → `LOCKED`.
  - The teacher can fix and resubmit until the sheet is locked; editing a submitted sheet puts it
    back to draft. A sheet with blanks cannot be submitted (422 `INCOMPLETE` with the count).
  - OWNER/ADMIN return a sheet with a note (back to draft), lock it, lock all submitted sheets of
    a class, or unlock it with a reason.
  - After lock only OWNER/ADMIN change marks, through **corrections** with a reason.
  - A published class freezes its sheets: unlock refuses while results are published.
- **Saves are whole sheets and idempotent**, like an attendance register: `submissionId` (a retry
  of the last one is answered from the saved state, `replayed: true`, no audit row), `baseVersion`
  (stale → 409 `VERSION_CONFLICT` with the current sheet) and the roster (changed → 409
  `ROSTER_CHANGED`). A submit is a new request with its own `submissionId`.
- **Audit:** every save, submit, return, lock, unlock and correction writes one audit row with
  only the changed cells (old → new); corrections also store the reason and the published
  version. `GET /exams/sheets/:id/history` shows them.
- **Marks are never deleted** (no DELETE grant); only `score_h`, `absent` and who/when can change.

### Phone-first entry and drafts

The sheet screen ([mark-entry.tsx](../apps/web/src/components/exams/mark-entry.tsx)) lists the
students with one large field per part; on a narrow screen one part at a time (a segmented
control), on a wide one every part. Enter moves down the column, then to the next part. A live
preview shows each student's total and grade. Drafts follow the attendance register
([attendance.md](attendance.md)):

- every change is written to the phone at once (`localStorage`
  `jantrik.marks:<user>:<tenant>:<examSubjectId>:<sectionId>`, ids, roll and names only) with a new
  `submissionId`, and saved to the server 3 s after typing stops, on blur and when the tab is
  hidden;
- a failed save retries with backoff; the pill shows "kept on this phone" or the retry countdown;
- a conflict offers keep mine or keep theirs. It is resolved silently only when the server holds
  exactly what one of this phone's unanswered saves carried (the draft remembers the last five);
  marks saved meanwhile by someone else, or by the same teacher on another device, are never
  overwritten unasked;
- a draft left on the phone is used only while the sheet can be entered (not when locked or
  archived). If the sheet moved on since, it is dropped when it holds nothing new, resumed when the
  server holds one of its own unanswered saves, and otherwise shown as a conflict;
- marks typed while a save is on its way are kept whatever its answer; when the roster changed the
  sheet is reloaded, so a student who moved in keeps the marks already entered for them;
- "Send now" retries at once;
- Submit is never disabled by a save in flight: a submit tapped during a save is sent right after
  it, kept across a retry and on the phone (leaving the page before the save answers still
  submits next time); each submit has its own `submissionId`;
- the connection screen counts marks drafts next to attendance drafts.

## Results

- **Subject result** (`subjectResult`): any absent part → F; under `PER_COMPONENT` any part under
  its pass mark → F; under `COMBINED` any kind's sum under its combined mark → F; otherwise the band
  of the total percentage. Pass checks compare the raw marks (22.5 of 70 against 23 fails).
- **GPA mode** (`studentResult`): with `compulsory_fail_zero`, any compulsory F gives GPA 0 (F).
  Otherwise GPA = (Σ compulsory points + max(0, 4th-subject point − `optional_bonus_above`)) ÷
  number of compulsory subjects, capped at `gpa_max`, then cut to `gpa_decimals` with
  `gpa_rounding`, all in integers. A failed 4th subject adds nothing and never fails the student.
  The letter comes from the shown GPA. The GPA without the 4th subject and the total including it
  are kept too.
- **MARKS mode** (coaching model tests): total, full marks and percentage; no GPA or letter. A
  subject passes when every part with a pass mark is passed.
- **Merit** (`meritPositions`): the exam's `merit_order` keys (`GPA`, `GPA_WITHOUT_OPTIONAL`,
  `TOTAL_MARKS`, `PERCENT`, `FEWER_FAILED_SUBJECTS`, `SUBJECT:<id>`, `ROLL`); GPA keys are ignored in
  MARKS mode. Default: passed first, then GPA (or total), then total, then the lower roll. Students
  tied on every key share the place (1, 2, 2, 4). Failed students are ranked after the passed ones
  or left unranked (`failed_ranking`). Places are given in the class and in the section.
- **Attendance on the report card:** the present % over the exam's window (`attendance_from/to`,
  prefilled from the day after the previous GPA exam, or the year start, to this exam's end), by
  the attendance module's rule; left out when ATTENDANCE is off.

### Publish

- **The publish check** (`GET …/publish-check`) lists blockers (sheets not locked, students with
  missing marks) and warnings (roster drift, missing 4th-subject choices).
- **Publish** (`POST …/publish` with `baseVersion`) needs every non-empty sheet locked. It
  computes the class in one pass and stores a **snapshot** (`exam_results`, one row per student,
  with the grading used in `exam_classes.grading_snapshot`), bumping `published_version`. Five
  concurrent publishes give one version (the exam class is locked FOR UPDATE; a stale `baseVersion`
  gets 409 `PUBLISH_CHANGED`). 600 students publish well inside the 15 s transaction.
- **Guardians, report cards and SMS read the snapshot**, so places never move silently. A
  correction or remark after publishing shows the class as "changed since publish" (computed:
  a sheet's `updatedAt` or a remark's time after `published_at`); republishing shows it.
- **Unpublish** needs a reason; guardians stop seeing the results.
- Before publishing, the tabulation is computed live and marked "preview".

### Lock order

Every marks write takes, in this order: the `exams` row FOR SHARE (setup changes and archive take
it FOR UPDATE), then the `exam_classes` row FOR SHARE (publish and unpublish take it FOR UPDATE),
then the sheet FOR UPDATE. Remarks take the exam (and require it OPEN) and the exam class FOR
SHARE. See `lockForMarks` in
[mark-sheet.service.ts](../apps/api/src/exams/marks/mark-sheet.service.ts).

## Printouts (browser print / Save as PDF)

- **Tabulation sheet** (`/exams/[id]/tabulation?class=&section=`): one row per student, every
  subject's marks and grade, total, %, GPA, place; A4 landscape with the header repeated. CSV with
  a BOM, ASCII digits and formula-safe cells; no phones or parents.
- **Report cards** (`/exams/[id]/report-cards?section=|student=`): Bangla first, A4 portrait, one per
  page (the named page `exam-a4` in `globals.css`). Institute, exam, student, ID, class, section,
  roll, group, photo; parents' names only where decision #19 allows (and to the guardian of their
  own child); each subject's parts, total, class highest, letter and point; total, GPA with and
  without the 4th subject, places, attendance, remarks, the grading key and signature lines. On a
  phone the parts go under the subject name.
- **Admit cards** (`/exams/[id]/admit-cards?section=`): two per A4 sheet with a cut line: student,
  room and seat, the student's own routine.
- **Seat plan** (`/exams/[id]/seats`): rooms (`exam_rooms`, rows × columns, at most 500 seats) are
  institute-wide; seating alternates classes column by column over the chosen rooms (409
  `CAPACITY_SHORT` with the shortfall); printed per room.

## Guardians

`GET /me/children/:id/results` (published only, newest first) and
`GET /me/children/:id/results/:examClassId` (the report card). Someone else's child, or results
that are not published, → 404. The dashboard's child card shows the latest result; the card page
prints on one A4 page.

## Result SMS

A manual action after publishing, never automatic.

- `POST …/sms/preview`: students, without a phone, already sent for this version, to send,
  segments, cost, today's cap left and how many would be skipped.
- `POST …/sms` with `expectedRecipients` (409 `PREVIEW_CHANGED` if the preview moved) → 202 with a
  run id; `GET /exams/result-sms/:runId` shows the counts.
- The job (queue `exams`, `send-result-sms`) queues one SMS per student to the primary guardian
  through `TenantSmsService.queue` in chunks of 25, with dedupe
  `exam-result:<examClassId>:v<version>:<studentId>`.
- **Over the daily cap a result SMS is skipped, not held** (`overCap: 'SKIP'`): a held message's
  dedupe key could never be sent again. Skipped students can be sent another day.
- The relevance check cancels a queued SMS if the class was unpublished or republished meanwhile.
- The text is fixed Bangla (`resultSmsText`): GPA and letter, or marks and %, and the class place.

## Tests

- Pure rules: `packages/shared/src/exams.test.ts`, `exams-results.test.ts` (GPA edge cases,
  COMBINED, rounding, merit ties).
- Tables: `packages/db/test/exams-*-rls.test.ts` (isolation, grants, triggers).
- API: `apps/api/test/exams-*.e2e-spec.ts` (roles, assignments, drafts, lock and corrections,
  publish, guardians, SMS, privacy).
- Browser: `apps/web/e2e/exams.spec.ts` (bn and en: a teacher at 360 px, the office at 1366 px, a
  guardian at 390 px, PDFs and CSV), plus the exam screens in `layout`, `themes` and `numerals`.

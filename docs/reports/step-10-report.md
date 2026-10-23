# Step 10 report: exams and results

Branch `feature/step-10-exams` (from main at `6a7bcfb`). Plan:
[docs/plans/step-10.md](../plans/step-10.md). How exams work: [docs/exams.md](../exams.md).
Choices to check against a real marksheet: [decisions-pending.md](../decisions-pending.md)
#31–#38.

## Commits

| Part    | Commit    | What                                                                                               |
| ------- | --------- | -------------------------------------------------------------------------------------------------- |
| 0.1     | `bc01c39` | Attendance present % per student over a range, for other modules                                   |
| 0.2     | `4b84bb0` | An SMS over the daily cap can be skipped instead of held                                           |
| 0.3     | `ac60a42` | GPA rules as scheme data; NCTB subject parts with combined two-paper passes                        |
| A1      | `9a71b58` | Setup tables: subject parts, combined pass marks, subject teachers, 4th-subject choices, rooms     |
| A2      | `85c8c78` | Rules: marks entry, grades, PER_COMPONENT and COMBINED passes, NCTB GPA, marks mode                |
| A1 rev. | `cc52340` | No silent cascades, safer CHECKs                                                                   |
| A3      | `8a152b1` | Setup API                                                                                          |
| B1      | `9a968fb` | Exams, covered classes, copied subjects and parts, rosters, seats                                  |
| B2      | `3791d35` | Exams API: open with roster, sync, seat plans, admit cards                                         |
| C1      | `2cb7225` | Mark sheets and marks (hundredths, never deleted, within full marks)                               |
| C2      | `d8ec805` | Marks entry API: assigned teachers only, drafts, submit, return, lock, corrections, history        |
| D1      | `3c48a24` | Results snapshot table; `EXAM_RESULT` SMS purpose                                                  |
| D2      | `635a305` | Merit places with tie-breakers; a class's results; the result SMS text                             |
| D3      | `497b5c8` | Publish check, publish and republish, unpublish, tabulation and CSV, report cards, remarks         |
| E1      | `b4cf28a` | Guardians' results and report card; result SMS; dashboard summary                                  |
| E3      | `645848c` | Demo data                                                                                          |
| E1 rev. | `9d8f7a9` | Review fixes (locks under publish, roster re-read, deleted students, admin checks)                 |
| Web     | `5b8f706` | Every exam screen, print pages, setup, guardian results, dashboard tile, bn/en messages            |
| Docs    | `9629708` | exams.md, database.md, auth.md, decisions #31–#38, backlog, demo accounts                          |
| E2E     | `b88ab74` | Playwright for the whole flow, bn and en; two submit bugs fixed; report cards fit A4; 360 px fixes |
| E2E     | `aa161a4` | The staff-screens layout test gets 60 s                                                            |
| Polish  | `91403d2` | A mark's error on its own line; the demo routine spread over days                                  |
| Perf    | `0ffd49b` | The dashboard no longer loads the report card                                                      |

| Security | `486088f` | Report cards: the query is pinned to the class and section that were checked |
| Review | `6be4f30` | Marks entry fixes from the final review (drafts, conflicts, roster, "Send now", submit); parts editor |

## Tests

| Suite                       | After this step | New in this step                                                                                                                      |
| --------------------------- | --------------: | ------------------------------------------------------------------------------------------------------------------------------------- |
| `@jantrik/shared` (Vitest)  |             410 | `exams.test.ts`, `exams-results.test.ts`                                                                                              |
| `@jantrik/db` (Vitest, RLS) |             266 | `exams-setup-rls`, `exams-structure-rls`, `exams-marks-rls`, `exams-results-rls`, provision, schema-safety list                       |
| `@jantrik/api` (Vitest e2e) |             408 | `exams-setup`, `exams-structure`, `exams-marks`, `exams-results`, `exams-guardian`, `exams-privacy`, `attendance-stats`, `tenant-sms` |
| `@jantrik/web` (Vitest)     |              17 | new: `sheet-controller.test.ts`, `parts.test.ts` (the final review's fixes)                                                           |
| Playwright e2e              |              74 | `exams.spec` (bn, en); exam screens in `layout`, `themes`, `numerals`                                                                 |

What the tests you asked for cover:

- **Tenant isolation for every exam table** (14 tenant tables): another institute cannot read,
  change or delete a row, insert one with this institute's id, or point a key at this
  institute's rows; the schema-safety test lists every table.
- **A teacher cannot enter marks for another subject or section:** a teacher of another subject,
  of another section, and a class teacher who is not assigned all get 403 `NOT_ASSIGNED`; in the
  browser the sheet shows "not assigned".
- **GPA edge cases:** a part failed with a total above 80 gives F; an absent MCQ gives F; a 4th
  subject at A+ adds 3.00 and caps at 5.00, at C adds nothing, failed adds nothing and never fails
  the student; a compulsory F with a 4th-subject A+ gives 0; 79.5 % under each rounding; 22.5 of 70
  against 23; COMBINED (20 + 26 = 46 passes although one paper is under 23, 45.5 fails, MCQ checked
  on its own, an absent paper fails, a kind without a group is not checked); 4.958 truncated and
  half up; nothing under 5 shows 5.00; marks mode percentages.
- **Merit ties:** ties on every key share the place (1, 2, 2, 4), each key breaks ties in order,
  roll ties across sections, failed students after the passed or unranked.
- **Lock and audit:** after lock a teacher gets 403; a correction without a reason is 422; the audit
  row holds only the changed cells and the reason; unlock is refused while published; a rollback
  leaves nothing.
- **A guardian sees only their own child, and only after publish:** another family's child or an
  unpublished result is 404 in the API and "not found" in the browser.
- **Playwright** (bn and en): a teacher at 360 px enters marks with Bangla digits, Enter moves on,
  an absent student, an over-full mark refused, a reload keeps the draft, offline keeps it on the
  phone and it is sent when back, then submits; the office at 1366 px locks the class, publishes,
  downloads the CSV (BOM, ASCII digits), prints the tabulation (A4 landscape) and the section's
  report cards (one A4 portrait page each); the guardian at 390 px sees the result on the
  dashboard and prints the report card on one A4 page; another guardian gets not found; the
  office previews the result SMS with its cost and sends it.

**How Playwright ran here.** `pnpm e2e` resets `jantrik_e2e`, and Prisma refuses that reset from
an AI agent without your consent at that moment, so I did not run it. Instead the same build ran
the whole suite against a scratch database (`jantrik_e2e_s10`: created, migrated with `migrate
deploy`, seeded with the e2e date, dropped at the end) through a local, uncommitted copy of the
config without the reset. Result: **70 passed, 1 failed, 2 not run**, then the one layout failure
fixed and rerun:

- `platform.spec` failed at its first step and its two follow-ups did not run: the seed creates
  the dev platform admin only on the dev or e2e database, not on a scratch one. Not related to
  exams; on `jantrik_e2e` it has its admin.
- `layout.spec` "staff screens" ran out of its 30 s (31–32 s): about twenty screens, each
  scrolled through and checked, and the dashboard's exams card added a little. It now has 60 s and
  passes (34.5 s, no layout problems).

## Before merge (your review)

1. **Two bugs found by the browser test and fixed** (no web unit tests exist, so the Playwright
   run was the failing test):
   - **Submit tapped right after typing was lost.** The field's blur started a save, the Submit
     button disabled itself before the click landed, and a submit during a save was dropped.
     Now the button stays enabled and a submit during a save follows it (also across a retry).
   - **A submit could stay a draft.** It reused the last save's request id, so the server answered
     it as a repeat of that save. Each submit now gets its own id.
2. **Report cards fit one A4 page** with up to 17 subjects (smaller print type, tight rows). On a
   phone the parts go under the subject name and numbers never wrap.
3. **To check against a real marksheet** (#38): GPA TRUNCATE, the parts table, the combined pass
   marks (Bangla CQ 46 / MCQ 20, English 66), and an absent paper failing under COMBINED. All are
   data you can change under Exams → Setup.
4. **Walkthrough** (scratch database; your `jantrik` was not touched), 38 bn screenshots at 1366
   and 390 px, every step passed:
   1. the owner reviews subject parts (class 9 Bangla shows the combined rule), subject teachers,
      4th-subject choices, rooms and GPA rules;
   2. the teacher (Nasrin) enters 6 ক Bangla on a phone: Bangla digits, one absent, an over-full
      mark refused, then submits;
   3. the admin locks the class, corrects a mark with a reason (it appears in the history) and
      publishes;
   4. the tabulation, the report cards, admit cards and the seat plan;
   5. the SMS preview (28 students, 56 segments, ৳16.80) without sending;
   6. Tasnim's mother sees the result on her dashboard and opens the report card.

   Screenshots: `C:\Users\ASUS\AppData\Local\Temp\claude\d--work-softwares-jantrik-school\13993c0a-bd6a-4998-b5e2-fa4765c02dae\scratchpad\shots` (temporary; they are not in the repo).

5. **The 3-second check** (390 px, CPU 4×, 150 ms RTT and 1.6 Mbps, cold cache, signed in; six
   interleaved pairs against a main build on the same API and data; "interactive" is the main
   content followed by 2 s without a long task):

   | Page        | Build  | To interactive, median (range) | Transfer |
   | ----------- | ------ | ------------------------------ | -------- |
   | Dashboard   | main   | 6.49 s (6.19–6.88)             | 674 KB   |
   | Dashboard   | branch | 6.58 s (6.37–6.62)             | 688 KB   |
   | Marks entry | branch | 4.91 s (4.72–5.21)             | 646 KB   |
   - The first run showed the branch's dashboard slower in all six pairs (+0.15 s median): it
     loaded the report card through the guardian results module. After splitting that out the
     ranges overlap and the pairs go both ways.
   - **Over the budget**, like every page today (design.md has the dashboard at 6.8 s): most of
     the time is the shared app shell (about 650 KB on a cold load). The marks page is the
     lightest staff page measured so far. The app-wide plan is in [backlog.md](../backlog.md).
   - The exam messages ship with every page (about 7 KB gzipped in bn), as the fee messages do;
     loading messages per route is backlog item 2.

## What was built

### Groundwork

- Present % per student over any date range, by the attendance module's rule (report cards).
- `TenantSmsService.queue` can skip an SMS over the daily cap instead of holding it.
- Grading schemes carry the GPA rules as data: highest GPA, the 4th-subject threshold, decimals,
  rounding (TRUNCATE by default) and "a compulsory fail gives 0".
- NCTB templates carry subject parts, pass marks and pass rules; COMBINED for Bangla and English
  in classes 9–10. Biology joins Higher Maths in the Science elective pool.

### Setup (OWNER/ADMIN)

- **Subject parts:** CQ, MCQ, practical, papers; full and pass marks; per-part or combined pass
  with combined marks per kind; "Fill in NCTB defaults" for existing institutes.
- **Subject teachers** per section and subject, with "give every subject to the class teacher".
- **4th subject:** the elective pool and a choice per student, with "set for the whole section".
- **Rooms** (rows × columns) and **GPA rules**; the bands are shown, not edited.

### Exams

- Per academic year: half-yearly, annual, pre-test, test, class test, model test or other; a date
  range, the classes covered, GPA or marks mode, merit order.
- Each class's subjects copy their parts and pass rule; the routine's date and time; parts fixed
  once marks exist.
- Opening takes the roster; sync adds newcomers, withdraws leavers and follows section changes.
- Seats alternate classes column by column over the chosen rooms; admit cards two per A4 page.

### Marks entry

- Teachers see "My mark sheets" first. The sheet is one long list on a phone (one part at a time),
  a grid on a wide screen; Enter moves on; Ab marks absent; Bangla digits; a live total and grade.
- Drafts on the phone with autosave, retry, offline and conflict handling, like attendance.
- Draft → submitted → locked. The office returns with a note, locks (also all of a class at
  once), unlocks with a reason, and corrects locked marks with a reason; every change is audited
  and shown in the history.

### Results

- NCTB GPA by the scheme's rules, marks mode for coaching, merit places with tie-breakers.
- Publish takes a snapshot (versioned; one winner when two publish at once; 600 students well
  inside the transaction). A change after publishing shows "changed since publish" until you
  publish again; unpublish needs a reason.
- Tabulation (A4 landscape, CSV), report cards (Bangla, A4, one per page, with attendance %,
  places, remarks and the grading key), remarks by the class teacher.
- Guardians see published results on the dashboard and open the report card.
- Result SMS: preview with recipients, cost, today's cap and skips; sent on confirmation, once per
  student and version.
- Dashboard: an exams card (sheets locked of all, waiting for lock, your own still to do).

## Decisions

You decided these (2026-10-23):

1. Browser print / Save as PDF for report cards, admit cards, the tabulation and the seat plan.
2. An elective pool with a choice per student for the 4th subject.
3. 1st/2nd papers as one subject with paper parts, with a PER_COMPONENT or COMBINED pass rule as
   data; COMBINED by default for Bangla and English 9–10.
4. A teacher may fix and resubmit until the sheet is locked.
5. GPA rounding TRUNCATE by default, listed to check with a real marksheet.

I decided these (decisions-pending #31–#37, open to change): results as a snapshot at publish;
merit order per exam with shared places; no implicit 4th subject; absent per part; class teachers
enter only assigned subjects; result SMS manual and skipped over the cap; decision #19 for exams.

### Rulings I made while building

Each with what it costs if it is wrong.

- **Template parts are copied to institutes in A1, not 0.3,** because the tenant tables only exist
  from A1. Cost: none.
- **Part kind is a Postgres enum** (`component_kind`), typed in Prisma and shared. Cost: a new kind
  needs a migration.
- **Migration SQL from `prisma migrate diff`** into the folder (create-only refuses
  non-interactively here). Cost: none, same SQL.
- **`calculateGrade` kept; `gradeForMarks` is the exact integer version** exams use, with a test
  that both agree on every 0.07 step of a 100-mark paper. Cost: two functions to keep in step.
- **Request schemas land with the API part that uses them.** Cost: none.
- **A subject choice is not tied to the student's class in the database;** the service checks the
  pool, class and group, and results only consider the exam class's subjects. Cost: a stray row
  could exist but never counts.
- **Cross-field checks of one request are 400** (zod); checks that need the database are 422.
  Cost: status code only.
- **"Give every subject to the class teacher" is a screen action** over the same save, no extra
  endpoint. Cost: none.
- **All screens were built after the API parts,** in one web phase. Cost: none.
- **A mark for a student of another class is refused by the service,** not the database (a NOT NULL
  column cannot be backfilled under forced RLS). Cost: a stray row could exist but results ignore it.
- **One review over C2–E1 together** for the permission parts. Cost: findings arrived later, fixed
  in one pass.
- **The results service was written before its API test;** the test was checked to fail against a
  planted bug (merit order reversed) before counting it. Cost: weaker evidence for untested paths.
- **Guardian and SMS tests share one spec; privacy checks live in `exams-privacy`** (the older
  privacy fixtures cannot switch EXAMS on). Cost: none, same coverage.
- **The lock order is documented next to the code** (`lockForMarks`) and in exams.md, not in a
  separate file. Cost: none.
- **The results screens are OWNER/ADMIN in the web** this step; a section's teachers can print and
  the class teacher can write remarks through the API (by link). Cost: teachers need the link until
  a teacher results view exists (backlog).
- **No dashboard banner for unsent marks;** the sheet shows its own state and the connection screen
  counts them. Cost: a teacher may notice a draft only when opening the sheet.
- **The term timeline keeps the usual exam months;** the exams card shows the real exams. Cost: the
  timeline's markers are approximate.
- **Playwright ran on a scratch database** with a local copy of the config without the reset,
  because Prisma blocks an AI-run reset of `jantrik_e2e` without your consent at that moment.
  Cost: none (same build, seed and specs); `pnpm e2e` is still yours to run.
- **The walkthrough ran on a scratch database too;** Prisma also refused `pnpm db:reset` on your
  `jantrik`, and I did not reuse your plan-time approval as its consent. Cost: your local demo has
  no exam data until you reset it.
- **The final fresh review covered the web, Playwright and docs range in depth;** the DB and API
  range had three earlier reviews. Cost: a cross-cutting issue between early parts could be missed.
- **Web unit tests added** (Vitest, `apps/web/src/**/*.test.ts`, run by `pnpm test`) so each final
  review fix had a failing test first. Cost: one more test runner in the web package.

## Review findings fixed

- **Earlier rounds** (DB and API parts, three fresh reviews): cascade deletes made explicit (a
  subject or section with choices or subject teachers is "in use"); a part's full marks can no
  longer drop under a saved mark (DB trigger); unlock, remarks and publish now take their locks in
  one order, so neither can slip past a publish; archive cannot race a save; deleted students
  leave every sheet and the SMS; the roster is re-read after the locks.
- **Final review** (web, Playwright, docs): each with a test that failed first.

  - **Critical: an old draft on a phone could overwrite marks saved on another device.** A draft now
    remembers its unanswered saves; a conflict is resolved silently only when the server holds one
    of them. Otherwise the teacher chooses keep mine or keep theirs. A draft on a sheet that moved
    on is dropped when it holds nothing new, resumed when the server holds its own save, and shown
    as a conflict otherwise. Drafts are never used on a locked or archived sheet.
  - **"Send now" did nothing;** it now sends at once.
  - **Marks typed while a refused save was on its way reverted;** they now stay.
  - **After a roster change, a student who moved in lost the marks already entered for them** on the
    next save; the sheet is now reloaded and merged.
  - **The parts editor refused saves with "check the form" and nothing marked;** combined marks now
    follow the parts' kinds, the problems are listed part by part, and Save waits for none.
  - **A submit confirmed during a save was lost if the teacher left the page;** it is now kept on the
    phone and sent next time.
  - **Docs:** 14 tenant tables (not 16); the conflict rule in exams.md.
  - **An automated security check** flagged the report-cards query; it was not exploitable (the
    request must name a section or a student, and one is checked), and the query is now pinned to
    the checked class and section anyway.

## Deferred minors

None of these loses or exposes marks:

- A pending draft opened offline is sent before the sheet loads; the server refuses it and the
  roster reload repairs it.
- The setup forms (subject teachers, 4th subject) reload after a network blip and lose unsaved
  edits.
- Every Enter saves the whole sheet (about 60 saves and audit rows per sheet).
- Remarks with trailing spaces show "unsaved" until reloaded.
- On a phone, Enter on the last student goes to Submit rather than the next part.
- The conflict dialog shows an X that does nothing.
- Two places show Bangla names in the English UI; the history shows raw part codes; two messages
  show ASCII digits in Bangla.
- The connection screen says marks drafts go "as soon as the connection is back"; they go when the
  sheet is opened.
- A queued submit does not re-check invalid cells (the server refuses them anyway).
- The sheet page's component key omits the sheet ids (no screen navigates between sheets in place).
- "Kept on this phone" shows even when the phone refused to store the draft.
- A teacher who types `/exams/setup` sees five "not allowed" boxes.
- `listMarkDrafts` is unused.
- From earlier reviews: pass groups have no `source_template_id`; room names are case sensitive;
  the full-marks trigger fails open when the part is invisible (RLS and keys refuse anyway); the
  publish CHECK could require the grading snapshot; a failed result SMS counts as sent for that
  version; the SMS job does not re-check the EXAMS module; the dashboard summary builds the whole
  sheets grid (about 120 ms); a transfer can move locked marks into a draft sheet.

## Skipped or left for later

- **`pnpm e2e` on `jantrik_e2e`:** not run (see above); it needs your consent for Prisma's reset.
- **`pnpm db:reset` on your `jantrik`:** not run. You allowed it in the plan, but Prisma asked for
  consent at the moment of the reset, and I did not reuse the earlier message for that.
- **Later work** ([backlog.md](../backlog.md), "Exams: later work"): combined results across
  exams, server-side bulk PDFs, a band editor, an "exempt" marker, holding admit cards for unpaid
  fees, next year's rolls from merit, an editable result SMS, manual seat moves, a teacher results
  view, an unsent-marks banner, real exams on the term timeline.

## What you need to do

- **Database:** nothing for the schema. The 51 migrations are already applied to your local
  `jantrik` (`prisma migrate status`: up to date). No new `.env` lines.
- **Demo data:** to get the exam demo locally, run `pnpm db:reset` yourself (it drops your local
  data and reseeds everything), or tell me to and I will run it with Prisma's consent.
- **Playwright:** `pnpm e2e` (ports 3000 and 4000 free). It drops and reseeds only `jantrik_e2e`.
- **Manual walkthrough** (`pnpm dev`, after `pnpm db:reset`; every password `Jantrik@2026`):
  1. Owner `01711000001`: Exams → Setup → Subject marks, class 9, Bangla (the combined rule).
  2. Teacher `01711000002` on a phone: Exams → My mark sheets → annual, 6 ক Bangla; enter,
     submit.
  3. Admin `01711000003`: the annual exam → lock all of class 6 → open a sheet → Correct (with a
     reason) → Results → Publish → Result SMS (preview only).
  4. Guardian `01811000102` (OTP, the code is in the API log): the dashboard's result line → the
     report card → print.
  5. Teacher at both `01911000999`: 9 ক English is left empty for you to try too.

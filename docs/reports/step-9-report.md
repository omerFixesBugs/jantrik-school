# Step 9 report: fees (phases 0 and A–E)

Branch `feature/step-9-fees` (from main at `3f128a4`; pushed, not merged). Plan:
[docs/plans/step-9.md](../plans/step-9.md). How fees work: [docs/fees.md](../fees.md). The bKash
gateway (phase F) is not built; its plan is in [docs/backlog.md](../backlog.md).

## Commits

| Part  | Commit    | What                                                                                      |
| ----- | --------- | ----------------------------------------------------------------------------------------- |
| 0     | `9e752f9` | Background jobs can audit without a person; the SMS cap for other modules                 |
| A1    | `0c6a785` | Setup tables: heads, terms, amounts, concessions, confirmed families                      |
| A2    | `9496c6f` | Fee rules in `@jantrik/shared`: periods, the dues plan, fines, allocation, words          |
| A1    | `ae287ed` | Setup tables after review: column grants, sibling pair check, free group prices           |
| A3    | `1c98dc6` | Setup API: settings, heads, terms, amounts, concessions, families, search                 |
| A3    | `0454f8e` | Accountants search by a whole phone number only                                           |
| B1    | `5322df2` | Dues and fine waiver tables                                                               |
| B2    | `9bb249a` | Dues generation, the student ledger, cancel and fine waivers                              |
| C1/C2 | `ef52d93` | Payments, allocations and the gap-free receipt counter; fee SMS purposes                  |
| C3/C4 | `8599351` | Counter API: collect cash, receipts, receipt SMS, void, daily closing                     |
| C1    | `bcc4beb` | Money tables after review: allocations checked at commit, tighter keys, final cancels     |
| D1    | `529efdf` | bKash/Nagad tables; fee keys never cascade; stronger allocation and cancel checks         |
| D2    | `d7ca72b` | bKash/Nagad API: the institute's numbers, TrxID submissions, verify/reject, guardian view |
| C     | `36c72e8` | Counter after review: closings that never change, background bulk work, safer recalc      |
| E1–E3 | `3bf477d` | Reports, due reminders and the dashboard card API                                         |
| A6    | `daa1135` | Demo seed: Shapla's fees, an admin, an accountant, a teacher who collects fees            |
| C5/B3 | `80ef115` | Screens' foundation: tabs, money field, receipt and its print pages, messages             |
| A5    | `0d91e41` | Tests: a teacher who also collects fees (TEACHER + ACCOUNTANT)                            |
| -     | `6670f57` | Docs: fees, the deferred gateway                                                          |
| A6    | `210be3e` | Demo seed: students admitted when the demo year began                                     |
| D2    | `75d0038` | A change to a number that does not name the label keeps it                                |
| C5/B3 | `9548372` | Counter screens: find a student, ledger, collect, receipt, daily closing                  |
| A4/A5 | `991df86` | Setup screens; one step to let a teacher collect fees                                     |
| D3/E  | `fae9ccf` | bKash/Nagad review, reports, reminders, dashboard card and guardian screens               |
| -     | `756648a` | Playwright: the counter, bKash/Nagad verification, a teacher who collects fees            |
| -     | `5ac0c23` | Format the bKash/Nagad API test                                                           |
| Final | `c798abc` | Final review: receipts print on their own page, cash in hand, fresh screens               |
| -     | `085f52f` | This report and the plan                                                                  |
| Merge | `dd230ac` | Tests: only an admin links or unlinks a family; unlinked, the discount ends               |
| Merge | `828c526` | The dashboard's overdue and the due list count only students still here                   |
| Merge | `d49ac23` | A guardian's retried bKash/Nagad submission returns the saved one                         |
| Merge | `9682908` | E2E on a fixed day: no test depends on the real date or weekday                           |
| Merge | `2940c0d` | Receipt: the receipt number, student ID and roll never break in the middle                |
| Merge | `584623a` | E2E: higher general request limits for the test API                                       |
| Merge | `836257d` | This report, updated before merge                                                         |
| Merge | (this)    | The guardian's fee page keeps the student ID whole; the report's commit list              |

Every part ran its own tests (shared unit, database RLS, and that part's API file) before its
commit. A separate review agent checked every migration and the money parts (C1, C3/C4, D1/D2),
and a fresh reviewer checked the whole branch at the end. Their findings were fixed in the
"after review" commits; see "Review findings fixed" below.

## Tests

| Suite                       | After this step | New in this step                                                                                      |
| --------------------------- | --------------: | ----------------------------------------------------------------------------------------------------- |
| `@jantrik/shared` (Vitest)  |             337 | `fees.test.ts`, `dates.test.ts` (the fixed test day)                                                  |
| `@jantrik/db` (Vitest, RLS) |             216 | `fees-setup-rls`, `fees-dues-rls`, `fees-payments-rls`, `fees-mobile-rls`, schema-safety list         |
| `@jantrik/api` (Vitest e2e) |             350 | `fees-setup`, `fees-dues`, `fees-collect`, `fees-mobile`, `fees-reports`, `fees-roles`, `job-context` |
| Playwright e2e              |              70 | `fees-counter` (bn, en), `fees-mobile` (bn, en), `fees-staff`; fee pages in `layout.spec.ts`          |

What the tests you asked for cover:

- **Tenant isolation for every fee table** (15 tables): another institute cannot read, change or
  delete a row, insert one with this institute's id, or point a key at this institute's rows; the
  schema-safety test lists every fee table.
- **Teachers and guardians cannot see other students' fees:** a teacher without ACCOUNTANT gets
  403 on every `/fees/*` route; a guardian gets 404 for another family's child and their
  receipts, and 403 on staff routes.
- **Gap-free receipt numbers under concurrency:** 20 database connections with every third rolling
  back, and 30 parallel collections through the API with 5 that fail after taking a number, both
  leave the numbers contiguous.
- **Dues generation is idempotent:** run twice, and five times in parallel, it gives the same rows.
- **Void:** only OWNER/ADMIN, with a reason; a second void is refused; the fine starts running
  again; the receipt shows VOID; an unsent receipt SMS is cancelled; the TrxID can be used again.
- **TrxID duplicates rejected:** pending, verified, and across the guardian and counter channels;
  allowed for the other method, in another institute, after a reject and after a void; two
  verifies at once make exactly one payment.
- **Fine edge cases:** on the due date, one day late, at the cap, paid before the due date,
  partial payment, void reopening, waivers, month ends and leap years.
- **Playwright** (360 px, touch, in bn and en): the accountant finds a student by a Bangla-digit
  phone (shown masked), collects part of two months, prints the receipt (one A5 page) and an
  admin voids it; a guardian submits a TrxID and the accountant verifies it.

**About Playwright.** GitHub CI runs it on every push, on its own database.

- **Fridays:** before merge it failed twice on a Friday in Dhaka, because two older specs assumed a school day (the demo's weekly holiday is Friday). The suite now lives on a fixed day (below), and CI was green on a Friday: 70 of 70 (`9682908`).
- **Too many requests:** on `2940c0d` one of its two runs failed `setup.spec`, because the section save got 429. The e2e run plays the owner in most specs and passed the API's 300-requests-a-minute limit per person; this step's extra fee pages made that likelier. The e2e API now runs with higher general request limits (login and code limits unchanged).

## Before merge (your review)

1. **Confirmed, with tests:**
   - **The sibling discount applies only after an ADMIN/OWNER confirms the family:**
     - `fees-setup` › "a shared guardian phone is only a suggestion until an admin confirms the family";
     - `fees-dues` › "only a confirmed family gets the sibling discount";
     - new: `fees-dues` › "only an admin links or unlinks a family; once unlinked, recalculating ends the discount".
   - **A teacher can also be the accountant:**
     - `fees-roles` › "teacher and accountant together" (3 tests);
     - Playwright `fees-staff` › "the owner lets a teacher collect fees in one step; the teacher then sees the counter".
2. **E2E on a fixed day.**
   - `todayIn` returns `JANTRIK_TEST_TODAY` when set, in a Node process that is not in production. Browsers never read it, and the API refuses to start with it unless `NODE_ENV=test`.
   - Playwright sets it to 2026-10-21, a Wednesday and a working day in the demo year. The seed, the API and the specs all use it; timestamps stay real.
   - The web no longer takes dates from the device. The dashboard's date line and the SMS preview use the server's today, and the platform pages get it from `GET /platform/auth/me`.
   - A sanity test checks that the specs, the API and the dashboard agree on the date.
3. **Fixed:**
   - **The dashboard's overdue count (and the due list)** now count only students who are active, not deleted, and enrolled this year.
   - **A guardian's bKash/Nagad retry after a server error:**
     - the sheet keeps its request id, and the API returns the saved submission;
     - the same id with other details, or from another person, is 422;
     - tested in the API and in Playwright, where the first send is saved but answered with a 500.
4. **Found in the walkthrough and fixed:** on a phone the receipt number and student ID broke across lines ("2026-/000001"). They no longer break; checked at 360 and 390 px, and in A5 and 80 mm print. The guardian's fee page had the same break in its header ("আইডি SHS-/2026-0002"), now fixed the same way.
5. **Walkthrough** (a scratch database, `jantrik_walkthrough`, seeded and then dropped; your `jantrik` database was not touched). Every step passed:
   1. the owner confirms the suggested family;
   2. the teacher-accountant finds Tasnim by phone (shown `018•••••101`), takes ৳500 for two months and gets receipt `2026-000001`;
   3. the admin voids it with a reason;
   4. the guardian sends a bKash TrxID;
   5. the accountant verifies it and opens the closing;
   6. the admin previews reminders (৳18);
   7. the owner sees the dashboard card and reports.

   There are 35 bn screenshots at 390 and 1366 px.

6. **The 3-second check:** a 390 px phone, 4× slower CPU, slow 4G, cold cache, signed in; 7 interleaved rounds against a main build.

   | Page                  | Interactive, median (range) |
   | --------------------- | --------------------------- |
   | `/fees` (counter)     | 3.66 s (3.50–3.79)          |
   | `/dashboard` (branch) | 3.93 s (3.91–4.30)          |
   | `/dashboard` (main)   | 3.78 s (3.75–4.01)          |
   - **The counter is over the budget by about 0.7 s.** It is faster than the dashboard on either build.
   - **Where the time goes:** a cold load is about 600 KB (337 KB scripts, 187 KB fonts, 53 KB page), about 3 s of transfer on slow 4G, and the same app shell as main. Getting under 3 s needs app-wide work on fonts and JS splitting.
   - **The dashboard ranges overlap,** so the fees card is not a clear regression.

## What was built

### Phase 0: groundwork

- Background jobs run inside one institute's database context, and audit rows written by a job
  with no person have no actor (the nightly dues run needs this).
- Other modules can read the institute's daily SMS cap.

### Phase A: setup (OWNER/ADMIN; the institute's numbers OWNER only)

- **Settings:** the date dues start from (nothing is charged before it, so switching fees on
  mid-year never back-charges), receipt SMS on or off (on by default), the sibling rule, and a
  receipt note.
- **Heads:** monthly, per term, yearly or one-time, each with its due day and its late fine
  (none, flat, or per day with a required cap).
- **Amounts** per class and year, with optional study-group prices and "copy from last year".
- **Terms** with their opening and due dates.
- **Concessions:** fixed or percent; full or half free studentship; scholarships need a reason;
  never two at once for the same head. All audited.
- **Siblings are confirmed, not automatic** (your change 1). A shared guardian phone only
  suggests a family. The discount applies after an OWNER/ADMIN confirms it; the link is stored,
  audited and removable with a reason, and "recalculate unpaid dues" is offered right after.
- **A teacher who collects fees** (your change 3): the staff page gives a teacher fee collection
  in one step (adds ACCOUNTANT to their roles) and takes it away the same way. Fee access still
  comes only from ACCOUNTANT, ADMIN or OWNER.

### Phase B: dues and the ledger

- Dues are made per period with their due dates, copying the amount, concession and fine rule at
  the time. Later setup changes apply to new periods, unless an OWNER/ADMIN recalculates unpaid
  dues.
- A nightly job (00:30 Asia/Dhaka) makes the day's dues, but nothing depends on it: opening a
  student's fees makes theirs first, and reports, reminders and the dashboard queue the run.
- Late joiners get at least 7 days to pay their first month.
- The student ledger: dues (including earlier years), concessions, the family link, fines,
  waivers, payments and the balance. OWNER/ADMIN can waive a fine or cancel a due, with a reason.

### Phase C: the counter, receipts, voids and the daily closing

- **Phone first.** Find a student by name, ID, class and roll, or guardian phone (Bangla digits
  work). The accountant sees phones masked (`018•••••101`).
- **Collect cash** for one or several months and heads, part payments allowed, advance months
  too. A sticky total opens a sheet with the amount and how it will be split. A double tap or a
  retry never collects twice.
- **Receipt numbers** like `2026-000123`, without gaps, restarting each calendar year.
- **The receipt** (Bangla or English): institute, number, date, student, class, lines, fine,
  total, amount in words, method and TrxID, collector, balance after. Prints on A5 or 80 mm
  (chosen per device); a voided receipt shows VOID and the reason.
- **Receipt SMS** to the primary guardian after the payment is saved, inside the daily cap, with
  its cost logged when sent.
- **Payments are never edited or deleted.** OWNER/ADMIN void them with a reason (audited). A void
  does not return mobile money; the screen says so.
- **Daily closing** per collector: collected, voided, by method, cash in hand (the cash the
  person should hold), and the receipts. A payment counts on the day it was recorded and a void
  on the day it is made, so a closed day never changes.

### Phase D: bKash/Nagad without the gateway

- The institute's own bKash/Nagad numbers (personal, merchant or agent), set by the OWNER.
- A guardian (from their child's fees page) or the accountant (from the counter) sends the
  amount, TrxID and sender number for chosen dues. A TrxID is used once per institute and method.
- The accountant checks it in the institute's app, then verifies it (a payment, a receipt and the
  SMS; the fine is counted to the day it was sent) or rejects it with a reason.

### Phase E: reports, reminders, dashboard, guardians

- **Reports:** dues by class and section, defaulters (by days late or amount), and collections by
  day, month, head, method or collector. Each has CSV (safe against spreadsheet formulas) and
  print.
- **Reminder SMS** (OWNER/ADMIN): a preview with the recipients, those without a phone, those
  already reminded, the SMS count and cost, and what today's cap leaves. Then a confirmation.
  Each student gets one reminder per period; a student who pays before the SMS goes out gets none.
- **Dashboard:** the fees card shows this month's collections against last month and what is
  overdue, plus a card for transfers waiting to be checked.
- **Guardians** see each child's balance on their dashboard, and per child the dues, payments,
  receipts and their bKash/Nagad submissions.

## Decisions

You decided these (see the plan):

1. Straight through, then the gates and one PR for phases 0 and A–E.
2. The bKash/Nagad numbers (and later the gateway credentials) are OWNER only; ADMIN sees them.
3. Receipt numbers restart each calendar year.
4. Late fines can be waived (part or all) by OWNER/ADMIN with a reason.
5. The accountant searches by guardian phone but sees it masked (decision #19 updated).
6. Receipt SMS on by default.
7. Siblings confirmed, not automatic; phase F later; a teacher may also be the accountant.

I decided these (recorded in `docs/decisions-pending.md` #29, open to change):

- One receipt per student; no family receipts yet.
- In a confirmed family, the student in the highest class pays full; ties go to the earlier
  admission.
- Concessions never stack: a due gets the larger of the manual concession and the sibling
  discount.
- Fee SMS texts are fixed Bangla; editable templates later.
- The daily closing counts payments on the day recorded and voids on the day made.
- The sender's number of a bKash/Nagad transfer is masked for the accountant (the TrxID and the
  amount are enough to check it).

### Rulings I made while building

- **No separate worktree:** you asked for a branch from main in this checkout. The tree was clean.
- **Term rows can be deleted while unused:** they are setup, not history, and a due still blocks
  the delete.
- **Fixes to applied migrations are follow-up migrations**, never edits, so your database never
  needs a reset. That is why some tables have a second and third migration.
- **Malformed input is 400, a broken business rule 422.** The repo's validation pipe answers 400
  for schema errors (the plan said 422).
- **Overlapping concessions are refused in the service** (409), not by a new Postgres extension.
  If wrong: two concessions with future end dates created at the same moment could overlap; an
  open-ended one is still caught by the database.
- **The receipt number is not forced by a database trigger:** the service's counter is its only
  writer. If wrong: a manual insert could break that year's numbering.
- **The void trigger does not overwrite the void time** with the database clock. The service sets
  it, and every void is audited with the server time.
- **The guardian fee view and own receipts were built in D2** (planned in E3), because the
  guardian submission screen needed them.
- **The sender's phone is masked for the accountant** in transfers, as #19 does for guardian
  phones.

## Review findings fixed

- **Accountant search** could tell whether a masked number matched by trying digits; it now
  matches only a whole phone number.
- **Siblings:** a rule with a value but no type got past the database check.
- **Concessions and families were rewritable:** column grants now let a concession only be
  ended and a family member only be removed.
- **Concessions** could overlap.
- **Allocations:** the database now checks at commit that no allocation goes to a void payment or
  a cancelled due, and that a payment's allocations never add up to more than the payment.
- **No fee key cascades:** changing a parent row's key (a term's year) could rewrite fee rows past
  their column grants.
- **The daily closing** changed when a payment was voided on a later day.
- **Waiving and cancelling** now take the institute's fee lock like every other money change, and
  a recalculation rewrites a due only if it is still untouched.
- **Whole-institute work in a request:** "generate now" and recalculating the whole institute now
  run as background jobs.
- **Changing an institute number's phone** blanked its label.
- **A guardian could see the full sender number** of another guardian's transfer for the same child.
- **Final review:**
  - **Receipts printed on A4 landscape.** Each receipt now prints on its own page: one A5 page, or
    80 mm wide, checked by printing to PDF in Chromium.
  - **The closing asked the accountant to hold bKash/Nagad money as cash.** It now shows cash in
    hand separately from the all-methods total.
  - **Fee screens stayed stale after a collection, void or verification.** Every fee screen now
    refreshes.
  - **A whole-institute reminder preview made every student's dues inside the request** (slow on
    big schools). It now queues that work.

## Deferred minors

None of these changes money or access:

- Reusing one request id for two different students at the same moment answers 409 instead of 422.
- An advance month left part-paid (or voided) counts as owed before its period starts.
- The receipt counter row stays locked until the payment commits, so a big reminder send can
  make a collection wait briefly.
- Re-picking dues when verifying a transfer shows today's balance, and a second refusal does not
  show the server's figure (the ledger now refreshes, which eases it).
- Phone cells in the due-list CSV start with an apostrophe (the formula guard on `+880…`).
- The nightly job id uses `:` (fine in BullMQ 6; a future major may not allow it).
- Every page's HTML is about 15 KB larger than on main (53 vs 38 KB): most likely the fee messages,
  sent with every page; they could go only to fee pages.
- Printing the due list from a phone prints only the cards shown (50 at a time).

## Skipped or left for later

- **Phase F, bKash tokenized checkout:** not built (your change 2). Its plan is in
  [docs/backlog.md](../backlog.md). Building it needs bKash **sandbox** credentials from you
  (bKash publishes none) and no live keys.
- **Playwright on this machine:** not run here; CI runs it on every push. `pnpm e2e` resets
  `jantrik_e2e`, and Prisma refuses that reset from an AI agent without your consent.
- **The 3-second budget on the counter:** not met (3.66 s); see above. This is app-wide work.
- **Design backlog** (`docs/design-backlog.md` §6):
  - Move the SMS cap and "send held SMS" out of the attendance settings, so an institute with
    fees and without attendance can change them.
  - Editable fee SMS templates.
  - Family receipts.
  - Checking the 80 mm receipt on real thermal printers.

## What you need to do

- **Database:** nothing. The fee migrations are already applied to your local `jantrik`
  database (`prisma migrate status`: up to date). There are no new `.env` lines.
- **Playwright:** `pnpm e2e`. It drops and reseeds only `jantrik_e2e`, and needs ports 3000 and
  4000 free; any day works now.
- **Demo data:** your local `jantrik` database already has Shapla and Alo, and the seed skips
  institutes that exist, so `pnpm db:seed` adds no fee data there. To get the fee demo locally,
  either `pnpm db:reset` (drops your local data, then reseeds everything) or set fees up through
  the screens as the owner.
- **Manual walkthrough** (`pnpm dev`; every password `Jantrik@2026`):
  1. Owner `01711000001`: Fees → Setup → Siblings, confirm Tasnim and Tahmid.
  2. Teacher `01711000002` (also the accountant) on a phone: Fees, find Tasnim by `01811000101`,
     collect part of two months, print the receipt.
  3. Admin `01711000003`: open that receipt and void it with a reason.
  4. Guardian `01811000101` (OTP, the code is in the API log): the child's fees, pay by bKash, send
     a TrxID.
  5. Accountant `01711000004`: Fees → bKash/Nagad, verify it; then the daily closing.
  6. Admin: Fees → Reminders, the preview (cost and count) without sending.
  7. Owner: the dashboard's fees card.

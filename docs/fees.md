# Fees

Module `FEES`. API: [`apps/api/src/fees`](../apps/api/src/fees). Rules shared by the API, the web
app, the seed and the tests: [`packages/shared/src/fees.ts`](../packages/shared/src/fees.ts);
request and response shapes: [`fees-api.ts`](../packages/shared/src/fees-api.ts). Web:
[`apps/web/src/app/(app)/fees`](<../apps/web/src/app/(app)/fees>) and
[`/children/[id]/fees`](<../apps/web/src/app/(app)/children>) for guardians. Tables, RLS and
grants: [database.md](database.md) → Fees.

Money is integer paisa everywhere. Dates are calendar dates in the tenant's timezone; "today"
always comes from the server. The bKash gateway (tokenized checkout) is not built yet: see
[backlog.md](backlog.md).

## Who does what

| Who                          | May                                                                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OWNER                        | everything below, and the only one who changes **where money goes**: the institute's bKash/Nagad numbers                                                        |
| ADMIN                        | setup (heads, amounts, terms, concessions, families, settings), cancel a due, waive a fine, recalculate, void a payment, reminders, see the numbers (read only) |
| ACCOUNTANT                   | the counter (find a student, ledger, collect cash), receipts, daily closing (their own), verify/reject bKash/Nagad transfers, reports                           |
| TEACHER (without ACCOUNTANT) | no fee route at all (403)                                                                                                                                       |
| GUARDIAN                     | their own children's fees (`/me/children/:id/fees`, 404 for any other child): dues, receipts, "I paid by bKash/Nagad"                                           |

One person may hold TEACHER and ACCOUNTANT together (a class teacher who collects fees): fee
access comes from ACCOUNTANT only, teaching rights stay those of a teacher. The staff page has a
one-step "give fee collection" action.

The accountant searches by guardian phone but sees it **masked** (`018•••••101`), and only a whole
number searches by phone (a part of a number would let them reveal the hidden digits one guess at
a time). OWNER/ADMIN see phones in full (decision #19).

## Setup (OWNER/ADMIN)

- **Settings:** the month dues start (`dues_from`, the 1st of a month; nothing is generated
  before it is set, so switching fees on mid-year never back-charges), receipt SMS (on by
  default), the sibling rule (fixed or %, from the n-th child, default 2nd), a note printed on
  every receipt.
- **Heads:** name (bn/en), kind (admission, tuition, exam, session, other), frequency:
  - MONTHLY: due on a day of each month (1–28);
  - PER_TERM: the year's terms (each with an opening date and a due date);
  - YEARLY: due a number of days after the year starts;
  - ONE_TIME: due a number of days after admission, charged only to students admitted on or
    after "charge from" (empty: never automatically).
    Late fine per head: none, a fixed amount once late, or an amount per day up to a cap. Heads
    are deactivated, never deleted (a deactivated head frees its name).
- **Amounts:** per year, head and class level; a study-group row overrides the class row (0 =
  free for that group). "Copy from another year" fills only what is missing.
- **Concessions:** per student, head and year: fixed or %, full (100 %) or half (50 %) free
  studentship, a scholarship (needs a reason); from a date; ended (with a reason), never deleted.
  Concessions on one head never overlap in time.
- **Families (siblings):** students who share a guardian phone are only **suggested**: guardians
  often give a relative's phone. The sibling discount applies only to a family an OWNER/ADMIN
  confirmed; members are removed with a reason. Inside a family the student in the highest class
  pays full; ties go to the earlier admission. A due gets the larger of the manual concession and
  the sibling discount: they never stack.

Every setup change is audited.

## Dues

A due is what one student owes for one head and period (`YYYY-MM`, `T:<term>`, `Y`, `ONCE`). It
exists when the period has started (or is paid ahead at the counter), starts on or after
`dues_from`, has not ended before the student was admitted, and the student's class (or group)
has an amount for an active head. A student admitted inside a period gets at least 7 days to pay.

- **Generated idempotently:** insert … ON CONFLICT DO NOTHING on student + head + year + period
  (a one-time fee once ever), so a due is never created twice.
- **Correctness never depends on the nightly job.** Opening a ledger (counter, guardian) generates
  that student's dues; reminders generate their students' first; reports queue the day's run.
  The nightly run (00:30 Asia/Dhaka, queue `fees`) visits only institutes listed in Redis
  (`fees:tenants`, re-listed whenever fees are used), 500 students per transaction, with no person
  acting (audit rows have no actor).
- **Snapshots:** a due copies its amount, concession and fine rule when it is created. Later setup
  changes apply to new periods. "Recalculate unpaid dues" (OWNER/ADMIN) rewrites only untouched
  dues (nothing paid, no fine waived): for a few students now (e.g. a family just confirmed), for
  the whole institute in the background.
- **Cancel** (OWNER/ADMIN, reason): only a due with nothing paid; it stays visible, struck
  through, and is never generated again. A cancelled due never changes again (database trigger).

## Fines and balances

`dueBalance()` in `fees.ts`:

- days late = (the day the principal was fully paid, or today) − the due date;
- FLAT: the amount once a day late; PER_DAY: days × the amount, at most the cap;
- owed fine = accrued − fine paid − fine waived (never below 0); a waiver of "all" stops it for
  good;
- the fine stops on the payer's date of the payment that completed the principal; a partial
  payment does not stop it; voiding that payment starts it again.

## Collecting cash (the counter)

`POST /fees/payments` for one student: choose dues (and periods to pay ahead), an amount up to
what they owe (partial payments allowed). Principal is paid oldest due first, then fines.

- The counter sends what it showed as owed; if it moved meanwhile: 409 `DUES_CHANGED`.
- `clientRequestId` is new for every attempt; a retried request returns the same receipt.
- Locks, always in this order: the tenant's fee lock (shared), the student's, a TrxID's, the
  receipt counter row, the SMS lock (`fee-locks.ts`).
- The cached totals on a due (paid principal and fine, the day the principal was cleared, waived
  fine) are re-derived from the allocations of live payments and the waivers, never incremented.
  A deferred database trigger checks every allocation at commit: never to a void payment or a
  cancelled due, never more than the payment.

## Receipts

- Numbered per institute and **calendar year** of the day it was recorded: `2026-000123`. The
  number comes from a counter row updated inside the payment's transaction, so a payment that
  rolls back gives its number back: **no gaps** (tested with concurrent payments and rollbacks).
- Bangla receipt (`components/fees/receipt.tsx`): A5 or 80 mm thermal, named `@page` rules, black
  on white; amounts and dates in Bangla digits, the receipt number, ID and TrxID in ASCII; the
  amount in words (`amountInWords`, lakh/crore).
- After commit, an SMS to the primary guardian (fixed Bangla text, at most 2 SMS), under the
  institute's daily SMS cap, its cost logged when sent. A receipt SMS that has not gone out when
  its payment is voided is cancelled.

## Voids

Payments are never edited or deleted. OWNER/ADMIN void one, once, with a reason
(`POST /fees/payments/:id/void`): its dues owe again (and their fines run again), the receipt
shows VOID with the reason, a linked bKash/Nagad submission becomes VOIDED (its TrxID free again).
Audited. Voiding gives no money back by itself: refunds happen outside the app.

## Daily closing

`GET /fees/closing?date`: per collector and method. A payment counts on the day it was recorded;
a void is deducted on the day it is made (listed with the payment's own date), so a closed day
never changes afterwards. Totals: collected, voided, net. An accountant sees only their own.

## bKash/Nagad without the gateway

1. The OWNER lists the institute's own numbers (personal, merchant or agent).
2. A guardian (or staff, for a student) submits the amount, the TrxID and the sender's number for
   chosen dues. TrxIDs are typed loosely (spaces, lower case, Bangla digits) and stored upper case.
   At most 5 waiting per child, 20 per person per hour.
3. Staff check it in the institute's own app, then **verify** (a payment and receipt dated the day
   it was submitted, so a fine stops there; the dues may be re-picked if they were paid meanwhile)
   or **reject** with a reason.

A TrxID is open once per method (waiting or verified submissions, live payments): checked under a
per-TrxID lock and by partial unique indexes; free again after a reject or a void. The sender's
number is masked for the accountant.

## Reports and reminders

- Due list by class/section, defaulters (overdue for at least N days and ৳ amount), collections by
  day, month, head, method or collector (money kept: void payments left out). CSV with a BOM,
  ASCII digits and formula-safe cells; print.
- Reminders (OWNER/ADMIN): a preview gives the students, those without a phone, those already
  reminded, segments, cost and what today's SMS cap leaves; sending needs the same count (409
  `PREVIEW_CHANGED`) and runs in the background. One reminder per student per overdue period
  (dedupe key `fee-reminder:<student>:<latest overdue due>`); cancelled at send time if they paid.
- Dashboard card: this month so far against the same days of last month, overdue (amount and
  students), transfers waiting to be checked.

## SMS

Receipts and reminders share the institute's daily SMS cap with absent SMS (one budget; the cap is
set on the attendance settings page for now: design-backlog.md). Fixed Bangla templates in
`fees.ts` (`receiptSmsText`, `reminderSmsText`).

## Demo data

`pnpm db:seed` sets up Shapla (see [demo-accounts.md](demo-accounts.md) → Fees): an admin, an
accountant, a teacher who collects fees, four heads, amounts, terms, a sibling suggestion, a half
free studentship and the institute's numbers. Alo has FEES on with nothing set up.

# Step 9: FEES module (phases 0 and A–E; bKash gateway deferred)

## Context

CLAUDE.md puts fees in the Phase 1 MVP scope. Some of it already exists:

- The `ModuleKey.FEES` and `Role.ACCOUNTANT` enums.
- FEES is switched on for both demo institutes.
- The nav has a "soon" fees item, the dashboard has a `module-card-fees` placeholder, and the guardian child card has a "coming soon" line.

There are no fee tables, services or screens. This step builds:

- **A.** Setup.
- **B.** Dues.
- **C.** Cash counter, receipts, voids and daily closing.
- **D.** Manual bKash/Nagad payments.
- **E.** Reports, reminders, dashboard and the guardian view.

**Phase F (bKash tokenized checkout) is not built now.** Its plan (at the end of this file) is recorded in `docs/backlog.md` and becomes a later step on its own branch.

### Owner decisions (2026-10-22)

| Topic                 | Decision                                                                                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delivery              | Phases 0 and A–E straight through on `feature/step-9-fees`, one or more commits per part, pushed as I go. Then the full gates, then **a PR for A–E**.                                                          |
| Money destinations    | bKash/Nagad numbers are **OWNER only**. ADMIN can view, not change. Changes are audited.                                                                                                                       |
| Receipt numbers       | Restart every **calendar year**, by the date the payment is recorded (Asia/Dhaka). Format `2026-000123`, ASCII digits.                                                                                         |
| Fine waiver           | ADMIN/OWNER can waive part or all of a due's late fine, with a reason. Audited and shown on the ledger.                                                                                                        |
| Accountant and phones | The accountant can search by guardian phone. Results show the number **masked** (last 3 digits). No full phones on the ledger or receipt. Decision #19 is updated.                                             |
| Receipt SMS           | **On by default**, switchable in fee settings.                                                                                                                                                                 |
| Siblings              | **Confirmed, not automatic.** A shared guardian phone only **suggests** possible siblings. The discount applies only after an ADMIN/OWNER confirms the family link. The link is stored, audited and removable. |
| Teacher + accountant  | One person can hold TEACHER and ACCOUNTANT together. The staff screen makes adding ACCOUNTANT to a teacher a single action. Fee access still comes only from the ACCOUNTANT, ADMIN or OWNER role.              |
| Seeding               | **Ask before running `pnpm db:seed`.** `pnpm e2e` reseeds only its own `jantrik_e2e` database as part of the gates.                                                                                            |

### Decisions I made (recorded in docs/decisions-pending.md)

- **One receipt per student.** No family receipts yet.
- **Sibling ranking inside a confirmed family.** The student in the highest class pays full price (ties go to the earlier admission). Children ranked at or after `from_child` (default 2) get the rule on heads marked sibling-eligible.
- **Concessions never stack.** A due gets the larger of the manual concession and the sibling discount.
- **Fee SMS templates are fixed Bangla text.** Editable templates go to the design backlog.
- **The SMS cap is the institute's existing shared daily cap.** It counts every SMS purpose and is read through `AttendanceSettingsService`. A FEES-only institute cannot change the cap or release held SMS yet; this goes to the design backlog.
- **Teachers without ACCOUNTANT get no fee route** (403).

## Workflow

- Branch: `git switch main && git pull --ff-only && git switch -c feature/step-9-fees`.
- Every tenant table goes through the **add-tenant-table skill**.
  - Each migration is created with `--create-only`, then the folder is **renamed to sort after `20261026000000_…`** (prefixes `20261027…`), because today's date would sort before existing folders.
  - RLS, grants and CHECKs are appended before applying with `pnpm db:migrate` on the local DB. This applies migrations only; there is no seed.
  - Drift check, schema-safety list and isolation tests follow.
- During each part I run only the affected tests: shared unit, `@jantrik/db` RLS, and the API e2e file for that part.
- A **review subagent** checks every migration/RLS part and the money parts: C3, C4 and D2.
- At the end:
  1. The full gates: `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, `pnpm test`, `pnpm build`, then `pnpm e2e` with ports 3000/4000 checked free.
  2. Push and open the PR with `gh pr create`; the body includes the step report.
- Screenshot checks: bn at 1366 and 390 px only.

## Core rules (pure functions in `packages/shared/src/fees.ts`, unit-tested)

- **Money**
  - Integer paisa.
  - `parseTaka(input)` accepts Bangla digits (via `toAsciiDigits`), commas and at most 2 decimals, and rejects floats and negatives.
  - Percent concessions are rounded half-up to the paisa.
  - Report sums use `SUM(...)::bigint`.
- **Periods** (`feePeriods`)

  | Frequency | Key          | Period start                                      | Due date                       |
  | --------- | ------------ | ------------------------------------------------- | ------------------------------ |
  | MONTHLY   | `YYYY-MM`    | 1st of the month (or the year start)              | the head's `due_day` (1–28)    |
  | PER_TERM  | `T:<termId>` | the term's `opens_on`                             | the term's `due_date`          |
  | YEARLY    | `Y`          | the year start                                    | year start + `due_offset_days` |
  | ONE_TIME  | `ONCE`       | the admission date (`students.created_at`, local) | admission date + offset        |
  - ONE_TIME dues are created only if the student was admitted on or after the head's `one_time_from`. If that date is NULL, they are never created automatically.

- **Which dues exist.** A due is created when all of these hold:
  - The period has started (`period_start ≤ today`), or it is a future period the counter explicitly pays in advance.
  - The period starts on or after `fee_settings.dues_from`. Nothing is generated until the owner sets that date, so switching fees on mid-year never back-charges.
  - The period is on or after the student's admission month.
  - The student is ACTIVE, not deleted, and enrolled in the current year.
  - An amount exists for the student's class level. A study-group row overrides the class-level row.
- **Late joiners.** A due whose period contains the admission date gets `due_date = max(scheduled, admitted + 7 days)`.
- **Snapshots.** Each due copies its amount, concession (with its source) and fine rule when it is created. Later setup changes apply to new periods only.
  - An explicit, audited "recalculate unpaid dues" (ADMIN/OWNER) rewrites dues that have no allocations.
  - It can be scoped to a family, and is offered right after a sibling link is confirmed or removed.
- **Fine** (`fineAccrued`)
  - `days = asOf − due_date`, with `asOf = principal_cleared_on ?? today(tz)`.
  - FLAT: the amount if `days > 0`. PER_DAY: `min(days × rate, cap)`, and a cap is required. A net due of 0 has no fine.
  - Fine owed = `fine_waived_all ? 0 : max(0, accrued − paid_fine − fine_waived)`.
  - A partial payment does not stop accrual.
  - A void recomputes `principal_cleared_on`, so accrual resumes.
- **Allocation** (`allocate`)
  - Covers only the dues the caller selected.
  - Principal is paid oldest due first, then fines oldest first.
  - The amount cannot exceed the selected outstanding total; there are no credit balances.
- **Dates on a payment.** `paid_on` drives fines (today for cash, the submission date for mobile payments). `recorded_on` (the insert's local date) drives the receipt year and the daily closing.
- **Locks, always taken in this order:**
  1. The tenant `fees:<tenant>` advisory lock: shared for payments, exclusive for bulk recalculation.
  2. The per-student lock.
  3. The per-TrxID lock.
  4. The receipt counter row.
  5. The SMS advisory lock that `TenantSmsService.queue` already takes.

  `client_request_id` is checked after the student lock. The same id with a different payload returns 422 `IDEMPOTENCY_MISMATCH`.

- **Cached totals on dues.** `paid_principal_paisa`, `paid_fine_paisa`, `principal_cleared_on` and `fine_waived_*` are written only by `recomputeDues(dueIds)`, re-derived from the allocations of ACTIVE payments and from the waivers. A CHECK forbids over-allocation, and a test asserts cache = Σ allocations.

## Data model (15 tenant tables, `Fee*` enums, composite FKs, forced RLS)

- History tables get **no DELETE**.
- Money rows carry `@@unique([tenantId, id, studentId])`. Their child rows carry `student_id`, so a composite FK makes it impossible to allocate to another student's due.

| Table                          | Key points                                                                                                                                                                                                                                                                                                         | Grants                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `fee_settings` (≤1 per tenant) | `dues_from`, `receipt_sms_enabled` (default true), sibling rule (`NONE\|PERCENT\|FIXED`, value, `from_child ≥ 2`), `receipt_note` ≤ 200                                                                                                                                                                            | S I U                                                                                                               |
| `fee_heads`                    | name bn/en, kind, frequency, `due_day` (MONTHLY only), `due_offset_days`, `one_time_from`, fine type/amount/cap (CHECK: PER_DAY needs a cap), `sibling_eligible`, active, sort                                                                                                                                     | S I U                                                                                                               |
| `fee_terms`                    | academic year, name bn/en, `opens_on ≤ due_date`, sort                                                                                                                                                                                                                                                             | S I U                                                                                                               |
| `fee_amounts`                  | year, head, class level, study group NULL; two partial uniques; `amount_paisa > 0`                                                                                                                                                                                                                                 | S I U D                                                                                                             |
| `fee_concessions`              | student, head, year, category (GENERAL\|FREE_FULL=100%\|FREE_HALF=50%\|SCHOLARSHIP needs a reason), FIXED\|PERCENT, `valid_from`, `ended_on`; one active per (student, head, year)                                                                                                                                 | S I U                                                                                                               |
| `fee_sibling_groups`           | a confirmed family; `created_by`                                                                                                                                                                                                                                                                                   | S I U                                                                                                               |
| `fee_sibling_members`          | group, student, `added_by`/`added_at`, `removed_by`/`removed_at`; partial unique (tenant, student) WHERE `removed_at IS NULL` (a student is in at most one family)                                                                                                                                                 | S I U                                                                                                               |
| `fee_dues`                     | snapshots, cached totals, status OPEN\|CANCELLED (+ reason); unique (tenant, student, head, year, period_key) plus a partial unique for ONCE; `period_key` regex CHECK                                                                                                                                             | S I U                                                                                                               |
| `fee_fine_waivers`             | due, student, amount (NULL = all), reason 3–500, by                                                                                                                                                                                                                                                                | S I                                                                                                                 |
| `fee_receipt_counters`         | (tenant, year) → `next_value`, gap-free upsert (not the student-code skip loop)                                                                                                                                                                                                                                    | S I U                                                                                                               |
| `fee_payments`                 | receipt year and number (unique), method CASH\|BKASH\|NAGAD, channel COUNTER\|MOBILE_MANUAL, amount, `paid_on`, `recorded_on`, `trx_id`, `sender_phone`, collector, `client_request_id` (unique), status ACTIVE\|VOID + void columns (billing CHECK pattern); partial unique (tenant, method, trx_id) WHERE ACTIVE | S I + **column UPDATE** on the void columns + `updated_at`; a plain `BEFORE UPDATE` trigger allows only ACTIVE→VOID |
| `fee_payment_allocations`      | payment, due, student, principal and fine amounts                                                                                                                                                                                                                                                                  | S I                                                                                                                 |
| `fee_mobile_accounts`          | method BKASH\|NAGAD, E.164 phone, kind PERSONAL\|MERCHANT\|AGENT, label, active                                                                                                                                                                                                                                    | S I U                                                                                                               |
| `fee_mobile_submissions`       | student, method, account, amount, `trx_id` (normalised; CHECK `^[A-Z0-9]{6,20}$`), sender phone, submitter, status PENDING\|VERIFIED\|REJECTED\|VOIDED, review fields, payment; partial unique (tenant, method, trx_id) WHERE PENDING/VERIFIED                                                                     | S I U                                                                                                               |
| `fee_mobile_submission_dues`   | submission, due, student                                                                                                                                                                                                                                                                                           | S I                                                                                                                 |

`SmsPurpose` gains `FEE_RECEIPT` and `FEE_REMINDER` in their own migration.

## Parts (commit-sized, in order)

### Phase 0: groundwork

- **0.1 Background jobs and the SMS cap.**
  - `TenantJobRunner` records the job's tenant.
  - `RequestContext.requireTenantId()` is added.
  - `AuditService.record` (`apps/api/src/audit/audit.module.ts`) writes `actor_user_id = NULL` inside a job with no actor, and still throws outside any context. The scheduled dues run needs this.
  - `AttendanceModule` exports `AttendanceSettingsService`, which gains `smsDailyCap()`.
  - Tests:
    - a job's audit row has a NULL actor;
    - with no context it still throws;
    - `smsDailyCap()` returns the same value as today's cap logic.

### Phase A: setup (OWNER/ADMIN; money destinations OWNER only)

- **A1 DB:** `fee_settings`, `fee_heads`, `fee_terms`, `fee_amounts`, `fee_concessions`, `fee_sibling_groups`, `fee_sibling_members`. Tests in `packages/db/test/fees-setup-rls.test.ts`, plus the schema-safety list.
- **A2 shared:** `fees.ts`, with these pieces:
  - zod schemas;
  - periods: `feePeriods`;
  - concessions and siblings: `concessionFor`, `siblingRanks` (over confirmed groups only);
  - fines and allocation: `fineAccrued`, `allocate`;
  - money and identifiers: `parseTaka`, `amountInWords` (bn/en, lakh/crore), `maskPhone`, `normalizeTrxId`;
  - the fixed Bangla SMS templates.

  Unit tests in `fees.test.ts` cover:
  - fine edge cases: on the due date, one day late, at the cap, cleared before the due date, partial payment, void reopening, waiver;
  - allocation order;
  - month and leap-year boundaries;
  - a coaching year running July to June;
  - amount in words;
  - sibling ranking (class, then admission order; `from_child`).

- **A3 API:** `apps/api/src/fees/fees.module.ts`, `setup/fee-setup.service.ts` and `.controller.ts`.
  - Settings, heads, terms, the amounts matrix (bulk upsert, "copy from last year"), concessions (create, end).
  - **Siblings:**
    - `GET /fees/siblings/suggestions`: current-year active students sharing a guardian phone and not already in the same confirmed family. Shown as a suggestion with guardian names.
    - `POST /fees/siblings`: confirm a family (≥ 2 students). If one student is already in a family, the others join it. Students in two different families return 409.
    - `POST /fees/siblings/:groupId/members/:studentId/remove`: needs a reason.
    - All ADMIN/OWNER and audited.
  - Every write is audited.
  - Tests in `apps/api/test/fees-setup.e2e-spec.ts`:
    - role matrix: TEACHER, ACCOUNTANT and GUARDIAN get 403; ADMIN gets 403 on owner-only routes;
    - module off returns 403; another institute's id returns 404;
    - validation returns 422;
    - audit rows are written;
    - a suggestion never applies a discount until confirmed, and removing a member stops the discount for new periods.
- **A4 Web:** `/fees/setup` with these tabs, built from the v3 kit (`SectionCard`, `FormGrid`, `ActionBar`, `DataTable`, `Pill`) plus a new v3 `MoneyField` that accepts Bangla digits:
  - Heads, including the fine rule.
  - Amounts: classes × heads, with group overrides.
  - Terms.
  - Concessions.
  - Siblings: suggestion cards ("সম্ভাব্য ভাইবোন — একই অভিভাবকের ফোন") with Confirm, confirmed families with Remove, and "add a family" by student search.
  - Settings: `dues_from`, receipt SMS, sibling rule, receipt note.
  - Bilingual text: a `fees` namespace in bn.json and en.json.
- **A5 Teacher + accountant**
  - **Staff page** (`apps/web/src/app/(app)/staff/page.tsx`): when FEES is on, a staff row without ACCOUNTANT gets a one-step action, "ফি আদায়ের দায়িত্ব দিন" (give fee collection). It confirms, then calls the existing `PUT /staff/:userId/roles` with the current roles plus ACCOUNTANT. A "remove" action does the reverse. The roles hint says a teacher can also be the accountant.
  - **Fee settings:** a "Who collects fees" card lists ACCOUNTANT/ADMIN/OWNER staff and links to the staff page.
  - The existing rules apply unchanged (who may change roles, audit, role-cache version bump).
  - **Web:** check that the dashboard variant for a TEACHER+ACCOUNTANT shows both the attendance items and the fees card and quick action.
  - Tests in `fees-roles.e2e-spec.ts`:
    - TEACHER+ACCOUNTANT can collect and view reports;
    - they still take attendance only for their own sections;
    - they get 403 on setup and void;
    - TEACHER alone gets 403 on `/fees/*`;
    - removing ACCOUNTANT gives 403 on the next request.
- **A6 Seed** (`packages/db/src/seed/demo.ts`):
  - Shapla gets an ADMIN (`01711000003`) and an ACCOUNTANT (`01711000004`), with staff profiles. I'll confirm the numbers are free first.
  - Teacher `01711000002` also gets ACCOUNTANT, so the combined case is in the demo.
  - Shapla fee setup: heads, amounts for CLASS_6 and CLASS_9 (with a SCIENCE override), 2 terms, a 50% sibling rule on tuition, one half-free studentship, and `dues_from` set to the first of the month two months before the seed date.
  - Tasnim and Tahmid are left **unconfirmed**, so the suggestion shows.
  - Alo stays unset, so empty states get covered.
  - `docs/demo-accounts.md` is updated.
  - **The seed is not run until you approve.**

### Phase B: dues and ledger

- **B1 DB:** `fee_dues` and `fee_fine_waivers`, with RLS, CHECK and cache-CHECK tests.
- **B2 API:** `dues/fee-dues.service.ts`.
  - `ensureForStudents(ids, upTo?)` and `ensureForTenant()`: the shared planner, then `createMany({ skipDuplicates })` in chunks of about 500 per transaction.
  - Also `recalculateUnpaid` (whole institute or one family), plus `cancelDue` and `waiveFine` (both ADMIN/OWNER with a reason), and `recomputeDues`.
  - Each run writes one audit row.
  - **Job:** queue `fees` with the scheduler `generate-dues` at 00:30 Asia/Dhaka. It visits the ZSET `fees:tenants`; any FEES request re-adds its tenant after commit. It skips institutes with FEES off or suspended.
  - **Correctness never depends on the job.** The counter, ledger and guardian views generate dues lazily per student. Reports, reminders and the dashboard generate per tenant, at most once a day (`SET fees:ensured:<tenant>:<date> NX`).
  - Ledger endpoint: dues (including earlier years' arrears), concessions, sibling link, fines, waivers, payments and balance.
  - Tests in `fees-dues.e2e-spec.ts`:
    - generation run twice, and 5× in parallel, gives the same rows;
    - `dues_from` and the admission month are respected;
    - ONCE is charged once across years and never before `one_time_from`;
    - inactive and deleted students get nothing;
    - the group override applies;
    - the concession is max(manual, confirmed sibling);
    - a cancelled due is never regenerated;
    - after deleting the Redis set, the lazy path still produces dues.
- **B3 Web:** `/fees/students/[id]` ledger: phone cards and a desktop `DataTable` with a `tfoot` total. Waive and cancel dialogs for admins.

### Phase C: collection counter, receipts, void, closing (OWNER/ADMIN/ACCOUNTANT)

- **C1 DB:** `fee_receipt_counters`, `fee_payments` (column grants and trigger), `fee_payment_allocations`.
  - **C2 DB:** a separate migration adds the SMS purposes.
  - Tests in `fees-payments-rls.test.ts`:
    - the app role cannot DELETE or UPDATE the amount;
    - VOID→ACTIVE raises; the void CHECK holds;
    - a cross-student allocation fails its FK;
    - 20 concurrent connections, with every third rolling back, still produce contiguous receipt numbers.
- **C3 API:** `collection/fee-collection.service.ts` and `fee-counter.controller.ts`.
  - Search: `searchStudentIds` by name, ID or phone, plus class + roll. Phones are masked unless the caller is OWNER/ADMIN.
  - **Collect** (`POST /fees/payments`): `{studentId, dueIds, advance[], amountPaisa, method:'CASH', expectedOutstanding, clientRequestId}`.
    1. Take the locks.
    2. Run the replay check.
    3. A stale state returns 409 `DUES_CHANGED` with the current state; an amount over the total returns 422.
    4. Allocate.
    5. Take the receipt number.
    6. Write the audit row.
    7. Queue the receipt SMS: dedupe `receipt:<paymentId>`, the cap applies, and the relevance check means it is sent only if the payment is still ACTIVE.
  - Receipt endpoint `GET /fees/payments/:id`.
  - Closing `GET /fees/closing?date&collectorId`: an accountant sees only their own; admins see anyone. Totals are by method and channel, with the receipt range and voids listed. Names come from `staff_profiles`.
  - Tests in `fees-collect.e2e-spec.ts`:
    - partial payments; several months and heads;
    - replay returns the same receipt; the 409 and 422 paths;
    - 30 parallel collects plus 5 failing ones (`TestController` "collect-then-fail") give contiguous numbers;
    - SMS is queued after commit, not on rollback, held over the cap, and its cost is logged on send;
    - phones are masked;
    - `no-global-names` covers the fee endpoints.
- **C4 API void** (`POST /fees/payments/:id/void`, OWNER/ADMIN, reason 3–500).
  - Flips the status, recomputes the dues, writes the audit row, cancels an unsent receipt SMS, and frees the TrxID (a linked submission becomes VOIDED).
  - Tests: ACCOUNTANT gets 403; a second void returns 409; the fine resumes; the receipt shows VOID.
- **C5 Web**
  - `/fees` counter, phone-first: search (Bangla digits), result cards, then the ledger with checkboxes and an "advance months" expander. A sticky total bar opens a bottom sheet with the amount, an allocation preview and a confirm button.
  - `/fees/receipts/[id]`: a Bangla receipt with institute, receipt no., date, student, ID, class/section/roll, lines, fine, total, amount in words, method/TrxID, collector, balance after, and a VOID stamp with reason.
    - Print uses named `@page receipt-a5 { size: A5 }` / `receipt-80` rules in `globals.css`, leaving the A4 register rule alone.
    - The A5/80mm choice is stored per device in localStorage.
  - `/fees/closing`, printable.
  - Nav `fees` gets `soon:false`, and FeesTabs are filtered by role.

### Phase D: manual bKash/Nagad

- **D1 DB:** `fee_mobile_accounts`, `fee_mobile_submissions`, `fee_mobile_submission_dues`, with RLS and partial-unique tests.
- **D2 API**
  - Guardian: `POST /me/children/:id/fees/submissions`.
    - Checks ownership (another child returns 404).
    - Normalises input with `toAsciiDigits`, uppercase and `normalizeBdPhone`.
    - Rate limits: at most 5 pending per child and 20 per hour per user.
    - Staff can submit too (`POST /fees/submissions`).
  - Under the TrxID lock, both tables are checked; a match returns 409 `TRX_ID_USED`.
  - Verify (ACCOUNTANT/ADMIN/OWNER): creates the payment with `paid_on` = the submission date, the receipt and the SMS. The verifier may re-pick dues, including advance months, if the original ones were paid meanwhile.
  - Reject requires a reason.
  - `PUT /fees/mobile-accounts`: OWNER only, audited.
  - Tests in `fees-mobile.e2e-spec.ts`:
    - duplicates: pending, verified, cross-channel;
    - allowed: the other method, another institute, after a reject, after a void;
    - concurrent verifies create exactly one payment;
    - the fine is computed at the submission date;
    - ADMIN gets 403 changing numbers.
- **D3 Web**
  - The guardian `ChildCard` shows the balance and links to `/children/[id]/fees`.
  - That page has a submit sheet showing the institute's numbers.
  - The staff queue `/fees/submissions` has verify and reject, plus "record bKash/Nagad".
  - Fee settings get the numbers card (OWNER edits, ADMIN reads).
  - Add `/children/:path*` to `proxy.ts`.

### Phase E: reports, reminders, dashboard, guardian history

- **E1 Reports** (OWNER/ADMIN/ACCOUNTANT)
  - Due list by class/section, defaulters (overdue, with minimum days or amount), and collections by day/month/head/method/collector.
  - CSV through `toCsv`/`csvCell` with ASCII digits, BOM and CRLF, using the attendance download pattern. Printing uses `.print-area`.
  - Payments from deleted students still count.
  - Tests: `=HYPERLINK(...)` in a name is escaped; totals larger than 2³¹ work.
- **E2 Reminders** (OWNER/ADMIN)
  - Preview returns: recipients, those without a phone, already reminded, segments, cost (segments × platform rate), what the cap has left today, and how many would be held.
  - Confirm sends `expectedRecipients`; if the count changed it returns 409 `PREVIEW_CHANGED`.
  - The job carries `actorUserId`, re-checks the role, and works in chunks of 25.
  - Dedupe key `fee-reminder:<student>:<latest overdue period>`. The relevance check means it is sent only if the student still owes.
  - Run status comes from `sms_logs` via `related_id`.
  - Tests: dedupe, held over the cap, cancelled when paid before sending.
- **E3**
  - `GET /fees/summary` drives a real dashboard KPI tile: collected this month with the change against last month, overdue in the hint, and a pending-verification attention card. The quick action is enabled.
  - Guardian `GET /me/children/:id/fees` returns dues, payments, submissions and payment options; guardians can view their own receipts.
  - Tests: guardian A gets 404 for guardian B's child; TEACHER gets 403 on every `/fees/*`; GUARDIAN gets 403 on staff routes.
  - Update the `module-card-fees` expectation in `e2e/auth.spec.ts`.

### Closing part

- **Docs**
  - New `docs/fees.md`, like `attendance.md`.
  - `database.md`: fee tables, history without DELETE, the void column grant plus trigger, sibling links.
  - `auth.md`: the job tenant context and system audit; guardian fee routes; combined roles.
  - `decisions-pending.md`: #19 updated; this step's decisions added.
  - `design-backlog.md`: the SMS cap move and the FEES-only gating gap, editable fee SMS templates, family receipts, a thermal printer check.
  - New **`docs/backlog.md`**: deferred product work. It holds the **full Phase F plan below** as the next step, plus a one-line pointer in CLAUDE.md beside the design-backlog line.
  - `demo-accounts.md`, and `CLAUDE.md` commands gets "Fees rules: docs/fees.md".
- **Gates, then the PR.** Push, then open the PR for phases 0 and A–E.

## Playwright (`apps/web/e2e/`)

- `fees-counter.spec.ts`, at 360×780 on a touch device, in bn and then en:
  - the accountant logs in and searches with a Bangla-digit phone, which shows masked;
  - selects 2 months and pays part of the amount;
  - the receipt shows its number in ASCII digits;
  - `emulateMedia('print')` shows only the receipt, and the A5 PDF is one page;
  - an admin voids it and the VOID stamp shows.
- `fees-mobile.spec.ts`, in bn and en: the guardian logs in by OTP (from the outbox), submits a TrxID, the accountant verifies it, and the guardian sees the receipt.
- `staff`: give a teacher fee collection in one action; that teacher then sees the counter.
- Fee pages are added to the existing 360 px overflow and 44 px target checks (`layout.spec.ts`) and to the themes sweep.

## Verification

1. **Per part:**
   - Drift check prints an empty migration.
   - `pnpm --filter @jantrik/db test`, `pnpm --filter @jantrik/shared test`, and `pnpm --filter @jantrik/api test -- fees-…`.
2. **Final gates:** `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, `pnpm test`, `pnpm build` (after clearing `apps/web/.next/cache/turbopack`), then `pnpm e2e` with ports checked free. Only processes I started get stopped.
3. **Manual walkthrough** with `pnpm dev`, **after you approve `pnpm db:seed`**:
   - the owner sets up fees and confirms the sibling suggestion;
   - the teacher-accountant collects and prints at 390 px;
   - the admin voids;
   - the guardian submits a TrxID and the accountant verifies;
   - the reminder preview;
   - the dashboard card.
   - Screenshots in bn at 1366 and 390 px.
4. **Performance:** the `/fees` counter at 390 px with 4× CPU and slow 4G should be interactive within 3 s, measured with an interleaved A/B against main.
5. **Report:** the files changed, how to run and test, and anything left undone.

## Risks

- **Scope.** This is about 15 tables, 5 migrations, around 35 endpoints and around 11 screens. Each part is committed separately.
- **Voiding refunds nothing.** Voiding a mobile payment does not return money; the UI says so.
- **Thermal printing.** Printer drivers may ignore `@page` sizes, so the receipt also fits 80 mm by width alone.
- **Exam terms.** `fee_terms` may later merge with exam terms.

---

## Deferred: Phase F, bKash tokenized checkout (NOT built in this step; copied to docs/backlog.md)

Per the bKash developer docs (checked 2026-10-22):

- Sandbox base URL `https://tokenized.sandbox.bka.sh/v2/tokenized-checkout/`, with endpoints `auth/grant-token`, `auth/refresh-token`, `payment/create`, `payment/execute` and `query/payment`.
- **At most 2 grant or refresh calls per hour**, otherwise bKash blocks refresh for an hour.
- A timeout is not a failure: query the payment first.
- A payment ID is valid for 24 hours and can be executed once.
- The docs publish no sandbox credentials.

The plan:

- **Credentials**
  - Table `fee_gateway_credentials`: provider BKASH, `mode` CHECK `'SANDBOX'`, enabled, nullable `secret_ciphertext`/`token_ciphertext`, expiries, last test result. Grants S I U.
  - Encryption: AES-256-GCM `secret-box` with AAD `fees-gateway:bkash:<tenantId>`, keyed by `FEES_GATEWAY_KEY` (required in production).
  - Other env: `WEB_PUBLIC_URL` (callback), and `BKASH_BASE_URL` (override refused in production).
  - `PUT` is OWNER-only and write-only. GET returns `{configured, enabled, updatedAt, lastTest}`. The audit stores field names only.
  - A "test connection" job, and a code-scan test that ciphertext is read only by the credentials service.
- **Client**
  - Fixed error codes, never response bodies or headers. Money parsed from strings into exact paisa. A 30 s timeout.
  - The token is stored encrypted on the credentials row behind a Redis lock and refreshed at 50 min, to respect the 2-per-hour limit.
  - A fake bKash server serves the API and Playwright tests; an opt-in sandbox smoke script needs credentials from the owner.
- **Flow.** Tables `fee_gateway_intents` (status CREATING\|AWAITING_PAYER\|EXECUTING\|COMPLETED\|FAILED\|NEEDS_REVIEW) and `fee_gateway_intent_dues`; queue `fees-gateway`. No HTTP inside a transaction.
  1. The guardian creates an intent; the server computes the amount.
  2. A create job gets the bKash URL, and the page redirects to it.
  3. bKash returns to `/pay/bkash/return` (add `/pay/:path*` to `proxy.ts`). The `paymentID` must match, and the URL status is never trusted.
  4. An execute job runs, querying instead on a timeout.
  5. Completion locks the intent and verifies the amount, BDT, `merchantInvoiceNumber`, `Completed` and the `paymentId`. It then records the payment, receipt and SMS, with the guardian as the actor.
- **Reconcile jobs** at +5 m, +30 m, +2 h and +25 h. A payer who verified but was never executed gets executed (to be confirmed in the sandbox). After 24 h the intent is FAILED.
- **Excess, mismatch, or a TrxID conflict** sets NEEDS_REVIEW. Excess spills to other open dues first, and the remainder shows as "unapplied". An admin resolves it by applying the remainder or marking it refunded outside the app with a reason.
- **Tests**
  - Happy path, cancel, execute timeout followed by a query, double return gives one payment.
  - Amount mismatch; excess from a race.
  - Another guardian gets 404.
  - The token is reused.
  - Sentinel credentials never appear in responses, logs, `audit_logs`, `sms_logs`, a Redis scan (including BullMQ failed jobs) or validation errors.

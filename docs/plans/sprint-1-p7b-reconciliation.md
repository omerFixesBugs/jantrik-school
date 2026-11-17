# Sprint 1, P7b: reconciliation and the review queue for online payments (implementation plan)

**Status: plan only (day run 2026-11-18), not approved, no code yet.** Written while the owner was
away. It details [sprint-1.md](sprint-1.md) → "P7b: Reconciliation and review queue", approved
on 2026-11-14, and builds on [sprint-1-p7a-online-payments.md](sprint-1-p7a-online-payments.md)
(P7a, not built yet: every P7a name used here is defined there). S22 and S23 stand as approved:
nothing in P7b posts money without a person deciding, except a reconciliation that finds a
payment which passes every P7a check, exactly as an IPN would. The new decisions are P7b-A to
P7b-O at the end, each with a recommended default.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.
> One review subagent (money).

**Goal:** no online payment is ever lost or left undecided. SSLCommerz is asked about every
payment on a fixed schedule, so a lost IPN and a closed browser tab still end in a receipt or in
the review queue. An owner or admin works through the queue (apply the money to chosen dues, mark
it refunded outside the app, or dismiss an item that holds no money), each action audited. The
fees reports, the daily closing and the dashboard show online money and what waits for review.

**Architecture:**

- **Reconciliation:** when a session is made (`REDIRECTED`), P7a's init job also queues four
  delayed `reconcile` jobs (+5 min, +30 min, +2 h, +25 h after init, the sprint plan's schedule)
  and puts the intent in a Redis sorted set `payments:open`. A `reconcile` job queries
  SSLCommerz by `tran_id` (Transaction Query API) and feeds every successful attempt into P7a's
  `confirm` path (Order Validation API, then `settle`): one decision path for every signal. At
  +25 h an intent with no success becomes `EXPIRED`.
- **Healing after a Redis loss:** a 10-minute `payments-sweep` scheduler re-adds overdue members of
  `payments:open`; the nightly fee run (which already visits each fee-using institute in its own
  context) re-queues that institute's intents still open after an hour; the guardian's payment page
  (P7a) and the review page heal on read. No query ever runs across institutes.
- **Review queue:** two kinds of items. **Intents** in `NEEDS_REVIEW` (reasons from P7a), and
  **signals**: validated money that no intent holds (`UNMATCHED`) or that came twice (`DUPLICATE`),
  i.e. P7a's VALIDATE events with a `review_reason`. Actions run in the admin's request
  transaction under the student's fee lock and the intent's row lock, so two admins, a late
  signal and the counter serialise.
- **Reports:** online payments by day and status with CSV; the daily closing's "online
  (SSLCommerz)" line; the dashboard's "to check" count includes the queue.

**Tech stack:** as P7a. No new dependency.

**Spec:** sprint-1.md → P7b, "Review focus" 1 and 2, S23 and S24.

**Branch:** `feature/sprint-1-p7b-reconciliation` from `main` after P7a2 is merged.

## What exists today (verified in the code on 2026-11-18, `integration/sprint-1` at `c8571025`)

Nothing of P7a or P7b exists yet. What P7b reuses from today's code:

- **Daily closing:** `FeeCollectionService.closing()`
  (`apps/api/src/fees/collection/fee-collection.service.ts:442-519`): per collector and method
  (`METHOD_ORDER`, `:66`), a payment on its recorded day, a void on the day it was made, totals
  collected, voided, net and cash in hand; an ACCOUNTANT sees only their own (`:447-450`).
- **Reports:** `FeeReportsService.collections()` (`apps/api/src/fees/reports/fee-reports.service.ts:248`,
  grouped by day, month, head, method or collector, void payments left out) and its CSV
  (`:326`); `sendCsv()` in `fees.module.ts:126` (UTF-8 with BOM, no-store); `summary()` (`:343`)
  with `pendingSubmissions`, read by the dashboard (`apps/web/src/app/(app)/dashboard/page.tsx:866`).
- **The nightly fee run:** `FeeDuesProcessor.generateAll()`
  (`apps/api/src/fees/dues/fee-dues.processor.ts:122`) visits every institute in the Redis sorted
  set `fees:tenants` (`fee-dues.service.ts:39`) at 00:30 Asia/Dhaka (`:55-59`), each inside
  `TenantJobRunner.run`.
- **Verify/reject of manual transfers** (`apps/api/src/fees/mobile/fee-mobile.service.ts:379-455`):
  the model for "a person decides about money": lock the student, replay a retried
  `clientRequestId`, refuse a second decision (409 `ALREADY_REVIEWED`), re-pick dues and periods
  paid ahead (`ensureAdvance`), `recordPayment`, audit old and new status.
- **Paying ahead:** `FeeDuesService.ensureAdvance()` (`fee-dues.service.ts:576`) creates future
  periods inside a payment, as the counter does.
- **A delayed job, a sorted set and a sweep:** P6b (#26, not merged) uses `notices:due` with a
  5-minute sweep and heal on read for scheduled broadcasts; P7b follows the same pattern.
- **The bKash plan** in `docs/backlog.md` (reconcile at +5 m, +30 m, +2 h, +25 h; excess shown as
  unapplied; refunded outside the app) is where this design comes from.

## Global constraints

- **Module and roles:** every route `@RequireModule('FEES')`. The queue, its items, the online
  payments list and report: OWNER, ADMIN, ACCOUNTANT read. Actions (apply, refund outside,
  dismiss, check now): OWNER and ADMIN (the sprint plan; P7b-D). Guardians see only P7a's
  payment view.
- **S23 kept:** a review item is never posted by a job. Reconciliation posts only what P7a's
  `settle` would post for an IPN (every check passing), and never touches an intent already in
  `NEEDS_REVIEW`.
- **Money never vanishes from the books:** an item with validated money ends only as applied
  (a `fee_payments` row) or refunded outside (with a reason), never dismissed (P7b-E).
- **One live payment per intent** (P7a's partial unique index); `applied + refunded outside =
validated amount` for every resolved intent (a CHECK).
- **Locks:** P7a's order (tenant shared → student → intent row); a signal item locks its event's
  intent's student when it has one, and the institute's `payments-signal` advisory lock otherwise.
- **No HTTP call inside a transaction:** a reconcile or "check now" queries SSLCommerz in a job,
  between two short transactions. Job data carries ids only.
- **Audit (CLAUDE.md rule 6):** every action writes `audit_logs` (`payment_intent` UPDATE with old
  and new status, the dues, the amounts, the reason; `payment_signal_review` CREATE); applying also
  writes `fee_payment` CREATE through `recordPayment`.
- **Strings and digits:** bn and en; amounts, counts and dates in Bangla digits in bn;
  `tran_id`, `bank_tran_id`, `val_id`, receipt numbers and refund references in ASCII.
- **Screens:** v3 kit, light-first; screenshots bn at 1366 and 390 px.
- **Gates:** affected tests during the work; full gates, the review subagent, the PR with CI green.

## Review focus

1. **One payment, three signals, plus a reconciliation** (sprint review focus 1). A reconcile
   finding the same `val_id` an IPN is posting at that moment. Expected: one payment. Test:
   Task 2.
2. **Counter and online money** (sprint review focus 2): the queue shows the online money of a
   `DUES_CHANGED` item as unapplied; applying it to other dues (or periods ahead) makes one
   payment; the rest is recorded as refunded outside in the same action; nothing is applied twice.
   Test: Task 4.
3. **Two people decide at once.** Two admins apply the same item; an admin applies while a late
   signal arrives; an admin refunds while another applies. Expected: exactly one decision, the
   other 409 `ALREADY_RESOLVED`. Test: Task 4.
4. **A success after `EXPIRED`** (the sprint plan): `NEEDS_REVIEW` `LATE_SUCCESS`, never a silent
   receipt. Test: Task 2.
5. **No silent dismissal of money.** Dismissing an item that holds validated money → refused;
   dismissing one without money → only after a fresh query found no success. Test: Task 4.
6. **Totals add up.** The closing's online line, the online report and the collections report
   agree for a day with payments, a void and an applied review item. Test: Task 5.

## Database

One migration, `…_payment_reviews` (in a day run, the `2026111760…` band), after P7a's. All
policies `tenant_id = (SELECT app_current_tenant_id())`; CHECKs NULL-safe; no backfill (columns
nullable, enum values already created by P7a).

### `payment_intents`: resolution columns (UPDATE grant extended to them)

| Column                   | Type             | Rule                                                                                |
| ------------------------ | ---------------- | ----------------------------------------------------------------------------------- |
| `resolved_by_id`         | uuid NULL        | → `users`                                                                           |
| `resolved_at`            | timestamptz NULL | both NULL or both set                                                               |
| `resolution_note`        | text NULL        | ≤ 500                                                                               |
| `applied_paisa`          | int NULL         | the applied payment's amount                                                        |
| `refunded_outside_paisa` | int NULL         | the part (or all) recorded as refunded outside                                      |
| `refund_reference`       | text NULL        | what the institute's records call the refund (≤ 100; ASCII letters, digits, `-_./`) |
| `last_checked_at`        | timestamptz NULL | the last query by `tran_id`                                                         |
| `last_check_outcome`     | text NULL        | `SUCCESS_FOUND`, `PENDING`, `NO_SUCCESS`, or a provider error code                  |

CHECKs:

- `status <> 'REFUNDED_OUTSIDE' OR (resolved_at IS NOT NULL AND refunded_outside_paisa =
validated_amount_paisa AND applied_paisa IS NULL AND resolution_note IS NOT NULL)`;
- `status <> 'DISMISSED' OR (resolved_at IS NOT NULL AND validated_amount_paisa IS NULL AND
resolution_note IS NOT NULL)` (money is never dismissed);
- `applied_paisa IS NULL OR (applied_paisa >= 1 AND applied_paisa + COALESCE(refunded_outside_paisa,

0. = validated_amount_paisa)`;

- `refunded_outside_paisa IS NULL OR refunded_outside_paisa >= 1`.

P7a's guard trigger already allows `NEEDS_REVIEW` → `PAID`, `REFUNDED_OUTSIDE`, `DISMISSED` and
`DISMISSED` → `NEEDS_REVIEW`; P7b extends it: `resolved_*`, `applied_paisa`,
`refunded_outside_paisa` and `refund_reference` are written only in the move out of
`NEEDS_REVIEW`; a later return to `NEEDS_REVIEW` (a void of the applied payment, a late success
after a dismissal) keeps the earlier values in the audit log and clears them on the row.

### `payment_signal_reviews` (new tenant table; jantrik_app S I) (P7b-C)

| Column                          | Type                       | Rule                                                                                                        |
| ------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `id`, `tenant_id`               | uuid                       |                                                                                                             |
| `event_id`                      | uuid NOT NULL              | composite FK → `payment_gateway_events`; UNIQUE `(tenant_id, event_id)`: one decision per item, final       |
| `outcome`                       | text NOT NULL              | CHECK `IN ('REFUNDED_OUTSIDE','DISMISSED')`                                                                 |
| `amount_paisa`                  | int NULL                   | the event's validated amount (REFUNDED_OUTSIDE); CHECK `outcome <> 'REFUNDED_OUTSIDE' OR amount_paisa >= 1` |
| `refund_reference`, `note`      | text NULL, text NOT NULL   | as above; note 3–500                                                                                        |
| `resolved_by_id`, `resolved_at` | uuid, timestamptz NOT NULL |                                                                                                             |
| `created_at`, `updated_at`      |                            |                                                                                                             |

- Index `(tenant_id, resolved_at)`. Grants `SELECT, INSERT` (history: no UPDATE, no DELETE).
- A deferred constraint trigger: the event is a VALIDATE event with a `review_reason`.
- Checklist: tenant_id NOT NULL ✓, `(tenant_id, id)` unique ✓, composite FK ✓, ON UPDATE
  RESTRICT ✓, leading index ✓, RLS enabled + forced + `tenant_isolation` ✓, grants ✓,
  schema-safety list ✓, isolation test (`packages/db/test/payments-rls.test.ts`) ✓.

## Reconciliation

### The schedule (P7a's init job, extended)

When an intent becomes `REDIRECTED`, after commit: four delayed `reconcile` jobs
`{ tenantId, intentId, step }`, job ids `rec-<intentId>-<step>`, delays 5 min, 30 min, 2 h and
25 h; `ZADD payments:open <due time> <tenantId>:<intentId>:<step>`. An intent that fails at init
gets none.

### A `reconcile` step

1. Transaction (no actor): the intent and the account's credentials. Skip (and `ZREM`) when the
   intent is `PAID`, `REFUNDED_OUTSIDE` or `DISMISSED` **except at step 4**, which runs for every
   intent so a second success (`DUPLICATE`) or a success after a close is found (P7b-J).
2. Outside a transaction: `query(creds, tranId)`; a QUERY event; `last_checked_at`,
   `last_check_outcome`.
3. For every VALID/VALIDATED attempt whose `val_id` has no VALIDATE event: P7a's `confirm` path
   (Order Validation API, then `settle`). A query answer alone never posts (P7b-A).
4. No success found:
   - steps 1–3: a `PENDING` attempt changes nothing; only `FAILED` attempts, and the intent past
     `expires_at` → `FAILED` (the payer had the whole window); nothing found → nothing yet;
   - step 4 (+25 h): an intent still `CREATED` or `REDIRECTED` → `EXPIRED` (PENDING included, as
     the sprint plan says), audited; one extra query at +7 days for an intent that was `PENDING`
     at +25 h (P7b-K).
5. `ZREM` the member; a provider `ERROR` retries the step (3 attempts, from 1 minute), then leaves
   the member for the sweep.

A success found after `EXPIRED` (by step 4's extra query, an IPN, "check now") goes through
`settle`, which sends it to `NEEDS_REVIEW` with `LATE_SUCCESS` (P7a's table).

### Healing (Redis loses jobs)

- **`payments-sweep`** (`upsertJobScheduler`, every 10 minutes): `ZRANGEBYSCORE payments:open
-inf <now - 2 min>`, re-add each `reconcile` with the same job id (a no-op while it exists);
  members older than 8 days are dropped.
- **The nightly fee run** (`generateAll`, per institute, in its own context): intents of that
  institute still `CREATED`/`REDIRECTED` an hour after creation, or `PAID` within the last 26 hours
  without a step-4 QUERY event, get their missing steps re-queued. This covers a wiped Redis
  within a day without any cross-institute SQL (P7b-B).
- **Heal on read:** P7a's guardian payment page; the queue page re-queues a `reconcile` for any
  open intent of the institute overdue by more than 10 minutes (at most once a minute per
  institute).

### "Check now"

`POST /fees/online-payments/:intentId/check` (OWNER/ADMIN/ACCOUNTANT): queues a `reconcile` with
step `manual` (`pay-check:<intentId>`, once a minute; 202). The page polls `last_checked_at`.
Dismissing an intent needs a check finished within the last 15 minutes that found no success
(below).

## The review queue

### Items

| Kind   | What                                                                     | Reasons                                                                                                                        | Money shown                                                                                                                                                          |
| ------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intent | `payment_intents` in `NEEDS_REVIEW`                                      | `AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`, `TRAN_ID_MISMATCH`, `HIGH_RISK`, `DUES_CHANGED`, `LATE_SUCCESS`, `DUPLICATE`, `VOIDED` | the validated amount (or "no money confirmed yet"), store amount, method, `bank_tran_id`, the child, the payer, the chosen dues with what they owed then and owe now |
| Signal | VALIDATE events with `review_reason` and no `payment_signal_reviews` row | `UNMATCHED` (a payment to the institute's store that no intent of ours holds), `DUPLICATE` (a second payment for an intent)    | the validated amount, method, `bank_tran_id`, `tran_id`, the intent and child when there is one                                                                      |

- Ordered oldest first; each item shows when SSLCommerz was last asked and what it said.
- Unmatched IPNs that SSLCommerz called invalid are not items; the page lists them for 30 days in a
  collapsed "checked, not a payment" section.

### Actions (OWNER/ADMIN; the request transaction; audited)

The sprint plan's three actions: "apply to chosen dues" is **Apply** (post), "mark refunded
outside the app" is **Refunded outside**, and "resolve with a note" is **Dismiss** (reject: nothing
to post). Each writes an `audit_logs` row with the old and new state, the amounts, the dues and the
note.

| Action               | Allowed for                                                               | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Errors                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Apply**            | intent items with validated money in BDT (not `CURRENCY_MISMATCH`, P7b-G) | `{ dueIds, advance, applyPaisa, expectedOutstandingPaisa, refundOutside?: { reference?, note }, note, clientRequestId }`: chosen dues of the intent's child (and periods ahead); `applyPaisa` ≤ validated amount and ≤ what they owe on the payment day; a remainder must be recorded as refunded outside in the same action (P7b-E). `recordPayment` with channel GATEWAY, the method, `trx_id` = `bank_tran_id`, `paid_on` = the gateway's payment day (P7b-F), actor = the admin; the intent → `PAID` with `applied_paisa`, `refunded_outside_paisa` | 409 `ALREADY_RESOLVED`, `DUES_CHANGED`; 422 `AMOUNT_EXCEEDS_DUE`, `REMAINDER_NEEDS_REFUND`, `NO_MONEY`, `CURRENCY_NOT_APPLICABLE`; a retried `clientRequestId` → the same receipt |
| **Refunded outside** | intent items with validated money; signal items                           | `{ note (3–500), reference? }`: the whole amount recorded as given back outside the app; intent → `REFUNDED_OUTSIDE`; a signal item gets a `payment_signal_reviews` row                                                                                                                                                                                                                                                                                                                                                                                 | 409 `ALREADY_RESOLVED`; 422 `NO_MONEY`                                                                                                                                            |
| **Dismiss**          | intent items **without** validated money; signal items                    | `{ note }`; an intent needs a check in the last 15 minutes that found no success (else 409 `CHECK_FIRST`); intent → `DISMISSED` (its dues free again; a success that still arrives comes back as `LATE_SUCCESS`)                                                                                                                                                                                                                                                                                                                                        | 409 `ALREADY_RESOLVED`, `CHECK_FIRST`; 422 `HAS_MONEY`                                                                                                                            |

- **Apply for signal items is not offered** (P7b-H): unmatched money did not come through our
  checkout (no S22 snapshot, no payer), and a duplicate is normally given back.
- **Concurrency:** apply, refund and dismiss take tenant shared → student → intent `FOR UPDATE`
  (a signal without an intent: the institute's `payments-signal` advisory lock, then the event's
  row by its unique review insert); the decision is re-checked on the locked row. A late signal's
  `settle` waits on the same locks and then sees the resolved state (P7a's table: a different
  `val_id` becomes a `DUPLICATE` signal item).
- **Void of an applied payment** (P7a's hook): the intent back to `NEEDS_REVIEW` with `VOIDED`;
  the earlier decision stays in the audit log.
- **What the guardian sees** (P7a's view): `PAID` after an apply (with the receipt), `REFUNDED`
  after a refund outside, `NOT_PAID` after a dismissal. No reasons.

## Reports

- **`GET /fees/reports/online-payments?from&to`** (OWNER/ADMIN/ACCOUNTANT): per day of creation in
  the institute's timezone: initiated (count, amount), paid (count, amount, store amount, gateway
  charges = amount − store amount, S24), failed or cancelled, expired, under review (count, amount
  validated), refunded outside; totals. `…/csv` with a BOM, ASCII digits for ids, formula-safe
  cells, as the other fee CSVs. At most 366 days.
- **Daily closing:** `FeeClosing` gains `online: { count, amountPaisa, byMethod, voided: [...],
netPaisa } | null`, counting GATEWAY payments by recorded day (voids on their own day, as
  today), not under any collector; `total.collectedPaisa` and `netPaisa` include it,
  `cashInHandPaisa` does not. Shown only in the whole-institute view (OWNER/ADMIN, no collector
  filter); an accountant's own closing has no online line (P7b-L).
- **Dashboard:** `FeeSummary` gains `onlineToReview` (intent items + signal items); the "to check"
  tile sums it with `pendingSubmissions` and links to the queue when it is the larger part.
- **Collections by method** already lists ROCKET, CARD, OTHER_ONLINE (P7a Task 10); by collector it
  shows "Online (SSLCommerz)" as one row for GATEWAY payments instead of guardian ids.

## API

| Route                                                          | Roles                    | Does                                                                           |
| -------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| `GET /fees/online-payments?status&from&to&q`                   | OWNER, ADMIN, ACCOUNTANT | intents, newest first, 50 a page; `q`: `tran_id`, `bank_tran_id`, student code |
| `GET /fees/online-payments/:id`                                | OWNER, ADMIN, ACCOUNTANT | one intent with its dues, events (whitelisted fields) and decisions            |
| `POST /fees/online-payments/:id/check`                         | OWNER, ADMIN, ACCOUNTANT | 202, queues a query                                                            |
| `GET /fees/online-payments/review`                             | OWNER, ADMIN, ACCOUNTANT | the queue (both kinds), oldest first                                           |
| `POST /fees/online-payments/:id/apply`                         | OWNER, ADMIN             | as above                                                                       |
| `POST /fees/online-payments/:id/refunded-outside`              | OWNER, ADMIN             | as above                                                                       |
| `POST /fees/online-payments/:id/dismiss`                       | OWNER, ADMIN             | as above                                                                       |
| `POST /fees/online-payments/signals/:eventId/refunded-outside` | OWNER, ADMIN             | a signal item                                                                  |
| `POST /fees/online-payments/signals/:eventId/dismiss`          | OWNER, ADMIN             | a signal item                                                                  |
| `GET /fees/reports/online-payments`, `…/csv`                   | OWNER, ADMIN, ACCOUNTANT | the report                                                                     |

All `@RequireModule('FEES')`; another institute's id → 404. Jobs on the `payments` queue:
`reconcile` `{ tenantId, intentId, step }`, `payments-sweep` (no data).

## Web

- **`/fees/online-payments`** (a new fees tab "অনলাইন পেমেন্ট" / "Online payments", OWNER, ADMIN,
  ACCOUNTANT): filters (status, dates), search, the list (state chip, child, amount in Bangla
  digits, method, `tran_id` in ASCII, created), "Check with SSLCommerz" on a row.
- **`/fees/online-payments/review`** (the tab shows the count as a badge): items as cards with the
  reason in plain words ("The amount SSLCommerz confirmed differs from what we asked for",
  "SSLCommerz marked this payment as risky: verify the payer before applying", "These dues were
  paid another way while this payment was in progress", …), the money, the child, the dues then
  and now.
  - **Apply** dialog: the child's open dues and periods ahead (the counter's picker), the amount to
    apply (defaults to the smaller of the money and what is ticked), the remainder shown with a
    required "refunded outside: note, reference"; a preview of the receipt lines; confirm.
  - **Refunded outside** and **Dismiss** dialogs with a required note; Dismiss disabled until a
    check in the last 15 minutes found nothing.
  - ACCOUNTANT sees the queue without the action buttons.
- **Daily closing** page: the "Online (SSLCommerz)" block (count, by method, voided, net) under the
  collectors, not in cash in hand.
- **Reports:** the online payments report (table, CSV, print), in the reports tabs.
- **Dashboard:** the "to check" tile counts the queue too.
- **Strings:** `fees.online.*`, `fees.review.*`, `fees.closing.online*`, `fees.reports.online*` (bn
  and en).

## Files

| File                                                                                                                                                 | Change                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `packages/db/prisma/schema.prisma` + 1 migration                                                                                                     | resolution columns, `payment_signal_reviews`, trigger changes                  |
| `packages/db/test/payments-rls.test.ts`, `schema-safety.test.ts`                                                                                     | constraints, isolation                                                         |
| `packages/shared/src/payments-api.ts`, `fees-api.ts`                                                                                                 | queue, actions, report, closing and summary shapes                             |
| `apps/api/src/payments/reconcile.service.ts`, `review.service.ts`, `review.controller.ts`, `payments.processor.ts`, `checkout.service.ts` (schedule) | reconciliation, sweep, queue, actions                                          |
| `apps/api/src/fees/dues/fee-dues.processor.ts`                                                                                                       | the nightly re-queue hook (through an interface the payments module registers) |
| `apps/api/src/fees/collection/fee-collection.service.ts`, `reports/fee-reports.service.ts`                                                           | the closing's online line, the report, `onlineToReview`                        |
| `apps/api/test/payments-reconcile.e2e-spec.ts`, `payments-review.e2e-spec.ts`, `payments-reports.e2e-spec.ts`                                        | API tests                                                                      |
| `apps/web/src/app/(app)/fees/online-payments/**`, closing, reports, dashboard, `fees-tabs.tsx`, messages                                             | pages                                                                          |
| `apps/web/e2e/payments-review.spec.ts`                                                                                                               | Playwright                                                                     |
| `docs/payments.md` (completed), `fees.md`, `backlog.md`, `deploy.md`, `database.md`, `decisions-pending.md`                                          | docs                                                                           |

---

### Task 1: The migration

**Files:** schema, migration, `packages/db/test/payments-rls.test.ts`.

- [ ] **Step 1: Failing tests:** `REFUNDED_OUTSIDE` without a note or with an amount other than the
      validated one → CHECK; `DISMISSED` with validated money → CHECK; `applied + refunded ≠
validated` → CHECK; a second `payment_signal_reviews` row for one event → unique violation; a
      review row for an event without `review_reason` → refused at commit; isolation for the new
      table; no UPDATE or DELETE on it; resolution columns written outside a move out of
      `NEEDS_REVIEW` → refused by the trigger.
- [ ] **Steps 2–4:** FAIL, schema and migration (drift empty), PASS.
- [ ] **Step 5: Commit:** "Review decisions for online payments: applied, refunded outside or
      dismissed, with money never dismissed (sprint 1 P7b)".

### Task 2: Reconciliation

**Files:** `reconcile.service.ts`, `payments.processor.ts`, `checkout.service.ts`,
`apps/api/test/payments-reconcile.e2e-spec.ts`. Handlers are called directly with the fake
`Clock` and the fake SSLCommerz (BullMQ's own delays run on real time).

- [ ] **Step 1: Failing tests:**
  - init schedules four jobs and four `payments:open` members with the right delays;
  - **IPN and return both lost:** the payer pays on the fake gateway, no signal reaches us →
    step 1 (+5 min) finds VALID → validated → posted, one receipt;
  - step 1 finds PENDING → nothing; step 4 (+25 h) still PENDING → `EXPIRED`, audited; the +7 days
    query finds VALID → `NEEDS_REVIEW` `LATE_SUCCESS`, no payment (review focus 4);
  - only FAILED attempts before `expires_at` → still `REDIRECTED`; after → `FAILED`; nothing found
    at +25 h → `EXPIRED`;
  - **review focus 1:** a reconcile and an IPN for the same `val_id` at once → one payment;
  - step 4 on a `PAID` intent finds a second VALID attempt → a `DUPLICATE` signal item;
  - a query answer with VALID but a different amount → validated → `AMOUNT_MISMATCH` review (the
    query alone posts nothing);
  - an intent already in `NEEDS_REVIEW` → the query only records facts;
  - provider down → the step retries; still down → the member stays for the sweep.
- [ ] **Steps 2–5.** Commit: "Ask SSLCommerz about every online payment at 5 minutes, 30 minutes,
      2 hours and 25 hours; expire what never completed, and send late successes to review".

### Task 3: Healing

**Files:** `payments.processor.ts`, `reconcile.service.ts`, `fee-dues.processor.ts`,
`apps/api/test/payments-reconcile.e2e-spec.ts`.

- [ ] **Step 1: Failing tests:** the jobs removed from Redis by hand → the sweep re-adds them and the
      payment is posted once; `payments:open` itself deleted → the nightly run re-queues the
      institute's open intents (and only that institute's); the queue page heals an overdue intent
      at most once a minute; the guardian page heal from P7a still works.
- [ ] **Steps 2–5.** Commit: "Reconciliation survives a Redis loss: a sweep, the nightly per-institute
      re-queue and heal on read".

### Task 4: The review queue and its actions

**Files:** `review.service.ts`, `review.controller.ts`, `apps/api/test/payments-review.e2e-spec.ts`.

- [ ] **Step 1: Failing tests:**
  - the queue lists intent items with their reasons and signal items; another institute's items
    never; an ACCOUNTANT reads, a TEACHER or GUARDIAN gets 403;
  - **review focus 2:** January paid at the counter, the online ৳1 200 in review as
    `DUES_CHANGED` → apply ৳1 200 to February (paid ahead) → one GATEWAY payment, `paid_on` the
    gateway's day, the receipt, the intent `PAID`, `applied_paisa` 120000; apply ৳800 to a ৳800
    due with no refund given → 422 `REMAINDER_NEEDS_REFUND`; with "refunded outside ৳400, reason" →
    applied 80000, refunded 40000;
  - `HIGH_RISK` applied after a note; `AMOUNT_MISMATCH` (paid ৳1 199.99) applied as a partial
    payment; `CURRENCY_MISMATCH` → apply refused, refund outside accepted;
  - **review focus 3:** two admins apply at once → one payment, one 409 `ALREADY_RESOLVED`; apply
    while a late `settle` for another `val_id` runs → one payment, one `DUPLICATE` signal item;
    refund outside while another applies → one decision;
  - **review focus 5:** dismiss an item with money → 422 `HAS_MONEY`; without money and without a
    recent check → 409 `CHECK_FIRST`; after a check that found nothing → `DISMISSED`, its dues free;
    a success that arrives later → back to `NEEDS_REVIEW` `LATE_SUCCESS`;
  - signal items: refund outside and dismiss write one `payment_signal_reviews` row; a second
    decision → 409; apply is not a route;
  - void of an applied payment → `NEEDS_REVIEW` `VOIDED`; apply again → a new payment (one live);
  - a retried apply (`clientRequestId`) → the same receipt; every action audited with old and new
    values; the guardian's view follows (`PAID`, `REFUNDED`, `NOT_PAID`).
- [ ] **Steps 2–5.** Commit: "Review queue for online payments: owners and admins apply the money
      to chosen dues, record a refund made outside the app, or dismiss what holds no money (S23)".

### Task 5: Reports, closing and dashboard

**Files:** `fee-reports.service.ts`, `fee-collection.service.ts`, `packages/shared/src/fees-api.ts`,
`apps/api/test/payments-reports.e2e-spec.ts`, `fees-reports.e2e-spec.ts` (extended).

- [ ] **Step 1: Failing tests:**
  - **review focus 6:** a day with two online payments (bKash ৳1 000 with store amount ৳980, card ৳500),
    one of them voided the next day, one applied review item: the report's per-day rows, the
    gateway charges (৳20 + the card's), the closing's online line on each day, the collections
    report by method, and the summary's `onlineToReview` agree; the CSV has a BOM, ASCII ids and
    formula-safe cells;
  - the online line is not in cash in hand; an accountant's own closing has none; by collector
    shows one "online" row.
- [ ] **Steps 2–5.** Commit: "Online payments in the reports: by day and status with gateway
      charges, the daily closing's online line, and the dashboard's to-check count (S24)".

### Task 6: Web

**Files:** pages, tabs, closing, reports, dashboard, messages, `apps/web/e2e/payments-review.spec.ts`.

- [ ] **Step 1: Playwright (CI, the fake gateway, bn, 1366 and 390 px):** a guardian pays for
      January online while the accountant takes January in cash (the fake holds the IPN until the
      cash is in) → the admin sees the item ("paid another way"), applies it to February, the
      guardian's page shows the receipt; a risky payment (fake `risk_level 1`) is applied after a
      note; the accountant sees the queue without buttons; the closing shows the online line.
- [ ] **Steps 2–4**, screenshots.
- [ ] **Step 5: Commit:** "The online payments list, the review queue with its actions, and online
      money in the closing and reports".

### Task 7: Docs

- `docs/payments.md` (completed): states, the decision table, signals, reconciliation and healing,
  the queue and its rules, what the guardian sees, the reports, the owner's sandbox steps.
- `docs/fees.md`: the GATEWAY channel, online money in the closing and reports, who resolves.
- `docs/backlog.md`: the bKash tokenized plan becomes "a second `PaymentProvider`" (credentials,
  the token cache, its own reconciliation of `execute`), and later items: live mode, SSLCommerz's
  refund API, applying unmatched money, a per-institute review notification.
- `docs/deploy.md`: the IPN URL per institute, SSLCommerz's addresses, the role, and that the
  worker needs `PAYMENT_CREDENTIALS_KEY`.
- `docs/database.md`, `docs/decisions-pending.md` (P7b section).
- [ ] `pnpm format:check`; commit "Docs for online payments: reconciliation and review (sprint 1 P7b)".

### Task 8: Gates, review, PR

- [ ] Full gates; review subagent (money): review focus 1–6, and that no job path posts an item in
      `NEEDS_REVIEW` or dismisses money.
- [ ] Fix with failing tests first; PR; CI green; not merged by Claude.

## Risks

- **SSLCommerz's query behaviour is only partly documented** (statuses listed: VALID, VALIDATED,
  PENDING, FAILED; how a cancelled or never-attempted session shows is not). The plan never posts
  from a query alone and never closes an intent before its window ends, so a surprising answer
  delays a receipt, never doubles one. The owner's sandbox smoke run records what the sandbox
  says.
- **Query volume:** four queries per payment (plus the +7 day one for pending ones); fine for the
  sandbox and small institutes. SSLCommerz publishes no rate limits; if one appears, step 4 for
  `PAID` intents is the first to drop.
- **People resolve money.** A wrong "apply" is corrected by a void and a new decision (both
  audited); a wrong "refunded outside" is final in the app and needs a note to the owner (P7b-N).
- **No refund through the app:** institutes refund through SSLCommerz's merchant panel or by
  other means, and record it here (P7b-I).

## Size and split

**M**, as the sprint plan says: one migration, one table, ~10 routes, 2 jobs, 3 pages, ~4 test
files. One PR.

## Self-review

- **Sprint plan coverage:** reconciliation at +5 min, +30 min, +2 h, +25 h by `tran_id` (Task 2);
  a PAID transaction not yet recorded is confirmed (Task 2, through P7a's path); pending after 25 h
  → `EXPIRED` (Task 2); a success after `EXPIRED` → `NEEDS_REVIEW` (Task 2); the queue for
  OWNER/ADMIN with ACCOUNTANT viewing (Task 4); the eight reasons (P7a, shown in Task 4; `VOIDED`
  added); apply to chosen dues, refunded outside with a reason, resolve with a note, all audited
  (Task 4); reports by day and status with CSV, the closing's online line, the dashboard count
  (Task 5); tests with fake time, late success, every action, the closing totals (Tasks 2–5);
  docs: payments.md, fees.md, backlog.md, deploy.md (Task 7).
- **Refinements, each a decision:** "resolve with a note" is a dismissal only for items without
  money (P7b-E); a remainder must be recorded as refunded outside (P7b-E); signal items cannot be
  applied (P7b-H); a new `payment_signal_reviews` table (P7b-C); the +7 day query (P7b-K).
- **Names:** `reconcile`, `payments-sweep`, `payments:open`, `payment_signal_reviews`,
  `onlineToReview`, `ALREADY_RESOLVED`, `REMAINDER_NEEDS_REFUND`, `CHECK_FIRST`, `HAS_MONEY`,
  `NO_MONEY`, `CURRENCY_NOT_APPLICABLE`.

## Decisions for the owner

S22 and S23 stand as approved (the owner: "S22/S23 as approved"). These are new; each default is
what the plan builds unless you change it.

| #     | Decision                                              | Recommended default                                                                                                                                                                                                          | Alternative                                                       |
| ----- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| P7b-A | What a query answer may do                            | Only find `val_id`s: each goes through the Order Validation API and the same checks as an IPN (one decision path); a query never posts by itself                                                                             | Post from the query's own fields                                  |
| P7b-B | Surviving a Redis loss                                | A 10-minute sweep of `payments:open`, the nightly fee run re-queuing each institute's open intents in its own context, heal on read                                                                                          | A narrow definer function listing due intents across institutes   |
| P7b-C | Where decisions on unmatched and duplicate money live | A new append-only table `payment_signal_reviews` (one final decision per item)                                                                                                                                               | A REVIEW kind of event in `payment_gateway_events`                |
| P7b-D | Who resolves                                          | OWNER and ADMIN (any action); ACCOUNTANT sees the queue and can "check now"                                                                                                                                                  | OWNER only for "refunded outside"                                 |
| P7b-E | What may end an item                                  | Money ends only as applied or refunded outside (never dismissed); applying less than the money requires recording the rest as refunded outside in the same action; dismiss only for items with no money, after a fresh check | Allow leaving a remainder unapplied for later                     |
| P7b-F | The payment day of an applied item                    | The day SSLCommerz took the money (its `tran_date`, Asia/Dhaka): fines stop then                                                                                                                                             | The checkout day (`priced_on`), as for automatic posting          |
| P7b-G | Applying a `CURRENCY_MISMATCH` item                   | Refused; refund outside only (we only ever ask for BDT, so this means something went wrong)                                                                                                                                  | Allow applying the BDT settlement amount                          |
| P7b-H | Applying unmatched or duplicate money to dues         | Not offered: refund outside or dismiss (it did not come through our checkout)                                                                                                                                                | Apply it to a child the admin picks                               |
| P7b-I | Refunds                                               | Outside the app (SSLCommerz's panel or by hand), recorded with a note and reference; the refund API is not used (it needs a registered public IP and live mode)                                                              | SSLCommerz's refund API later (backlog)                           |
| P7b-J | Queries for payments already posted                   | Only the +25 h one, to catch a second payment or a success after a close                                                                                                                                                     | None (saves queries; duplicates only seen through IPNs)           |
| P7b-K | Payments still PENDING at +25 h                       | `EXPIRED` (the sprint plan), plus one last query at +7 days so a late bKash completion lands in review                                                                                                                       | No +7 day query                                                   |
| P7b-L | The closing's online line                             | In the whole-institute closing only (OWNER/ADMIN), counted in collected and net, not in cash in hand; not in an accountant's own closing                                                                                     | Shown to accountants too                                          |
| P7b-M | Telling admins about new review items                 | The dashboard's "to check" count and a badge on the fees tab; no SMS                                                                                                                                                         | An SMS to the OWNER (costs the institute's cap)                   |
| P7b-N | Undoing "refunded outside"                            | Not possible in the app (final, audited); a mistaken one is noted in the institute's own records                                                                                                                             | An OWNER-only reopen with a reason                                |
| P7b-O | How long gateway events are kept                      | For ever (money history; a few hundred bytes each)                                                                                                                                                                           | Prune events older than 2 years except those a decision points to |

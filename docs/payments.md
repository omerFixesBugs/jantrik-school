# Online payments (SSLCommerz)

Sprint 1 P7a: a guardian pays chosen dues in full through SSLCommerz's hosted page (bKash, Nagad,
Rocket, cards), sandbox only this sprint. This page covers **P7a1: the gateway account and the
client** and **P7a2: checkout to receipt** (the guardian's checkout, the payer's return and the
IPN, confirmation with SSLCommerz, the decision that posts or holds the money, the receipt) and
**P7b: reconciliation and the review queue** (SSLCommerz asked about every payment on a fixed
schedule, the queue where a person applies, refunds or dismisses, and online money in the
reports). The owner's decisions: S21 to S24 (approved), P7a-A to P7a-V and P7b-A to P7b-O
([decisions-pending.md](decisions-pending.md) → Sprint 1, P7a1, P7a2 and P7b). Fees in general:
[fees.md](fees.md).

**The owner's rule (S23):** anything SSLCommerz flags as risky, or any mismatch in amount,
currency or transaction ID, goes to review and is never posted automatically. In P7a such an
online payment waits in `NEEDS_REVIEW` with its reasons and the money recorded, with no receipt,
until a person decides (the review queue, below). Nothing in P7b posts money without a person
deciding, except a reconciliation that finds a payment passing every check, exactly as an IPN
would (through `confirm` and `settle`); the database itself refuses any move out of review that
is not a person's decision.

## Who does what

| Who               | What                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OWNER             | Saves the store ID and password (write-only), tests the connection, turns online payments on and off, copies the IPN address into the SSLCommerz panel                                                                                                                                                                                                                                                                        |
| ADMIN, ACCOUNTANT | Nothing in the settings: the page and its API are the owner's alone (where money goes). The admin sees no "Online payments" tab; the page says who sets it up. At the counter they see a due being paid online (a badge) and still take cash; OWNER/ADMIN may void an online payment as any other. The online payments list and the review queue: both read them and may ask SSLCommerz again; OWNER and ADMIN decide (P7b-D) |
| GUARDIAN          | Pays chosen dues of their own child in full, online (P7a2); sees the payment's state and the receipt                                                                                                                                                                                                                                                                                                                          |
| Everyone else     | Nothing                                                                                                                                                                                                                                                                                                                                                                                                                       |

The account's routes are `@RequireModule('FEES')` and `@Roles('OWNER')`, the guardian's
`@RequireModule('FEES')` and `@Roles('GUARDIAN')`: with the fee module off they answer 403, like
every fee route. The two signal routes are public (below).

## The gateway account

One row of `payment_gateway_accounts` per institute and provider (only `SSLCOMMERZ` for now),
created on the owner's first save. Mode `SANDBOX` only (a CHECK; live mode is a later decision).
Never deleted, only switched off (P7a-P). Database details: [database.md](database.md) → Online
payments.

| Route                                        | Does                                                                                                                                                                                       | Errors                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `GET /fees/online-payments/account`          | `{ provider, mode, configured, enabled, hint, credentialsUpdatedAt, lastTest: { at, result } \| null, lastFailure: { at, code } \| null, ipnUrl }`; no row yet → not configured            |                                                            |
| `PUT /fees/online-payments/account`          | `{ storeId, storePassword }` (write-only): saved encrypted, **the account switched off and its last test and last failure cleared in the same update** (P7a-M, P7a1-x19); answers the view | 400 (messages name the field, never repeat a value)        |
| `POST /fees/online-payments/account/test`    | 202 `{ requestedAt }`; queues an `account-test` job. The page asks for the view until `lastTest.at` reaches `requestedAt`                                                                  | 422 `CREDENTIALS_REQUIRED`; 429 (10 an hour per institute) |
| `POST /fees/online-payments/account/enable`  | on                                                                                                                                                                                         | 422 `TEST_REQUIRED`, `API_PUBLIC_URL_MISSING`              |
| `POST /fees/online-payments/account/disable` | off                                                                                                                                                                                        |                                                            |

- **On only after a passing test** (P7a-M): the API checks it, and the database refuses
  `enabled = true` unless credentials are saved and the last test is `OK`. A test that fails
  while the account is on switches it off (its result is recorded and the owner sees why).
- **The connection test** asks SSLCommerz's transaction query API for a transaction that never
  existed (`JSTEST…`): `APIConnect DONE` → `OK`, `FAILED` → `BAD_CREDENTIALS`, `INACTIVE` →
  `STORE_INACTIVE`, no answer in 30 s or no connection → `UNREACHABLE`, anything else → `ERROR`.
  The job acts for the owner who asked (the audit row names them) and records nothing if they are
  no longer the owner, or if the credentials were replaced while it ran.
- **The last failure** (`lastFailure`) is a job's fixed code with its time, e.g.
  `CREDENTIALS_UNREADABLE` when the test could not decrypt the credentials (the result is then
  `ERROR` and SSLCommerz is not asked). New credentials and a passing test clear it (P7a1-x19): it
  always describes the credentials the account has now.
- **The IPN address** is `<API_PUBLIC_URL>/public/payments/sslcommerz/<slug>/ipn`, shown on the
  page to paste into the store's SSLCommerz panel (each session also names it). Without
  `API_PUBLIC_URL` the page says so and the account cannot be turned on.
- **Audit** (`payment_gateway_account`): saving `{ changed: ['storeId', 'storePassword'],
enabled: false }` (CREATE the first time, UPDATE after, with the old `enabled`), each test
  result `{ test: 'OK' }` (with `enabled: false` when it switched the account off), on and off
  `{ enabled }`. Never a value, not even the hint.
- **The page** (`/fees/setup/online-payments`, a tab beside the bKash/Nagad numbers): a sandbox
  badge, the status (not set up, set up and off, on), the hint `••••1234`, the last test and the
  last failure, the write-only form (never pre-filled, cleared after a save), "Test connection",
  "Turn on"/"Turn off", and the IPN address with a copy button.

## Paying online (P7a2)

A guardian ticks some of a child's dues on the fees page ("অনলাইনে পরিশোধ" / "Pay online", above
"I paid by bKash/Nagad", which stays as the fallback), pays them **in full** on SSLCommerz's page
(bKash, Nagad, Rocket, cards), and comes back to a receipt that exists only after our server asked
SSLCommerz itself and every check passed (S22, S23).

| Route                                                          | Who                    | Does                                                                                                              | Errors                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /me/children/:id/fees` (existing)                         | the child's guardians  | gains `online: { available, inProgress: { intentId, mine, createdAt } \| null }`                                  |                                                                                                                                                                                                                                                                                  |
| `POST /me/children/:id/fees/online-payments`                   | the child's guardians  | `{ dueIds (1–24, each once), expectedAmountPaisa, clientRequestId }` → 201 the payment view                       | 400 (an unknown key, such as an amount); 404; 409 `DUES_CHANGED { amountPaisa }`, `PAYMENT_IN_PROGRESS { intentId, mine }`; 422 `NOTHING_DUE`, `ONLINE_AMOUNT_OUT_OF_RANGE { minPaisa, maxPaisa }`, `ONLINE_PAYMENTS_OFF`, `IDEMPOTENCY_MISMATCH`; 429 (10 an hour per guardian) |
| `GET /me/children/:id/fees/online-payments/:intentId`          | the child's guardians  | the payment view; `checkoutUrl` only for the one who started it, while it is READY; heals an open payment (below) | 404                                                                                                                                                                                                                                                                              |
| `POST /me/children/:id/fees/online-payments/:intentId/abandon` | the one who started it | CANCELLED ("start again")                                                                                         | 404; 409 `NOT_ABANDONABLE`                                                                                                                                                                                                                                                       |
| `GET /me/children/:id/fees/payments/:paymentId` (existing)     | the child's guardians  | gateway receipts too                                                                                              | 404                                                                                                                                                                                                                                                                              |

All `@RequireModule('FEES')` and `@Roles('GUARDIAN')`: staff never start a payment for a guardian
(no staff payment links, S22), and another family's child or payment is a 404.

**Checkout**, in the guardian's request transaction: the child is theirs; the account is on and
the server has both public addresses (`API_PUBLIC_URL`, `WEB_PUBLIC_URL`), else 422
`ONLINE_PAYMENTS_OFF`; then the tenant's fee lock (shared) and the student's lock; a retried
`clientRequestId` returns the same payment (the same guardian, child and dues) or 422; one payment
in progress per child for 60 minutes (P7a-F, 409 with no name of who started it); the dues are
generated and each must be open, the child's own and owe something; **the amount is what they owe
today in full, principal and fine**, compared with what the guardian was shown (409
`DUES_CHANGED` with the real amount); ৳10 to ৳5 lakh (P7a-L). The intent is written with what
each due owed (the snapshot, `payment_intent_dues`), `priced_on` today, our `tran_id` and
`expires_at` an hour on; audited (`payment_intent` CREATE); after commit the `checkout-init` job.

**The `checkout-init` job** (one attempt, no retry: a retry would reuse the `tran_id`, P7a-Q):
reads the intent, the account, the decrypted credentials, the payer and the slug in one short
transaction; asks SSLCommerz for a session outside any transaction; then, under the student's lock
and the intent's row lock, records an `INIT` event and moves the intent to `REDIRECTED` (the
session key and the payer page) or `FAILED` with a fixed code (also the account's last failure,
shown to the owner). An intent abandoned meanwhile stays abandoned; an account switched off
meanwhile fails it with `ONLINE_PAYMENTS_OFF` and no call. The payer sent to SSLCommerz (P7a-K):
the guardian's English name as the institute recorded it (else "Guardian"), their phone in local
form, a fixed no-reply email, the institute's English address or `N/A`; nothing about the child.

**The payment's page** (`/children/[id]/fees/pay/[intentId]`): `PREPARING` (asks every second for
30 s) → `READY` (straight on to SSLCommerz, with a button as well) → back from the gateway
(`?from=gateway`: never sent to the gateway again) `CONFIRMING` (every 2 s for 2 minutes, then
every 15 s; "do not pay again") → `PAID` (the amount, the receipt number, "View receipt"),
`CHECKING` (the school checks it: do not pay again), `NOT_PAID` ("Start again" opens the sheet,
or pay another way) or `EXPIRED`. Review reasons are never shown to guardians. The sheet is loaded
only when opened, so the fees page keeps its first-load size.

**Heal on read:** reading an open payment more than a minute after it started queues `confirm`
again, at most once a minute per payment (`pay-heal:<intentId>`), so a lost signal or job is
picked up while the guardian waits.

## States

| From                             | May move to                                                                                                        | By                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `CREATED`                        | `REDIRECTED` (session made), `FAILED` (session failed), `CANCELLED` (abandoned), `PAID`, `NEEDS_REVIEW`, `EXPIRED` | init job, payer, `settle`; `EXPIRED` only from P7b |
| `REDIRECTED`                     | `PAID`, `NEEDS_REVIEW`, `FAILED`, `CANCELLED`, `EXPIRED`                                                           | `settle`, payer (abandon); `EXPIRED` only from P7b |
| `FAILED`, `CANCELLED`, `EXPIRED` | `NEEDS_REVIEW` (`LATE_SUCCESS`)                                                                                    | `settle`                                           |
| `PAID`                           | `NEEDS_REVIEW` (`VOIDED`)                                                                                          | the void hook                                      |
| `NEEDS_REVIEW`                   | `PAID` (applied), `REFUNDED_OUTSIDE`, `DISMISSED`                                                                  | P7b's review actions only                          |
| `DISMISSED`                      | `NEEDS_REVIEW` (`LATE_SUCCESS`)                                                                                    | `settle`                                           |
| `REFUNDED_OUTSIDE`               | nothing (final; more money for it is a `DUPLICATE` event)                                                          |                                                    |

The database enforces the table (trigger `payment_intents_guard`). `REFUNDED_OUTSIDE` and
`DISMISSED` exist now so P7b needs no enum migration; nothing in P7a writes them (P7a-T).

## Signals: the return and the IPN

`POST|GET /public/payments/sslcommerz/:slug/return/:tranId/(success|fail|cancel)` (the payer's
browser) and `POST /public/payments/sslcommerz/:slug/ipn` (SSLCommerz's notification). Both
`@Public()` and `@NoRateLimit()` with limits of their own; neither ever opens an institute's
transaction, and nothing in a signal is trusted.

- **The body** is read before the app's own parsers (`public/signal-body.ts`): a form
  (`application/x-www-form-urlencoded`) of at most 16 KB, flat; anything else is malformed. Only
  the whitelisted fields are kept (`signalFields`: `status`, `tran_date`, `amount`,
  `store_amount`, `currency`, `currency_type`, `currency_amount`, `bank_tran_id`, `card_type`,
  `card_brand`, `risk_level`, `risk_title`, `error`; short printable strings); never `card_no`,
  `verify_sign`, `verify_key`, `value_*`, `cus_*` or `store_id`. `verify_sign` is not checked
  (P7a-D). Nothing from a body is ever logged.
- **Stored** by `payment_signal_record` (below): a `RETURN` or `IPN` event with the path's word as
  a hint (`SUCCESS`/`FAIL`/`CANCEL`), our `tran_id`, the `val_id` if it is well-formed, the fields,
  and whether the sender's address is one SSLCommerz documents (P7a-C: sandbox `103.26.139.87`,
  live `103.26.139.81` and `103.132.153.81`, the older docs' `144.76.92.216` and `.241`; recorded,
  never enforced).
- **Then** a `confirm` job for the intent (`jobId confirm-<intentId>`: a burst of signals makes one
  job), or an `unmatched-check` job for an IPN that named no intent of the institute.
- **Answers:** the return a 303 to `<WEB_PUBLIC_URL>/children/<child>/fees/pay/<intent>?from=gateway`,
  or to `/children` when it names no intent (a `tran_id` this institute never made, a bad path);
  the IPN `200 OK`, also for an unknown slug or intent and for a malformed one (no retries
  invited).
- **Limits** (refused requests spend no shared budget): a return 60 a minute per address (over it:
  still a 303, nothing recorded; the page heals it); an IPN from a listed address 1 200 a minute
  per address; from any other address 30 a minute per address and then, once its body parsed,
  120 an hour per institute; over either, 429. **No per-payment count** decides whether a signal
  is stored (P7a2-x23): every guardian of the child has the `tran_id` (it is in the return URL),
  so such a count would let anyone spend what the payer's own return depends on. What a flood of
  signals can make us ask SSLCommerz is bounded in `confirm` instead (below, P7a2-x24).

### The role and the function (P7a-B)

`payment_signal_record(slug, kind, tran_id, outcome, val_id, fields, source_listed, now)` is a
`SECURITY DEFINER` function owned by the NOLOGIN role **`jantrik_payments`** (the P3b pattern),
run by `jantrik_app` with no request context. It checks every argument (else `INVALID`, nothing
stored), resolves the slug (any status: money is recorded for a suspended institute too; unknown:
`UNKNOWN`), finds the intent by our `tran_id` **in that institute only** (a return with none:
`NO_INTENT`, nothing stored; an IPN with none is stored without an intent), inserts the event and
answers `RECORDED` with the institute, event, intent and child. The role may read `tenants (id,
slug)` and `payment_intents (tenant_id, id, student_id, tran_id)` and insert RETURN/IPN events,
through `TO jantrik_payments` policies; `jantrik_app` is not a member, so those policies never
widen what the API sees. A code scan keeps `Db`, `TenantJobRunner`, the fee services and the
credentials service out of `apps/api/src/payments/public/`. Database details:
[database.md](database.md) → Online payments.

## Confirmation and `settle`

**The `confirm` job** (`{ tenantId, intentId }`, 6 attempts from 30 s, doubling) asks SSLCommerz
with the institute's own credentials, outside any transaction, and settles each answer:

- **Validation, while the payment is open:** the new `val_id`s returns and IPNs carried (each
  once; those SSLCommerz's listed addresses brought first, then the oldest) are validated, **at
  most 3 a round**, and **at most 10 an hour per payment** for the `val_id`s anyone but
  SSLCommerz brought, another 10 for those its listed addresses brought (Redis
  `pay-val-other:<intent>`, `pay-val-listed:<intent>`; P7a2-x24). The rest are left to the query.
  A `val_id` whose answer was `PENDING` is validated again (a later signal, or the query listing
  it VALID; P7a2-x27); any other answer settles it.
- **The query by our `tran_id`** (a `QUERY` event, recorded at the time it was asked) is never
  refused and is authoritative: it lists every attempt, so it **answers for every signal stored
  before it** (such a `val_id` is validated only if the query lists it as a successful attempt).
  It is asked once per job while the payment is open (a failed or cancelled return, a made-up or
  pending `val_id`, a heal, `val_id`s left over), and on a closed payment when a signal since the
  last query is unaccounted for: a new `val_id` (a second payment is then validated from the
  query's list and recorded as `DUPLICATE`; a made-up one is never validated), or a signal without
  one that came with no validation in that job (a late payment). Every successful attempt it lists
  whose money we have not seen is validated the same way: nothing is posted from a query answer
  alone (P7b-A).
- **Closing:** a failed or cancelled return, or an IPN that said so, closes an open intent as
  `FAILED` or `CANCELLED` **only when the query lists a failed or cancelled attempt** and no
  successful or pending one (P7a2-x26; the signal's word if the query lists it, else the
  gateway's). A return needs only the `tran_id`, which every guardian of the child has (even an
  `<img>` link sends one): "nothing found" closes nothing, and the payment stays open for P7b's
  expiry. `PENDING` changes nothing.
- A gateway error records a `VALIDATE` or `QUERY` event with the code and the account's last
  failure, and fails the job with that code (BullMQ retries it; after the last attempt the intent
  stays as it is for P7b and the heal). Up to three rounds per job take signals that arrived while
  it ran.

The review's probe (40 returns with made-up `val_id`s, which made 46 validation calls) now makes at
most 10 validations of made-up `val_id`s an hour per payment, plus at most one query per job; the
payer's own return is stored and posted whatever was sent before it
(`payments-settle.e2e-spec.ts`, `payments-signals.e2e-spec.ts`).

**`settle`** is the only place that posts. One transaction acting as the guardian who paid, under
the tenant's fee lock (shared), the student's lock and the intent's row lock. A `VALIDATE` event is
written first, whatever follows. Then (`settle-decision.ts`):

1. **Whose money is it?** If the `tran_id` SSLCommerz returned is not this intent's, nothing of
   that money is recorded on this intent: an open, failed, cancelled, expired or dismissed intent
   goes to `NEEDS_REVIEW` with `TRAN_ID_MISMATCH`, one already in review gains the reason, a
   `PAID` or refunded one keeps its state (P7a-H). Money for no intent of ours marks the event
   `UNMATCHED`; another intent's money is posted through that intent's own signals.
2. The decision table:

| Intent                                                 | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| already holding this `val_id`                          | nothing (a repeat)                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| holding another `val_id` (`PAID`, in review, refunded) | the event gets `DUPLICATE` (money received twice, P7b's queue); the intent unchanged                                                                                                                                                                                                                                                                                                                                                                                                         |
| `NEEDS_REVIEW` with no money yet                       | the money recorded (with any mismatch found); stays in review: never posted by a signal                                                                                                                                                                                                                                                                                                                                                                                                      |
| `FAILED`, `CANCELLED`, `EXPIRED`, `DISMISSED`          | the money recorded; `NEEDS_REVIEW` with `LATE_SUCCESS` (and any mismatch found)                                                                                                                                                                                                                                                                                                                                                                                                              |
| `CREATED`, `REDIRECTED`                                | the money recorded and the reasons collected: `AMOUNT_MISMATCH` (`amount` or `currency_amount` not exactly the intent's, unparseable included), `CURRENCY_MISMATCH` (`currency` or `currency_type` not BDT), `TRAN_ID_MISMATCH` (`bank_tran_id` missing or not `^[A-Za-z0-9._-]{6,80}$`), `HIGH_RISK` (`risk_level` not `"0"`, missing included), `DUES_CHANGED` (a due no longer open, or what it owes on the checkout day differs from the snapshot). Any → `NEEDS_REVIEW`. None → posted. |

**Posting:** `FeeCollectionService.recordPayment` with channel `GATEWAY`, the method from the card
type (P7a-J), the `bank_tran_id` as the TrxID (P7a-I), **paid on the checkout day** (`priced_on`:
the fines were counted to then, so a payment that crosses midnight is not a review, P7a-E),
recorded today, the intent's id as the request id and the payment's intent; the guardian who paid
is the actor (`collected_by_id` and the audit row). Then the intent is `PAID` with its payment, and
the receipt SMS follows as at the counter (P7a-U). A unique violation (the `bank_tran_id` already
on a live payment of that method, or a second payment for the intent) rolls everything back, and
`settle` runs again as a `DUPLICATE` review, the money kept on the intent.

Validated money is posted even if the fee module was switched off, the institute suspended, or the
guardian unlinked from the child after the checkout (P7a-O, P7a-R); new checkouts need all of them.

**The `unmatched-check` job:** an IPN that named no intent of the institute, with a `val_id`, is
checked with the institute's own credentials when its budget allows (30 an hour): money of one of
our intents (its own `tran_id`) queues that intent's `confirm`; money of this store with no intent
becomes a `VALIDATE` event marked `UNMATCHED` (P7b's queue); anything else is recorded and nothing
more.

## Receipts, voids and the counter

- **The receipt** of a gateway payment: "অনলাইনে (SSLCommerz) · <method>", the bank transaction
  ID and our `tran_id` (ASCII), and "Paid online" instead of a collector (no signature line).
  `FeeReceipt` has `channel: 'GATEWAY'` and `online: { tranId, bankTranId, instrument }`.
- **The daily closing** lists online payments under no collector (P7a-V) and on their own line
  in the whole-institute closing (P7b-L, below). The collections report by collector shows them as
  one "Online (SSLCommerz)" line.
- **A void** of a gateway payment (OWNER/ADMIN, the usual route) sends its intent back to
  `NEEDS_REVIEW` with `VOIDED` and without its payment, in the same transaction (P7a-G); a person
  applies it again or records it as refunded (the review queue). The database refuses a void that
  leaves the intent holding it, and an intent that lets go of a payment still live (P7a2-x25). A
  live gateway payment must be its intent's money: posted by `settle`, the intent's amount, its
  `bank_tran_id` as the TrxID, paid on its `priced_on` (P7a2-x28); applied from review (P7b), the
  applied amount, the same TrxID, paid on a day from the checkout day to the day recorded.
- **The counter** sees `onlinePending` on a due an open payment names (an "online payment in
  progress" badge) and still takes cash: the online money then waits for review as
  `DUES_CHANGED`, never on a due, never twice (review focus 2). Online first: the counter's stale
  amount is a 409 `DUES_CHANGED`.
- The fee module reads nothing of the payments tables: the payments module registers
  `FeeOnlineHooks` at start (the pending dues, the guardian's `online`, the receipt's online part,
  the void, the nightly re-queue and the dashboard's count, P7b).

## Reconciliation (P7b)

SSLCommerz is asked about every online payment by our `tran_id` (the transaction query API) on a
fixed schedule, so a lost IPN and a closed browser tab still end in a receipt or in review. A
query answer never posts by itself (P7b-A): every successful attempt it lists whose `val_id` has
not been decided yet (no `VALIDATE` event saying `VALID` or `VALIDATED`; one that said
`PENDING` is asked again) goes through the validation API and `settle`
(`ConfirmService.validate`), exactly as an IPN does: one decision path for every signal. At most
3 new `val_id`s per step (`confirm`'s own bound per round, P7b-x23).

| Step     | When (after the intent was created) | Runs for                                                        | Besides asking                                                                                                                            |
| -------- | ----------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1, 2, 3  | +5 min, +30 min, +2 h               | every intent not `PAID`, refunded or dismissed                  | an open intent past its hour whose listed attempts all ended unpaid (FAILED, CANCELLED, EXPIRED, UNATTEMPTED) → `FAILED` (or `CANCELLED`) |
| 4        | +25 h                               | every intent (P7b-J: a second payment, a success after a close) | an intent still open → `EXPIRED`, PENDING included (audited, no person); one PENDING or UNKNOWN then is asked once more at +7 days        |
| 5        | +7 days                             | an intent PENDING or UNKNOWN at +25 h (P7b-K, P7b-x30)          | nothing: a success found goes to review as `LATE_SUCCESS`                                                                                 |
| `manual` | "Check with SSLCommerz" (staff)     | any intent                                                      | as steps 1–3                                                                                                                              |

- **Each step** (`reconcile` job `{ tenantId, intentId, step }`, job id `rec-<intentId>-<step>`, 3
  attempts from a minute apart): a short transaction reads the intent and its credentials; the
  query runs outside any transaction; a `QUERY` event (recorded at the time it was asked, as
  `confirm`'s) and the intent's `last_checked_at` and `last_check_outcome` (`SUCCESS_FOUND`,
  `PENDING`, `NO_SUCCESS` when every attempt listed ended unpaid or none was, `UNKNOWN` when one is
  in a status SSLCommerz does not document, or the provider's error code) are written; then the
  validations. Nothing is closed when in doubt: no attempt at all, a `PENDING` one or an `UNKNOWN`
  one changes nothing before +25 h, and only `NO_SUCCESS` lets a dismissal go ahead (P7b-x30).
- **An intent in review** is only asked about: `settle` records what it finds (a second payment is
  a `DUPLICATE` item) and never moves it out of review (S23).
- **A gateway error** (or unreadable credentials) fails the step with a fixed code; BullMQ retries
  it; after the last attempt the step stays listed for the sweep.
- **The schedule:** once the session is made (`REDIRECTED`), the init job lists steps 1–4 in the
  Redis sorted set `payments:open` (`<tenantId>:<intentId>:<step>`, scored by when each is due)
  and adds their delayed jobs. A step's member is removed only when the step is done. A session
  that failed gets none.

### Healing after a Redis loss (P7b-B)

- **`payments-sweep`** (every 10 minutes, one scheduler for all instances): every listed step
  overdue by more than 2 minutes is added again with its own job id (nothing while that job
  exists); a step listed more than 8 days ago is dropped. It reads Redis only.
- **The nightly fee run** (00:30 Asia/Dhaka) visits each institute in `fees:tenants` and, in that
  institute's own context, lists again its open intents older than an hour (the latest due step now
  unless it already ran, the later ones at their times), the intents posted in the last 26 hours
  whose +25 h query has not run, and the expired ones still PENDING or UNKNOWN at +25 h (their +7
  day query). Each list leaves out, in its query, what has nothing left to run (an open intent past
  +25 h whose +25 h step ran), so payments that stay open never crowd out the rest (500 per list,
  oldest first; P7b-x32). No query ever runs across institutes. It runs before the fee module
  check: validated money is posted even with fees off.
- **Heal on read:** the guardian's payment page (P7a2) and the review queue (an open intent whose
  latest due step is more than 10 minutes overdue and has not run is asked about now, at most once
  a minute per institute; the query reads only such intents, P7b-x32).

## The review queue (P7b)

`/fees/online-payments/review` (Fees → Online payments → to check): **intents** in `NEEDS_REVIEW`
and **money items** (`VALIDATE` events marked `UNMATCHED` or `DUPLICATE` with no decision yet),
oldest first. Each shows why in plain words, the money SSLCommerz confirmed (amount, method, the
bank's transaction ID, when, the store's share, the risk), the child, the guardian who paid, the
dues with what they owed then and owe now, and when SSLCommerz was last asked. Unmatched IPNs that
SSLCommerz said were not this store's payments are not items: a collapsed "checked, not a
payment" section lists them for 30 days.

| Route                                                          | Who                      | Does                                                                                                           |
| -------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `GET /fees/online-payments?status&from&to&q&page`              | OWNER, ADMIN, ACCOUNTANT | intents, newest first, 50 a page; `q`: our `tran_id`, the `bank_tran_id` or the student ID                     |
| `GET /fees/online-payments/:id`                                | OWNER, ADMIN, ACCOUNTANT | one intent with its dues, its events (whitelisted fields) and its decision                                     |
| `POST /fees/online-payments/:id/check`                         | OWNER, ADMIN, ACCOUNTANT | 202 `{ requestedAt }`: a `manual` step (once a minute per intent, else 429); the answer arrives on `lastCheck` |
| `GET /fees/online-payments/review`, `…/review/count`           | OWNER, ADMIN, ACCOUNTANT | the queue (heals overdue checks); the number alone (the fee tabs' badge)                                       |
| `POST /fees/online-payments/:id/apply`                         | OWNER, ADMIN             | below; 201 with the receipt                                                                                    |
| `POST /fees/online-payments/:id/refunded-outside`              | OWNER, ADMIN             | below                                                                                                          |
| `POST /fees/online-payments/:id/dismiss`                       | OWNER, ADMIN             | below                                                                                                          |
| `POST /fees/online-payments/signals/:eventId/refunded-outside` | OWNER, ADMIN             | a money item                                                                                                   |
| `POST /fees/online-payments/signals/:eventId/dismiss`          | OWNER, ADMIN             | a money item, as a repeat record only                                                                          |
| `GET /fees/reports/online-payments`, `…/csv`                   | OWNER, ADMIN, ACCOUNTANT | the report (below)                                                                                             |

All `@RequireModule('FEES')`; another institute's id is a 404 (RLS). Every decision needs a note
(3 to 500 characters), runs in the request transaction under the tenant's fee lock (shared), the
student's lock and the intent's row lock (a money item: its intent's when it has one, then the
advisory lock on its `val_id`), re-checks the state on the locked row (409 `ALREADY_RESOLVED`
for the second of two people) and is audited with the old and new state, the amounts, the dues and
the note (`payment_intent` UPDATE; `payment_signal_review` CREATE; applying also `fee_payment`
CREATE through `recordPayment`).

- **Apply** (intents with validated money in taka): `{ dueIds, advance, applyPaisa,
expectedOutstandingPaisa, refundOutside?: { reference }, note, clientRequestId }`. The chosen dues
  of the intent's child (and periods paid ahead, as at the counter); one gateway payment through
  `recordPayment` with the intent's method, its `bank_tran_id` as the TrxID, **paid on the day
  SSLCommerz took the money** (its `tran_date` in the institute's timezone, else the day its
  validation was recorded, never before the checkout day nor after today; P7b-F), recorded today,
  the admin as the actor; the intent `PAID` with `applied_paisa`. Less than the money only with
  `refundOutside`: the rest is recorded as given back outside the app in the same action (P7b-E).
  **The money** is what SSLCommerz validated less what was already refunded outside (an applied
  payment voided back into review keeps its refunded part, P7b-x24); a further remainder is added
  to that refund (a new reference replaces the old one on the row; the audit keeps both).
  Errors: 409 `ALREADY_RESOLVED`, `DUES_CHANGED { outstandingPaisa }` (what the chosen dues owe on
  the payment day differs from what was shown), `TRX_ID_USED` (that bank transaction is already a
  live payment); 422 `NO_MONEY`, `CURRENCY_NOT_APPLICABLE` (P7b-G), `AMOUNT_UNKNOWN`,
  `TRX_ID_UNUSABLE`, `AMOUNT_EXCEEDS_MONEY`, `AMOUNT_EXCEEDS_DUE`, `REMAINDER_NEEDS_REFUND
{ remainderPaisa }`, `IDEMPOTENCY_MISMATCH`; a retried `clientRequestId` → the same receipt.
- **Refunded outside** (intents with validated money; money items): `{ note, reference? }`, the
  whole money given back outside the app (SSLCommerz's merchant panel or by hand; the refund API is
  not used, P7b-I); for an intent with a refund kept from a voided apply, the rest now (the audit
  names it), its earlier reference kept unless a new one is given. Final: no undo in the app
  (P7b-N). 422 `NO_MONEY`. **One payment is refunded once** (P7b-x25): a money item whose money
  another record already refunded is 409 `ALREADY_REFUNDED` (dismiss it as a repeat), one whose
  money an intent holds 409 `HELD_BY_PAYMENT` (decide it on that intent).
- **Dismiss**: an intent **without** validated money (its own: a `TRAN_ID_MISMATCH` carries
  another payment's money elsewhere) and only after a check in the last 15 minutes found no
  success (409 `CHECK_FIRST`, 422 `HAS_MONEY`); its dues are free again and a success that still
  arrives brings it back as `LATE_SUCCESS`. A money item only as a **repeat record** of money held
  elsewhere: an intent holds the same `val_id`, or another item records it and was not itself
  dismissed (422 `HAS_MONEY`). Money is never dismissed (P7b-E).
- **Money items are never applied** to dues (P7b-H): unmatched money did not come through our
  checkout (no snapshot, no payer; two institutes sharing one store would even see each other's
  money as unmatched), and money paid twice is normally given back.
- **A void of an applied payment** sends the intent back to review (`VOIDED`); the decision is
  cleared from the row (the audit log keeps it), except the money already refunded outside with it,
  which stays with its reference (P7b-N, P7b-x24: the view's `refundedOutside`, the card's "Already
  refunded outside"); the rest may be applied again: one live payment.
- **One item per payment:** `settle` and the unmatched check record every validation, but put a
  `val_id` in the queue only once (under its advisory lock): two signals validating one second
  payment at once make one item (P7b-x25).
- **What the guardian sees** (P7a's view): `PAID` with the receipt after an apply, `REFUNDED` after
  a refund outside, `NOT_PAID` after a dismissal. Never the reasons.
- **The database:** only a person's decision moves an intent out of review, and the decision is
  written exactly then, in the name of the signed person (`payment_intents_resolution_guard`,
  P7b-x27); a refunded intent records the whole validated amount, applied + refunded outside is the
  validated amount, a refund outside never shrinks or loses its reference, a dismissed one holds no
  money (CHECKs and the guard); a live gateway payment and its `PAID` intent agree on the amount,
  the TrxID, the day and (applied) the currency, checked at commit from both sides, and an intent
  never lets go of a live payment (P7a2-x25); `payment_signal_reviews` holds one final decision per
  item, history only, by the signed person, a refund with its event's validated amount, once per
  payment (P7b-x25, x28). Details: [database.md](database.md) → Online payments.

### The web pages

- **`/fees/online-payments`** (a fees tab "অনলাইন পেমেন্ট", OWNER, ADMIN, ACCOUNTANT; the tab shows
  how many items wait): filters (state, dates), search, the list (state, child, amount in Bangla
  digits, our `tran_id` in ASCII, when) and "Check with SSLCommerz" on an open or reviewed one.
- **`/fees/online-payments/review`**: the items as cards; **Apply** (the child's open dues and
  periods ahead as the counter picks them, the amount to apply, the rest with its refund
  reference, the note), **Refunded outside** and **Dismiss** dialogs with a required note
  (Dismiss enabled only after a fresh check found nothing). An accountant sees the cards without
  the buttons.

## Reports (P7b)

- **The online payments report** (`GET /fees/reports/online-payments?from&to`, Reports → Online
  payments, OWNER/ADMIN/ACCOUNTANT; at most a year): per day each payment was started, in the
  institute's timezone: started (count, amount asked), open, paid now (count, amount of each
  payment: an applied one's applied amount), failed or cancelled, expired, in review (count, money
  validated less any refund kept from a voided apply), refunded outside (count, amount, whole or
  the rest of an applied one, kept after a void), dismissed, and all the money SSLCommerz validated
  for them with the store's share and **SSLCommerz's charges** (amount − store amount where both are
  known; S24), whatever happened since. **Money items count too** (P7b-x31): a second payment on its
  payment's start day, money of no payment of ours on the day it arrived, each payment's money once
  (a dismissed repeat record, or money an intent holds, is not counted again): in received, in
  review while undecided, in refunded outside once refunded; so received = paid + in review +
  refunded outside. `…/csv`: a BOM, ASCII digits, bn or en headers, formula-safe cells.
- **The daily closing** (P7b-L): `FeeClosing.online` (count, amount, by method, voids made that day,
  net) for gateway payments recorded that day and gateway voids made that day, in the
  whole-institute closing only (OWNER/ADMIN, no collector chosen), counted in collected and net,
  never in cash in hand. An accountant's own closing has none.
- **The dashboard** (P7b-M): `FeeSummary.onlineToReview` (intents in review and money items); the
  "to check" tile sums it with the bKash/Nagad transfers waiting and links to the larger part. No
  SMS.
- The online report counts by the day a payment was **started**; the closing and the collections
  report by the day a payment was **recorded**. They agree for a day whose payments were started,
  decided and recorded that day (review focus 6, `payments-reports.e2e-spec.ts`).

## Locks and idempotency

- `fee-locks.ts` step **2a**: the intent's row (`FOR UPDATE`), after the student's lock. Every
  writer of an intent (checkout, abandon, the init job, settle, the void hook) takes the student's
  lock first, so the counter, a void and three signals for one payment queue up on the student.
- Layers: BullMQ's `jobId` per intent; `VALIDATE` events by `val_id` (validated once per intent,
  unless the call failed or the answer was `PENDING`); the decision table under the row lock;
  `fee_payments_live_intent` (one live payment per intent) and `fee_payments_live_trx` in the
  database; the payment's request id is the intent's id; the receipt SMS's dedupe key. Three
  settles at once make one decision to post (`recordPayment` runs once; the test fails with the
  student's and the intent's locks removed).
- **The review queue (P7b)** takes the same locks (tenant shared → student → intent row), so a
  decision, a late signal's `settle`, the counter and a void queue up on the student; decisions
  on a money item then take an advisory lock on its `val_id` (`payment-locks.ts`), which the
  database's commit-time check takes again. An applied payment's request id is the admin's
  `clientRequestId` (a retry gets the same receipt), so applying again after a void makes a new
  payment.

## Credentials at rest

- The store ID and password are one AES-256-GCM ciphertext, `v1.` + base64url(iv | tag |
  ciphertext), in `credentials_ciphertext`. The additional data (AAD) is
  `payments:<provider>:<tenantId>:<accountId>:v<credentials_version>`, so a ciphertext copied
  onto another institute's or another account's row never decrypts. Helpers:
  `packages/db/src/payments/secrets.ts` (`paymentKeys`, `credentialsAad`, `encryptCredentials`,
  `decryptCredentials`).
- **No rollback** (P7a1-x20): `credentials_version` is set by a database trigger alone: 0 for an
  account without credentials, 1 when one is inserted with them, one up whenever the ciphertext
  changes, unchanged by any other update. `jantrik_app` may not UPDATE it, and an INSERT's value is
  replaced. Saving locks the row (`FOR NO KEY UPDATE`), encrypts as the row's version + 1 and
  checks that the update stored that version; reading decrypts with the row's version. So an older
  ciphertext of the same row put back (an SQL injection inside the institute: a store a former
  owner once saved) raises the version past its own and reads as `CREDENTIALS_UNREADABLE`, never
  as the old store; the owner saves the store again.
- **The key** is `PAYMENT_CREDENTIALS_KEY` (at least 32 characters, its own secret). Required in
  production; development and tests derive one from `OTP_PEPPER` (not the key the platform
  derives for 2FA). Changing it makes every saved store unreadable: a job that needs them records
  `CREDENTIALS_UNREADABLE` as the account's last failure and the page asks the owner to save them
  again. Key rotation is not built (`key_version` is 1).
- **Only `PaymentCredentialsService` reads or writes the ciphertext.** The database cannot tell
  services apart, so two more checks stand in: every Prisma client leaves the column out of its
  reads unless a query names it (`CLIENT_OMIT`, as `users.password_hash`), and a code scan
  (`apps/api/src/payments/credentials-scan.spec.ts`) fails if any other file under `apps/api/src`
  names it. The view shows the store ID's last 4 characters only (`credentials_hint`).
- **The password never appears** in a response, a log line, `audit_logs`, a Redis key or value, a
  job's data, or a failed job (review focus 6; `payments-account.e2e-spec.ts` sends a sentinel
  password through a save, a refused test, a 500 from SSLCommerz and a too-long password, and
  finds it only in what the fake SSLCommerz was sent). Validation errors list paths, never input.

## The client

`apps/api/src/payments/provider.ts` is the `PaymentProvider` interface (as approved, with the
validated `tran_id`, the currency fields and a query's several attempts); `SslcommerzProvider`
(`sslcommerz/sslcommerz.provider.ts`) its only implementation.

- **Where it calls:** `https://sandbox.sslcommerz.com`, fixed. `SSLCOMMERZ_BASE_URL` replaces it
  only outside production and only with a plain-http address on this machine (the fake, P7a-S).
- **The three APIs:** the session (`POST /gwprocess/v4/api.php`, a form), validation
  (`GET /validator/api/validationserverAPI.php?val_id&store_id&store_passwd&format=json`) and the
  transaction query (`GET /validator/api/merchantTransIDvalidationAPI.php?tran_id&…`). The session
  sends `total_amount` as `formatGatewayAmount` (`125050` → `"1250.50"`), `currency` BDT, our
  `tran_id`, the return and IPN addresses, `product_name` "School fees" (ASCII), category
  "Education", profile `non-physical-goods`, `shipping_method` NO, `emi_option` 0, `value_a` the
  intent id (support only, never trusted) and the payer's `cus_*` fields (P7a-K, filled by P7a2).
- **One attempt, 30 s:** every call has a 30 s timeout on its own timer, never retries, and never
  follows a redirect (it could carry the password to another host).
- **Strict parsing:** at most 256 KB is read; zod schemas keep only the fields the checks need,
  each a string of at most 200 characters or null. A number where a string belongs is null too,
  so an amount is never read through a float: `parseGatewayAmount` accepts exactly
  `^\d{1,7}(\.\d{1,2})?$`. `risk` is `LOW` only for `risk_level` `"0"`; anything else, missing
  included, is `HIGH`. `tran_date` is read as Asia/Dhaka. The payer page (`GatewayPageURL`) must be
  https on `sandbox.sslcommerz.com` itself (P7a2-x21: no other SSLCommerz host, now that
  guardians are sent there), or the fake's own address; anything else is `BAD_RESPONSE` and the
  payment fails before anyone is sent anywhere.
- **Fixed error codes, nothing else leaves it:** `TIMEOUT`, `NETWORK`, `HTTP_STATUS` (any non-2xx,
  a redirect included), `BAD_RESPONSE`, `AUTH_FAILED` (`APIConnect FAILED`, or a session refused
  for its credentials), `STORE_INACTIVE`, `INVALID_REQUEST`. The password travels in the session
  form and in the validation and query URLs (SSLCommerz's design), so the client never logs,
  returns or rethrows a URL, a body, a header or a `fetch` error.
- **Method mapping** (`methodFromInstrument`, P7a-J, in `@jantrik/shared`): `card_type` `BKASH-…` →
  bKash, `NAGAD-…` → Nagad, `DBBLMOBILEB-…` → Rocket, `VISA-`/`MASTER-`/`AMEX-` or `card_brand`
  VISA, MASTERCARD, AMEX → card, anything else → other online. Checked in the sandbox by the
  smoke run (below).
- **Our transaction IDs:** `newTranId()`, `JS` + a ULID (26 Crockford base32 characters: the time,
  then 80 random bits), 28 characters (SSLCommerz allows 30).

What the documentation does not say (whether the payer's browser returns by POST, IPN retries,
which IPN address wins, `card_type` values, how a cancelled session shows in a query, the test
connection's answers) is listed in the P7a plan; the code assumes the least, and the smoke run
prints what it could see.

## Tests and the fake SSLCommerz

Nothing in CI or in any local test calls SSLCommerz, the sandbox included.

- **The fake** (`apps/api/test/support/fake-sslcommerz.ts`, node built-ins only): the three APIs
  with the documented shapes, a payer page `/pay/<sessionkey>` with Pay, Fail and Cancel that posts
  the browser back and sends the IPN, one-shot overrides per API (an HTTP status, a delay, a raw or
  JSON body), stores it accepts (and inactive ones), and a log of every request (the sentinel
  tests' positive control). The API tests start it on a port the OS picks and pass its address to
  `createHarness({ payments })`; without that, the API tests point SSLCommerz at
  `http://127.0.0.1:9`, where nothing listens (`apps/api/vitest.config.ts`).
- **Playwright** runs it on its own (`pnpm --filter @jantrik/api payments:fake`, 127.0.0.1:4090,
  store `jantrikfake01` / `jantrikfake01@ssl`), with the API's `SSLCOMMERZ_BASE_URL` pointing at it
  and `API_PUBLIC_URL=http://localhost:4000`.
- Tests: `packages/shared/src/payments.test.ts`, `packages/db/test/payments-secrets.test.ts`,
  `payments-rls.test.ts`, `payments-intents.test.ts` (the P7a2 tables, triggers and the gateway
  payment's rules), `payments-function.test.ts` (the signal function and its role),
  `schema-safety.test.ts` (the role's privileges), `apps/api/test/payments-provider.e2e-spec.ts`,
  `payments-credentials.e2e-spec.ts`, `payments-account.e2e-spec.ts`,
  `payments-scripts.e2e-spec.ts`, `payments-checkout.e2e-spec.ts`, `payments-signals.e2e-spec.ts`,
  `payments-settle.e2e-spec.ts` (review focus 1 to 8), `apps/api/src/payments/credentials-scan.spec.ts`,
  `settle-decision.spec.ts`, `public/no-tenant-access.spec.ts`, `apps/web/e2e/payments.spec.ts`
  (the owner's setup; a guardian paying and cancelling on the fake's page; the counter's badge).
- P7b: `packages/db/test/payments-reviews.test.ts` (the decision columns, the guard, money never
  dismissed, two connections dismissing at once, the payment and intent matched from both sides),
  `apps/api/test/payments-reconcile.e2e-spec.ts` (the schedule, every step, expiry, a late success,
  the sweep, the nightly re-queue, heal on read; steps run directly with a fake clock),
  `payments-review.e2e-spec.ts` (the queue, every action, two people at once, a late signal,
  audit, the browser test's flow, review round 1's cases) and `payments-reports.e2e-spec.ts`
  (review focus 6, money items), `apps/web/e2e/payments-review.spec.ts` (paid at the counter while
  paying online, applied ahead; a risky payment; the accountant's view; the closing's online line;
  its own child and guardian, Rakib `SHS-2026-0104` and `DEMO.rakibGuardian`, so it never uses
  Tahmid's dues or his father's OTP budget, which payments.spec needs; P7b-x33). The fake's payer
  page has a **Risky** button (paid, reported with `risk_level` 1).
- **Playwright** also gives the API `WEB_PUBLIC_URL=http://localhost:3000`, so the fake's
  payer page brings the browser back to the web app, and the fake posts its IPN to the API.

## The owner's sandbox steps (P7b)

With the sandbox store on (above) and `API_PUBLIC_URL` reachable by SSLCommerz (a tunnel in
development), pay a due as a guardian with the sandbox's test card, then: close the browser tab
before it returns and wait for the +5 minute query (the payment is posted by reconciliation);
pay a due while the accountant takes it in cash (it waits in the review queue as "paid another
way": apply it to the next month); look at the day's closing (the online line) and Reports →
Online payments (SSLCommerz's charges). Nothing in CI or in a local test calls SSLCommerz.

## Commands (the owner's)

Neither runs in CI. Both read the root `.env`.

- **`pnpm --filter @jantrik/api payments:sandbox-smoke`**: a ৳10 session in SSLCommerz's real
  sandbox with a fresh `tran_id`. It skips (exit 0) unless `SSLCOMMERZ_SANDBOX_STORE_ID` and
  `SSLCOMMERZ_SANDBOX_STORE_PASSWORD` are both set, and refuses `NODE_ENV=production`. It tests the
  connection (and a wrong password), prints the payer page, asks the query API every 5 s for 5
  minutes while you pay (test card `4111 1111 1111 1111`, 12/26, CVV 111; mobile banking OTP
  `111111`), validates the payment twice, and prints the parsed outcome (amount in paisa,
  currencies, risk, `card_type` and the method it maps to) and the undocumented points it could
  see. It writes nothing anywhere and prints no credential.
- **`pnpm --filter @jantrik/api payments:load-sandbox -- --tenant shapla-school`**: development
  only. Encrypts the two variables onto that institute's SSLCommerz account in the local `jantrik`
  database (through `PaymentCredentialsService`; off and untested), audited with no person and
  `{ changed: [...], source: 'load-sandbox' }`. Refuses production, a database host that is not
  this machine and any database but `jantrik` (the `db:reset` guard's rules). Then sign in as that
  institute's owner, test the connection and turn it on.

## Environment

| Variable                                    | Read by          | Rules                                                                                                                                                                                                    |
| ------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAYMENT_CREDENTIALS_KEY`                   | API, worker      | at least 32 characters; required in production (`openssl rand -base64 48`); development and tests derive one from `OTP_PEPPER`; production refuses an example marker and a value equal to another secret |
| `API_PUBLIC_URL`                            | API, worker      | the API's own address, scheme, host and port only (normalised); optional; production refuses http, local hosts and anything else; the production compose sets it from `API_DOMAIN`                       |
| `WEB_PUBLIC_URL`                            | API              | from P3b (required in production); where the payer's browser comes back to. Without it (development) no checkout starts                                                                                  |
| `SSLCOMMERZ_SANDBOX_STORE_ID`, `…_PASSWORD` | the two commands | production refuses either one set                                                                                                                                                                        |
| `SSLCOMMERZ_BASE_URL`                       | API, worker      | development and tests only, and only `http://127.0.0.1:<port>` or `http://localhost:<port>` (a fake); production refuses it                                                                              |

The device receiver never gets `PAYMENT_CREDENTIALS_KEY` (it refuses to start with it in
production). Production: [deploy.md](deploy.md) → The settings file, Environment checks.

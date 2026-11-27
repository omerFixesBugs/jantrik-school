# Online payments (SSLCommerz)

Sprint 1 P7a: a guardian pays chosen dues in full through SSLCommerz's hosted page (bKash, Nagad,
Rocket, cards), sandbox only this sprint. This page covers **P7a1: the gateway account and the
client** and **P7a2: checkout to receipt** (the guardian's checkout, the payer's return and the
IPN, confirmation with SSLCommerz, the decision that posts or holds the money, the receipt).
Reconciliation and the review queue (P7b) are added here when they land. The owner's decisions:
S21 to S24 (approved), P7a-A to P7a-V ([decisions-pending.md](decisions-pending.md) → Sprint 1,
P7a1 and P7a2). Fees in general: [fees.md](fees.md).

**The owner's rule (S23):** anything SSLCommerz flags as risky, or any mismatch in amount,
currency or transaction ID, goes to review and is never posted automatically. In P7a such an
online payment waits in `NEEDS_REVIEW` with its reasons and the money recorded, with no receipt;
P7b brings the screen where a person deals with it.

## Who does what

| Who               | What                                                                                                                                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OWNER             | Saves the store ID and password (write-only), tests the connection, turns online payments on and off, copies the IPN address into the SSLCommerz panel                                                                                                                                            |
| ADMIN, ACCOUNTANT | Nothing in the settings: the page and its API are the owner's alone (where money goes). The admin sees no "Online payments" tab; the page says who sets it up. At the counter they see a due being paid online (a badge) and still take cash; OWNER/ADMIN may void an online payment as any other |
| GUARDIAN          | Pays chosen dues of their own child in full, online (P7a2); sees the payment's state and the receipt                                                                                                                                                                                              |
| Everyone else     | Nothing                                                                                                                                                                                                                                                                                           |

The account's routes are `@RequireModule('FEES')` and `@Roles('OWNER')`, the guardian's
`@RequireModule('FEES')` and `@Roles('GUARDIAN')`: with the fee module off they answer 403, like
every fee route. The two signal routes are public (below).

## The gateway account

One row of `payment_gateway_accounts` per institute and provider (only `SSLCOMMERZ` for now),
created on the owner's first save. Mode `SANDBOX` only (a CHECK; live mode is a later decision).
Never deleted, only switched off (P7a-P). Database details: [database.md](database.md) → Online
payments.

| Route                                        | Does                                                                                                                                                                            | Errors                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `GET /fees/online-payments/account`          | `{ provider, mode, configured, enabled, hint, credentialsUpdatedAt, lastTest: { at, result } \| null, lastFailure: { at, code } \| null, ipnUrl }`; no row yet → not configured |                                                            |
| `PUT /fees/online-payments/account`          | `{ storeId, storePassword }` (write-only): saved encrypted, **the account switched off and its last test cleared in the same update** (P7a-M); answers the view                 | 400 (messages name the field, never repeat a value)        |
| `POST /fees/online-payments/account/test`    | 202 `{ requestedAt }`; queues an `account-test` job. The page asks for the view until `lastTest.at` reaches `requestedAt`                                                       | 422 `CREDENTIALS_REQUIRED`; 429 (10 an hour per institute) |
| `POST /fees/online-payments/account/enable`  | on                                                                                                                                                                              | 422 `TEST_REQUIRED`, `API_PUBLIC_URL_MISSING`              |
| `POST /fees/online-payments/account/disable` | off                                                                                                                                                                             |                                                            |

- **On only after a passing test** (P7a-M): the API checks it, and the database refuses
  `enabled = true` unless credentials are saved and the last test is `OK`. A test that fails
  while the account is on switches it off (its result is recorded and the owner sees why).
- **The connection test** asks SSLCommerz's transaction query API for a transaction that never
  existed (`JSTEST…`): `APIConnect DONE` → `OK`, `FAILED` → `BAD_CREDENTIALS`, `INACTIVE` →
  `STORE_INACTIVE`, no answer in 30 s or no connection → `UNREACHABLE`, anything else → `ERROR`.
  The job acts for the owner who asked (the audit row names them) and records nothing if they are
  no longer the owner, or if the credentials were replaced while it ran.
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
  120 an hour per institute; over either, 429.

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

**The `confirm` job** (`{ tenantId, intentId }`, 6 attempts from 30 s, doubling): for every
`val_id` a return or IPN carried that has not been validated yet, ask SSLCommerz's validation API
with the institute's own credentials, outside any transaction, and settle each answer. With none
to validate while the intent is open (a failed or cancelled return, a made-up `val_id`, a heal),
or when a signal without a `val_id` came after the last query, ask the transaction query API by our
`tran_id` (a `QUERY` event); every successful attempt it lists is then validated the same way:
nothing is posted from a query answer alone (P7b-A). A failed or cancelled return, or an IPN that
said so, closes an open intent as `FAILED` or `CANCELLED` only when the query finds no successful
or pending attempt; `PENDING` changes nothing. A gateway error records a `VALIDATE` or `QUERY`
event with the code and the account's last failure, and fails the job with that code (BullMQ
retries it; after the last attempt the intent stays as it is for P7b and the heal). Up to three
rounds per job take signals that arrived while it ran.

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
- **The daily closing** lists online payments under no collector (P7a-V; P7b adds their own
  line). The collections report by collector shows them as one "Online (SSLCommerz)" line.
- **A void** of a gateway payment (OWNER/ADMIN, the usual route) sends its intent back to
  `NEEDS_REVIEW` with `VOIDED` and without its payment, in the same transaction (P7a-G); P7b applies
  it again or marks it refunded. The database refuses a void that leaves the intent holding it.
- **The counter** sees `onlinePending` on a due an open payment names (an "online payment in
  progress" badge) and still takes cash: the online money then waits for review as
  `DUES_CHANGED`, never on a due, never twice (review focus 2). Online first: the counter's stale
  amount is a 409 `DUES_CHANGED`.
- The fee module reads nothing of the payments tables: the payments module registers
  `FeeOnlineHooks` at start (the pending dues, the guardian's `online`, the receipt's online part,
  the void).

## Locks and idempotency

- `fee-locks.ts` step **2a**: the intent's row (`FOR UPDATE`), after the student's lock. Every
  writer of an intent (checkout, abandon, the init job, settle, the void hook) takes the student's
  lock first, so the counter, a void and three signals for one payment queue up on the student.
- Layers: BullMQ's `jobId` per intent; `VALIDATE` events by `val_id` (validated once per intent,
  unless the call failed); the decision table under the row lock; `fee_payments_live_intent` (one
  live payment per intent) and `fee_payments_live_trx` in the database; the payment's request id is
  the intent's id; the receipt SMS's dedupe key.

## Credentials at rest

- The store ID and password are one AES-256-GCM ciphertext, `v1.` + base64url(iv | tag |
  ciphertext), in `credentials_ciphertext`. The additional data (AAD) is
  `payments:<provider>:<tenantId>:<accountId>`, so a ciphertext copied onto another institute's
  or another account's row never decrypts. Helpers: `packages/db/src/payments/secrets.ts`
  (`paymentKeys`, `credentialsAad`, `encryptCredentials`, `decryptCredentials`).
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
- **Playwright** also gives the API `WEB_PUBLIC_URL=http://localhost:3000`, so the fake's
  payer page brings the browser back to the web app, and the fake posts its IPN to the API.

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

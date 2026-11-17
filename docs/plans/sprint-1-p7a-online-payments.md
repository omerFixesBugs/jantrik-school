# Sprint 1, P7a: online fee payments through SSLCommerz, checkout to receipt (implementation plan)

**Status: plan only (day run 2026-11-18), not approved, no code yet.** Written while the owner was
away. It details [sprint-1.md](sprint-1.md) → "P7a: Online payments, checkout to receipt", which
the owner approved on 2026-11-14 with decisions S21 (methods `ROCKET`, `CARD`, `OTHER_ONLINE`,
channel `GATEWAY`), S22 (guardians pay selected dues in full only, the amount computed by the
server, no free-typed amount, no staff payment links), S23 (anything SSLCommerz flags as risky, or
any mismatch in amount, currency or transaction ID, goes to a review queue and is never posted
automatically: the owner's rule) and S24 (the institute bears the gateway charges). The owner
confirmed "S22/S23 as approved". Nothing here reopens them. The new decisions this plan needs are
P7a-A to P7a-V at the end, each with a recommended default. Reconciliation and the review queue
are [sprint-1-p7b-reconciliation.md](sprint-1-p7b-reconciliation.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.
> One review subagent per PR (money, secrets, the public surface, the database).

**Goal:** a guardian ticks some of a child's dues, pays them in full through SSLCommerz's hosted
page (bKash, Nagad, Rocket, cards; sandbox only), and comes back to a receipt that exists only
after our server asked SSLCommerz itself and every check passed. Anything doubtful waits for a
person, with the money recorded on the payment intent and never on a due.

**Architecture:**

- **Gateway account (P7a1):** one `payment_gateway_accounts` row per institute and provider
  (`SSLCOMMERZ`, mode `SANDBOX` only). The store ID and password are encrypted together
  (AES-256-GCM, AAD `payments:SSLCOMMERZ:<tenantId>:<accountId>`, key from
  `PAYMENT_CREDENTIALS_KEY`); only `PaymentCredentialsService` reads the ciphertext. The OWNER
  enters them on a write-only form, tests them (a queue job), and switches the account on.
- **Provider (P7a1):** the approved `PaymentProvider` interface, one implementation
  `SslcommerzProvider` (plain `fetch`, 30 s timeout, fixed error codes, strict parsers), and a fake
  SSLCommerz server for the API tests and Playwright. CI never calls SSLCommerz.
- **Checkout (P7a2):** `payment_intents` (one per attempt) with `payment_intent_dues` (the dues
  and the exact principal and fine each owed when the amount was computed: the snapshot).
  Creating an intent takes the student's fee lock, computes the amount as the counter does, and
  queues the `checkout-init` job, which calls the session API outside any transaction.
- **Signals (P7a2):** the payer's browser return and the IPN reach two `@Public()` routes. They
  never open a tenant transaction: one `SECURITY DEFINER` function, `payment_signal_record`, owned
  by a new NOLOGIN role `jantrik_payments` (the P3b pattern), stores the signal as a
  `payment_gateway_events` row and answers which institute, intent and child it belongs to. The
  API then queues `confirm` and answers (303 to the child's payment page, or 200 to the IPN).
  Nothing in a signal is trusted.
- **Confirmation (P7a2):** the `confirm` job asks the Order Validation API by `val_id` (or the
  Transaction Query API by `tran_id` when a signal carried none), then, under the student's fee
  lock and a row lock on the intent, applies one decision table: post the payment through
  `FeeCollectionService.recordPayment` (channel `GATEWAY`, the guardian as the actor), or put the
  intent in `NEEDS_REVIEW` with its reasons and the money facts, and no payment. Three signals for
  one payment make one receipt (one decision under the lock, a partial unique index behind it).

**Tech stack:** NestJS, Prisma/PostgreSQL 16, BullMQ, Redis, Next.js (v3 kit), next-intl, Vitest,
Playwright. No new dependency (Node's `fetch` and `crypto`).

**Spec:** sprint-1.md → P7a, "New tables at a glance", "Environment variables", "What needs real
accounts", "Review focus" 1 and 2, decisions S21–S24.

**Branches:** `feature/sprint-1-p7a1-gateway-accounts`, then
`feature/sprint-1-p7a2-checkout` on top of it (decision P7a-A), each from `main` once the PRs
this plan depends on have merged (below).

## What exists today (verified in the code on 2026-11-18, `integration/sprint-1` at `c8571025`)

- **Recording money:** `FeeCollectionService.recordPayment()`
  (`apps/api/src/fees/collection/fee-collection.service.ts:210-292`).
  - The caller holds the student's lock. It computes each due's balance on `paidOn`
    (`dueBalance`), refuses `NOTHING_DUE` and `AMOUNT_EXCEEDS_DUE`, allocates oldest first
    (`allocate`), takes the next receipt number (`nextReceiptNo`, `:102`, the counter row inside
    the transaction: no gaps), writes the payment and its allocations, re-derives the dues
    (`recomputeDues`), audits `fee_payment` CREATE, and queues the receipt SMS (`:295`, dedupe key
    `receipt:<paymentId>`).
  - `channel` is typed `'COUNTER' | 'MOBILE_MANUAL'` (`:215`); `collectedById` is always the
    principal (`:260`), so a job must run with an actor.
  - `collect()` (`:133`) is the model for computing what chosen dues owe: `planContext()`,
    `ensureForStudents()`, `openDues()` (`:190`, 404 for anything not open or not this student's),
    `outstanding()`, and 409 `DUES_CHANGED` when the client's expected total differs (`:151-156`).
    `replay()` (`:173`) returns the earlier receipt of a retried `clientRequestId`.
  - The manual bKash/Nagad `verify()` (`apps/api/src/fees/mobile/fee-mobile.service.ts:379-427`)
    is the closest model: lock, replay, re-check, `recordPayment` with `paidOn` = the day it was
    sent, then mark its own row. `assertTrxFree()` (`:228-250`) refuses a TrxID already on a live
    payment of the same method.
- **Locks** (`apps/api/src/fees/fee-locks.ts:3-29`), always in this order: the tenant's fee lock
  (shared), the student's, a TrxID's, the receipt counter row, the SMS lock.
- **`fee_payments`** (`packages/db/prisma/schema.prisma:2598-2642`; migrations
  `20261027020000_fees_payments`, `20261027020200_fees_money_review`, `20261027030100_fees_integrity`):
  - `GRANT SELECT, INSERT` and `UPDATE` on the void columns only; triggers: created ACTIVE, ACTIVE
    → VOID once; a deferred constraint trigger checks every allocation at commit (live payment,
    open due, never more than the payment; it locks the payment and the due).
  - CHECK `fee_payments_trx_id`: `trx_id IS NULL OR trx_id ~ '^[A-Z0-9]{6,20}$'`. **SSLCommerz's
    `bank_tran_id` does not fit it** (the docs' sample `1709162025350IvUOK8nCTb6Uan` has lower
    case letters and 27 characters).
  - CHECK `fee_payments_channel`: COUNTER ⇒ CASH, no TrxID, no sender; MOBILE_MANUAL ⇒ BKASH or
    NAGAD with both.
  - Partial unique `fee_payments_live_trx (tenant_id, method, trx_id) WHERE status = 'ACTIVE' AND
trx_id IS NOT NULL`; unique `(tenant_id, client_request_id)`; `collected_by_id NOT NULL` → users.
  - Enums `fee_payment_method` = `CASH, BKASH, NAGAD` (`schema.prisma:2555`) and
    `fee_payment_channel` = `COUNTER, MOBILE_MANUAL` (`:2563`); shared
    `FEE_PAYMENT_METHODS` (`packages/shared/src/fees-api.ts:449`) and `FeeReceipt.channel`
    (`:502`) mirror them.
- **Who appears as the collector:** the daily closing groups by `collected_by_id` and names people
  with `staffNames()` (`fee-collection.service.ts:442-519`, `METHOD_ORDER` at `:66`), which reads
  `staff_profiles` only (`apps/api/src/staff/staff.module.ts:53`). A guardian as the collector
  would show as an unnamed collector; the receipt's `collectedBy` likewise.
- **Guardian fees:** `GuardianFeesController` (`apps/api/src/fees/fees.module.ts:351-372`,
  `@RequireModule('FEES')`, `@Roles('GUARDIAN')`): `GET /me/children/:id/fees`,
  `POST …/fees/submissions`, `GET …/fees/payments/:paymentId`. `assertChild()`
  (`fee-mobile.service.ts:156`) answers 404 for any child not the caller's. `FeesModule` exports
  only `FeeCollectionService` (`fees.module.ts:510`).
- **Guardian web:** `/children/[id]/fees` (`apps/web/src/app/(app)/children/[id]/fees/page.tsx`)
  with `components/fees/guardian/*`; the manual "I paid" sheet is `pay-sheet.tsx` (759 lines, at
  most 24 dues per submission: `use-child-fees.ts:53`). The route namespace `children` loads
  `fees.common` and `fees.guardian` (`apps/web/src/i18n/route-messages.ts:109`). `proxy.ts`
  covers `/children/:path*` with the `jantrik_signed_in` hint cookie (`SameSite=Lax`,
  `lib/auth/auth-client.ts:402`); the refresh cookie is `SameSite=Strict`
  (`apps/api/src/auth/auth.controller.ts:148`). The OWNER-only bKash/Nagad numbers page is
  `/fees/setup/numbers`.
- **Dashboard:** `FeeReportsService.summary()` (`apps/api/src/fees/reports/fee-reports.service.ts:343`)
  returns `pendingSubmissions` (the "to check" count); its raw SQL names `fee_payments`
  unqualified.
- **Money input:** `parseTaka()` (`packages/shared/src/fees.ts:40`) accepts commas and Bangla
  digits and caps at ৳10 lakh: right for people, too lenient for a gateway's answer.
- **Jobs:** `TenantJobRunner.run(tenantId, fn, { actorUserId })`
  (`apps/api/src/tenancy/tenant-job-runner.service.ts:32`) makes the actor the principal, so
  `recordPayment` and `AuditService.record` name them; the tenant id must come from our own
  records. Queues are registered per module (`fees.module.ts:486`).
- **Public routes:** `@Public()` (`apps/api/src/common/decorators.ts:12`) gets no transaction
  (`tenant-context.interceptor.ts:32`); `RateLimitGuard` limits unauthenticated requests per
  address, 600 a minute (`apps/api/src/common/guards.ts:99-140`), unless `@NoRateLimit()`.
  `RateLimiter.consume(...rules)` counts a hit on every rule even when an earlier one refused
  (`apps/api/src/redis/rate-limiter.service.ts:53`), so budgets that must not be spent by refused
  requests are consumed one call at a time, cheapest refusal first.
- **Slug lookup:** `auth_resolve_tenant(p_slug)` (migration
  `20261017054031_auth_sessions_and_definer_functions:154`) returns id, name, status and locale;
  EXECUTE for `jantrik_app`.
- **Definer function rules:** `packages/db/test/schema-safety.test.ts:131-200`: pinned
  `search_path` with `pg_temp` last, no PUBLIC execute, no `uuid`/tenant parameter, scoped by
  context unless listed (`PRE_CONTEXT_AUTH_LOOKUPS` `:148`, `isIngest` `:179`).
- **Secrets at rest:** `packages/db/src/platform/secrets.ts:25-55` (AES-256-GCM, `v1.` +
  base64url(iv | tag | ciphertext), a development key derived from `OTP_PEPPER`); `env.ts:103`
  and `:177` require `PLATFORM_TOTP_KEY` in production; `production-env.ts` refuses example
  markers, short secrets and two equal secrets (deploy.md → Environment checks).
- **Not there:** no payment table, provider, queue, route or page; no `API_PUBLIC_URL` or
  `WEB_PUBLIC_URL`; no `PAYMENT_*` or `SSLCOMMERZ_*` variable. backlog.md holds the bKash
  tokenized plan this design follows.

## What P7a needs from other PRs (not in this branch)

- **#16, #18, #17** through `integration/sprint-1`.
- **#20 (P1-J8, verified request context):** every new policy calls
  `tenant_id = (SELECT app_current_tenant_id())`; context only through `withContext` (the
  `TenantJobRunner`, the request pipeline), never `set_config`; the request path's raw SQL is
  schema-qualified (`public.payment_intents`); runtime logins have no TEMP and no CREATE in
  `public`, so a function's new owner gets CREATE only for the hand-over and loses it in the same
  migration (P3b's `GRANT USAGE, CREATE` … `REVOKE CREATE`).
- **#23/#24 (P3a/P3b):** `WEB_PUBLIC_URL` (P3b adds it; if P7a2 starts first it adds the same
  variable with the same rules), and the pattern for a NOLOGIN role behind a public surface: the
  role created outside migrations, a migration guard that stops with the exact command, the
  `isAdmission` group and privilege snapshot in `schema-safety.test.ts`, and per-address limits
  checked before any shared budget.
- **#21/#22 (P5):** they change the dues engine around earlier years' dues and fee copies.
  Guardians already see earlier years' open dues (fees.md → Dues), and online payment treats them
  like any other due. P7a touches `fee-collection.service.ts`, the ledger and `fees-api.ts`;
  rebase after P5.
- **P0 (#12, merged):** the start-up check refuses a login that can become a BYPASSRLS role; the
  new role is NOLOGIN and NOBYPASSRLS and `jantrik_app` is never granted it (tested in Task 12).

## SSLCommerz: what the official documentation says (checked 2026-11-18)

Sources: [developer docs v4](https://developer.sslcommerz.com/doc/v4/),
[docs v3.5](https://developer.sslcommerz.com/docs.html), the sandbox documentation site
[sandbox-gw.sslcommerz.com/docs](https://sandbox-gw.sslcommerz.com/docs) with its pages
[IPN callbacks](https://sandbox-gw.sslcommerz.com/doc/v4/ipn.html),
[Order Validation](https://sandbox-gw.sslcommerz.com/doc/v4/order-validation.html) and
[Order Query](https://sandbox-gw.sslcommerz.com/doc/v4/order-query.html).

**Verified in the official docs:**

| Fact                                                                                                                                                                                                                                                                                                                       | Where                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Hosts: sandbox `https://sandbox.sslcommerz.com`, live `https://securepay.sslcommerz.com`; separate store IDs and passwords for each; TLS 1.2 or higher only                                                                                                                                                                | v4, v3.5, sandbox docs |
| Session: `POST /gwprocess/v4/api.php`; mandatory `store_id`, `store_passwd`, `total_amount` (decimal 10,2, **10.00 to 500000.00 BDT**), `currency`, `tran_id` (**string, 30**), `success_url`, `fail_url`, `cancel_url`, `cus_*`, `shipping_method`, `product_name`, `product_category`, `product_profile`                 | v4, sandbox docs       |
| `ipn_url` is an optional session parameter ("better to use"); the IPN listener is also set in the store panel; which wins is not stated                                                                                                                                                                                    | v4, IPN page           |
| `value_a`…`value_d` come back unchanged                                                                                                                                                                                                                                                                                    | v4                     |
| Session answer: `status` SUCCESS/FAILED, `failedreason`, `sessionkey` ("must be saved … to query"), `GatewayPageURL`                                                                                                                                                                                                       | v4                     |
| IPN: a POST to the listener; status `VALID`, `FAILED`, `CANCELLED`, `UNATTEMPTED`, `EXPIRED`; fields include `tran_id`, `val_id`, `amount`, `store_amount`, `currency`, `currency_type`, `currency_amount`, `bank_tran_id`, `card_type`, `risk_level`, `risk_title`, `verify_sign`, `verify_key`                           | IPN page, v4           |
| "Never trust the notification on its own": validate through the Order Validation API, and check `tran_id`, `amount`, `currency_type`, `currency_amount` against your own records                                                                                                                                           | IPN page               |
| Order Validation: `GET /validator/api/validationserverAPI.php?val_id&store_id&store_passwd&format=json`; status `VALID`, `VALIDATED` (validated more than once), `INVALID_TRANSACTION`; returns amount, currency fields, `bank_tran_id`, `card_type`, `risk_level`, `risk_title`                                           | Order Validation page  |
| `risk_level` 1 is high risk: "hold the service and proceed to collect customer verification documents"; the merchant decides                                                                                                                                                                                               | Order Validation, IPN  |
| Transaction Query: `GET /validator/api/merchantTransIDvalidationAPI.php` with `tran_id` (answer: `APIConnect`, `no_of_trans_found`, `element[]`, one per attempt) or `sessionkey`; status `VALID`, `VALIDATED`, `PENDING`, `FAILED`; `APIConnect` `INVALID_REQUEST`, `FAILED` (authentication), `INACTIVE` (store), `DONE` | Order Query page       |
| In a query, `currency` is the settlement currency and `currency_type`/`currency_amount` what the merchant sent                                                                                                                                                                                                             | Order Query page       |
| Network ("Common Issues"): sandbox, allow TCP 80/443 from `103.26.139.87`; live, from `103.26.139.81` and `103.132.153.81`, and reach `103.26.139.148`/`103.132.153.148` on 443. The older v3.5 page lists other sandbox addresses (`144.76.92.216`, `.241`)                                                               | sandbox docs, v3.5     |
| `verify_sign`/`verify_key`: v3.5 describes an MD5 scheme (an MD5 of the store password among sorted fields); the v4 IPN page does not describe it, and every page says to validate through the API                                                                                                                         | v3.5, IPN page         |
| Refund API (initiate with `bank_tran_id`, `refund_trans_id`, `refund_amount`, `refund_remarks`; query by `refund_ref_id`); "Your Public IP must be registered at SSLCOMMERZ Live System". **Out of scope** (sprint plan; P7b-I)                                                                                            | v4, sandbox docs       |
| Sandbox store: registration at `sandbox-gw.sslcommerz.com/register`; test cards VISA `4111111111111111`, Mastercard `5111111111111111`, AMEX `371111111111111` (expiry 12/26, CVV 111); mobile banking OTP `111111` or `123456`                                                                                            | sandbox docs           |

**Not in the official docs (from memory or from SSLCommerz's older connectivity guide and
community libraries); each is checked in the sandbox at P7a's start, as the sprint plan's Risks
section asks, and the code does not depend on it being true:**

- The payer's browser comes back as a **form POST** to `success_url`/`fail_url`/`cancel_url`
  carrying the IPN's fields (with `val_id`). The return routes accept POST and GET and trust none
  of it (P7a-N).
- IPN retries (whether, how often) and the exact acknowledgement (the docs say "print any
  message"; we answer 200). Assumed: at most one IPN; reconciliation (P7b) covers a lost one.
- Whether a per-session `ipn_url` overrides the panel's IPN URL. deploy.md tells the owner to set
  the panel URL to the same address.
- How long a session and its `GatewayPageURL` stay payable; when a `PENDING` transaction ends.
- The timezone of `tran_date` (assumed Asia/Dhaka; shown, never used for money in P7a).
- `card_type`/`card_brand` values (`BKASH-BKash`, `NAGAD-Nagad`, `DBBLMOBILEB-Dbbl Mobile
Banking` for Rocket, `VISA-…`, `MASTER-…`, `AMEX-…`): the method mapping falls back to
  `OTHER_ONLINE` for anything unknown (P7a-J).
- How a cancelled or never-attempted session shows in a query by `tran_id` (FAILED, another
  status, or nothing found).
- That a query with a random `tran_id` answers `APIConnect: DONE` with nothing found for good
  credentials and `FAILED` for bad ones (the test-connection check, P7a-M).
- What session init does with a `tran_id` it has seen before (we never reuse one).
- Rate limits on SSLCommerz's APIs.

## Global constraints

- **Module and roles:** every new route is `@RequireModule('FEES')`. Guardian routes
  `@Roles('GUARDIAN')` and 404 for another family's child or intent (auth.md → Access inside a
  role). Gateway account routes `@Roles('OWNER')` only. The two public routes are `@Public()` and
  `@NoRateLimit()` with their own limits. Jobs post validated money even if FEES was switched off
  or the institute suspended after the checkout (P7a-O); new checkouts need both.
- **S22, enforced on the server:** the request carries due ids, never an amount (only
  `expectedAmountPaisa`, compared like the counter's `expectedOutstandingPaisa`); each chosen due
  is paid in full (principal and fine owed on the checkout day); no staff route creates an intent.
- **S23, enforced in one place:** the `settle` decision table (below). Any reason puts the intent
  in `NEEDS_REVIEW`, records the money facts on the intent, and writes no `fee_payments` row and
  no receipt. An intent in `NEEDS_REVIEW` is never posted by a later signal.
- **Money:** integer paisa; gateway amounts parsed from `^\d{1,7}(\.\d{1,2})?$` strings exactly
  (`parseGatewayAmount`), never through a float; sent as `formatGatewayAmount(paisa)`
  (`125050` → `"1250.50"`). Online amounts between ৳10 and ৳5 lakh (P7a-L).
- **No HTTP call inside a transaction.** Every SSLCommerz call runs in a `payments` queue job
  between two short transactions. Job data carries ids only.
- **Secrets:** the store password never appears in a response, log line, `audit_logs`,
  `sms_logs`, `payment_gateway_events`, Redis key or value, job payload, failed job, or validation
  error. Validation and query calls are GETs with the password in the query string: the client
  never logs a URL or rethrows a `fetch` error (it maps every failure to a fixed code first).
- **Signals:** whitelisted fields only are stored (`status`, `tran_date`, `amount`,
  `store_amount`, `currency`, `currency_type`, `currency_amount`, `bank_tran_id`, `card_type`,
  `card_brand`, `risk_level`, `risk_title`, `error`; each a string ≤ 100 characters). Never
  `card_no` (even masked), `verify_sign`, `verify_key`, `value_*`, `cus_*` or `store_id`.
- **Audit (CLAUDE.md rule 6):** every create and status change of an intent (`payment_intent`),
  every gateway account change (`payment_gateway_account`, field names only:
  `{ changed: ['storeId','storePassword'] }`), every payment (`fee_payment`, as today).
- **Strings and digits:** bn and en; amounts, dates and counts in Bangla digits in bn; `tran_id`,
  `bank_tran_id`, receipt numbers and the store ID hint in ASCII (`formatIdentifier`).
- **Screens:** v3 kit, light-first; screenshots bn at 1366 and 390 px. The online pay sheet is
  loaded on demand so the guardian's fees page keeps its first-load size.
- **Gates:** affected tests during the work; at the end of each PR the full gates, then the
  review subagent, then the PR with CI green.

## Review focus

1. **One payment, three signals** (sprint review focus 1). The IPN, the browser return and a
   query arrive for one `tran_id` at the same moment. Expected: one `fee_payments` row, one
   receipt number, one receipt SMS; the other two runs record their events and change nothing.
   Test: Task 16 (three concurrent `settle` runs; the unique index alone, with the lock bypassed
   in a db test).
2. **Dues paid at the counter while the guardian is paying** (sprint review focus 2). Expected:
   the counter's payment stands; the online money is recorded on the intent (`NEEDS_REVIEW`,
   `DUES_CHANGED`, validated amount, `bank_tran_id`), never on a due, never twice. The counter
   sees "online payment in progress" on those dues while the intent is open. Test: Task 16.
3. **Mismatches never post** (S23). Amount, currency (`currency` or `currency_type`), `tran_id`
   (validated ≠ ours, or `bank_tran_id` missing or malformed), risk (`risk_level` not `"0"`,
   missing included), and a late success: each `NEEDS_REVIEW` with no payment row and no receipt.
   Test: Task 16.
4. **The return URL is never enough.** A POST to `…/return/<tranId>/success` with a made-up
   `val_id`, or with the `val_id` of another payment (ours or not): nothing is posted unless the
   Validation API, asked with this institute's credentials, confirms this `tran_id`, BDT and the
   exact amount. Test: Task 16.
5. **Cross-institute.** Institute B's `tran_id` sent to A's IPN URL: recorded at A as an
   unmatched event, nothing posted at either; another guardian's child or intent → 404. Test:
   Tasks 15 and 16.
6. **Credentials leak nowhere.** A sentinel password through save, test, a failing checkout, a
   failing validation and a 422: absent from every response, log, audit row, `sms_logs`, event,
   Redis key or value, and failed job. Test: Tasks 6 and 16.
7. **The new role cannot widen anyone's view.** `jantrik_app` is not a member of
   `jantrik_payments`; the `TO jantrik_payments` policies never apply to `jantrik_app`; the role's
   privileges equal a snapshot. Test: Task 12.
8. **The fine across midnight.** Checkout at 23:55, paid at 00:05 the next day, a per-day fine:
   posted (the fine counted to the checkout day, P7a-E), not a `DUES_CHANGED` review. Test:
   Task 16.

## Database

All new tenant tables: forced RLS, policy `tenant_isolation` with
`USING/WITH CHECK (tenant_id = (SELECT app_current_tenant_id()))`, `@@unique([tenantId, id])`,
composite foreign keys `ON UPDATE RESTRICT ON DELETE RESTRICT`, an index leading with
`tenant_id`, explicit grants, no DELETE, listed in `schema-safety.test.ts`, isolation tests in
`packages/db/test/payments-rls.test.ts`. CHECKs test nullable columns with `IS [NOT] NULL` first.
No tenant backfill.

### Enums

- `payment_provider`: `SSLCOMMERZ` (`BKASH_TOKENIZED` later, its own migration).
- `payment_intent_status`: `CREATED`, `REDIRECTED`, `PAID`, `FAILED`, `CANCELLED`, `EXPIRED`,
  `NEEDS_REVIEW` (the sprint plan's list) and `REFUNDED_OUTSIDE`, `DISMISSED` (P7b's outcomes,
  created now so P7b needs no enum-only migration; nothing in P7a writes them; P7a-T).
- `payment_review_reason`: `AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`, `TRAN_ID_MISMATCH`,
  `HIGH_RISK`, `DUES_CHANGED`, `LATE_SUCCESS`, `DUPLICATE`, `UNMATCHED` (the sprint plan's) and
  `VOIDED` (a posted gateway payment voided by an admin, P7a-G).
- `payment_event_kind`: `INIT`, `RETURN`, `IPN`, `VALIDATE`, `QUERY`.
- `fee_payment_channel` gains `GATEWAY`; `fee_payment_method` gains `ROCKET`, `CARD`,
  `OTHER_ONLINE` (S21), in a migration of their own.

### `payment_gateway_accounts` (P7a1; jantrik_app S I, UPDATE by column)

| Column                                                  | Type                                   | Rule                                                                                                   |
| ------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `id`, `tenant_id`                                       | uuid                                   |                                                                                                        |
| `provider`                                              | `payment_provider`                     | UNIQUE `(tenant_id, provider)`: one per provider per institute                                         |
| `mode`                                                  | text NOT NULL                          | CHECK `mode = 'SANDBOX'` (live is not this sprint)                                                     |
| `enabled`                                               | boolean NOT NULL                       | default false; CHECK `NOT enabled OR (credentials_ciphertext IS NOT NULL AND last_test_result = 'OK')` |
| `credentials_ciphertext`                                | text NULL                              | CHECK `IS NULL OR ~ '^v1\.[A-Za-z0-9_-]{40,2000}$'`                                                    |
| `credentials_hint`                                      | text NULL                              | the store ID's last 4 characters; CHECK `IS NULL OR ~ '^[A-Za-z0-9_-]{1,4}$'`                          |
| `key_version`                                           | smallint NOT NULL                      | default 1; CHECK `BETWEEN 1 AND 100`                                                                   |
| `credentials_updated_at`, `credentials_updated_by_id`   | timestamptz NULL, uuid NULL            | both NULL or both set                                                                                  |
| `last_test_at`, `last_test_result`, `last_tested_by_id` | timestamptz NULL, text NULL, uuid NULL | result CHECK `IN ('OK','BAD_CREDENTIALS','STORE_INACTIVE','UNREACHABLE','ERROR')`                      |
| `last_failure_code`, `last_failure_at`                  | text NULL, timestamptz NULL            | the last checkout or validation failure from a job (a fixed code), shown to the OWNER                  |
| `created_at`, `updated_at`                              |                                        |                                                                                                        |

- Grants: `SELECT, INSERT`, `UPDATE (enabled, credentials_ciphertext, credentials_hint,
key_version, credentials_updated_at, credentials_updated_by_id, last_test_at,
last_test_result, last_tested_by_id, last_failure_code, last_failure_at, updated_at)`. No
  DELETE: an account is switched off, never removed (P7a-P).
- Saving credentials sets `last_test_result = NULL` and `enabled = false` in the same update
  (P7a-M), so the CHECK above holds.
- The database cannot tell services apart: a code-scan test (Task 4) fails if any file under
  `apps/api/src` other than `payment-credentials.service.ts` names `credentialsCiphertext` or
  `credentials_ciphertext`.

### `payment_intents` (P7a2; jantrik_app S I, UPDATE by column, no DELETE)

| Column                                           | Type                                    | Rule                                                                                                                                           |
| ------------------------------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `tenant_id`                                | uuid                                    | `@@unique([tenantId, id])`, `@@unique([tenantId, id, studentId])` (target of the payment's key)                                                |
| `account_id`                                     | uuid NOT NULL                           | composite FK → `payment_gateway_accounts`                                                                                                      |
| `student_id`                                     | uuid NOT NULL                           | composite FK → `students`                                                                                                                      |
| `payer_user_id`                                  | uuid NOT NULL                           | FK → `users` (global, like `collected_by_id`)                                                                                                  |
| `amount_paisa`                                   | int NOT NULL                            | CHECK `BETWEEN 1000 AND 50000000` (৳10 to ৳5 lakh, SSLCommerz's range)                                                                         |
| `currency`                                       | text NOT NULL                           | CHECK `= 'BDT'`                                                                                                                                |
| `priced_on`                                      | date NOT NULL                           | the institute's day the amount was computed; the payment's `paid_on` (P7a-E)                                                                   |
| `tran_id`                                        | text NOT NULL                           | ours: `JS` + 26 Crockford base32 characters (time, then 80 random bits); UNIQUE `(tenant_id, tran_id)`; CHECK `~ '^JS[0-9A-HJKMNP-TV-Z]{26}$'` |
| `client_request_id`                              | uuid NOT NULL                           | UNIQUE `(tenant_id, client_request_id)`                                                                                                        |
| `status`                                         | `payment_intent_status`                 | default `CREATED`                                                                                                                              |
| `session_ref`                                    | text NULL                               | SSLCommerz `sessionkey`; CHECK `IS NULL OR char_length BETWEEN 1 AND 100`                                                                      |
| `checkout_url`                                   | text NULL                               | `GatewayPageURL`; CHECK `IS NULL OR ~ '^https://'` (the API also checks the host, below)                                                       |
| `init_error`                                     | text NULL                               | a fixed code when the session could not be made                                                                                                |
| `val_id`, `bank_tran_id`, `instrument`, `method` | text NULL ×3, `fee_payment_method` NULL | the validated payment's facts; written once (trigger)                                                                                          |
| `validated_amount_paisa`, `store_amount_paisa`   | int NULL                                | CHECK `≥ 0`; `store_amount_paisa ≤ validated_amount_paisa`                                                                                     |
| `validated_currency`                             | text NULL                               | as returned (`currency_type`), ≤ 10                                                                                                            |
| `risk`                                           | text NULL                               | CHECK `IN ('LOW','HIGH')`                                                                                                                      |
| `gateway_paid_at`                                | timestamptz NULL                        | `tran_date`, read as Asia/Dhaka; shown only                                                                                                    |
| `fee_payment_id`                                 | uuid NULL                               | composite FK `(tenant_id, fee_payment_id, student_id)` → `fee_payments`; UNIQUE `(tenant_id, fee_payment_id)`                                  |
| `expires_at`                                     | timestamptz NOT NULL                    | `created_at + 60 min`: the window in which it blocks another checkout for the child (P7a-F)                                                    |
| `review_reasons`                                 | `payment_review_reason[]` NOT NULL      | default `'{}'`                                                                                                                                 |
| `review_since`                                   | timestamptz NULL                        |                                                                                                                                                |
| `closed_at`                                      | timestamptz NULL                        | when it left `CREATED`/`REDIRECTED`                                                                                                            |
| `created_at`, `updated_at`                       |                                         |                                                                                                                                                |

- CHECKs: `(status = 'PAID') = (fee_payment_id IS NOT NULL)`;
  `status <> 'PAID' OR (val_id IS NOT NULL AND bank_tran_id IS NOT NULL AND method IS NOT NULL
AND validated_amount_paisa IS NOT NULL)`;
  `status <> 'NEEDS_REVIEW' OR (cardinality(review_reasons) > 0 AND review_since IS NOT NULL)`;
  `status <> 'REDIRECTED' OR (session_ref IS NOT NULL AND checkout_url IS NOT NULL)`;
  `(status IN ('CREATED','REDIRECTED')) = (closed_at IS NULL)`; `expires_at > created_at`.
- Indexes: `(tenant_id, student_id, status)`, `(tenant_id, status, created_at)`,
  `(tenant_id, payer_user_id, created_at)`.
- Grants: `SELECT, INSERT`, `UPDATE (status, session_ref, checkout_url, init_error, val_id,
bank_tran_id, instrument, method, validated_amount_paisa, store_amount_paisa,
validated_currency, risk, gateway_paid_at, fee_payment_id, review_reasons, review_since,
closed_at, updated_at)`. Never `amount_paisa`, `tran_id`, `student_id`, `payer_user_id`,
  `account_id`, `priced_on`, `client_request_id`, `expires_at`.
- Trigger `payment_intents_guard` (BEFORE UPDATE, plain SECURITY INVOKER, pinned `search_path`):
  - status moves only along the table in "Flow" below (anything else: `check_violation`);
  - `val_id`, `bank_tran_id`, `instrument`, `method`, `validated_amount_paisa`,
    `store_amount_paisa`, `validated_currency`, `risk`, `gateway_paid_at` go from NULL to a value
    once and never change: the money an intent stands for never changes;
  - `fee_payment_id` is set only with `status` → `PAID`, and cleared only with `PAID` →
    `NEEDS_REVIEW` when `VOIDED` is among the new reasons.
- Constraint trigger `payment_intents_paid_check` (AFTER INSERT OR UPDATE, DEFERRABLE INITIALLY
  DEFERRED): at commit, a `PAID` intent's payment is ACTIVE, channel `GATEWAY`, and names this
  intent.

### `payment_intent_dues` (P7a2; jantrik_app S I)

| Column                                          | Type          | Rule                                                                                                               |
| ----------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------ |
| `id`, `tenant_id`                               | uuid          |                                                                                                                    |
| `intent_id`, `student_id`                       | uuid NOT NULL | composite FK `(tenant_id, intent_id, student_id)` → `payment_intents (tenant_id, id, student_id)`                  |
| `due_id`                                        | uuid NOT NULL | composite FK `(tenant_id, due_id, student_id)` → `fee_dues (tenant_id, id, student_id)`: the child's own dues only |
| `planned_principal_paisa`, `planned_fine_paisa` | int NOT NULL  | the snapshot; CHECK both `≥ 0` and their sum `> 0`                                                                 |
| `created_at`, `updated_at`                      |               |                                                                                                                    |

- UNIQUE `(tenant_id, intent_id, due_id)`; index `(tenant_id, due_id)` (the counter's "in
  progress" badge).
- Constraint trigger (deferred, AFTER INSERT): at commit the intent's rows add up to its
  `amount_paisa`.

### `payment_gateway_events` (P7a2; jantrik_app S I; jantrik_payments INSERT by column)

| Column                     | Type                         | Rule                                                                                                                            |
| -------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `tenant_id`          | uuid                         | ids from the function are `gen_random_uuid()`; from the API, v7                                                                 |
| `intent_id`                | uuid NULL                    | composite FK → `payment_intents`; NULL: matched no intent of this institute                                                     |
| `kind`                     | `payment_event_kind`         |                                                                                                                                 |
| `outcome`                  | text NULL                    | RETURN: `SUCCESS`/`FAIL`/`CANCEL` (from the path, a hint only); VALIDATE/QUERY/INIT: the gateway status or our error code; ≤ 40 |
| `tran_id`, `val_id`        | text NULL                    | CHECK `~ '^[A-Za-z0-9_.-]{1,50}$'` each when not NULL                                                                           |
| `fields`                   | jsonb NOT NULL               | default `'{}'`; CHECK an object, only the whitelisted keys, string values, `octet_length(fields::text) <= 4000`                 |
| `source_listed`            | boolean NULL                 | RETURN/IPN: whether the sender's address is in SSLCommerz's documented list (P7a-C)                                             |
| `review_reason`            | `payment_review_reason` NULL | VALIDATE only: `UNMATCHED` or `DUPLICATE` (money with no intent to hold it, P7b's queue)                                        |
| `received_at`              | timestamptz NOT NULL         | the API's clock                                                                                                                 |
| `created_at`, `updated_at` |                              |                                                                                                                                 |

- CHECKs: `review_reason IS NULL OR (kind = 'VALIDATE' AND review_reason IN ('UNMATCHED','DUPLICATE'))`;
  `source_listed IS NULL OR kind IN ('RETURN','IPN')`.
- Indexes: `(tenant_id, intent_id, received_at)`, `(tenant_id, tran_id)`,
  `(tenant_id, received_at) WHERE review_reason IS NOT NULL`.
- Append-only: no UPDATE, no DELETE for anyone.

### `fee_payments` changes (P7a2)

- New column `payment_intent_id uuid NULL`, composite FK `(tenant_id, payment_intent_id,
student_id)` → `payment_intents (tenant_id, id, student_id)`.
- Partial unique `fee_payments_live_intent (tenant_id, payment_intent_id) WHERE status =
'ACTIVE' AND payment_intent_id IS NOT NULL`: one live payment per intent (P7a-G).
- `fee_payments_channel` replaced by:
  `(channel = 'COUNTER' AND method = 'CASH' AND trx_id IS NULL AND sender_phone IS NULL AND
payment_intent_id IS NULL) OR (channel = 'MOBILE_MANUAL' AND method IN ('BKASH','NAGAD') AND
trx_id IS NOT NULL AND sender_phone IS NOT NULL AND payment_intent_id IS NULL) OR (channel =
'GATEWAY' AND method IN ('BKASH','NAGAD','ROCKET','CARD','OTHER_ONLINE') AND trx_id IS NOT
NULL AND sender_phone IS NULL AND payment_intent_id IS NOT NULL)`.
- `fee_payments_trx_id` replaced by: `trx_id IS NULL OR (channel <> 'GATEWAY' AND trx_id ~
'^[A-Z0-9]{6,20}$') OR (channel = 'GATEWAY' AND trx_id ~ '^[A-Za-z0-9._-]{6,80}$')` (P7a-I).
- `fee_payments_live_trx` stays: a `bank_tran_id` already on a live payment of that method is
  refused, which `settle` turns into a `DUPLICATE` review.
- Constraint trigger (deferred, AFTER INSERT): a `GATEWAY` payment's intent is `PAID` with
  `fee_payment_id` = this payment at commit (the mirror of `payment_intents_paid_check`).
- Grants unchanged (INSERT is table-wide, UPDATE only the void columns).

### The role and the public function (P7a2, decision P7a-B)

- **Role** (outside migrations; `jantrik_owner` cannot create roles):
  `CREATE ROLE jantrik_payments NOLOGIN NOSUPERUSER NOBYPASSRLS; GRANT jantrik_payments TO
jantrik_owner WITH INHERIT FALSE, SET TRUE;` in `docker/postgres/init/01-roles.sh`,
  `deploy/postgres/create-roles.sh` (idempotent), database.md's role table and its "existing
  local volume" commands. The access migration starts with a guard that raises the exact command
  when the role is missing (P3b's guard).
- **Grants and policies** (`TO jantrik_payments` only; `jantrik_app` is not a member, so they
  never apply to it):

  | Table                    | Grant to `jantrik_payments`                                                                                                     | Policy                                                                                         |
  | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
  | `tenants`                | SELECT `(id, slug)`                                                                                                             | `payments_read` FOR SELECT USING (true)                                                        |
  | `payment_intents`        | SELECT `(tenant_id, id, student_id, tran_id)`                                                                                   | `payments_read` FOR SELECT USING (true)                                                        |
  | `payment_gateway_events` | INSERT `(id, tenant_id, intent_id, kind, outcome, tran_id, val_id, fields, source_listed, received_at, created_at, updated_at)` | `payments_signal` FOR INSERT WITH CHECK (`kind IN ('RETURN','IPN') AND review_reason IS NULL`) |

- **Function** `payment_signal_record(p_slug text, p_kind text, p_tran_id text, p_outcome text,
p_val_id text, p_fields jsonb, p_source_listed boolean, p_now timestamptz) RETURNS TABLE
(result text, tenant_id uuid, event_id uuid, intent_id uuid, student_id uuid)`; `SECURITY
DEFINER`, `SET search_path = pg_catalog, public, pg_temp`, schema-qualified bodies; `REVOKE ALL
… FROM PUBLIC`, `GRANT EXECUTE … TO jantrik_app` before `OWNER TO jantrik_payments`, then
  `REVOKE CREATE ON SCHEMA public FROM jantrik_payments`. Always one row:
  1. `p_kind` in (`RETURN`, `IPN`); for RETURN, `p_outcome` in (`SUCCESS`,`FAIL`,`CANCEL`) and
     `p_tran_id` matches our pattern; `p_tran_id`, `p_val_id` match the event CHECKs; `p_fields`
     whitelisted (the same rule as the CHECK). Else `INVALID`, nothing stored.
  2. Resolve the slug (any status: money is recorded even for a suspended institute). Unknown →
     `UNKNOWN`, nothing stored.
  3. Find the intent by `(tenant_id, tran_id)`. A RETURN with no intent → `NO_INTENT`, nothing
     stored (the payer's browser goes to the child list). An IPN with no intent is stored with
     `intent_id` NULL.
  4. Insert the event (`received_at = p_now`); `RECORDED` with the ids.
- **schema-safety additions:** an `isPayments` group (owner `jantrik_payments`, EXECUTE for
  `jantrik_app` only, not `jantrik_platform_app`, `jantrik_ingest_app`, `jantrik_login_app` or
  PUBLIC), excluded from "scoped by context" with the reason ("before any context: the
  institute comes from the slug, the intent from its own `tran_id`"); no `uuid` parameter, so no
  new exception there; a privilege snapshot of `jantrik_payments` equal to the table above.

### Migrations, in order

P7a1 (timestamps after the last merged migration; in a day run, the `2026111750…` band):

1. `…_payment_gateway_accounts`: `payment_provider`, the table, RLS, CHECKs, grants.

P7a2 (`2026111751…`):

2. `…_fee_payment_gateway_values`: `ALTER TYPE fee_payment_channel ADD VALUE 'GATEWAY'`, and
   `fee_payment_method` `ROCKET`, `CARD`, `OTHER_ONLINE` (nothing else: a new value cannot be used
   in the transaction that adds it).
3. `…_payment_intents`: the other three enums, the three tables, the `fee_payments` column, index,
   CHECKs and triggers.
4. `…_payment_signal_access`: the role guard, `GRANT USAGE, CREATE ON SCHEMA public TO
jantrik_payments`, the grants and policies.
5. `…_payment_signal_function`: the function, its privileges, `OWNER TO`, `REVOKE CREATE`.

Each written by hand (or `migrate dev --create-only` once against a scratch database, folder found
with `ls -t`), drift-checked with `prisma migrate diff`, applied to a scratch database only.

## The provider (P7a1)

`apps/api/src/payments/provider.ts`, as approved, with two refinements the checks need (the
validated `tran_id` and the currency fields must reach `settle`, and a query can return several
attempts):

```ts
interface PaymentProvider {
  readonly key: 'SSLCOMMERZ'; // 'BKASH_TOKENIZED' later, as an institute setting
  readonly credentialsSchema: ZodType<SslcommerzCredentials>; // { storeId, storePassword }
  testConnection(creds): Promise<ProviderTestResult>; // OK | BAD_CREDENTIALS | STORE_INACTIVE | UNREACHABLE | ERROR
  createCheckout(
    creds,
    intent: CheckoutRequest,
  ): Promise<{ redirectUrl: string; sessionRef: string }>;
  confirm(creds, ref: { tranId: string; valId?: string }): Promise<ProviderOutcome>; // the Validation API
  query(creds, tranId: string): Promise<ProviderAttempt[] | ProviderError>; // the Transaction Query API
}
type ProviderOutcome =
  | {
      kind: 'PAID'; // VALID or VALIDATED
      tranId: string | null; // as the gateway returned it
      valId: string;
      amountPaisa: number | null; // null: not a well-formed amount
      currency: string | null; // `currency`
      currencyType: string | null; // `currency_type`
      currencyAmountPaisa: number | null; // `currency_amount`
      storeAmountPaisa: number | null;
      bankTranId: string | null;
      instrument: string | null; // `card_type`
      risk: 'LOW' | 'HIGH'; // 'LOW' only for risk_level "0"; anything else, missing included, 'HIGH'
      paidAt: Date | null;
    }
  | { kind: 'PENDING' }
  | { kind: 'FAILED' | 'CANCELLED' | 'EXPIRED' }
  | { kind: 'INVALID' } // INVALID_TRANSACTION: not a payment of this store
  | { kind: 'ERROR'; code: ProviderErrorCode }; // TIMEOUT | NETWORK | HTTP_STATUS | BAD_RESPONSE | AUTH_FAILED | STORE_INACTIVE | INVALID_REQUEST
```

- **`SslcommerzProvider`:** base URL fixed per mode (`https://sandbox.sslcommerz.com`); the
  override `SSLCOMMERZ_BASE_URL` is accepted only with `NODE_ENV` development or test (the fake
  server). Session init is a form POST; validation and query are GETs with `format=json`. Every
  call has `AbortSignal.timeout(30_000)`; non-2xx, non-JSON, a missing field or an `APIConnect`
  other than `DONE` become a fixed `ProviderErrorCode`; no body, header or URL ever leaves the
  client. Responses are parsed with zod schemas that keep only the fields above.
- **Session fields:** `total_amount` = `formatGatewayAmount(amount)`, `currency` BDT, our
  `tran_id`, `success_url`/`fail_url`/`cancel_url` =
  `${API_PUBLIC_URL}/public/payments/sslcommerz/${slug}/return/${tranId}/(success|fail|cancel)`,
  `ipn_url` = `${API_PUBLIC_URL}/public/payments/sslcommerz/${slug}/ipn`, `product_name` "School
  fees" (`বেতন ও ফি` is not sent: ASCII only), `product_category` "Education", `product_profile`
  `non-physical-goods`, `shipping_method` `NO`, `emi_option` 0, `value_a` = the intent id
  (support only, never trusted). Customer fields per P7a-K: the guardian's name as the institute
  recorded it (else "Guardian"), phone in local form (`01…`), `cus_email` a fixed no-reply
  address, address fields from the institute profile when set (else `N/A`), country
  "Bangladesh".
- **`GatewayPageURL` check:** `https:` and a host of the mode's list (`sandbox.sslcommerz.com`,
  plus `*.sslcommerz.com` subdomains seen in the sandbox); otherwise `BAD_RESPONSE` and the intent
  fails. The browser is never sent to an address the gateway's answer chose freely.
- **Method mapping** (`methodFromInstrument`, data in `@jantrik/shared`, P7a-J): `card_type`
  prefix `BKASH-` → BKASH, `NAGAD-` → NAGAD, `DBBLMOBILEB-` → ROCKET, `card_brand` one of
  `VISA`, `MASTERCARD`, `AMEX` or `card_type` prefix `VISA-`, `MASTER-`, `AMEX-` → CARD, anything
  else → OTHER_ONLINE. The raw `card_type` is kept in `instrument` (≤ 50 characters).
- **Test connection:** a query by a random `JSTEST…` `tran_id`: `APIConnect DONE` → OK, `FAILED`
  → BAD_CREDENTIALS, `INACTIVE` → STORE_INACTIVE, a network error or timeout → UNREACHABLE,
  anything else → ERROR (P7a-M; checked in the sandbox).
- **The fake server** (`apps/api/test/support/fake-sslcommerz.ts`, and
  `apps/api/scripts/fake-sslcommerz.ts` to run it standalone for Playwright on port 4090): the
  three endpoints with the documented shapes; a payer page `/pay/<sessionkey>` with "Pay",
  "Fail", "Cancel" buttons that posts the browser back and sends the IPN; controls for the tests
  (amount, currency, `risk_level`, `bank_tran_id`, status, a second VALID attempt, delays,
  timeouts, HTTP 500, `APIConnect` FAILED/INACTIVE, a malformed body); it records what it was
  sent (the sentinel test's positive control).

## Flow

### States

| From                             | May move to                                                                                                        | By                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `CREATED`                        | `REDIRECTED` (session made), `FAILED` (session failed), `CANCELLED` (abandoned), `PAID`, `NEEDS_REVIEW`, `EXPIRED` | init job, payer, `settle`; `EXPIRED` only from P7b |
| `REDIRECTED`                     | `PAID`, `NEEDS_REVIEW`, `FAILED`, `CANCELLED`, `EXPIRED`                                                           | `settle`, payer (abandon); `EXPIRED` only from P7b |
| `FAILED`, `CANCELLED`, `EXPIRED` | `NEEDS_REVIEW` (`LATE_SUCCESS`)                                                                                    | `settle`                                           |
| `PAID`                           | `NEEDS_REVIEW` (`VOIDED`)                                                                                          | the void hook                                      |
| `NEEDS_REVIEW`                   | `PAID` (applied), `REFUNDED_OUTSIDE`, `DISMISSED`                                                                  | P7b's review actions only                          |
| `DISMISSED`                      | `NEEDS_REVIEW` (`LATE_SUCCESS`)                                                                                    | `settle`                                           |
| `REFUNDED_OUTSIDE`               | nothing (final; more money for it is a `DUPLICATE` event)                                                          |                                                    |

### 1. Checkout (`POST /me/children/:id/fees/online-payments`)

In the guardian's request transaction:

1. `assertChild` (404); the account exists and is enabled, `API_PUBLIC_URL` and `WEB_PUBLIC_URL`
   are set (else 422 `ONLINE_PAYMENTS_OFF`); `RateLimiter` `pay-start:<userId>` 10 an hour.
2. `lockTenantFees('shared')`, `lockStudentFees(student)`.
3. Replay: an intent with this `client_request_id` → the same intent if the payer, child and
   dues match, else 422 `IDEMPOTENCY_MISMATCH`.
4. One in progress per child (P7a-F): an intent of this child in `CREATED`/`REDIRECTED` with
   `expires_at > now` → 409 `PAYMENT_IN_PROGRESS` `{ intentId, mine }` (no name of who started it).
5. `planContext()`, `ensureForStudents([child])`, `openDues(child, dueIds)`; each due's balance
   on `today`; a due owing 0 → 422 `NOTHING_DUE`; the sum ≠ `expectedAmountPaisa` → 409
   `DUES_CHANGED { amountPaisa }`; outside ৳10–৳5 lakh → 422 `ONLINE_AMOUNT_OUT_OF_RANGE
{ minPaisa, maxPaisa }`.
6. Insert the intent (`priced_on = today`, `tran_id = newTranId()`, `expires_at = now + 60 min`)
   and one `payment_intent_dues` row per due with its principal and fine; audit
   `payment_intent` CREATE `{ amountPaisa, dues, tranId }`; after commit queue `checkout-init`
   (`jobId = init-<intentId>`).

### 2. `checkout-init` job

1. Transaction (no actor): the intent (`CREATED`?), the account, decrypted credentials, the
   guardian's name and phone, the slug. Anything else → stop.
2. Outside a transaction: `createCheckout`. One attempt, no retry (a retry would reuse the
   `tran_id` with a session that may exist, P7a-Q).
3. Transaction: an `INIT` event; ok → `REDIRECTED` with `session_ref`, `checkout_url`; error →
   `FAILED` with `init_error` and the account's `last_failure_code`; audited.

### 3. Signals (public routes)

`POST|GET /public/payments/sslcommerz/:slug/return/:tranId/:outcome` and
`POST /public/payments/sslcommerz/:slug/ipn`:

1. Limits (P7a-C, refused requests spend no shared budget): RETURN `pay-ret-ip:<ip>` 60 a minute
   (over it: still a 303, nothing recorded; the page's poll heals). IPN from a listed source
   `pay-ipn-ip:<ip>` 1 200 a minute; from any other source first `pay-ipn-ip:<ip>` 30 a minute,
   then, only once the body parsed, `pay-ipn-tenant:<slug>` 120 an hour; over → 429.
2. Body: `application/x-www-form-urlencoded`, ≤ 16 KB; the whitelist above; formats checked; a
   malformed request → IPN 200 `OK` with nothing stored (no retries invited), RETURN 303 to
   `/children`.
3. `payment_signal_record(...)` through `PrismaService.client` (no transaction of ours, no
   context).
4. `RECORDED` with an intent → queue `confirm` (`jobId = confirm-<intentId>`, so a burst of
   signals makes one job); without an intent → queue `unmatched-check` (`jobId =
unmatched-<eventId>`).
5. Answer: IPN `200 OK` (also for `UNKNOWN` and `NO_INTENT`: an unknown slug learns nothing a
   public slug list does not already say); RETURN `303` to
   `${WEB_PUBLIC_URL}/children/<studentId>/fees/pay/<intentId>`, or `/children` when there is no
   intent. The status in the path is stored as a hint and never trusted.

### 4. `confirm` job (`{ tenantId, intentId }`, 6 attempts, backoff from 30 s)

1. Transaction (no actor): the intent, its account's credentials, and the `val_id`s seen in its
   RETURN/IPN events that have no VALIDATE event yet.
2. Outside a transaction, for each such `val_id`: `confirm(creds, { tranId, valId })`. When there
   is none (a FAIL/CANCEL return, an IPN status other than VALID, a return without fields, a heal):
   `query(creds, tranId)`, recorded as a QUERY event; every VALID/VALIDATED attempt's `val_id` is
   then validated the same way (one decision path: nothing is posted from a query answer alone,
   P7b-A).
3. `TenantJobRunner.run(tenantId, settle, { actorUserId: intent.payer_user_id })` for each result.
4. A provider `ERROR` → the account's `last_failure_code`, and the job throws a fixed-code error
   so BullMQ retries; after the last attempt the intent stays as it is (P7b's reconciliation and
   the page's heal pick it up).

### 5. `settle` (the only place that posts; locks: tenant shared → student → intent `FOR UPDATE`)

A VALIDATE event (or QUERY event) is written first, whatever follows. Then, for a `PAID` outcome
with `val_id = v`:

**First, whose money is it?** If the `tran_id` the gateway returned is not this intent's, no money
fact is recorded on this intent (the money belongs to the returned `tran_id` and is handled through
its own signals, or listed as unmatched). An intent that is open, `FAILED`, `CANCELLED`, `EXPIRED`
or `DISMISSED` goes to `NEEDS_REVIEW` with `TRAN_ID_MISMATCH`; one already in `NEEDS_REVIEW` gains
the reason; a `PAID` or `REFUNDED_OUTSIDE` intent keeps its state (the event is the record).
Conservative, as the owner asked (P7a-H). Otherwise:

| Intent state                                                          | Decision                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| already holding `val_id = v` (any state)                              | nothing (a repeat signal)                                                                                                                                                                                                                                                                                                                                                                                                   |
| `PAID`, `NEEDS_REVIEW` or `REFUNDED_OUTSIDE` holding another `val_id` | the VALIDATE event gets `review_reason = DUPLICATE` (money received twice, P7b's queue); the intent unchanged                                                                                                                                                                                                                                                                                                               |
| `NEEDS_REVIEW` with no money yet                                      | record the money facts; stays `NEEDS_REVIEW` (never posted by a signal)                                                                                                                                                                                                                                                                                                                                                     |
| `FAILED`, `CANCELLED`, `EXPIRED`, `DISMISSED`                         | record the facts; `NEEDS_REVIEW` + `LATE_SUCCESS`                                                                                                                                                                                                                                                                                                                                                                           |
| `CREATED`, `REDIRECTED`                                               | record the facts and collect reasons: `TRAN_ID_MISMATCH` (`bank_tran_id` missing or not `^[A-Za-z0-9._-]{6,80}$`), `CURRENCY_MISMATCH` (`currency` or `currency_type` ≠ BDT), `AMOUNT_MISMATCH` (`amount` or `currency_amount` ≠ `amount_paisa`, unparseable included), `HIGH_RISK`, `DUES_CHANGED` (a due no longer OPEN, or its principal or fine owed on `priced_on` ≠ the snapshot). Any → `NEEDS_REVIEW`. None → post. |

**Posting:** `recordPayment({ studentId, dues: openDues(snapshot ids), amountPaisa:
intent.amount_paisa, method: methodFromInstrument(...), channel: 'GATEWAY', trxId: bank_tran_id,
senderPhone: null, paidOn: priced_on, recordedOn: today, clientRequestId: intent.id,
paymentIntentId: intent.id })` as the payer; then the intent → `PAID` with `fee_payment_id`;
audit `payment_intent` UPDATE; the receipt SMS as today. A unique violation (`fee_payments_live_intent`
or `fee_payments_live_trx`: the same `bank_tran_id` already on a live payment) rolls everything
back; `settle` runs again in a new transaction and puts the intent in `NEEDS_REVIEW` with
`DUPLICATE`, the money facts kept.

A FAIL or CANCEL return, or an IPN status other than VALID, closes a `CREATED`/`REDIRECTED`
intent as `FAILED` or `CANCELLED` (the return's path picks the word) only when a query then finds
no VALID, VALIDATED or PENDING attempt (the session is over). A scheduled query alone closes
nothing before `expires_at` (P7b), and `PENDING` changes nothing (P7b expires it at +25 h).

### 6. Abandon, void and the counter

- `POST …/online-payments/:intentId/abandon` (the payer, `CREATED`/`REDIRECTED`) →
  `CANCELLED`, audited; a success that still arrives becomes `LATE_SUCCESS`.
- **Void of a GATEWAY payment** (`POST /fees/payments/:id/void`, OWNER/ADMIN, unchanged route):
  `FeeCollectionService` calls a hook the payments module registers at start (like
  `registerRelevanceCheck`, no circular import): the intent → `NEEDS_REVIEW` with `VOIDED`,
  `fee_payment_id` NULL, in the same transaction (P7a-G). P7b re-applies or refunds it.
- **Counter:** the ledger's due view gains `onlinePending: boolean` (an open, unexpired intent
  names the due); the counter shows a badge and still takes cash (review focus 2).

### Locks and idempotency

- `fee-locks.ts` gains a step: **2a. the payment intent row (`FOR UPDATE`), after the student's
  lock.** Every writer of an intent takes the student's lock first (checkout, abandon, settle,
  void hook, P7b's actions), so the counter, a void and three signals serialise on the student.
- Idempotency layers: BullMQ `jobId` per intent (a burst makes one job); VALIDATE events by
  `val_id` (each `val_id` validated once per intent, unless the call failed); the state table
  above under the row lock; `fee_payments_live_intent` and `fee_payments_live_trx` in the
  database; `client_request_id` = intent id for the payment; the receipt SMS's dedupe key.

### Failure modes

| What happens                                                 | Result                                                                                                           |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| SSLCommerz down or slow at checkout                          | `FAILED` (`init_error` TIMEOUT/NETWORK/HTTP_STATUS); the page offers "try again" and the manual bKash/Nagad form |
| Bad credentials (password changed in the panel)              | `FAILED` (AUTH_FAILED); the OWNER's settings page shows the last failure; checkouts keep failing until fixed     |
| `PAYMENT_CREDENTIALS_KEY` changed                            | decryption fails → `FAILED` (CREDENTIALS_UNREADABLE) and "enter the credentials again" on the settings page      |
| Validation API down when a success arrives                   | `confirm` retries six times (about 30 minutes); then reconciliation (P7b) and the page's heal                    |
| Worker dies after posting, before the job is marked done     | the job runs again and finds `PAID` with that `val_id`: nothing                                                  |
| Database error while posting                                 | one transaction: nothing half-written; retried                                                                   |
| IPN lost (localhost, firewall, our 429)                      | the browser return; then reconciliation (P7b)                                                                    |
| Return lost (tab closed)                                     | the IPN; then reconciliation                                                                                     |
| Both lost, and Redis lost the jobs                           | P7b: the sweep, the nightly per-institute re-queue, heal on read                                                 |
| Paid twice in one session, or two sessions for the same dues | the second `val_id` → `DUPLICATE` (P7b: refund outside)                                                          |
| Dues changed between checkout and payment                    | `DUES_CHANGED` review (counter payment, waiver, recalculation, cancellation)                                     |
| A per-day fine grows past midnight                           | none: fines counted to `priced_on` (review focus 8)                                                              |
| Receipt SMS over the cap or failed                           | the receipt exists; the SMS follows today's rules                                                                |
| FEES switched off, institute suspended, guardian unlinked    | validated money is still posted (P7a-O, P7a-R); new checkouts refused                                            |

## API

### Guardian (`GuardianPaymentsController`, `@RequireModule('FEES')`, `@Roles('GUARDIAN')`)

| Route                                                          | Does                                                                                                     | Errors                                                                                                                                              |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /me/children/:id/fees` (existing)                         | gains `online: { available: boolean; inProgress: { intentId, mine, createdAt } \| null }`                |                                                                                                                                                     |
| `POST /me/children/:id/fees/online-payments`                   | `{ dueIds (1–24), expectedAmountPaisa, clientRequestId }` → 201 the payment view                         | 404; 409 `DUES_CHANGED`, `PAYMENT_IN_PROGRESS`; 422 `NOTHING_DUE`, `ONLINE_AMOUNT_OUT_OF_RANGE`, `ONLINE_PAYMENTS_OFF`, `IDEMPOTENCY_MISMATCH`; 429 |
| `GET /me/children/:id/fees/online-payments/:intentId`          | the payment view (any guardian of the child; `checkoutUrl` only for the payer); a heal when open (below) | 404                                                                                                                                                 |
| `POST /me/children/:id/fees/online-payments/:intentId/abandon` | the payer only → `CANCELLED`                                                                             | 404; 409 `NOT_ABANDONABLE`                                                                                                                          |

- **The payment view** (`OnlinePaymentView` in `packages/shared/src/payments-api.ts`):
  `{ id, state, amountPaisa, dues: [{ id, head, periodKey, term, principalPaisa, finePaisa }],
createdAt, checkoutUrl?, receipt?: { id, receiptNumber } }`, where `state` is what a guardian
  may know: `PREPARING` (CREATED), `READY` (REDIRECTED, no return yet), `CONFIRMING`
  (REDIRECTED after a return), `PAID`, `CHECKING` (NEEDS_REVIEW, any reason: "the school is
  checking this payment; do not pay again"), `NOT_PAID` (FAILED, CANCELLED, DISMISSED),
  `EXPIRED`, `REFUNDED`. Review reasons are never shown to guardians.
- **Heal on read:** an open intent older than one minute whose last confirm is over a minute old
  re-queues `confirm` (`pay-heal:<intentId>`, once a minute).
- `GET /me/children/:id/fees/payments/:paymentId` (existing) serves gateway receipts too.

### Gateway account (`GatewayAccountController`, `@RequireModule('FEES')`, `@Roles('OWNER')`)

| Route                                                   | Does                                                                                                                                    | Errors                                        |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `GET /fees/online-payments/account`                     | `{ provider, mode: 'SANDBOX', configured, enabled, hint, credentialsUpdatedAt, lastTest: { at, result } \| null, lastFailure, ipnUrl }` |                                               |
| `PUT /fees/online-payments/account`                     | `{ storeId, storePassword }` (write-only) → disables the account, clears the test; audit field names only                               | 422 (messages never echo a value)             |
| `POST /fees/online-payments/account/test`               | 202; queues `account-test` (`pay-test:<tenantId>` 10 an hour)                                                                           | 422 `CREDENTIALS_REQUIRED`; 429               |
| `POST /fees/online-payments/account/enable` / `disable` | on/off; audited                                                                                                                         | 422 `TEST_REQUIRED`, `API_PUBLIC_URL_MISSING` |

### Public (`GatewaySignalsController`, `@Public()`, `@NoRateLimit()`)

As in "Flow → Signals". A code-scan test (`apps/api/src/payments/public/no-tenant-access.spec.ts`)
fails if a file under `apps/api/src/payments/public/` imports `Db`, `TenantJobRunner`,
`FeeCollectionService` or `PaymentCredentialsService`.

### Jobs (queue `payments`, `PaymentsProcessor`, data ids only)

| Job               | Data                                   | Notes                                                                                                                                                 |
| ----------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkout-init`   | `{ tenantId, intentId }`               | one attempt                                                                                                                                           |
| `confirm`         | `{ tenantId, intentId }`               | `jobId confirm-<intentId>`; 6 attempts, exponential from 30 s; `removeOnComplete`                                                                     |
| `unmatched-check` | `{ tenantId, eventId }`                | validates the event's `val_id` when it has one and `pay-unmatched:<tenantId>` (30 an hour) allows; a VALID answer → a VALIDATE event with `UNMATCHED` |
| `account-test`    | `{ tenantId, accountId, actorUserId }` | writes `last_test_*`; audited                                                                                                                         |

## Web

- **Guardian, `/children/[id]/fees`:** when `online.available`, a primary "অনলাইনে পরিশোধ" /
  "Pay online" (bKash, Nagad, Rocket, card) above the existing "I paid by bKash/Nagad", which
  stays as the fallback. With `inProgress`, the button says "Continue the payment in progress"
  and links to it.
- **`online-pay-sheet.tsx`** (new, loaded on demand): the owed dues as checkboxes, each with its
  full amount owed today (principal, fine); overdue ones ticked first; the total in Bangla digits;
  "pays the chosen dues in full" and "the amount is set by the school" in plain words; no amount
  field. "Continue to SSLCommerz" → POST → the payment page. 409 `DUES_CHANGED` refreshes the
  dues and says why; under ৳10 explains the minimum.
- **`/children/[id]/fees/pay/[intentId]`:** `PREPARING` (polls every second up to 30 s) → `READY`
  (`location.assign(checkoutUrl)` at once, a button as well) → back from the gateway
  `CONFIRMING` (every 2 s for 2 minutes, then every 15 s; "this can take a few minutes; do not pay
  again") → `PAID` (amount, receipt number, "View receipt") / `CHECKING` / `NOT_PAID` ("Start
  again" abandons and returns to the sheet; the manual form as an alternative) / `EXPIRED`.
- **Receipts** (`components/fees/receipt.tsx`): channel GATEWAY prints "অনলাইনে (SSLCommerz) ·
  <method>", the bank transaction ID (ASCII) and our `tran_id`, and "Paid online" instead of a
  collector's name.
- **OWNER, `/fees/setup/online-payments`** (a tab beside "numbers"): a SANDBOX badge; status
  (not set up, set up and off, on), the hint `••••1234`, last test and last failure; the
  write-only form (store ID, store password, never pre-filled); "Test connection" (polls the
  result); "Turn on"/"Turn off"; the IPN address to paste into the SSLCommerz panel, copyable.
- **Counter:** an "online payment in progress" badge on a due with `onlinePending`.
- **Strings:** `fees.guardian.online.*`, `fees.setup.online.*`, `fees.receipt.gateway.*`,
  method names for ROCKET, CARD, OTHER_ONLINE (bn/en); the new page uses the `children` route
  namespace (already loads `fees.guardian`).

## Environment

| Variable                                    | Read by          | Rules                                                                                                                                                                                                                                 |
| ------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAYMENT_CREDENTIALS_KEY`                   | API, worker      | ≥ 32 characters; required in production; development and test derive one from `OTP_PEPPER` (as `PLATFORM_TOTP_KEY`); production refuses example markers and a value equal to `JWT_ACCESS_SECRET`, `OTP_PEPPER` or `PLATFORM_TOTP_KEY` |
| `API_PUBLIC_URL`                            | API, worker      | the base of the return and IPN URLs; optional; production refuses a value that is not `https://` or is local; enabling an account without it → 422                                                                                    |
| `WEB_PUBLIC_URL`                            | API              | from P3b (same rules); the 303 target                                                                                                                                                                                                 |
| `SSLCOMMERZ_SANDBOX_STORE_ID`, `…_PASSWORD` | dev scripts only | production refuses either one set                                                                                                                                                                                                     |
| `SSLCOMMERZ_BASE_URL`                       | API, worker      | development and test only (the fake server); production refuses it (P7a-S)                                                                                                                                                            |

Added to `.env.example`, `deploy/.env.prod.example` (the key only), `deploy/docker-compose.prod.yml`
(API and worker), `deploy/compose.sh`'s secret checks, deploy.md (Environment checks; the IPN URL
per institute: `https://api.<domain>/public/payments/sslcommerz/<slug>/ipn`; allow SSLCommerz's
documented addresses through any firewall in front of Caddy). The owner fills `.env`.

## What needs the owner (real accounts)

Nothing in P7a needs a real account to be built or tested: CI and every local test use the fake
SSLCommerz. The owner's steps, only to try a real sandbox payment (sprint-1.md → "What needs real
accounts"):

1. **A sandbox store:** register at `https://sandbox-gw.sslcommerz.com/register` (the docs'
   "Create Sandbox Account"; SSLCommerz's docs also point to their helpline). The store ID and
   password arrive by email.
2. **Put them in the root `.env`** as `SSLCOMMERZ_SANDBOX_STORE_ID` and
   `SSLCOMMERZ_SANDBOX_STORE_PASSWORD` (never in chat or code).
3. **Run the smoke test yourself:** `pnpm --filter @jantrik/api payments:sandbox-smoke`, open the
   printed address, pay ৳10 with the docs' test card (`4111 1111 1111 1111`, 12/26, CVV 111) or
   mobile banking OTP `111111`. It prints what SSLCommerz answered and which undocumented points
   it could confirm.
4. **Optional, in the app on your machine:** run
   `pnpm --filter @jantrik/api payments:load-sandbox -- --tenant shapla-school`, then as Shapla's
   owner test the connection and turn it on, and pay as a demo guardian. Without a public address the payment completes through the browser return (and
   P7b's queries); for the IPN, a tunnel (for example cloudflared) to the API with `API_PUBLIC_URL`
   set to it, or the staging server.
5. **Later, not this sprint:** each institute's live merchant account with SSLCommerz, a live mode
   (a new decision), and the institute's IPN URL in its SSLCommerz panel.

## Files

| File                                                                                                                                                                                                                                                      | Change                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `packages/db/prisma/schema.prisma` + 5 migrations                                                                                                                                                                                                         | enums, tables, `fee_payments` changes, the role's grants, the function                                       |
| `packages/db/test/payments-rls.test.ts`, `payments-function.test.ts`, `schema-safety.test.ts`, `fees-payments-rls.test.ts` (extended)                                                                                                                     | isolation, constraints, triggers, the function and role                                                      |
| `docker/postgres/init/01-roles.sh`, `deploy/postgres/create-roles.sh`                                                                                                                                                                                     | `jantrik_payments`                                                                                           |
| `packages/shared/src/payments.ts` (+ `.test.ts`), `payments-api.ts`, `fees-api.ts`, `index.ts`                                                                                                                                                            | amounts, `tran_id`, method mapping, views, the new methods and channel                                       |
| `apps/api/src/payments/` (`payments.module.ts`, `provider.ts`, `sslcommerz/*`, `payment-credentials.service.ts`, `gateway-account.*`, `checkout.service.ts`, `guardian-payments.controller.ts`, `settle.service.ts`, `payments.processor.ts`, `public/*`) | the module                                                                                                   |
| `apps/api/src/fees/collection/fee-collection.service.ts`, `fees.module.ts`, `fee-locks.ts`, `dues/fee-ledger.service.ts`, `mobile/fee-mobile.service.ts`                                                                                                  | `GATEWAY` in `recordPayment`, the void hook, exports, step 2a, `onlinePending`, the guardian view's `online` |
| `apps/api/src/config/env.ts`, `production-env.ts` (+ specs)                                                                                                                                                                                               | variables and production checks                                                                              |
| `apps/api/scripts/payments-sandbox-smoke.ts`, `payments-load-sandbox.ts`, `fake-sslcommerz.ts`; `apps/api/package.json`                                                                                                                                   | the two owner commands, the standalone fake                                                                  |
| `apps/api/test/support/fake-sslcommerz.ts`; `apps/api/test/payments-*.e2e-spec.ts`                                                                                                                                                                        | fake server and API tests                                                                                    |
| `apps/web/src/components/fees/guardian/online-pay-sheet.tsx`, `child-fees-view.tsx`, `app/(app)/children/[id]/fees/pay/[intentId]/page.tsx`, `components/fees/receipt.tsx`, `app/(app)/fees/setup/online-payments/page.tsx`, the counter's due row        | pages                                                                                                        |
| `apps/web/messages/{bn,en}/fees.json`                                                                                                                                                                                                                     | strings                                                                                                      |
| `apps/web/e2e/payments.spec.ts`, `apps/web/playwright.config.ts` (the fake as a `webServer`), the e2e seed                                                                                                                                                | Playwright                                                                                                   |
| `docs/payments.md` (new, completed in P7b), `fees.md`, `database.md`, `auth.md`, `deploy.md`, `.env.example`, `decisions-pending.md`                                                                                                                      | docs                                                                                                         |

---

## P7a1: gateway accounts and the SSLCommerz client

### Task 1: Environment

**Files:** `apps/api/src/config/env.ts`, `production-env.ts`, `production-env.spec.ts`,
`env.spec.ts` (or the existing env tests), `.env.example`, `deploy/*`.

- [ ] **Step 1: Write the failing tests:** production without `PAYMENT_CREDENTIALS_KEY` → refused;
      a 31-character key → refused; equal to `OTP_PEPPER` → refused; with `CHANGE_ME` → refused;
      production with `SSLCOMMERZ_SANDBOX_STORE_ID` or `SSLCOMMERZ_BASE_URL` set → refused;
      `API_PUBLIC_URL=http://api.example.com` in production → refused; development without the
      key → a derived key (stable across calls, different from the platform key).
- [ ] **Step 2: Run** `pnpm --filter @jantrik/api exec vitest run src/config`. Expected: FAIL.
- [ ] **Step 3: Implement**; the derivation in `packages/db/src/payments/secrets.ts` (the
      platform helper's shape: `paymentKeys(env)`, `encryptCredentials(json, aad, keys)`,
      `decryptCredentials(...)`).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit:** "Payment settings: the credentials key (required in production), the
      public API address, and the sandbox-only variables refused in production (sprint 1 P7a)".

### Task 2: Shared rules

**Files:** `packages/shared/src/payments.ts`, `payments.test.ts`, `index.ts`.

**Produces:** `parseGatewayAmount(s): number | null`, `formatGatewayAmount(paisa): string`,
`ONLINE_MIN_PAISA = 1000`, `ONLINE_MAX_PAISA = 50_000_000`, `newTranId(now, random)`,
`TRAN_ID_PATTERN`, `methodFromInstrument(cardType, cardBrand)`, `isWellFormedBankTranId(s)`.

- [ ] **Step 1: Failing tests:** `"1250.50"` → 125050; `"1250.5"` → 125050; `"1250"` → 125000;
      `"0.01"` → 1; `"500000.00"` → 50000000; refused (null): `"1,250.50"`, `"১২৫০.৫০"`, `"-1.00"`,
      `"1250.505"`, `"1e3"`, `"+10"`, `" 10.00"`, `""`, `"NaN"`, `"10000000.00"`, `null`;
      `formatGatewayAmount(125050)` = `"1250.50"`, `(1000)` = `"10.00"`; `newTranId` is 28
      characters, matches the pattern, sorts by time, and 10 000 of them are distinct; the method
      table (`BKASH-BKash` → BKASH, `DBBLMOBILEB-Dbbl Mobile Banking` → ROCKET, `VISA-Brac bank`
      → CARD, `IBBL-Islami Bank` → OTHER_ONLINE, `""` → OTHER_ONLINE).
- [ ] **Steps 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit:** "Gateway amounts parsed exactly into paisa, our transaction IDs, and
      the payment method from SSLCommerz's card type (S21)".

### Task 3: The accounts table

**Files:** schema, migration 1, `packages/db/test/payments-rls.test.ts`, `schema-safety.test.ts`.

- [ ] **Step 1: Failing tests:** B cannot see A's account; a second SSLCOMMERZ account for A →
      unique violation; `mode = 'LIVE'` → CHECK; `enabled = true` without ciphertext or without a
      passing test → CHECK; a hint of 5 characters → CHECK; the app cannot DELETE, nor UPDATE
      `provider`, `mode` or `tenant_id`; the table is in the tenant list.
- [ ] **Steps 2–4:** FAIL, write the schema and migration (drift empty), PASS.
- [ ] **Step 5: Commit:** "payment_gateway_accounts: one encrypted account per provider per
      institute, sandbox only, on only after a passing test".

### Task 4: `PaymentCredentialsService`

**Files:** `apps/api/src/payments/payment-credentials.service.ts`, `.spec.ts`,
`credentials-scan.spec.ts`.

**Interface:** `save(accountId, creds)`, `read(accountId): Promise<SslcommerzCredentials>` (throws
`CREDENTIALS_UNREADABLE`), `hint(storeId)`.

- [ ] **Step 1: Failing tests:** round trip; the ciphertext of A's row put on B's row (or another
      account id) fails to decrypt (the AAD); a changed key → `CREDENTIALS_UNREADABLE`; two saves
      of the same value give different ciphertexts; the scan: no file under `apps/api/src`
      except this one names `credentialsCiphertext`/`credentials_ciphertext`.
- [ ] **Steps 2–5.** Commit: "Store credentials encrypted per institute and account; only one
      service can read them".

### Task 5: `SslcommerzProvider` and the fake server

**Files:** `apps/api/src/payments/provider.ts`, `sslcommerz/sslcommerz.provider.ts`,
`sslcommerz/sslcommerz.schemas.ts`, `apps/api/test/support/fake-sslcommerz.ts`,
`apps/api/test/payments-provider.e2e-spec.ts`.

- [ ] **Step 1: Failing tests** (against the fake on a random port):
  - `createCheckout` sends exactly the documented fields with `total_amount "1250.50"` and our
    URLs; SUCCESS → `{ redirectUrl, sessionRef }`; FAILED → `ERROR`; a `GatewayPageURL` on
    another host or `http:` → `BAD_RESPONSE`;
  - `confirm`: VALID and VALIDATED → `PAID` with every field; INVALID_TRANSACTION → `INVALID`;
    `risk_level "1"` and a missing `risk_level` → `HIGH`; `amount "1,250.00"` → `amountPaisa
null`;
  - `query`: two attempts (FAILED then VALID) → both; `APIConnect FAILED` → `AUTH_FAILED`,
    `INACTIVE` → `STORE_INACTIVE`;
  - a 31 s answer → `TIMEOUT` after 30 s (fake timers on the client's clock, not real waiting);
    HTTP 500 → `HTTP_STATUS`; HTML → `BAD_RESPONSE`;
  - the thrown or returned error never contains the password, the URL or a body (string search
    on `JSON.stringify` and `String` of the error).
- [ ] **Steps 2–5.** Commit: "The SSLCommerz client behind PaymentProvider: session, validation
      and query with strict parsing, fixed error codes and a 30 s timeout, and a fake SSLCommerz
      for tests".

### Task 6: Account API (OWNER) and the test job

**Files:** `gateway-account.controller.ts`, `gateway-account.service.ts`, `payments.processor.ts`,
`payments.module.ts`, `apps/api/test/payments-account.e2e-spec.ts`.

- [ ] **Step 1: Failing tests:**
  - OWNER saves → `configured: true, enabled: false, hint`; an ADMIN, ACCOUNTANT or GUARDIAN →
    403; FEES off → 403;
  - test with good credentials (the fake) → `lastTest.result OK`; with bad → `BAD_CREDENTIALS`;
    fake down → `UNREACHABLE`; enable before a passing test → 422 `TEST_REQUIRED`; without
    `API_PUBLIC_URL` → 422; enable, then save new credentials → off again;
  - audit rows: `{ changed: ['storeId','storePassword'] }`, test results, on/off; never a value;
  - **review focus 6 (part):** a sentinel password through save, a 422 (a password of 200
    characters), a failed test and a 500 from the fake: absent from every response body, the
    captured logs, `audit_logs`, every Redis key and value (`SCAN` the test database, BullMQ
    failed jobs' `data`, `failedReason` and `stacktrace` included); present in the fake's request
    log (the positive control).
- [ ] **Steps 2–5.** Commit: "The OWNER sets up the SSLCommerz sandbox store: write-only
      credentials, test connection as a job, on only after a passing test (audited by field
      name)".

### Task 7: Owner commands

**Files:** `apps/api/scripts/payments-sandbox-smoke.ts`, `payments-load-sandbox.ts`,
`apps/api/package.json`, `apps/api/test/payments-scripts.e2e-spec.ts`.

- **`pnpm --filter @jantrik/api payments:sandbox-smoke`** (opt-in, the owner's own run, never in
  CI): refuses without both sandbox variables or with `NODE_ENV=production`; makes a ৳10 session
  in the real sandbox with a fresh `tran_id` and prints the `GatewayPageURL`; the owner pays with a
  documented test card or OTP; it then queries by `tran_id` every 5 s for 5 minutes, validates the
  `val_id`, and prints the parsed outcome (amount in paisa, currency, risk, method mapping) and
  a checklist of the facts above marked "not in the docs" it could observe. It writes nothing to
  any database and prints no credential.
- **`pnpm --filter @jantrik/api payments:load-sandbox -- --tenant shapla-school`** (development
  only): refuses production, a non-local database host and a database other than `jantrik`
  (the `db:reset` guard's rules); encrypts the two variables onto the institute's account (off,
  untested), audited with no actor and `{ changed: [...], source: 'load-sandbox' }`.
- [ ] **Step 1: Failing tests** (the refusals only: production, missing variables, a remote host;
      the smoke's network part is not tested).
- [ ] **Steps 2–5.** Commit: "Two owner commands: a sandbox smoke run and loading the sandbox
      store onto the demo institute (never in CI)".

### Task 8: The settings page

**Files:** `apps/web/src/app/(app)/fees/setup/online-payments/page.tsx`, the setup tabs, messages,
`apps/web/e2e/payments.spec.ts` (setup part).

- [ ] **Step 1: Playwright (CI, the fake as a `webServer`):** the owner enters credentials (the
      fields are empty afterwards), tests (OK), turns it on; the IPN address is shown; an admin
      has no such tab.
- [ ] **Steps 2–4**, screenshots bn 1366 and 390 px.
- [ ] **Step 5: Commit:** "Online payments settings page for the owner (sandbox)".

### Task 9: P7a1 docs, gates, review, PR

- [ ] `docs/payments.md` (accounts, the key, the client, the commands), `deploy.md`,
      `.env.example`, `decisions-pending.md` (P7a section).
- [ ] Full gates; review subagent (secrets at rest, the client, env checks); PR; CI green.

## P7a2: checkout to receipt

### Task 10: The enum values

**Files:** migration 2, `schema.prisma`, `packages/shared/src/fees-api.ts`
(`FEE_PAYMENT_METHODS`, the channel type), reports and closing method lists.

- [ ] **Step 1: Failing tests:** the enums have the values; the collections report by method
      lists ROCKET, CARD, OTHER_ONLINE with labels; `METHOD_ORDER` includes them.
- [ ] **Steps 2–5.** Commit: "fee_payment_method ROCKET, CARD, OTHER_ONLINE and the GATEWAY
      channel, in their own migration (S21)".

### Task 11: Intents, their dues, events, and the payment's link

**Files:** migration 3, schema, `packages/db/test/payments-rls.test.ts`,
`fees-payments-rls.test.ts`.

- [ ] **Step 1: Failing tests:**
  - isolation of the three tables; an intent due naming another student's due → FK error;
  - CHECKs: `PAID` without a payment; `NEEDS_REVIEW` without a reason; `REDIRECTED` without a URL;
    `amount_paisa` 999 or 50 000 001; a `tran_id` not ours; fields with `card_no`, a number value
    or 5 KB;
  - the guard trigger: `CREATED` → `REFUNDED_OUTSIDE` refused; `PAID` → `FAILED` refused; a second
    write of `val_id` or `validated_amount_paisa` refused; `fee_payment_id` cleared without
    `VOIDED` refused;
  - the deferred checks: an intent's dues not adding up to its amount → refused at commit; a
    `PAID` intent whose payment is VOID or another intent's → refused; a GATEWAY payment whose
    intent is not `PAID` with it → refused;
  - `fee_payments`: a GATEWAY row without an intent, with a sender phone or with method CASH →
    CHECK; a COUNTER row with an intent → CHECK; `bank_tran_id` `1709162025350IvUOK8nCTb6Uan`
    accepted for GATEWAY and still refused for MOBILE_MANUAL; two live payments for one intent →
    unique violation, one live and one void → fine; the same `bank_tran_id` on two live GATEWAY
    payments of one method → unique violation;
  - grants: no UPDATE of `amount_paisa`, `tran_id`, `student_id`; no DELETE anywhere; no UPDATE
    on events.
- [ ] **Steps 2–5.** Commit: "Payment intents with the dues they pay, append-only gateway events,
      and a gateway payment tied to exactly one live intent (S22, S23)".

### Task 12: The role and the public function

**Files:** migrations 4 and 5; `01-roles.sh`, `create-roles.sh`;
`packages/db/test/payments-function.test.ts`; `schema-safety.test.ts`; `docs/database.md`.

- [ ] **Step 1: Failing tests** (as `jantrik_app` with no context, like `ingest-functions.test.ts`):
  - an IPN for A's intent → `RECORDED` with A, the intent and the child; the row has only
    whitelisted fields;
  - a RETURN for an unknown `tran_id` → `NO_INTENT`, no row; an IPN for one → a row with no
    intent; B's `tran_id` at A's slug → a row at A with no intent, nothing at B;
  - an unknown slug → `UNKNOWN`, no row; a SUSPENDED institute → recorded;
  - `card_no` in the fields, a `p_kind` of `VALIDATE`, a RETURN outcome `PAID` → `INVALID`, no
    row;
  - **review focus 7:** `pg_has_role('jantrik_app','jantrik_payments','MEMBER')` false;
    `jantrik_owner` has SET without INHERIT; `jantrik_app` without context sees no intents (the
    `TO jantrik_payments` policy does not apply to it); `jantrik_platform_app`,
    `jantrik_ingest_app` and `jantrik_login_app` cannot execute the function; the role has no
    CREATE on `public` after the migration; its privileges equal the snapshot.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Create the role on the scratch cluster** (the documented command), write
      migrations 4 and 5.
- [ ] **Steps 4–5.** Commit: "Gateway signals reach the database through one definer function
      under the jantrik_payments role, never a tenant transaction".

### Task 13: `recordPayment` for gateway money

**Files:** `fee-collection.service.ts`, `fee-locks.ts`, `fees.module.ts` (exports
`FeeDuesService`, the void hook), `fee-ledger.service.ts`, `receipt` view,
`apps/api/test/fees-collect.e2e-spec.ts` (extended).

- [ ] **Step 1: Failing tests:** a GATEWAY payment through `recordPayment` (in a job with the
      guardian as actor) gets the next receipt number, allocations, the SMS and an audit row
      naming the guardian; the receipt has `channel GATEWAY`, the method, `online: { tranId,
bankTranId, instrument }` and no collector name; the daily closing does not list the guardian
      as a collector (P7a-V); voiding it moves its intent to `NEEDS_REVIEW` (`VOIDED`) in the same
      transaction; every existing fees test passes unchanged.
- [ ] **Steps 2–5.** Commit: "Fee payments can come from the gateway: recorded like the counter's,
      the guardian as the actor, never listed as a collector, and a void sends the intent to
      review".

### Task 14: Checkout API and the init job

**Files:** `checkout.service.ts`, `guardian-payments.controller.ts`, `payments.processor.ts`,
`apps/api/test/payments-checkout.e2e-spec.ts`.

- [ ] **Step 1: Failing tests:**
  - **S22:** two dues (one with a per-day fine) → the amount is principal + fine of both today,
    snapshot rows match; a body with `amountPaisa` → 422 (unknown key); a wrong
    `expectedAmountPaisa` → 409 `DUES_CHANGED` with the real amount; a due already paid → 422
    `NOTHING_DUE`; another child's due → 404; a cancelled due → 404; ৳9.99 → 422 with the minimum;
  - another guardian's child → 404; an ACCOUNTANT or OWNER on the guardian route → 403 (no staff
    payment links);
  - a retry with the same `clientRequestId` → the same intent; with other dues → 422;
  - a second checkout for the child while one is open → 409 `PAYMENT_IN_PROGRESS`; after
    `abandon` or after `expires_at` → allowed;
  - init: the fake answers SUCCESS → `REDIRECTED` with its URL, an INIT event; FAILED or a
    timeout → `FAILED` with the code and the account's `last_failure_code`; no retry;
  - the account off, `API_PUBLIC_URL` unset → 422 `ONLINE_PAYMENTS_OFF`, and `online.available`
    false.
- [ ] **Steps 2–5.** Commit: "Guardians start an online payment for chosen dues in full; the
      server sets the amount and makes the SSLCommerz session in a job (S22)".

### Task 15: The public routes

**Files:** `public/gateway-signals.controller.ts`, `public/gateway-signals.service.ts`,
`public/no-tenant-access.spec.ts`, `apps/api/test/payments-signals.e2e-spec.ts`.

- [ ] **Step 1: Failing tests:**
  - a success return → 303 to `/children/<child>/fees/pay/<intent>` and a `confirm` job; a
    return for an unknown `tran_id` → 303 to `/children`, nothing stored; GET works like POST;
  - an IPN → 200 `OK`, an IPN event, one `confirm` job for three identical IPNs;
  - an IPN with `card_no`, `verify_sign` and `value_a` → stored without them;
  - limits: 31 IPNs a minute from an unlisted address → the 31st 429; from the sandbox's listed
    address → accepted; 121 an hour for one institute from unlisted addresses → refused, and the
    listed source still accepted; a malformed IPN spends no institute budget; a 61st return a
    minute → still 303 with nothing stored;
  - the code scan; nothing from a body in the captured logs.
- [ ] **Steps 2–5.** Commit: "Public return and IPN routes: store the signal through the
      definer function, queue confirmation, trust nothing (S23)".

### Task 16: Confirmation and `settle`

**Files:** `settle.service.ts`, `payments.processor.ts`, `apps/api/test/payments-settle.e2e-spec.ts`.

- [ ] **Step 1: Failing tests** (the fake gateway; handlers called directly; fake `Clock`):
  - happy path: pay → IPN and return → one payment (GATEWAY, method BKASH, `trx_id` =
    `bank_tran_id`, `paid_on` = `priced_on`), one receipt, one SMS, the intent `PAID`;
  - fail and cancel returns: the query finds no success → `FAILED`/`CANCELLED`; a query showing
    PENDING → still `REDIRECTED`;
  - **review focus 1:** three `settle` runs at once for one `val_id` (IPN, return, query) → one
    payment, one receipt number used, two runs changed nothing; a db test inserts two GATEWAY
    payments for one intent from two connections → one unique violation;
  - **review focus 2:** checkout for January (৳1 200) → the accountant collects January at the
    counter → the payment arrives → `NEEDS_REVIEW` `DUES_CHANGED`, `validated_amount_paisa`
    120000, `bank_tran_id` kept, no second payment, no receipt, the counter's payment untouched;
    the counter's ledger showed `onlinePending` before the cash; the reverse order (online
    first) → the counter gets 409 `DUES_CHANGED`;
  - **review focus 3:** the fake returns amount `"1199.99"`; `currency_amount "1201.00"`;
    `currency "USD"`; `currency_type "USD"`; another `tran_id`; no `bank_tran_id`; `risk_level
"1"`; no `risk_level` → each `NEEDS_REVIEW` with that reason, no `fee_payments` row, no
    receipt, no SMS; a fine waived meanwhile → `DUES_CHANGED`;
  - **review focus 4:** a return with a made-up `val_id` (INVALID) → nothing; a return carrying
    the `val_id` of another of our intents → this intent `TRAN_ID_MISMATCH`, the other one's own
    signals still post it;
  - **review focus 5:** B's `tran_id` IPN at A → an unmatched event at A; `unmatched-check` with
    A's credentials gets INVALID → nothing to review; VALID (A's store, not our intent) →
    `UNMATCHED` VALIDATE event;
  - **review focus 8:** checkout 23:55, IPN at 00:05 the next day, a ৳10-per-day fine → posted
    with the fine to the checkout day;
  - late: abandon, then the payment → `LATE_SUCCESS`; a second VALID `val_id` after `PAID` →
    a `DUPLICATE` event, still one payment;
  - provider down at validation → retried; then up → posted once;
  - the institute suspended or FEES off after checkout → still posted; the guardian unlinked →
    still posted, actor the payer;
  - **review focus 6 (rest):** the sentinel through a checkout, a failing validation and a
    `DUPLICATE`: absent everywhere (as Task 6), including `payment_gateway_events.fields`.
- [ ] **Steps 2–5.** Commit: "Confirm every payment with SSLCommerz's validation API and post it
      only when tran_id, BDT, the exact amount, low risk and the dues all match; anything else
      waits for review with the money recorded (S23)".

### Task 17: Guardian pages, receipt and counter badge

**Files:** web files above, messages, `apps/web/e2e/payments.spec.ts`.

- [ ] **Step 1: Playwright (CI, bn, 390 px):** a guardian ticks two dues, sees the total in
      Bangla digits, continues, pays on the fake gateway page, comes back, sees "paid" and the
      receipt (amount in Bangla digits, bank transaction ID in ASCII); a second run cancels on the
      gateway → "not paid", "start again"; the accountant's counter shows the badge for an open
      intent. 1366 px screenshots of the same.
- [ ] **Steps 2–4:** implement; the guardian fees page's first-load size unchanged
      (`perf/budget.json`), the sheet loaded on demand.
- [ ] **Step 5: Commit:** "Guardians pay online from the fees page and come back to a receipt;
      the counter sees payments in progress".

### Task 18: P7a2 docs, gates, review, PR

- [ ] `docs/payments.md` (flow, states, the decision table, signals, the role), `fees.md` (the
      GATEWAY channel, S22), `database.md` (tables, the role, the function, existing-volume
      command), `auth.md` (a no-login surface: the signal routes), `deploy.md` (the role in
      `create-roles.sh`, the IPN URL, firewall addresses), `decisions-pending.md`.
- [ ] Full gates; review subagent (money, the public surface, the definer function) with review
      focus 1–8; PR; CI green.

## Risks

- **Undocumented SSLCommerz behaviour** (the list above). The smoke run checks what it can at
  P7a's start; the code assumes the least (accepts POST and GET returns, never needs an IPN,
  never relies on `verify_sign`, falls back to OTHER_ONLINE).
- **The sandbox test cards expire 12/26** per the docs page; if they stop working, the docs list
  new ones.
- **The payer coming back signed out.** The return is a cross-site POST to the API answered with
  a 303 to the web app: the `SameSite=Lax` hint cookie travels with that top-level navigation and
  the page's refresh is a same-site request. Playwright runs on one site, so the owner's sandbox
  run checks it on a real domain; if a browser drops the session, the page says "sign in to see
  this payment" and the payment completes anyway (IPN, reconciliation).
- **IPN reachability.** SSLCommerz cannot reach `localhost`; sandbox payments still complete
  locally through the return (and P7b's queries). Production needs Caddy reachable from
  SSLCommerz's addresses.
- **All IPNs come from one or two SSLCommerz addresses.** Limits per address would throttle every
  institute's notifications at once; listed sources get a large budget (P7a-C). If SSLCommerz
  changes addresses, their IPNs fall into the small budget and reconciliation covers the rest.
- **A new database role** needs the owner's one-time command on each existing Postgres (local
  volume, staging), as for `jantrik_admission`; the migration stops with the command until then.
- **Size.** P7a is the largest money change of the sprint; hence two PRs.

## Size and split

**L.** About 5 migrations, 4 tables, 1 role, 1 definer function, ~11 routes, 4 jobs, 3 pages,
~10 test files. Recommended as **two PRs** (P7a-A):

- **P7a1 gateway accounts and the client** (Tasks 1–9): no money moves; reviewed as a secrets
  and outside-call change.
- **P7a2 checkout to receipt** (Tasks 10–18): reviewed as a money and public-surface change with
  review focus 1–8.

## Self-review

- **Sprint plan coverage:** the provider interface (Task 5, refined: validated `tran_id` and
  currency fields, attempts from a query); the four tables (Tasks 3, 11), the `fee_payments`
  column and S21's values (Tasks 10, 11); the flow steps 1–5 (Tasks 14–16); "never posted
  automatically" (Task 16); unmatched events (Tasks 12, 16); OWNER-only settings with a
  write-only form, test and enable (Tasks 6, 8); "Pay online" beside the manual form (Task 17);
  hardening: fixed sandbox base, 30 s timeout, fixed codes, ids-only jobs, the code scan, limits
  on return and IPN (Tasks 1, 4, 5, 15); every listed test (Tasks 14–16); the opt-in smoke and the
  load command (Task 7); review focus 1 and 2 (Task 16).
- **Refinements of the sprint plan, each a decision:** a role and definer function for the
  signal routes (P7a-B); `paid_on` = the checkout day (P7a-E); one in progress per child (P7a-F);
  the live-only unique index and the `VOIDED` reason (P7a-G); the GATEWAY TrxID format (P7a-I);
  the two P7b statuses created now (P7a-T); the `PaymentProvider` additions (above).
- **Not in P7a:** reconciliation jobs, the review queue's actions, reports, the closing's online
  line, the dashboard count (all P7b); live mode, refunds through the API, a bKash provider.
- **Names used consistently:** `payment_signal_record`, `jantrik_payments`, `settle`,
  `checkout-init`, `confirm`, `unmatched-check`, `account-test`, `priced_on`,
  `parseGatewayAmount`, `formatGatewayAmount`, `newTranId`, `methodFromInstrument`,
  `onlinePending`, `ONLINE_AMOUNT_OUT_OF_RANGE`, `PAYMENT_IN_PROGRESS`, `ONLINE_PAYMENTS_OFF`.

## Decisions for the owner

S21–S24 stand as approved. These are new; each default is what the plan builds unless you change
it.

| #     | Decision                                                    | Recommended default                                                                                                                                                                                                                      | Alternative                                                                                                                                     |
| ----- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| P7a-A | One PR or two                                               | Two: P7a1 accounts and the client (no money moves), then P7a2 checkout to receipt                                                                                                                                                        | One PR                                                                                                                                          |
| P7a-B | How the return and IPN routes reach the database            | A new NOLOGIN role `jantrik_payments` owning one definer function that stores the signal and names the intent and child (the P3b pattern; the signal is durable before we answer). Needs your one-time command on each existing Postgres | No new role: resolve the slug with `auth_resolve_tenant` and let a job store the signal (lost if Redis loses the job; reconciliation covers it) |
| P7a-C | SSLCommerz's documented IPN addresses                       | Not enforced (they changed between doc versions); recorded on each event and used only to give SSLCommerz a large rate budget and everyone else a small one                                                                              | Refuse IPNs from any other address                                                                                                              |
| P7a-D | `verify_sign`                                               | Not checked or relied on: v4 does not document it, it is MD5, and every IPN is validated through the API anyway                                                                                                                          | Check it and record the result (never decisive)                                                                                                 |
| P7a-E | Which day a gateway payment counts as paid (fines)          | The checkout day (`priced_on`): the amount was fixed then, so a fine growing past midnight never turns a correct payment into a review                                                                                                   | The gateway's `tran_date` (a late-night payment then goes to review as `DUES_CHANGED`)                                                          |
| P7a-F | Two checkouts for one child                                 | At most one in progress per child for 60 minutes; "start again" cancels the old one (a success that still arrives goes to review)                                                                                                        | Only refuse overlapping dues                                                                                                                    |
| P7a-G | Voiding a gateway payment                                   | Allowed (OWNER/ADMIN, as today); the intent goes back to review with `VOIDED` so the money is re-applied or marked refunded; one live payment per intent (a partial unique index)                                                        | One payment per intent ever: a voided gateway payment can only be refunded outside                                                              |
| P7a-H | A `val_id` that belongs to another `tran_id`                | The named intent goes to review (`TRAN_ID_MISMATCH`), with no money recorded on it; the money is handled under its own `tran_id`                                                                                                         | Record the signal only, leaving the named intent open                                                                                           |
| P7a-I | The TrxID of a gateway payment                              | SSLCommerz's `bank_tran_id` (as approved), with its own format rule (`^[A-Za-z0-9._-]{6,80}$`; the docs' sample has lower case and 27 characters); the manual rule unchanged                                                             | Our `tran_id` as the TrxID, `bank_tran_id` only on the intent                                                                                   |
| P7a-J | Mapping SSLCommerz's card type to the method                | `BKASH-*` bKash, `NAGAD-*` Nagad, `DBBLMOBILEB-*` Rocket, card brands Card, anything else Other online; checked in the sandbox                                                                                                           | Everything except bKash/Nagad as Other online                                                                                                   |
| P7a-K | Payer details sent to SSLCommerz                            | The guardian's name and phone (the gateway needs a payer), a fixed no-reply email, the institute's address or "N/A"; nothing about the child                                                                                             | Ask guardians for an email                                                                                                                      |
| P7a-L | Amount limits                                               | ৳10 to ৳5 lakh per online payment (SSLCommerz's documented range); a smaller due is paid with others or at the counter                                                                                                                   | —                                                                                                                                               |
| P7a-M | Turning an account on                                       | Only after a passing test; saving new credentials turns it off until tested again. Test = a query for a random transaction (credentials refused vs. accepted)                                                                            | Allow on without a test                                                                                                                         |
| P7a-N | The browser return                                          | Accepted as POST or GET (the docs do not say which); its fields are a hint, only the validation API decides                                                                                                                              | POST only                                                                                                                                       |
| P7a-O | FEES switched off or the institute suspended mid-payment    | Validated money is still posted (never dropped); new checkouts are refused                                                                                                                                                               | Hold it for review                                                                                                                              |
| P7a-P | Removing an account                                         | Never deleted, only switched off (history of who set what)                                                                                                                                                                               | Allow delete when no intent uses it                                                                                                             |
| P7a-Q | A failed session start                                      | No automatic retry (it would reuse the `tran_id`); the guardian starts again                                                                                                                                                             | Retry once on a connection error                                                                                                                |
| P7a-R | A guardian unlinked from the child before the money arrives | Posted all the same, the payer as the actor                                                                                                                                                                                              | Review                                                                                                                                          |
| P7a-S | The base URL override                                       | `SSLCOMMERZ_BASE_URL` for development and tests only (the fake server); production refuses it                                                                                                                                            | —                                                                                                                                               |
| P7a-T | P7b's statuses                                              | `REFUNDED_OUTSIDE` and `DISMISSED` created with the enum now (unused until P7b)                                                                                                                                                          | Add them in P7b's own enum migration                                                                                                            |
| P7a-U | Receipt SMS for online payments                             | The same receipt SMS as at the counter (the fee settings switch applies)                                                                                                                                                                 | No SMS (the guardian saw the receipt on screen)                                                                                                 |
| P7a-V | Online payments in today's daily closing (until P7b)        | Not listed under any collector (the guardian is the actor); P7b adds the "online (SSLCommerz)" line                                                                                                                                      | Bring the online line into P7a                                                                                                                  |

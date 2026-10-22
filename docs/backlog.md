# Product backlog (deferred work)

Work agreed with the owner but not built yet, with enough of a plan to start from. Design work
that was deferred lives in [design-backlog.md](design-backlog.md).

## bKash Payment Gateway, tokenized checkout (step 9, phase F, deferred)

Split out of step 9 on 2026-10-22 at the owner's request: phases 0 and A–E (fees with the
manual bKash/Nagad flow) ship first; this becomes a later step on its own branch. Sandbox only:
no live keys. Each institute uses **its own** merchant account: money goes to the institute,
never to Jantrik.

### What bKash's docs say (checked 2026-10-22, developer.bka.sh)

- Sandbox base URL `https://tokenized.sandbox.bka.sh/v2/tokenized-checkout/`; endpoints
  `auth/grant-token`, `auth/refresh-token`, `payment/create`, `payment/execute`, `query/payment`
  (and `general/search-transaction`).
- Grant/refresh take `username` and `password` headers and `app_key`/`app_secret` in the body;
  the `id_token` lasts an hour. **At most 2 grant or refresh calls per hour**, otherwise refresh is
  blocked for an hour: the token must be cached and reused.
- Create returns `paymentId` and `bKashURL`; the payer is sent back to the callback URL with
  `paymentID` and `status=success|failure|cancel`. Only a successful Execute (or a `Completed`
  status from Query) means paid.
- A timeout is not a failure: query the payment first. A payment ID is valid for 24 hours and can
  be executed once.
- The docs publish no sandbox credentials: they come from bKash's onboarding (ask the owner for
  sandbox credentials before testing against the real sandbox).

### Plan

- **Credentials**
  - Table `fee_gateway_credentials` (tenant table): provider BKASH, `mode` CHECK `'SANDBOX'`,
    enabled, nullable `secret_ciphertext` / `token_ciphertext`, expiries, last test result.
    Grants S I U.
  - AES-256-GCM (`secret-box`), AAD `fees-gateway:bkash:<tenantId>`, key from `FEES_GATEWAY_KEY`
    (required in production). Other env: `WEB_PUBLIC_URL` (callback), `BKASH_BASE_URL` (override
    refused in production).
  - `PUT` is OWNER-only and write-only; `GET` returns only `{configured, enabled, updatedAt,
lastTest}`; the audit stores field names only. A "test connection" job. A code-scan test that
    only the credentials service reads the ciphertext.
- **Client:** fixed error codes, never response bodies or headers; money parsed from strings into
  exact paisa; a 30 s timeout; the token stored encrypted on the credentials row behind a Redis
  lock and refreshed at 50 minutes (respects the 2-per-hour limit). A fake bKash server for the
  API and Playwright tests; an opt-in sandbox smoke script.
- **Flow:** tables `fee_gateway_intents` (CREATING | AWAITING_PAYER | EXECUTING | COMPLETED |
  FAILED | NEEDS_REVIEW) and `fee_gateway_intent_dues`; queue `fees-gateway`; no HTTP call inside
  a transaction.
  1. The guardian starts a payment; the server computes the amount.
  2. A job creates the bKash payment; the page polls, then redirects to `bKashURL`.
  3. bKash returns to `/pay/bkash/return` (add `/pay/:path*` to `proxy.ts`); the `paymentID` must
     match; the status in the URL is never trusted.
  4. A job executes (on a timeout: query).
  5. Completion locks the intent and verifies amount, BDT, `merchantInvoiceNumber`, `Completed`
     and the `paymentId`, then records the payment (channel GATEWAY), receipt and SMS with the
     guardian as actor (reuse `FeeCollectionService.recordPayment`).
- **Reconcile** jobs at +5 m, +30 m, +2 h, +25 h; a payer who verified but was never executed is
  executed (to be confirmed in the sandbox); after 24 h: FAILED.
- **Excess, mismatch or a TrxID conflict** (e.g. cash taken meanwhile) sets NEEDS_REVIEW: the
  money is recorded, excess goes to other open dues, any remainder is shown as unapplied; an admin
  applies it or marks it refunded outside the app, with a reason.
- **Tests:** happy path, cancel, execute timeout then query, a double return makes one payment,
  amount mismatch, excess from a race, another guardian gets 404, the token is reused, and
  sentinel credentials never appear in any response, log, `audit_logs`, `sms_logs`, Redis (incl.
  failed BullMQ jobs) or validation error.

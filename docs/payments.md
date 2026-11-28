# Online payments (SSLCommerz)

Sprint 1 P7a: a guardian pays chosen dues in full through SSLCommerz's hosted page (bKash, Nagad,
Rocket, cards), sandbox only this sprint. This page covers what is built so far, **P7a1: the
gateway account and the client**. Checkout, the payer's return and the IPN, confirmation and the
receipt (P7a2), and reconciliation and the review queue (P7b) are added here as they land. The
owner's decisions: S21 to S24 (approved), P7a-A to P7a-V ([decisions-pending.md](decisions-pending.md)
→ Sprint 1, P7a1). Fees in general: [fees.md](fees.md).

No money moves through anything in P7a1: an institute can save, test and switch on its SSLCommerz
sandbox store, and nothing uses it yet.

## Who does what

| Who               | What                                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OWNER             | Saves the store ID and password (write-only), tests the connection, turns online payments on and off, copies the IPN address into the SSLCommerz panel      |
| ADMIN, ACCOUNTANT | Nothing here: the settings page and its API are the owner's alone (where money goes). The admin sees no "Online payments" tab; the page says who sets it up |
| Everyone else     | Nothing yet (guardians pay from P7a2)                                                                                                                       |

Every route is `@RequireModule('FEES')` and `@Roles('OWNER')`: with the fee module off it answers
403, like every fee route.

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
  page to paste into the store's SSLCommerz panel (the route itself comes with P7a2). Without
  `API_PUBLIC_URL` the page says so and the account cannot be turned on.
- **Audit** (`payment_gateway_account`): saving `{ changed: ['storeId', 'storePassword'],
enabled: false }` (CREATE the first time, UPDATE after, with the old `enabled`), each test
  result `{ test: 'OK' }` (with `enabled: false` when it switched the account off), on and off
  `{ enabled }`. Never a value, not even the hint.
- **The page** (`/fees/setup/online-payments`, a tab beside the bKash/Nagad numbers): a sandbox
  badge, the status (not set up, set up and off, on), the hint `••••1234`, the last test and the
  last failure, the write-only form (never pre-filled, cleared after a save), "Test connection",
  "Turn on"/"Turn off", and the IPN address with a copy button.

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
  https on `sandbox.sslcommerz.com` or another `*.sslcommerz.com` host (or the fake's own
  address); anything else is `BAD_RESPONSE`.
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
  `payments-rls.test.ts`, `apps/api/test/payments-provider.e2e-spec.ts`,
  `payments-credentials.e2e-spec.ts`, `payments-account.e2e-spec.ts`,
  `payments-scripts.e2e-spec.ts`, `apps/api/src/payments/credentials-scan.spec.ts`,
  `apps/web/e2e/payments.spec.ts`.

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
| `SSLCOMMERZ_SANDBOX_STORE_ID`, `…_PASSWORD` | the two commands | production refuses either one set                                                                                                                                                                        |
| `SSLCOMMERZ_BASE_URL`                       | API, worker      | development and tests only, and only `http://127.0.0.1:<port>` or `http://localhost:<port>` (a fake); production refuses it                                                                              |

The device receiver never gets `PAYMENT_CREDENTIALS_KEY` (it refuses to start with it in
production). Production: [deploy.md](deploy.md) → The settings file, Environment checks.

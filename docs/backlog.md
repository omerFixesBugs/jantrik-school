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

## Exams: later work (from step 10)

Agreed in the step 10 plan, not built yet. Rules today: [exams.md](exams.md).

- **Combined results:** class tests and model tests weighted into the half-yearly or annual
  result (a weight per exam, the annual's merit from the weighted total).
- **Server-side bulk PDFs:** report cards and admit cards for a whole class as one PDF file
  (browser print covers one section at a time today).
- **Grade band editor:** bands are read-only; the GPA rules and rounding are editable.
- **"Exempt" marker** for a part or subject (a medical exemption), distinct from absent.
- **Hold admit cards back for unpaid fees** (an opt-in rule reading the fee ledger).
- **Next year's rolls from merit:** promote with rolls by the annual's class places.
- **Editable result SMS template** (the text is fixed Bangla today, like the fee SMS).
- **Manual seat moves** in the seat plan (it is generated today).
- **A teacher results view:** a section's teachers can print its tabulation and report cards and
  the class teacher can write remarks (the API allows it), but the web shows those screens to
  OWNER/ADMIN only.
- **Unsent marks banner** on the dashboard (attendance has one; the marks page shows its own
  drafts state).
- **Term timeline with real exams:** the dashboard timeline still shows the usual exam months; the
  exams tile shows the real ones.

## Performance: reach the 3-second budget (from step 9)

Recorded at the owner's request on 2026-10-23, when step 9 was ready to merge. The budget and the
method are in [design.md](design.md) → Performance budget: ≤ 3 s to interactive on a 390 px phone
(4× CPU, slow 4G, cold cache, signed in), builds compared only interleaved. Where things stand:

- By that definition (main content on screen, then 2 s without a long task), design v2.1 measured
  the dashboard at 6.8 s and the students list at 6.2 s.
- Step 9's check used a looser mark, the page's main control on screen and hydrated, so it is the
  earliest usable moment, not the documented "interactive": `/fees` 3.66 s (3.50–3.79), the
  dashboard 3.93 s against 3.78 s on main (the ranges overlap). Even that is over 3 s.
- A cold load of `/fees` downloads about 600 KB: 337 KB of scripts, 187 KB of fonts and a 53 KB
  page, about 3 s of transfer on slow 4G before any work. The shell is shared, so every page pays
  it.

### 1. Slim the shared app shell

- **Scripts (about 340 KB on every page):** measure what each route ships (e.g.
  `@next/bundle-analyzer`). Move what the first screen does not need behind dynamic imports: the
  command palette, dialogs and sheets, date pickers, charts, the theme and density settings. Look
  for duplicate or oversized libraries.
- **Fonts (about 190–210 KB):** subset Noto Sans Bengali (and the Latin face) to the glyphs the
  UI uses, keep fewer weights, and preload only the body weight.
- **After the first screen:** on the dashboard the time from content to interactive grew to
  1.5 s (design.md). Find the long tasks (hydration, the follow-up requests).
- Measure every change with the interleaved A/B and record it in design.md's table. The target is
  ≤ 3 s by the documented definition.

### 2. Load translation namespaces per route

- **Today:** `NextIntlClientProvider` in `apps/web/src/app/layout.tsx` sends every message to the
  browser on every page, including the fee and exam areas merged in `apps/web/src/i18n/request.ts`.
  Step 9 made each page's HTML about 15 KB larger (53 KB against 38 KB for the dashboard); step
  10's exam messages add more (measured in the step 10 report).
- **Instead:** the root layout passes only the shell's namespaces. Each area's layout passes its
  own, for example `fees` under `/fees` and on the guardian's fee pages, through a nested
  `NextIntlClientProvider` with only those messages. Server components keep reading the full set.
- **Checks:** a page's HTML carries only its namespaces (the dashboard has no `fees.setup` keys),
  and e2e fails on a missing-message error, so a client component can never ask for a namespace
  its route does not provide.

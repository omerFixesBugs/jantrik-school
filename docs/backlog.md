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

## Devices and staff attendance: later work (step 11)

Agreed in the step 11 plan, deferred during the build or left by the final review, not built yet.
Rules today: [devices.md](devices.md).

### From the plan and the build

- **A separate billable DEVICES module**, if the owner chooses that later (devices sit under
  ATTENDANCE today: a new module needs a `module_key` value, a `tenant_modules` row for every
  institute and a platform switch).
- **Marking coaching batches (PER_SESSION) from punches.** Needs a batch timetable (which period
  a punch belongs to); registers stay manual in that mode.
- **Addresses:**
  - a hard "accept this device only from IP x" lock;
  - "trust a network range", if `NEW_IP` alerts prove noisy for schools whose ISP changes their
    address often;
  - a platform screen of refused serial numbers (today: `LRANGE ingest:refused 0 -1` in Redis),
    and a platform tool to settle a squatted serial number.
- **Re-fetch a time range from the device** (`DATA QUERY ATTLOG`): punches dropped in a flood are
  gone from our side (the device still has them).
- **Entry and exit SMS:** editable texts (fixed Bangla today), and entry/exit notifications in the
  guardian app.
- **Staff:** per-person or per-shift office hours, half days, a leave register, staff seeing their
  own attendance. Switching someone's tracking on should re-apply the punches already ignored for
  them (it does not today).
- **Staff roles in the live feed:** staff punches show as "staff" (the feed API has no roles).
- **Devices switched off and on again:** the "still on a device" rule counts active devices only,
  so a device switched off while an ID was given to someone else keeps the old person's
  fingerprints under it when switched back on. Count inactive devices too, or send the pending
  removals when a device is switched on. Also: an ID released between an add being SENT and
  confirmed can be given away (negligible: the window is one poll).
- **Other brands.** The receiver is ZKTeco push 2.x only, behind the `brand` column; the 3.x
  access-control firmware (`/iclock/registry`, `rtlog`) is not supported either.
- **HTTPS and `pushcommkey`** directly in the receiver, once a real device shows how they work
  (a TLS proxy in front works today).

### From the final review

The CAN WAIT items of the final whole-branch review, each with why it waits. Done or fixed ones
are left out.

- **Processing and the tick**
  - Re-queue an ID's UNMAPPED punches of the last 7 days when it is given to a person (M1): a
    staff member's punches made before their ID was set build no staff day (the feed's "set an ID"
    invites exactly this); it heals on their next punch that day. Students are fine (arrivals read
    raw punches).
  - A tick duration metric before many schools turn auto-mark on (M8): every held-back section is
    re-evaluated each minute for an hour (punch lock and `idsOnDevices`), in one sequential job over
    all institutes. Fine at today's size.
  - A review that does not change whether a punch counts keeps a stale outcome (e.g. REJECT of a
    processed HELD punch stays HELD): informational only, counting reads the flags and the review.
  - The arrival rule is written twice (the cutoff and the recompute): one shared rule; they agree
    today.
  - Entry and exit SMS have no "today" check: `sendsSms` compares when a punch arrived with when
    it was made, not when it is processed, so a leftover punch processed much later (by the minute
    sweep, or after ATTENDANCE is switched back on) can still send a stale "entered at" SMS. The
    window is small; check the processing time against the punch's day or the real-time window.
- **Receiver and database**
  - A lower bound on the 24-hour first-address window (a `p_now` before `created_at` counts as
    inside): `p_now` is the receiver's clock, not an attacker's.
  - The Redis trusted mark is per /64, and the untrusted-budget peek and the refused-address brake
    can overshoot under concurrent requests: still charged after `ingest_resolve`; the overshoot is
    small.
  - Some INSERT grants are table-wide (the app could supply its own `device_commands.seq`):
    hardening, no exploit path found.
  - In development a receiver that refuses to start stops the API too (fail-loud accepted).
  - The isolation code scan misses indirect imports, and the biometric sentinel's database scan
    sees only rows visible under the device institute's RLS: the receiver's start-up check covers
    the first at run time.
  - The unknown-IDs join has no tenant predicate and the feed cursor no plain lower bound: RLS, and
    the 60 s overlap with the 7-day window, cover them.
- **People and device IDs**
  - Fail closed for an ID freed without an audit row (today it counts as free): every app path
    audits, only hand-made data lacks one; do it with the next people change.
  - `reenrol` reads false when someone takes their ID back while a removal is still waiting (the
    removal wipes the fingerprints): rare, and the person re-enrols when the device rejects them.
  - Collisions do not say whether the holder has the ID or it is only still on a device (wording).
  - People-API minors: a remove-then-re-add skipped while the old upsert waits, each PUT reading
    all waiting upserts, a 1 MB file of blank lines parsed before the row cap, `MISSING_COLUMNS`
    overstating, a 413 without a code; and coverage gaps (concurrent writers, removal of an unheld
    ID, the import branch of the audit lookup).
- **Registers and close from device**
  - The close-from-device confirm counts active absent students while the register also marks the
    inactive ones ABSENT ("2" vs "6"), and the card shows "10 students" next to "4/6": show "+N
    inactive also marked absent (no SMS)". Cosmetic, on an admin-confirmed action.
  - Refuse close from device for a section with no active student: reachable only by a direct API
    call, and the register it writes (all ABSENT, no SMS) is accurate.
  - A student inactive now shows no arrival on a past date's take screen.
- **Web, SMS and print**
  - Devices screen minors: the feed polls with no devices, partial "send to devices" failures lose
    the totals, focus after a review, a trust confirm that can vanish mid-dialog, the dashboard
    card shifting layout, a stale poll carrying an older review over a newer one (two admins within
    one poll), duplicated query keys and helpers.
  - Staff month print: the weekday line (5.5 pt grey) is hard to read, দেআ fills its column, and
    the name button keeps its touch height in print (more pages).
- **Tests, seed and tooling**
  - Coverage gap: the simulator CLI's 50-line batches (`cli.ts` runs at import; testing it needs
    its loop split out).
  - The staff desk e2e cannot run twice in one run (the saved leave stays), and specs must not
    assert today's computed staff state (it depends on the real time of the run).
  - Seed minors: demo serials stay active in jantrik_test after a killed run, a failed owner insert
    leaves Shapla without punches and a reseed skips it, hard-coded special-day phones, staff-day
    timestamps at seed time. Demo and test data only.
  - Clean up the 4 tenants and 16 devices the retention benchmark left in jantrik_test: invisible
    without a tenant context, and the gates pass with them.
  - The local `jantrik` database holds test data from the step's visual checks (a switched-off
    device, default IDs, punches, addresses, a device register, a manual staff day): a reseed with
    the owner's approval clears it.
  - Style: `packages/db/test/env.ts` throws at import without the ingest login, as for the
    platform one (CI sets both).

## Performance: reach the 3-second budget (from step 9; step 12 done in part)

The budget and the method are in [design.md](design.md) → Performance budget: ≤ 3 s to
interactive on a 390 px phone (4× CPU, slow 4G, cold cache, signed in), builds compared only
interleaved, with `apps/web/perf/measure.mjs`. Step 12 (day run of 2026-11-13, PR #9) did:

- **Scripts:** zod out of the browser (`@jantrik/shared` split, a test guards it), the command
  palette and the dashboard's below-the-fold charts loaded when wanted: every page's first
  JavaScript is 54-62 KB (gzip) smaller (the dashboard 360 → 298 KB).
- **Translations per route:** each route sends only its namespaces
  (`apps/web/src/i18n/route-messages.ts`, a test and an e2e check): a page's HTML went from 69 KB
  to 17-26 KB (gzip).
- **A size budget in CI** (`apps/web/perf/budget.json`).
- **Fonts (decision P2, 2026-11-14):** the two Bangla faces carry only their Bangla subset
  (`apps/web/src/fonts`, next/font/local), so Latin text on a Bangla page renders in Plus Jakarta
  Sans as design.md says; the Bangla login page fetches 3 font files (192 KB) instead of 4
  (210 KB). Tried and not kept: not preloading Noto Sans Bengali and starting both Bangla faces
  when the app hydrates (interleaved, the medians were equal or up to 0.8 s worse on the four
  pages measured, the ranges overlapping).

Still open:

### 1. The session and data waterfall (the largest part left)

After the JavaScript, the refresh, `GET /me/context` and the page's requests run one after
another, each with a CORS preflight. The plan to start the session earlier, cache preflights and
(later) serve the API on the app's origin is in [plans/step-12-auth.md](plans/step-12-auth.md),
waiting for the owner (auth change).

### 2. After the first screen

- **The owner dashboard's second batch** (the setup checklist's requests, the device alerts
  card, the student filters) starts after the first screen's data and renders about 1.5-2 s
  after the content, so "interactive" comes late. Start it with the first batch, or after the
  page is interactive (an idle callback); measure both.
- **The render after `/me/context`** (the shell, the theme and density providers) takes
  0.5-1 s on the throttled phone before the page's first requests start; profile it.

### 3. API calls worth a look (not on the critical path today)

Server time of every call the budget pages make was 12-107 ms, except:

- `GET /me/children/:id/fees` (guardian dashboard, once per child): about 210 ms, because every
  read runs the dues engine (`planContext` and `ensureForStudents`, which may write dues). Money
  logic: cache the plan per request or skip the ensure when the student's dues are up to date, with
  a review.
- `GET /exams/summary` (owner dashboard): about 107 ms; it builds the open exam's whole sheets
  grid to count sheet states. A count query would need the grid's rules (which sheets have
  students).

On slow 4G each call costs 300-600 ms (a preflight and a round trip) whatever its server time, so
fewer sequential calls (section 1) matter more than faster queries.

### 4. Smaller scripts still

- The user menu (Base UI Menu) and the phone drawer (Sheet) could load on first use.
- next-intl parses ICU messages in the browser (about 9 KB of parser); precompiled messages would
  drop it.

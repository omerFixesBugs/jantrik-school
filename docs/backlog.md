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
  - Drop an id from `devices:tenants` whose institute no longer exists (M7): retention logs a
    failure for it every night and the tick skips it silently.
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
  - Some INSERT grants are table-wide (the app could supply its own `device_commands.seq`), and the
    unique-violation tests match the word "unique" rather than the constraint's name: hardening, no
    exploit path found.
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
  - Coverage gaps: retention (an old DONE superseded only by a young DONE), the simulator
    (per-record-type assertion, `poll()` silent on a non-200, the CLI's 50-line batches).
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

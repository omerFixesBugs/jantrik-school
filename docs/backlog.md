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
  - A test that the tick skips an institute with ATTENDANCE off that has leftover punches (the
    process-punches job's skip is tested).
  - The arrival rule is written twice (the cutoff and the recompute): one shared rule; they agree
    today.
  - Entry and exit SMS have no "today" check: `sendsSms` compares when a punch arrived with when
    it was made, not when it is processed, so a leftover punch processed much later (by the minute
    sweep, or after ATTENDANCE is switched back on) can still send a stale "entered at" SMS. The
    window is small; check the processing time against the punch's day or the real-time window.
- **Receiver and database**
  - A RESTRICTIVE twin of the permissive `ingest_delete` policy on `device_source_ips` in the next
    migration: unreachable today (no tenant context on the ingest login, and the function's DELETE
    filters `trusted_at IS NULL`).
  - A lower bound on the 24-hour first-address window (a `p_now` before `created_at` counts as
    inside): `p_now` is the receiver's clock, not an attacker's.
  - The Redis trusted mark is per /64, and the untrusted-budget peek and the refused-address brake
    can overshoot under concurrent requests: still charged after `ingest_resolve`; the overshoot is
    small.
  - An index for refused serials: each unknown or inactive serial scans `attendance_devices`;
    braked per address before the database.
  - Some INSERT grants are table-wide (the app could supply its own `device_commands.seq`), and the
    unique-violation tests match the word "unique" rather than the constraint's name: hardening, no
    exploit path found.
  - A DEVICE staff day has no CHECK that `reason IS NULL`: the code never writes one (only manual
    days carry a reason).
  - `device_punches.reviewed_by_id` can be set without `review` (no CHECK pairs them; only
    `review` and `reviewed_at` are paired): the app always writes the three together.
  - `parseDeviceCmdResults` accepts unbounded digit runs (Infinity, beyond 2^53): the receiver
    already keeps only safe integers in int32 range.
  - `wallClockToUtc` checks only the shape (2026-02-30 25:00:00 normalises silently): its inputs
    pass `realDeviceTime` first.
  - An untrusted `devicecmd` body is drained up to 2 MB rather than the 64 KB cap (never buffered);
    in development a receiver that refuses to start stops the API too (fail-loud accepted).
  - The receiver's start-up check retries a failing query for about 3 minutes but gives each
    attempt no time limit of its own: a database that accepts the connection and never answers
    hangs the start instead of failing it. Add a per-attempt timeout (CI run 1 fix, `6412892`).
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
  - The people page loses the staff view on reload with `unmapped=1`, and the not-on-device text
    tells teachers to give IDs (they cannot open that screen).
- **Registers and close from device**
  - The close-from-device confirm counts active absent students while the register also marks the
    inactive ones ABSENT ("2" vs "6"), and the card shows "10 students" next to "4/6": show "+N
    inactive also marked absent (no SMS)". Cosmetic, on an admin-confirmed action.
  - Refuse close from device for a section with no active student: reachable only by a direct API
    call, and the register it writes (all ABSENT, no SMS) is accurate.
  - A student inactive now shows no arrival on a past date's take screen.
  - The today page reads "taken from the device; changed by <teacher>, <time>" where the time is
    the register's last change, which can be the device's later change of a record (the teacher
    stays named since the final fixes). Drop the time from that wording or label it as the last
    change.
- **Web, SMS and print**
  - The SMS student name is cut by code point, not grapheme (Bangla can end on a hasant): only for
    names too long for two segments.
  - Devices screen minors: the feed polls with no devices, partial "send to devices" failures lose
    the totals, focus after a review, a trust confirm that can vanish mid-dialog, the dashboard
    card shifting layout, a stale poll carrying an older review over a newer one (two admins within
    one poll), duplicated query keys and helpers.
  - Staff month print: the weekday line (5.5 pt grey) is hard to read, দেআ fills its column, and
    the name button keeps its touch height in print (more pages).
  - Two buttons with one name: the fees setup confirm for switching a bKash/Nagad number off
    reads "বন্ধ করুন", the same as the dialog's close button (fixed for the device switch-off in
    `b485763`). Give it its own label; screen-reader users hear two identical buttons. Older than
    step 11.
- **Tests, seed and tooling**
  - Coverage gaps: the database tests never exercise the three grace-range CHECKs on
    `attendance_settings` (device, staff late, staff early), and the receiver login's denial list
    has no case for INSERT into `attendance_devices`, `device_commands` or `device_people`, or for
    DELETE on `device_commands` or `device_source_ips` (the catalog shows it holds no grants); shared
    rules (mapped-person collisions, a staff month row on an off day, the SMS cut keeping the
    longest name), ingest error paths (`INGEST_BAD_RESULTS`, a non-object row, a
    NULL or negative `p_max`), retention (an old DONE superseded only by a young DONE), the
    simulator (per-record-type assertion, `poll()` silent on a non-200, the CLI's 50-line batches).
  - The race test's `pg_locks` poll matches any waiting `jantrik_ingest_app` session in the
    cluster: a possible flake, never a false pass.
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
  - Style: the duplicated `toSeconds` helpers (`devices.ts`, `staff-attendance.ts`, `dates.ts`) and
    long comment lines in `ci.yml`; `packages/db/test/env.ts` throws at import without the ingest
    login, as for the platform one (CI sets both).

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

### 3. Fonts (owner decision)

Every Bangla page downloads Noto Sans Bengali's Bangla and Latin faces (106 + 26 KB) and Anek
Bangla's Bangla and Latin faces (57 + 19 KB): next/font emits every Google subset, so Latin text
does not fall to Plus Jakarta Sans as design.md says. Options: self-host only the Bangla faces
(next/font/local, OFL licence; Latin letters then render in Jakarta, a visible change), or keep
fewer weights. Decisions P2 in [decisions-pending.md](decisions-pending.md).

### 4. API calls worth a look (not on the critical path today)

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

### 5. Smaller scripts still

- The user menu (Base UI Menu) and the phone drawer (Sheet) could load on first use.
- next-intl parses ICU messages in the browser (about 9 KB of parser); precompiled messages would
  drop it.

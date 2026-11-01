# Step 11 report: attendance devices and staff attendance

Branch `feature/step-11-devices` (from main at `ed52ead`). Plan:
[docs/plans/step-11.md](../plans/step-11.md), approved 2026-10-24 (Q1–Q6 as recommended, with
additions 1–3). How it works: [docs/devices.md](../devices.md). Choices made during the build,
open to change: [decisions-pending.md](../decisions-pending.md) #39–#68 and Deployment
requirements item 4. Later work: [backlog.md](../backlog.md#devices-and-staff-attendance-later-work-step-11).

No device has been bought. Everything was built and tested against the simulator. The checklist
for the first real device is in [devices.md](../devices.md) → Verify on the real device.

## 1. Summary

| What                                                                                       | Where the code lives                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Receiver**: ZKTeco push 2.x over plain HTTP, own Nest app, port 4080, own login          | [`apps/api/src/ingest`](../../apps/api/src/ingest), [`ingest-main.ts`](../../apps/api/src/ingest-main.ts), [`ingest-env.ts`](../../apps/api/src/config/ingest-env.ts)                                                  |
| **Ingest functions**: the receiver's only way into the database                            | migrations `20261029000100`–`20261029000300` in [`packages/db/prisma/migrations`](../../packages/db/prisma/migrations)                                                                                                 |
| **Devices screen**: list, setup guide in Bangla, live feed, alerts, addresses, review      | [`apps/api/src/devices`](../../apps/api/src/devices), [`/attendance/devices`](<../../apps/web/src/app/(app)/attendance/devices>), [`components/devices`](../../apps/web/src/components/devices)                        |
| **People and device IDs**: defaults, collisions, CSV, send to devices, IDs still on one    | [`device-people.service.ts`](../../apps/api/src/devices/device-people.service.ts), [`device-people.ts`](../../packages/shared/src/device-people.ts), the `people` page                                                 |
| **Students from punches**: arrivals, cutoff, hold-backs, close from device, entry/exit SMS | [`punch-processing.service.ts`](../../apps/api/src/devices/punch-processing.service.ts), [`device-registers.service.ts`](../../apps/api/src/devices/device-registers.service.ts), today and take screens               |
| **Staff attendance**: day view, manual entry, tracked switch, month, print, CSVs           | [`apps/api/src/staff-attendance`](../../apps/api/src/staff-attendance), [`/attendance/staff`](<../../apps/web/src/app/(app)/attendance/staff>), [`staff-attendance.ts`](../../packages/shared/src/staff-attendance.ts) |
| **Spoofing checks**: NEW_IP, OUTSIDE_HOURS, BURST, review in the feed                      | the ingest functions; [`device-punches.service.ts`](../../apps/api/src/devices/device-punches.service.ts); [`punch-feed.tsx`](../../apps/web/src/components/devices/punch-feed.tsx)                                    |
| **Device IDs unique across students and staff**                                            | table `device_people`, one unique index on `(tenant_id, device_user_id)`                                                                                                                                               |
| **Retention of raw punches**                                                               | [`device-retention.service.ts`](../../apps/api/src/devices/device-retention.service.ts), policy `retention_only`                                                                                                       |
| **Simulator**: plays a device for tests and by hand                                        | [`packages/device-sim`](../../packages/device-sim), `pnpm device:sim`                                                                                                                                                  |
| **Pure rules**, unit-tested first                                                          | [`devices.ts`](../../packages/shared/src/devices.ts), `device-people.ts`, `staff-attendance.ts`, `dates.ts` in `packages/shared/src`                                                                                   |
| **Demo data**: two Shapla devices, IDs, a month of staff days                              | [`demo-devices.ts`](../../packages/db/src/seed/demo-devices.ts), [demo-accounts.md](../demo-accounts.md) → Devices                                                                                                     |

- 7 migrations (`20261029000000_devices` to `20261029020000_staff_attendance`), 58 in all.
- 2 new database roles: `jantrik_ingest` (owns the 4 functions) and `jantrik_ingest_app` (the
  receiver's login).
- 1 new package (`@jantrik/device-sim`), 3 new screens (devices, people, staff), changes to the
  today page, the take screen, the student report, the settings and the dashboard.
- 49 commits, 202 files, about 34 700 lines added (most of it tests and docs).

### Commits

| Task | Commits                                                                     | What                                                                            |
| ---- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Plan | `7890bb2`                                                                   | The approved plan                                                               |
| T1   | `1f7a336`, `a3e76b4`, `a445c1e`                                             | Shared device and staff rules; DST fix; stamp and serial checks                 |
| T2   | `3bf833a`                                                                   | Ingest roles, receiver config, an injectable Clock                              |
| T3   | `3f48705`                                                                   | Device tables, settings columns, ingest policies, retention guard               |
| T4   | `81bc96b`, `6dff4d3`, `52f0df7`                                             | The 4 ingest functions; trust binding; 24 h window, eviction, locked device     |
| T5   | `d6300c7`                                                                   | The simulator and `pnpm device:sim`                                             |
| T6   | `5789f6c`, `a05dc4b`, `3f509fa`, `8a8a60b`, `c9c07fb`                       | The receiver; hardening; per-serial budgets; check before the database          |
| T7   | `ea7f14f`, `f38f60c`, `92409c8`                                             | Settings; devices API (feed, review, addresses, alerts)                         |
| T8   | `58afc63`, `0cad6a6`                                                        | People and device IDs API; IDs still on a device                                |
| T9   | `08dbdd9`, `0ac5d05`                                                        | Devices and people screens, dashboard alert; feed and guide fixes               |
| T10  | `4764045`                                                                   | Register and record sources, SMS purposes, `staff_attendance_days`              |
| T11  | `8f9ba94`, `99ff5bc`                                                        | `AbsentSmsService`, today from the Clock; punch processing                      |
| T12  | `0e5cd06`, `cfcd546`, `f62b9d6`, `e55ddd5`, `4116d7a`                       | Registers from punches; hold-backs, per-section transactions, BUSY, active-only |
| T13  | `c8e1673`, `8fb857f`                                                        | Retention; the fast superseded-command query                                    |
| T14  | `eadf3fe`                                                                   | Staff attendance API                                                            |
| T15  | `d21a86f`, `a64fed8`, `95224b4`                                             | Attendance and staff screens; print and filter fixes; A4 width, 44 px targets   |
| T16  | `4caabab`, `a8256f1`                                                        | Demo seed for devices and staff                                                 |
| T17  | `396eb05`, `323da37`                                                        | Docs                                                                            |
| T18  | `42b9174`, `7b2beaa`                                                        | Playwright specs and their review fixes                                         |
| Fix  | `1720fe4`, `4a7d5c7`, `a5a480a`, `cd2e618`, `9596992`, `a798af9`, `aad78d4` | The final review's fix wave (section 6)                                         |

## 2. Owner decisions honoured

| #   | Decision                                                  | How it was built                                                                                                                                                                     |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | Devices and staff attendance under ATTENDANCE             | Every new API route has `@RequireModule('ATTENDANCE')`. The receiver refuses (403) an institute with ATTENDANCE off; the minute tick and the `process-punches` job skip it.          |
| Q2  | Punches become the register at the cutoff, in one go      | Before the cutoff nothing is written. The today page shows "punched in 28/35"; the take screen shows each arrival time. At the cutoff the minute tick writes the whole register.     |
| Q3  | Hold back when no device was seen or half are missing     | Both checks (15 minutes; more than half). Two more were added during the build: `NOT_ON_DEVICE` and `AUTO_CLOSE_ENDED` (#42, #43). An admin can "close from device" after a confirm. |
| Q4  | No automatic marking for coaching (PER_SESSION)           | Registers from punches are DAILY only. Punches, the feed, arrival times, entry/exit SMS and staff attendance work in both modes.                                                     |
| Q5  | English name, ASCII, 24 characters, else the student code | `deviceDisplayName`; a tab or line break can never reach a device, and a CHECK on `device_commands.payload` backs it.                                                                |
| Q6  | Receiver as its own Nest app, port and login              | `apps/api/src/ingest`, port 4080, login `jantrik_ingest_app` that runs only the 4 `ingest_*` functions. Inside `pnpm dev`; its own process with its own variables in production.     |

**Addition 1, spoofing defence.** Built as asked, with one change and one addition:

- `NEW_IP`, `OUTSIDE_HOURS` (default 05:00–20:00) and `BURST` (default 60 a minute; held until
  accepted; beyond 5 × N dropped and counted, with a FLOOD alert).
- A `NEW_IP` or `OUTSIDE_HOURS` punch counts unless rejected, but sends no entry or exit SMS. An
  accepted BURST punch counts but sends none either.
- The live feed has a "flagged" filter, a chip per flag and OK / accept / reject. Every review is
  audited (`device_punch`). A reject rebuilds the person's day; a student left ABSENT after the
  cutoff gets the absent SMS once.
- **Change:** the plan trusted a device's first address ever. Security reviews showed that whoever
  connects first with a known serial number becomes trusted. Now the first address is trusted
  automatically only within 24 hours of the device's registration (#57). Later first contacts wait
  for an admin's "trust" in the setup guide or the alert.
- **Added:** commands (which carry names) and their results go only through a trusted address,
  enforced in the database (#58).

**Addition 2, device IDs unique in the database.** One table (`device_people`) with one unique
index on `(tenant_id, device_user_id)` for students and staff. IDs are `^[1-9][0-9]{2,8}$`. The
staff range is a setting (`staff_device_id_start`, default 9001); staff defaults skip every number
in use and every number a current student's code gives. The settings form shows how many student
codes fall in the next 1000 numbers. The people screen has a Collisions panel with "set an ID".
Added: an ID still on a device goes to nobody else (#53).

**Addition 3, retention.** `punch_retention_days` (default 730, 30–3650). The `expire-punches` job
runs at 00:40 Asia/Dhaka, per institute in `devices:tenants`, 5000 rows per transaction, oldest
first. The restrictive policy `retention_only` stops the app deleting a punch from the last 30
days; raw columns cannot be updated. Commands go after 90 days, but each ID's latest done command
per device is kept (the "still on a device" rule reads it; #65). Registers, records, staff days,
SMS logs and the audit log are never deleted.

**Your other instructions:** the two roles were added to the local Postgres by hand with the
one-off commands (now in [database.md](../database.md) → Database roles). No reseed was run.
Biometric data is never stored, queued or logged (section 4). On 2026-10-25 you asked that GitHub
CI run Playwright instead of a local `pnpm e2e`; that is how this branch is checked.

## 3. How to run and try it locally

**Start** (from the repo root):

```sh
docker compose up -d   # Postgres and Redis
pnpm db:deploy         # applies any migration not applied yet (step 11 adds 7)
pnpm dev               # web :3000, API :4000, the device receiver inside the API on :4080
```

- **Your machine:** the two roles and `DATABASE_INGEST_URL` were added during the build, and the
  7 migrations were applied (the visual checks ran on your `jantrik`).
- **Any other machine with an older Postgres volume:** add `jantrik_ingest` and
  `jantrik_ingest_app` once with the commands in [database.md](../database.md) → Database roles
  ("Existing local volume…"), before `pnpm db:deploy` (the migrations grant to these roles). A new
  volume gets them from `docker/postgres/init/01-roles.sh`.
- **`.env` additions** (both in `.env.example`):
  - `DB_INGEST_PASSWORD=ingest_dev_password` (the init script sets the role's password from it);
  - `DATABASE_INGEST_URL=postgresql://jantrik_ingest_app:ingest_dev_password@localhost:5432/jantrik`.
  - Without `DATABASE_INGEST_URL` the API does not start in development.
- A fresh checkout needs `@jantrik/shared` built before `pnpm device:sim`: run `pnpm build` or
  start `pnpm dev` once.

**Demo devices need a reseed.** The seed gives Shapla two devices (প্রধান ফটক `DEMO00000001`,
শিক্ষকদের কক্ষ `DEMO00000002`), IDs for everyone and a month of staff days. `pnpm db:seed` skips
institutes that already exist, so your local data gets them only from `pnpm db:reset` (drops your
local data). Run it only when you approve it. Without a reseed you can add a device by hand on the
Devices page and use its serial number with `--sn`.

**The simulator** (it talks to `http://localhost:4080` unless `--url` says otherwise):

```sh
pnpm device:sim handshake --sn DEMO00000001            # print the options the server sends
pnpm device:sim listen --sn DEMO00000001               # poll every 30 s, apply and confirm commands
pnpm device:sim listen --sn DEMO00000001 --interval 5  # quicker
pnpm device:sim punch --sn DEMO00000002 --pin 9002     # one staff punch; --out, --at 16:05
pnpm device:sim morning --sn DEMO00000001 --pins 20260102-20260127 --from 07:30 --minutes 40
pnpm device:sim biometric --sn DEMO00000001 --sentinel XYZ  # biometric-looking payloads
pnpm device:sim --help                                 # every command and option
```

- Other options: `--skew <seconds>` (a fast or slow device clock), `--legacy` (old firmware
  without `pushver`), `--tz`, `--ip` (sent as `X-Forwarded-For`; believed only when
  `INGEST_TRUST_PROXY` is set).
- Punches in the past count for arrivals but send no entry SMS (not real time).

**Watching the device close a register** (owner `01711000001` or admin `01711000003`, password
`Jantrik@2026`). Switching auto-mark on is not enough: a section closes only once **every active
student of it has an ID confirmed on a device**. Until then the today page shows it held back as
`NOT_ON_DEVICE` with the count.

1. Keep `pnpm device:sim listen --sn DEMO00000001` running.
2. Devices page → **Send people to this device** for প্রধান ফটক. Wait until its pending count is
   0 (20 names per poll). "Send to devices" on the People page also queues for শিক্ষকদের কক্ষ,
   which never connects, so that list keeps saying "sending".
3. Send the morning's arrivals (the `morning` command above). At least half of the section's
   active students must have punched in, and a device must have called within 15 minutes
   (`listen` does that).
4. Attendance settings: switch auto-mark on and set the cutoff minutes so that ষষ্ঠ শ্রেণি ক's
   cutoff (morning shift, starts 07:00; default cutoff 08:00) falls a few minutes from now. The
   setting allows 15–300 minutes after the start.
5. The register is written within a minute of the cutoff. With the absent SMS on, they show in the
   `pnpm dev` console after the correction delay.

- The device closes a register by itself only until **an hour after the cutoff**. Later, or while
  held back, the today page offers **Take from the device** (owner or admin, after a confirm).
- Steps 2, 3 and 4 each list Shapla for the minute job. After a seed it is not listed until one of
  them runs.
- Details: [demo-accounts.md](../demo-accounts.md) → Devices.

## 4. Security model as built

The protocol identifies a device only by its serial number, in clear, over plain HTTP. Anyone who
learns a registered serial can post as that device. This is how it is contained. Details:
[devices.md](../devices.md) → Security model.

- **Own login, 4 functions.** The receiver logs in as `jantrik_ingest_app`, which reads no table
  and runs only `ingest_resolve`, `ingest_store_punches`, `ingest_take_commands` and
  `ingest_command_results`. None takes a tenant or device id: each finds and locks the device from
  the serial number and scopes every query by it. The institute in a job comes from the
  function's answer, never from the request.
- **Fail-closed start.** The receiver refuses to start unless its login can run `ingest_resolve`
  and cannot read `students` or `device_punches`. A database not reachable yet is retried for
  about 30 s, then the start fails. A code scan and a runtime check keep the API's database access
  out of the receiver.
- **Own environment.** The receiver validates only `NODE_ENV`, `DATABASE_INGEST_URL`, `REDIS_URL`,
  `QUEUE_PREFIX`, `INGEST_PORT`, `INGEST_TRUST_PROXY` and the limits. In production it must get
  none of the API's logins or secrets. A test boots it with only these variables.
- **First-address trust for 24 hours.** A device's first address is trusted automatically only on
  first contact within 24 hours of registration. Any other new address is recorded untrusted, its
  punches are flagged `NEW_IP`, and an admin trusts or revokes it (audited).
- **Commands only through trusted addresses**, enforced in the database. A sniffed serial cannot
  read the names in a device's commands or fake its answers.
- **Budgets and limits** (Redis, configurable):
  - 1200 requests a minute per address; 300 per serial and address, so outsiders cannot use up the
    real device's share;
  - one shared budget of 1200 a minute per serial for all its **untrusted** addresses, so rotating
    addresses gains nothing and a trusted device is never starved;
  - once that budget is spent, untrusted callers are refused **before any database call** (an
    address Redis remembers as trusted skips this check);
  - an IPv6 address counts by its /64, so one host cannot rotate through its own addresses;
  - 30 refused serials per 10 minutes per address, then 429 without a database call;
  - bodies: ATTLOG 512 KB and 10 000 lines (413); other uploads drained up to 2 MB; an answer
    sent before the body arrived closes the connection; header, request and idle timeouts;
  - GET and POST only (a HEAD on getrequest would have marked commands sent).
- **At most 50 untrusted addresses per device.** A new one evicts the least recently seen, so the
  school's real new address can always be recorded. Known limit: a sustained flood of 50 or more
  new addresses every 30 s keeps it out; the escape is to switch the device off and register the
  serial again (#59).
- **Flags and review.** `NEW_IP`, `OUTSIDE_HOURS` and `BURST` (held), plus `CLOCK_FUTURE` and
  `STALE`. Only IDs mapped to a person count.
- **No SMS from flagged punches.** Entry and exit SMS go only for real-time, unflagged punches,
  once per student per day and direction, within 90 % of the daily cap. No register is closed
  while more than half are missing.
- **Biometric data never stored, queued or logged.** Only `table=ATTLOG` is parsed, and only 4
  fields of a line are kept. Every other upload is drained unread. Logs carry the serial, the
  address, a reason and error names, never bodies, query strings or messages. The sentinel test
  sends fingerprint, face, photo and user-info payloads with a marker, then searches every text,
  json and bytea column, every Redis key (BullMQ jobs too) and all logs (Nest and `console`,
  Buffers too) in plain, base64 and hex. Planted leaks prove the search works.
- **Serial numbers** are active in one institute only; a taken one says "contact Jantrik" without
  saying where. Jantrik never removes people from a device on its own.

## 5. Tests and gates

**Part B gates** (T18, on `95224b4`, before the fix wave; ports 3000, 4000 and 4280 free before
and after):

| Gate                                   | Result                                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `pnpm lint`                            | passed, 9/9 tasks (66 s)                                                                              |
| `pnpm typecheck`                       | passed, 9/9 tasks (24 s)                                                                              |
| `pnpm format:check`                    | failed only on git-ignored `.superpowers/` notes; fixed by `.prettierignore` in `7b2beaa`, then green |
| `@jantrik/shared` (Vitest)             | 565 passed (30 files)                                                                                 |
| `@jantrik/db` (Vitest, RLS)            | 348 passed (33 files)                                                                                 |
| `@jantrik/device-sim` (Vitest)         | 17 passed (new package)                                                                               |
| `@jantrik/web` (Vitest)                | 67 passed (8 files)                                                                                   |
| `@jantrik/api` (Vitest), 3 chunks      | 557 passed (59 files: 205 in 249 s, 151 in 245 s, 201 in 209 s)                                       |
| `pnpm build` (Turbopack cache cleared) | passed, 6/6 tasks, 51/51 static pages                                                                 |

- No flaky test; everything passed on the first run. Log noise outside step 11: a `pg`
  deprecation warning, and `MaxListenersExceededWarning` in the fees-collect concurrency test.
- The full API suite takes about 11 minutes, so it ran in 3 chunks with streaming output.

**New test files in this step:**

- shared: `devices`, `device-people`, `devices-api`, `staff-attendance`, `staff-attendance-api`;
- db: `devices-rls`, `ingest-functions`, `staff-attendance-rls`, `demo-devices`, and the
  schema-safety list (the ingest login has zero grants; no login can CREATE in `public`);
- api: `devices-ingest`, `devices-ingest-env`, `devices-api`, `devices-people`,
  `devices-processing`, `devices-review`, `devices-attendance`, `devices-retention`,
  `devices-simulator`, `staff-attendance`, `clock`, and unit specs for the receiver, its login,
  its isolation, its environment and the Prisma error filter;
- web: `device-settings`, `register-controller`, `time-input`, `feed`, `people`, `addresses`,
  `entry`;
- device-sim: `simulator`.

**The fix wave** (`7b2beaa..aad78d4`) ran only the affected specs, one file at a time in the
foreground:

| Spec                                        | Result |
| ------------------------------------------- | ------ |
| devices-processing                          | 14/14  |
| devices-api                                 | 20/20  |
| attendance                                  | 32/32  |
| devices-attendance                          | 22/22  |
| devices-retention                           | 6/6    |
| devices-review                              | 4/4    |
| devices-simulator                           | 1/1    |
| `src/config` (3 files, incl. `ingest-env`)  | 29/29  |
| devices-ingest + `src/ingest` (4 files)     | 49/49  |
| shared attendance tests                     | 79/79  |
| web device lib (3 files, incl. `addresses`) | 29/29  |

- Then `pnpm lint` 9/9, `pnpm typecheck` 9/9 and `pnpm format:check` clean on `aad78d4`.
- Both built entry points were started: `dist/main.js` (development, receiver inside) and
  `dist/ingest-main.js` (production, only its own variables, no `.env`).
- Each fix came with tests. For I2 and M6 the new tests were also run against the old code and
  failed there.
- The fix wave added about a dozen API cases and 4 web cases after Part B. The full suites with
  them run in CI's "Lint, typecheck, test, build" job.

**Playwright.** 9 new tests, written and reviewed, **not run locally** (you asked that GitHub CI
run the full suite):

- `devices.spec.ts` (5): device IDs by hand, by CSV with one bad row, by default and past a
  collision; a new device whose guide turns connected when the simulator calls; send people;
  punches named in the feed and an unknown ID called out; a second address flagged, rejected and
  trusted; 390 px touch; the device going offline and being switched off.
- `staff-attendance.spec.ts` (2): the day view, a manual leave with a reason, the month grid, its
  print on one A4 landscape page, both CSVs, at 1366 and 390 px.
- `layout.spec.ts` and `numerals.spec.ts` (1 each): the four new screens at 360/390 px and their
  Bangla digits. `themes.spec.ts` covers them in dark (no new test).
- 83 tests in 24 files in all.
- **CI: pending — see the PR checks.**
- The new demo seed has never run end to end on `jantrik_e2e`; CI's e2e job is its first run.

Deviations in the specs: punches are made at the real time, not dated `E2E_TODAY` (a punch before
the device's registration day is skipped by design); the collision is a student, not a staff member
(a staff default can never be taken).

## 6. Reviews

Every task had a spec and quality review by a fresh reviewer, then fix rounds with a re-review
until nothing Critical or Important was open. Automated security reviews also ran on the receiver
and the ingest functions at several commits.

| Task | Part                     | Review                 | Fix rounds |
| ---- | ------------------------ | ---------------------- | ---------- |
| T1   | shared rules             | needs fixes (DST)      | 1          |
| T2   | roles, config, Clock     | approved               | 0          |
| T3   | device tables            | approved               | 0          |
| T4   | ingest functions         | needs fixes            | 2          |
| T5   | simulator                | approved               | 0          |
| T6   | receiver                 | needs fixes            | 3          |
| T7   | devices API              | approved, minors taken | 1          |
| T8   | people API               | approved, hazard fixed | 1          |
| T9   | devices web              | needs fixes            | 1          |
| T10  | sources, staff days (DB) | approved               | 0          |
| T11  | punch processing         | approved               | 0          |
| T12  | registers from punches   | needs fixes            | 4          |
| T13  | retention                | needs fixes            | 1          |
| T14  | staff API                | approved               | 0          |
| T15  | attendance and staff web | needs fixes            | 2          |
| T16  | seed                     | approved               | 1          |
| T17  | docs                     | needs fixes (sources)  | 1          |
| T18  | Playwright               | needs fixes            | 1          |

### Notable findings fixed

**Receiver and ingest security:**

- **Command theft** (security review): `getrequest` and `devicecmd` worked from any address, so a
  sniffed serial could read PINs and names and fake answers. Now commands and results go only
  through a trusted address, enforced in the database (`6dff4d3`).
- **Quota exhaustion** (security review): the per-device limit was keyed by serial only, so
  outsiders could use it up. Now a share per serial and address (`a05dc4b`), plus a per-serial
  budget against address rotation (`3f509fa`), charged only to untrusted addresses so outsiders
  cannot starve the real device (`8a8a60b`).
- **Untrusted budget before the database** (security review): over-budget callers still reached
  `ingest_resolve` (address writes, eviction). Now they are refused before any database call
  unless Redis remembers the address as trusted (`c9c07fb`).
- **Unread bodies** (T6 review): after a 400/403/404/429 a body was read without a cap (1 GiB in
  under 4 s). Now the connection closes, and server timeouts are set (`a05dc4b`).
- **IPv6 rotation** (T6 review): limits were per /128; now per /64 (`a05dc4b`).
- **HEAD** on getrequest marked commands SENT without sending them; now only GET and POST
  (`a05dc4b`).
- **Fail-closed start:** the start-up role check passed when its own query failed; now it refuses
  (`a05dc4b`).
- **The sentinel test** missed `console` output and printed Buffers as truncated hex; both are
  now caught, with planted leaks as controls (`a05dc4b`, `8a8a60b`).
- **24-hour trust window** (security review, twice): trust on first use let a squatter who
  connects first become trusted (`52f0df7`, section 2).
- **Eviction at 50** (security review): the untrusted-address list could be filled so the real
  new address could never be recorded; now the least recently seen is evicted (`52f0df7`).
- **The locked device:** one function looked the serial up again instead of using the device it
  had locked (a deactivate and re-register race could trust an address on another device). Now
  each function locks the device in its lookup and re-checks it (`52f0df7`).
- **Scope tests:** no test failed if a query lost its device or institute scope. Tests now cover a
  second device in the same institute and another institute, with mutation runs (`6dff4d3`,
  `52f0df7`). A test checks that no login can CREATE in `public` (`6dff4d3`).
- **Upload speed:** a 10 000-line upload took 199 s on a grown table. Uploads are now set-based:
  1.5–1.8 s (`6dff4d3`).
- **DST and injection in the shared rules** (T1 review): `wallClockToUtc` was wrong next to DST
  changes; an LF in a stamp could add option lines to the handshake (`a445c1e`).

**Device IDs and registers:**

- **Freed IDs still on a device** (T8 review): an ID taken from someone could be given to another
  person while the old fingerprints were still enrolled under it. Now `ID_STILL_ON_DEVICE` until
  every active device confirms the removal (`0cad6a6`).
- **Students without IDs held back** (T12 review): a student with no ID, or not confirmed on a
  device, would have been marked absent with an SMS every day. Now the section is held back as
  `NOT_ON_DEVICE` (`cfcd546`).
- **Per-section transactions** (T12 review): the cutoff wrote every register and absent SMS in one
  15 s transaction; about 1000 absentees would fail it every minute. Now one transaction per
  section (`cfcd546`).
- **Auto-close window, late enrolment, BUSY** (T12): auto-close only within an hour of the cutoff;
  a student enrolled after the device's register gets a MANUAL record on submit instead of a 500;
  a lock wait over 5 s answers 409 BUSY (`cfcd546`).
- **BUSY scope** (T12 re-review): every transaction timeout was being answered as BUSY and no
  longer logged. Now only a lock wait (55P03) is BUSY (`f62b9d6`).
- **Inactive students** (T12 rounds 2–4): they no longer hold a section back, get no absent SMS
  from the device, and are left out of the "half missing" check, the counts and the arrivals
  (`f62b9d6`, `e55ddd5`, `4116d7a`).
- **Retention query speed** (T13 review): finding superseded commands ran a subquery per row. Now
  one ranking: 11.6 s to 53 ms nightly, 7.4 s to 0.2 s the first night, at 4 devices × 5000 IDs
  (`8fb857f`).
- **Deadlock:** trusting an address took locks in the other order from processing; fixed when
  processing was built (`99ff5bc`).

**Screens and tests:**

- A feed poll could undo a punch review; the setup guide showed "connected" for an offline device
  (`0ac5d05`).
- The staff month's side panel printed over the grid; the today page's "give IDs" link ignored
  its filter (`a64fed8`). The month now prints within one A4 landscape width, and two buttons
  became 44 px targets (`95224b4`).
- The devices spec had no cleanup after a failure (a CI retry would fail for certain), and the
  feed test needed more than 30 s (`7b2beaa`).
- Docs: the protocol source links were missing (`323da37`).

### Final whole-branch review

Verdict: **ready to merge with fixes**. No Critical finding. Lock order, tenant isolation, the
biometric rule and every SMS path were found to hold across tasks. Its one deferred MUST FIX item
was the first end-to-end run of the new seed, which CI's e2e job now covers (section 8).

The fix wave (`7b2beaa..aad78d4`):

| Item | Problem                                                                                            | Fix                                                                                               | Commit    |
| ---- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------- |
| I1   | An institute was listed for the minute tick and retention only when a device was added via the API | Listed again on every path that needs it (device change, sync, settings with auto-mark, each job) | `1720fe4` |
| I2   | The stand-alone receiver needed the API's whole secret set to start                                | Its own environment schema; production gives it none of the API's logins or keys                  | `4a7d5c7` |
| M2   | A late punch cleared the teacher's name on an edited device register                               | The teacher stays the updater; the device's change is marked so conflicts name the device         | `a5a480a` |
| M3   | The setup guide offered to trust `last_ip`, which any caller with the serial can set               | It shows the device's own trusted address, or the untrusted one seen last, with counts            | `cd2e618` |
| M4   | `INGEST_PUBLIC_HOST` defaulted to localhost in production                                          | The API refuses to start in production without it or with a loopback host                         | `4a7d5c7` |
| M5   | The take screen suggested ABSENT for inactive students, and a save sent them absent SMS            | Absent SMS only to ACTIVE students on every path; no suggestion for inactive ones                 | `9596992` |
| M6   | Two places used the clock's date instead of the institute's "today"                                | Both use `todayAt` / `settings.load().today`                                                      | `a798af9` |
| M9   | `process-punches` did not check ATTENDANCE                                                         | It lists the institute and processes nothing while ATTENDANCE is off                              | `1720fe4` |

Also in the wave: doc wording from the T17 re-review and the backlog's step 11 list (`aad78d4`).

**Behaviour change from M5 you should know:** a teacher marking an inactive (transferred or
dropped-out) student absent no longer sends their guardian an absent SMS. Before this fix it did.
This settles the owner note from T12 (a teacher's edit of a device register re-queued absent SMS
for inactive students too). Decision #45.

A fresh re-review of the fix wave was started at the same time as this report.

## 7. Rulings made on your behalf

Every ruling in the build ledger, grouped by task, in ledger order within each group. Each says
what was decided and what it costs if wrong. The durable ones are decisions-pending #39–#68.

**Planning (before T1):**

- Staff-day tables land with the register sources (T10), before processing needs them. Cost: none.
- The simulator is built before the receiver, so the receiver tests can drive it. Cost: none.
- The review endpoint first stores the review and its audit only; processing (T11) wires in the
  recompute and its tests. Cost: reviews did nothing between T7 and T11 (never shipped so).
- The settings extension for every new column is done in T7, the first API user. Cost: none.
- `AbsentSmsService` is split out at the start of T11 and reused by the cutoff. Cost: none.
- Where the plan's table and its corrections list differ, the corrections win (IDs of 3–9 digits,
  `flags text[]`, review columns, `source_ip`, HELD). Cost: none.

**T1 shared rules:**

- The unvalidated handshake stamp (an LF could add a second `TransFlag`) was raised to Important
  and fixed; the database checks stamps too. Cost: one small extra fix.
- Subagent commits name their own model in the Co-Authored-By trailer; no history rewrite. Cost:
  cosmetic.

**T3 tables:**

- The 30-day retention floor uses the database's `current_date`. Cost: a punch 29–31 days old may
  or may not be deletable; the setting's minimum is 30 anyway (#65).

**T4 ingest functions:**

- Duplicates are checked before the per-minute cap, so a re-sent punch is a duplicate, not
  dropped (#61). Cost: none.
- One upload's ids share a millisecond, so the feed orders by `received_at`, `punched_at`, id and
  pages with a `(received_at, id)` cursor. Cost: a row could show out of device order within one
  upload.
- The receiver always passes an array of clock samples, never NULL. Cost: uploads would fail.
- A missing test that no login can CREATE in `public` (an injected operator could hijack a definer
  function) was raised to Important. Cost: one extra test.
- `ingest_note_address` uses the locked device and re-checks it; a FAILED-sweep scope test was
  added; both joined round 2. Cost: none.

**Receiver security (T4 and T6, from the security reviews):**

- Commands and their results are bound to trusted addresses in the database, and the per-device
  limit is keyed by serial and address (#58). Cost: after an ISP change, commands wait until an
  admin trusts the new address.
- Trust on first use was kept at first, with every trusted address listed and a revoke action.
  Cost: a squatter who connects first must be spotted and revoked. (Revised below.)
- At the 50-address cap the least recently seen untrusted address is evicted (#59). Cost: none.
- **Revised:** the first address is trusted automatically only within 24 hours of the device's
  registration (#57). Cost: a device installed more than a day after registration needs one admin
  click before commands and entry SMS flow.
- The per-serial budget is charged only to untrusted addresses, after `ingest_resolve` (#60).
  Cost: after an ISP change, the school's new untrusted address can be starved by an attacker
  until the admin trusts it.
- LRU eviction is kept and the flood case is documented as a known limit (#59). Cost: under a
  sustained flood the admin cannot trust the new address until it stops (switch off and
  re-register is the escape).
- Untrusted callers are refused before the database once the budget is spent, unless Redis marks
  the address trusted (#60). Ruled with a 5-minute mark; built as 7 days, renewed on each request.
  Cost: a revoked address skips the early check for up to 7 days; it is still charged after the
  database answers and gets no commands.

**T6 receiver:**

- HEAD on getrequest, the fail-open start check and the missing server timeouts were raised to
  Important. Cost: small extra work.
- The Buffer-blind log capture in the sentinel test was raised to Important (it guards your
  biometric rule). Cost: one small test change.

**T7 devices API:**

- The flagged feed covers punches received in the last 7 days (#62). Cost: older unreviewed flags
  leave the flagged view (they stay in the normal feed).
- Lock order: the institute's punch lock, then punch rows, then registers and staff days; reviews
  take the punch lock first. Cost: none.
- The feed poll asks from 60 s before its newest row and merges by id, so out-of-order commits are
  not missed (#62). Cost: a skipped row would show on reload.
- The fix round also took two query fixes (the NEW_IP alert in SQL, unknown IDs' devices in one
  query). Cost: none.

**T8 people API:**

- "Remove from devices" also takes IDs nobody holds, e.g. enrolled on the device outside Jantrik
  (#52). Cost: an admin can delete such a device user on purpose.
- Any student who exists, inactive too, may get an ID by hand or CSV; lists, defaults and the
  export cover this year's active people (#51). Cost: an inactive student can hold an ID.
- An ID freed by a change or clear stays reserved while a device still has it (#53). Cost: an
  admin must remove an old ID from the devices before reusing it.
- Students without a section are listed with no section. Cost: none.

**T9 devices web:**

- "The guide shows connected for an offline device" was raised to Important. Cost: none.
- Staff punches in the feed say "কর্মী" without roles (the feed API has none) (#68). Cost: less
  detail in the feed.

**T11 processing:**

- T11 was handed to a fresh implementer after two stalls, with tests streaming and limits under
  10 minutes. Cost: some rework.
- A BURST punch never sends entry or exit SMS, even when accepted (#46). Cost: an accepted burst
  punch sends no SMS.

**T14 staff API:**

- Accepted: untracked people show NONE, not ABSENT; the day view lists every active staff member
  (and ex-staff with a row that day); typed times are kept as typed; an out before the in is 422;
  the tracked switch needs active staff (#48, #49). Cost: small UI or API changes.
- Seeded staff profiles back-dated to 1 January. Cost: none (demo data). (Revised in T16.)

**T16 seed:**

- **Revised:** staff profiles date from the start of the seeded month, so older months show NONE,
  not ABSENT. Cost: none (demo data).

**Process:**

- Only one agent at a time runs tests against `jantrik_test` and Redis (concurrent runs share the
  BullMQ prefix and took each other's jobs). Implementers run affected specs only; the full suite
  runs at the gates in chunks. Cost: slower progress.

**T12 registers from punches:**

- Punches are processed 100 per transaction (500 passed the 15 s limit on the slowest path; 100
  takes about 4.8 s) (#63). Cost: more transactions per backlog.
- Accepted: the today report says CLOSED for a teacher's register too and BEFORE_CUTOFF until the
  tick writes; no device view on off days or for empty sections; close from device needs DAILY
  mode, not auto-mark; extra codes `WRONG_PERIOD_FOR_MODE`, `NON_WORKING_DAY`, `NO_STUDENTS`
  (#44, #67). Cost: small API or UI changes.
- A section with a student not confirmed on a device is held back as `NOT_ON_DEVICE`; the teacher
  takes it, or an admin closes it from the device after a confirm naming them (#42). Cost: more
  held-back sections until IDs are mapped and sent.
- The cutoff uses one transaction per section (#63). Cost: none.
- Raised from minors: auto-close only within 60 minutes of the cutoff (#43); a submit with a newly
  enrolled student must not fail; lock timeouts answer 409 BUSY with `Retry-After` everywhere
  (#64); boundary and race tests; a looser timing assertion. Cost: small.
- Accepted: a student enrolled after the device's register gets a MANUAL record on the teacher's
  submit (#39); BUSY is mapped once in the global Prisma filter; the new state
  `AUTO_CLOSE_ENDED`. Cost: that student's record is never updated by later punches.
- `NOT_ON_DEVICE` counts only ACTIVE enrolled students (#42). Cost: none.
- The cutoff and close from device send absent SMS only to ACTIVE students (#45; extended to every
  path by M5). Cost: guardians of inactive students on a device register get no absent SMS.
- "Half missing" and the today counts use ACTIVE students only, arrivals only their counting
  punches, and the BUSY wording is neutral (#45). Cost: none.

**T13 retention:**

- Command retention keeps each ID's latest done command per device and every waiting one; it
  deletes only failed, cancelled and superseded done ones after 90 days (ruled during T8) (#65).
  Cost: command rows grow by one per person per device.
- Accepted: punches are deleted oldest first; a command's age is the latest of `updated_at`,
  `sent_at` and `done_at`; an old FAILED latest add may go (#65). Cost: an old failure is no
  longer shown.

**T15 attendance and staff web:**

- A version conflict where the server and the draft agree on every student settles silently
  (#66). Cost: none.
- The UI defects the Playwright author predicted (print width, two 44 px targets) were fixed
  before the gates. Cost: none.

**T18 Playwright:**

- The review's minors were taken too: poll the API for offline, measure the print at the A4
  printable width, cleanup that cannot hide the first error, watch for a blank second PDF page.
  Cost: none.
- `.superpowers/` goes into `.prettierignore` (prettier does not read the nested `.gitignore`).
  Cost: none.

**Final review:**

- The fix wave is I1, I2, M2–M6 and M9 (absent SMS active-only on every path), the doc wording and
  the backlog list. The manual walkthrough and the performance check are not done in this step.
  Cost: they stay open (section 8).
- M2 marks a device change with the nil UUID in `last_submission_id`, with no migration. Cost: a
  teacher retrying an old submission after a device change gets a conflict naming the device
  instead of a replay (rare).

## 8. What was NOT done, still open

- **Local `pnpm e2e`:** not run, as you asked. GitHub CI runs the full Playwright suite on the PR,
  and that is also the first end-to-end run of the new demo seed on `jantrik_e2e`. Result: see
  section 5.
- **The manual walkthrough** (plan Verification 3) after a reseed: not done. It needs your approval
  for `pnpm db:reset`. Section 3 has the steps.
- **The 3-second check** (plan Verification 4: `/attendance/devices` at 390 px, 4× CPU, slow 4G,
  and the dashboard A/B against main): not measured. The new devices and staff messages add about
  45 KB of raw Bangla text to every page's message bundle. The fix is the existing backlog item
  "Load translation namespaces per route" ([backlog.md](../backlog.md) → Performance).
- **The real device:** nothing has met hardware. The checklist is in
  [devices.md](../devices.md) → Verify on the real device (`pushver`, `TransFlag`, the first
  `ATTLOGStamp=None`, USERINFO commands keeping fingerprints, state and verify codes, the clock,
  upload sizes and CRLF, PIN length, one public address, error answers, `INFO`, HTTPS and
  `pushcommkey`).
- **Screenshots:** 67 were taken during the build (27 for the devices screens, 40 for the
  attendance and staff screens, bn at 1366 and 390 px). They are in the git-ignored
  `.superpowers/sdd/step-11/shots/`, not committed. The fix wave's setup-guide change (M3) had no
  screenshot; the Playwright specs check its text.
- **The full API and web suites after the fix wave:** not run locally; CI runs them.

## 9. What you need to do

1. **Reseed, if you want the demo devices locally.** `pnpm db:reset` drops your local data and
   reseeds. Run it yourself, or tell me to.
2. **Know that your local `jantrik` has test data** from the visual checks (the attendance
   settings were put back afterwards). A reseed clears it:
   - device `T9SIM0001`, switched off; one trusted and one untrusted address;
   - device IDs for Shapla's 35 people (one changed by CSV);
   - some punches;
   - a device register for ষষ্ঠ শ্রেণি ক on the day of the check;
   - one manual staff day.
3. **Other machines and production:** create `jantrik_ingest` and `jantrik_ingest_app` (commands
   in [database.md](../database.md) → Database roles; in production a strong
   `DB_INGEST_PASSWORD`), and set `DATABASE_INGEST_URL`. Do it **before** `pnpm db:deploy` /
   `prisma migrate deploy`.
4. **Deployment** ([decisions-pending.md](../decisions-pending.md) → Deployment requirements, item
   4):
   - run the receiver as its own process (`node apps/api/dist/ingest-main.js`) with **only its own
     variables**: `NODE_ENV`, `DATABASE_INGEST_URL`, `REDIS_URL`, `QUEUE_PREFIX`, `INGEST_PORT`,
     `INGEST_TRUST_PROXY` and the limits. Never `DATABASE_URL`, `DATABASE_PLATFORM_URL`,
     `JWT_ACCESS_SECRET`, `OTP_PEPPER`, `PLATFORM_TOTP_KEY`, and no `.env` holding them where it
     starts;
   - set `INGEST_IN_PROCESS=false` for the API (the default in production);
   - open its port (4080) to schools over **plain HTTP**; a TLS proxy in front is optional for
     devices that support HTTPS;
   - `INGEST_TRUST_PROXY`: `false` for direct connections, a hop count or the proxy's address
     behind a proxy, **never `true`** (any client could then claim a school's trusted address);
   - set `INGEST_PUBLIC_HOST` (and `INGEST_PUBLIC_PORT`) for the API: what devices dial. The API
     refuses to start in production without it or with localhost;
   - the same Redis and `QUEUE_PREFIX` as the API; roles before migrations; migrations, then
     restart the API and the receiver.
5. **When the first device is bought,** go through the real-device checklist with it, and tell me
   what it does differently.
6. **Review the rulings** in section 7 and decisions #39–#68. The ones most worth a look: the
   24-hour first-address trust (#57), commands only through trusted addresses (#58), the
   `NOT_ON_DEVICE` hold-back (#42), the one-hour auto-close (#43) and absent SMS only for active
   students (#45).

## 10. Deferred work

Everything deferred from the plan, the build and the final review, each with why it waits:
[backlog.md](../backlog.md#devices-and-staff-attendance-later-work-step-11) → "Devices and staff
attendance: later work (step 11)". The larger items: a billable DEVICES module, marking coaching
batches from punches, an IP lock and "trust a network range", re-fetching punches from a device,
editable entry/exit SMS, staff office hours per person, staff roles in the feed, other brands,
HTTPS in the receiver, and re-processing a staff member's punches made before their ID was set.

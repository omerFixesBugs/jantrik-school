# Step 11: ATTENDANCE DEVICES (ZKTeco push) and STAFF ATTENDANCE

## Context

There is no device code yet. What exists and is reused:

- **Attendance registers.** A register (`attendance_sessions` + `attendance_records`) is either complete (every enrolled student has a status) or not taken. DAILY mode uses period 0; PER_SESSION (coaching) uses periods 1–20. `LATE` exists, but only as a status a teacher picks by hand. There is no cutoff, grace or office-hours logic anywhere.
- **Absent SMS.** `queueAbsentSms` in `AttendanceService` runs after a submit, with the dedupe key `absent:<student>:<date>`, the daily cap, the correction delay and the relevance check ("still absent in any register today", otherwise `CANCELLED`).
- **Times.** `shifts.start_time` / `end_time` (local wall-clock) are the only times of day. Sections without a shift (all of Alo) have none.
- **Staff.** `staff_profiles` (name, phone) has no staff code or employee id.
- **Jobs.** `TenantJobRunner.run(tenantId, fn)`, BullMQ schedulers in `onModuleInit`, and Redis sets of tenants (`fees:tenants`, `sms:held-tenants:<date>`), so no job queries across institutes.
- **Separate DB roles.** The platform area already runs on its own login role (`jantrik_platform_app`) that can only execute `platform_*` definer functions. The device link copies that pattern.

This step builds, behind `@RequireModule('ATTENDANCE')`:

- **A.** A device receiver for the ZKTeco push protocol (ADMS / iclock), on its own port, process and DB role, with a device simulator.
- **B.** Devices screen: add and edit devices, online and last seen, live punch feed, offline alert, setup instructions in Bangla.
- **C.** People ↔ device IDs: defaults, editing, CSV import and export, unmapped people, sending the people list to the devices.
- **D.** Students: PRESENT or LATE from the first IN punch, ABSENT at the cutoff, absent SMS, optional entry and exit SMS, the source of each record.
- **E.** Staff attendance: daily in and out, late arrival, early leave, manual entry with a reason, monthly report with print and CSV.
- **F.** Spoofing checks on punches, device IDs unique across students and staff in the database, and retention of raw punches.

No device has been bought: everything is built and tested against the simulator, and a short "verify on the real device" checklist goes into the report.

### Owner decisions (2026-10-24)

Q1–Q6 below approved as recommended, with three additions (next section). The two new database roles may be added to the local Postgres with one-off commands (documented). Ask before any reseed.

| #   | Question                                                        | My recommendation                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | Which module do devices and staff attendance belong to?         | **ATTENDANCE.** A separate billable DEVICES module would need a new `module_key` value, a `tenant_modules` row for every existing institute (only the platform can add those) and a platform switch. It can be split out later.                                                                                                                                                                                                |
| Q2  | When do punches become the register?                            | **At the cutoff.** Before it, the Today screen shows "arrived by device: 28 of 35" live and the take screen shows each student's arrival time, but the register stays "not taken". At the cutoff the register is written in one go (PRESENT/LATE/ABSENT). Writing it at every punch would leave half-filled registers that every report counts as complete, and would bump the version under a teacher's draft at every punch. |
| Q3  | Should the cutoff ever hold back?                               | **Yes, in two cases:** no device of the institute was seen in the last 15 minutes, or more than half of the section has no punch (a broken device or a strike day must not send 300 absent SMS). The Today screen then says why, and an admin can "close from device" after a confirm, or the teacher takes it by hand. Same idea as the existing "more than half absent? confirm".                                            |
| Q4  | Coaching centres (PER_SESSION mode)?                            | **No automatic marking in this step.** Punches, the live feed, entry/exit SMS and staff attendance work; registers stay manual. Marking a batch's period from punches needs a batch timetable we don't have (backlog).                                                                                                                                                                                                         |
| Q5  | Which name goes onto the device?                                | **The English name, ASCII only, cut to 24 characters; the student code when there is none.** ZKTeco screens can't draw Bangla.                                                                                                                                                                                                                                                                                                 |
| Q6  | Receiver as its own process and DB role, or a route in the API? | **Its own Nest app** (`apps/api/src/ingest`, own port, own login role `jantrik_ingest_app` that can only run four `ingest_*` functions). In development it starts inside `pnpm dev`; in production it runs as its own process. It is the only code that parses internet input without a login, over plain HTTP.                                                                                                                |

### Additions (owner, 2026-10-24)

**1. Spoofing defence.** Serial numbers travel in plain HTTP and can be sniffed, so every punch is checked as it arrives and may get flags:

- **`NEW_IP`:** the upload came from an address the device has not used before. Each device keeps its source addresses (`device_source_ips`). The first address a device ever uploads from is trusted automatically; after that, a new one raises an alert ("প্রধান ফটক: নতুন IP 103.4.5.6 থেকে ১২টি পাঞ্চ") on the devices screen and the dashboard, with **Trust this address** (its punches are marked reviewed) and **Review punches**.
- **`OUTSIDE_HOURS`:** the punch time is outside the institute's hours (settings, default 05:00–20:00).
- **`BURST`, the per-device cap:** at most N punches per device stamped in the same minute (setting, default 60; a real gate manages about 30). Punches over N are **kept but held**: they do not count until an admin accepts them. Beyond 5 × N in one minute the rest are dropped and counted (a flood), with an alert. This is the one flag that holds a punch back, because a cap that only flags would not cap anything.
- **Everything else counts unless rejected,** as you asked. A flagged punch (`NEW_IP` or `OUTSIDE_HOURS`) marks attendance but **sends no entry or exit SMS**, so a spoofer cannot text guardians. After an ISP changes a school's address, entry SMS pause until an admin trusts the new address; the alert says so.
- **Review in the live feed:** a "flagged" filter and a chip per flag (নতুন IP, সময়ের বাইরে, অতিরিক্ত). Actions: **looks right** (clears it from review), **accept** (a held BURST punch is applied), **reject** (the punch stops counting; that person's day is recomputed: a staff day is rebuilt unless it is MANUAL; a student's DEVICE record is rebuilt from the punches that still count, and if that leaves them ABSENT after the cutoff, the absent SMS runs through the usual pipeline, once). Every review is audited (`device_punch`).
- **Tests:** first address trusted, a second flagged and alerted, trusted afterwards; outside hours; the N+1th punch in a minute held, accepted later and applied; beyond 5 × N dropped and counted; a flagged punch counts but sends no entry SMS; rejecting recomputes the register and staff day and sends the absent SMS once; reviews audited; Playwright: a punch from a second address shows its chip in the feed and is rejected.

**2. Device IDs unique across students and staff, in the database.**

- One table holds everyone's ID (`device_people`), with one unique index on `(tenant_id, device_user_id)`. A student and a staff member can never share an ID, whatever the UI or an import does. IDs are institute-wide (one ID per person, on every device), so they are also unique on each device. `device_commands` only ever carries IDs from that table.
- IDs are 100 to 999 999 999 (`^[1-9][0-9]{2,8}$`). Below 100 is left to the device's own admin users, which are often 1.
- **The staff range is a setting** (`staff_device_id_start`, default 9001). A staff default takes the next free number from there, skipping every number already in use **and** every number a current student's code would give, even for students not mapped yet. Changing the start shows how many student codes fall within the next 1000 numbers.
- **The mapping screen has a Collisions panel:** a person whose default is taken (and by whom), two students whose codes give the same number, and CSV rows that clash with each other or with the database. Each has "set an ID".
- **Tests:** the database refuses the same ID for a student and a staff member (and for two of either); staff defaults skip student-code numbers; the overlap warning; the collisions list; CSV clashes reported without writing.

**3. Raw punch retention.**

- Per institute setting `punch_retention_days` (default 730 = 2 years, 30–3650).
- A daily job `expire-punches` (00:40 Asia/Dhaka), the same pattern as the import sweep: institutes from the Redis ZSET `devices:tenants`, one `TenantJobRunner` transaction each, punches whose `local_date` is older than the setting deleted in chunks of 5000. Command rows that are done, failed or cancelled are deleted after 90 days (they carry names).
- The database backs it: the app's DELETE on `device_punches` is limited by a restrictive policy to punches more than 30 days old, so no bug can delete recent ones. Raw columns still cannot be updated.
- Registers, records, staff days, SMS logs and the audit log are kept.
- Documented in `docs/devices.md`, `attendance.md` and `database.md`.
- **Tests:** old punches deleted, newer kept, registers and staff days untouched, the other institute untouched; the app cannot delete a 10-day-old punch.

### Decisions I made (recorded in docs/decisions-pending.md, open to change)

- **Manual wins.** The device never changes a record a person set (`source = MANUAL`). A teacher's change to a device record turns that record MANUAL; the records they did not touch stay DEVICE. Every change is audited as today.
- **After the cutoff,** a student who punches later (today only) is moved from ABSENT to LATE if the record is still DEVICE. A pending absent SMS is then cancelled by the existing relevance check; one already sent cannot be taken back (the entry SMS follows it).
- **LATE** means the first IN punch is strictly after `shift start + grace` (08:10:00 with grace 10 is PRESENT; 08:10:01 is LATE). Sections without a shift use a "school starts at" setting.
- **Cutoff** is per shift: `shift start + cutoff minutes` (default 60), so a morning and a day shift close at different times.
- **Entry and exit SMS:** off by default; at most one per student per day per direction (`entry:<student>:<date>`, `exit:<student>:<date>`); only on working days, only for punches received within 10 minutes of being made (a device that uploads yesterday's backlog sends no SMS); never held over the cap: they stop when the day's SMS reach **90 % of the cap**, so the last 10 % stays for absent alerts and fee receipts. Text fixed in Bangla, e.g. "তাসনিম প্রবেশ করেছে সকাল ৭:৪৫ — শাপলা উচ্চ বিদ্যালয়" (editable templates later).
- **In and out on a BOTH device** come from the in/out state the device sends (the setup guide tells the admin to switch on the device's automatic state by time). Students: arrival = first IN, exit = first OUT after it.
- **Staff in/out** ignore direction: first punch of the day = in, last punch = out if it is at least 30 minutes after the in. Late = in after office start + grace; early leave = out before office end − grace. Each day keeps a copy of the office hours it was judged by, so changing them later never rewrites a past month.
- **Who counts as staff:** every active staff member with a profile, except people whose only role is OWNER (they can be switched on, and anyone can be switched off, per person).
- **Device IDs** are digits only, 3–9 digits, no leading zero (devices drop leading zeros), one ID per person across all the institute's devices, unique across students and staff (addition 2).
  - Student default: the digits of the student code (`SHS-2026-0042` → `20260042`, `ALO-26-001` → `26001`).
  - Staff default: from the staff range start (9001), in the order staff were added (staff have no ID today).
  - A default that is taken or invalid is reported in the Collisions panel for a manual choice.
- **People are never removed from a device automatically** (that deletes their enrolled fingerprints). A deactivated student shows up under "on the devices but no longer active", with an explicit "remove from devices" action.
- **A serial number** can be active in only one institute. Adding one that is taken anywhere answers "this serial number can't be added; contact Jantrik" (no hint whose it is). A device is deactivated, never deleted (its punches stay).
- **Unknown serial numbers** are refused (HTTP 403) and logged: one log line per serial per 10 minutes, and a Redis list of the latest 500 refused serials for support. Nothing is written to the database for them.
- **Punches older than the device's registration day are not stored; punches older than 7 days are stored but only shown, not applied.** Staff days are updated for punches up to 7 days old (a device that was offline for a weekend still counts); student registers only for today.

## Workflow

- Branch: `feature/step-11-devices`, created from an up-to-date `main` (done).
- Every tenant table goes through the **add-tenant-table skill**. Migrations are created with `--create-only` (once; the folder found with `ls -t`), renamed to `20261029…` so they sort after `20261028040100_exams_sms_purpose`, then RLS, grants, CHECKs, policies and functions are appended, `pnpm db:migrate` runs on the local DB (migrations only, no seed), then the drift check (empty), the schema-safety list and the isolation tests.
- **New DB roles** `jantrik_ingest` and `jantrik_ingest_app` go into `docker/postgres/init/01-roles.sh`, CI and the docs. Your local volume already exists, so I add them once with `docker compose exec postgres psql -U postgres …` (the same one-off commands go into `docs/database.md` for your other machines).
- Pure rules are written test-first (`packages/shared/src/devices.ts`, `staff-attendance.ts`).
- During each part only the affected tests run. A **review subagent** checks the DB parts (A1, A2, D1, E1), the receiver (B1–B3: SN check, parsing, biometric dropping, limits) and the SMS and register parts (D2, D3).
- One or more commits per part, pushed as I go. At the end: `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, `pnpm test`, `pnpm build` (after clearing `apps/web/.next/cache/turbopack`), then `pnpm e2e` with ports 3000/4000/4280 checked free; I stop only processes I started. Then `gh pr create` with the step report.
- Screenshot checks: bn at 1366 and 390 px only.
- Seeding: I ask before any `pnpm db:seed` / `db:reset` on the local DB. `pnpm e2e` reseeds only `jantrik_e2e`.

## How it fits together

```
ZKTeco device ──HTTP (plain)──▶ ingest server :4080  (apps/api/src/ingest, role jantrik_ingest_app)
                                  │ SN → device and institute only through ingest_* functions
                                  │ ATTLOG lines parsed; every other table drained and dropped
                                  ▼
                           device_punches (immutable)  +  BullMQ "devices" job {tenantId}
                                                              │
API worker ── TenantJobRunner.run(tenantId) ◀─────────────────┘
   ├─ students: arrival time, entry/exit SMS, late punches after the cutoff
   ├─ staff: staff_attendance_days (in, out, late, early)
   └─ every minute ("devices-tick"): leftover punches, then cutoffs → registers + absent SMS
```

- The ingest server has no JWT stack, no CORS, no cookies and no tenant context. It never touches `PrismaService` (the app role) or `Db`; a code-scan test (like `platform-isolation.spec.ts`) checks both directions.
- The tenant id in a job comes from the `ingest_*` function's answer (the database's mapping of the serial number), never from the request.
- On start, the ingest client refuses to run if its login can read any table or cannot run `ingest_resolve` (as `PlatformPrismaService` does).

## The device link: protocol and security

**What the receiver speaks.** Sources: ZKTeco's "Attendance PUSH Communication Protocol" (V3.7, 2020, push 2.4.1) and "PUSH SDK Communication Protocol" (2.0.1), ZKTeco's own iclock server and Java demo, and open-source servers tested on hardware (links go into `docs/devices.md`). Push 2.x only; the 3.x access-control firmware (`/iclock/registry`, `/iclock/push`, `rtlog`) is not supported, and the first request's `pushver` is logged so we know which one a device speaks.

| Request                                                                                                                                                                                          | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /iclock/cdata?SN=…&options=all&pushver=…` (handshake)                                                                                                                                       | `GET OPTION FROM: <SN>` then `ATTLOGStamp=<last stored, or None>`, `OPERLOGStamp=9999`, `ATTPHOTOStamp=9999`, `ErrorDelay=60`, `Delay=30`, `TransTimes=00:00;14:05`, `TransInterval=1`, `TransFlag=TransData AttLog` (attendance only: no user, fingerprint, face or photo uploads), `TimeZone=6` (from the institute's zone), `Realtime=1`, `Encrypt=None`. No `PushProtVer` (the device then stays on 2.2.14: no encryption handshake), no `MultiBioDataSupport`, no `PushOptionsFlag`. Firmware that sends no `pushver` gets the old names (`Stamp`, `OpStamp`, `PhotoStamp`). We never send a stamp of 0 (that asks for the whole history again). |
| `POST /iclock/cdata?SN=…&table=ATTLOG&Stamp=…`                                                                                                                                                   | Lines `PIN⇥time⇥status⇥verify⇥workcode⇥…` parsed (the last fields may be missing or empty, a trailing tab is normal), punches stored, `OK: <lines received>`; the stamp is stored for the next handshake                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `POST /iclock/cdata?table=<anything else>` and `/iclock/fdata` (OPERLOG with its `USER`/`FP`/`FACE`/`FVEIN`/`USERPIC`/`BIOPHOTO` lines, BIODATA, ATTPHOTO, IDCARD, `FPImage`, ERRORLOG, options) | Body drained unread up to a limit and dropped, then **HTTP 200 `OK`**: any other status makes the device send it again forever                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET /iclock/getrequest?SN=…` (every 30 s)                                                                                                                                                       | Up to 20 pending commands, one per line, `C:<seq>:DATA UPDATE USERINFO PIN=…⇥Name=…` or `C:<seq>:DATA DELETE USERINFO PIN=…` (numeric ids; the protocol allows 200 commands or 40 KB), or `OK`. From `INFO` we keep only the firmware version and the user count                                                                                                                                                                                                                                                                                                                                                                                      |
| `POST /iclock/devicecmd?SN=…`                                                                                                                                                                    | Lines `ID=<seq>&Return=<code>&CMD=…` recorded (0 = done; anything else = failed with its code, e.g. −1002 "not supported"), `OK`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /iclock/ping`; anything else under `/iclock`                                                                                                                                                | `OK`; 404                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Every answer is `text/plain` with `Content-Length` (no chunking), `Cache-Control: no-store` and a `Date` header in GMT, which the protocol requires.

**Biometric data never lands anywhere.**

- Only `table=ATTLOG` is parsed, and from each line only four fields are kept: device user id, time, in/out state, verify type (fingerprint, card, face, password). Extra fields (work codes, temperature, mask) are dropped.
- Every other table is read off the socket and thrown away without being parsed, stored, queued or logged. The handshake asks the device not to send them in the first place.
- Commands we send carry only `PIN` and `Name` (never card, password or privilege fields, so a push can't wipe a card or demote a device admin).
- The receiver logs only the serial number (after validation), the table name and error names, never bodies or query strings. A test sends fingerprint, face, photo and user-info payloads with a sentinel string and then searches every text column of the database, every Redis key (including BullMQ jobs) and the captured logs.

**What a serial number proves.** The protocol identifies a device only by its serial number, over plain HTTP. So:

- Someone who knows a registered serial could post fake punches. Limits: the spoofing checks of addition 1 (new address, outside hours, per-minute cap, review and reject); only mapped IDs count; flagged punches send no SMS; at most one entry and one exit SMS per student per day, only for real-time punches, inside the 90 % cap; no register is closed while more than half is missing. A hard "accept this device only from IP x" lock goes to the backlog.
- Someone could register another school's serial first (squatting). The real owner then sees "can't be added; contact Jantrik", and support resolves it. We never send delete commands automatically, so squatting can't wipe a device's fingerprints.
- Nothing secret travels on the link (no names except the device display name, no tokens).

**Limits** (Redis, configurable): 1200 requests/min per IP, 300/min per device, 30 refused serials per 10 min per IP (then 429 without a DB call); ATTLOG body at most 512 KB and 10 000 lines (413 beyond); other tables drained up to 2 MB, then the connection is closed. Serial numbers must match `^[A-Za-z0-9]{6,32}$` (400 otherwise, before any lookup).

**Time.**

- Devices send local wall-clock time without a zone. It is read in the institute's timezone (`tenants.timezone`).
- Each punch keeps `device_time` (as sent), `received_at` (our clock) and `punched_at` (the time used for rules).
- Clock skew: while a device is online it uploads in real time, so for each batch the newest punch's `device_time − received_at` is a sample. With 3 consistent samples (within 90 s of each other) the median becomes the device's clock offset, shown on the devices screen when it is 2 minutes or more ("ঘড়ি ৭ মিনিট এগিয়ে"), and subtracted from `punched_at`.
- A punch more than 5 minutes in the future (after correction) gets `punched_at = received_at` and a `FUTURE` flag.
- First line of defence: the protocol has the device set its clock from our `Date` header, with `TimeZone=6` telling it our zone, so a connected device should stay right. The skew estimate is the safety net for firmware that doesn't.

## Core rules (`packages/shared/src/devices.ts`, `staff-attendance.ts`, `dates.ts`; unit-tested first)

- `parseAttlog(body)`: CRLF/LF, a BOM, tabs; keeps `pin` (`^[A-Za-z0-9]{1,24}$`), `deviceTime` (`YYYY-MM-DD HH:MM:SS`), `state`, `verify`; counts rejected lines; at most 10 000 lines.
- `wallClockToUtc(localDateTime, timeZone)` and `localDateOf(instant, timeZone)` in `dates.ts`.
- `interpretPunch({deviceTime, receivedAt, timeZone, clockOffsetSec, registeredOn})` → `{punchedAt, localDate, clockFlag}` or `skip`; `nextClockOffset(samples, sample)`.
- `punchDirection(deviceDirection, state)` → IN | OUT: an IN or OUT device decides; on a BOTH device the status code does (0 clock in, 3 back from break, 4 overtime in, 9 meal end → IN; 1 clock out, 2 break, 5 overtime out, 8 meal start → OUT; anything else → IN).
- `verifyLabel(code)`: firmware uses two numberings (old: 0 password, 1 fingerprint, 2 card; newer: 1 fingerprint, 3 password, 4 card, 15 face). The raw code is stored; the label is "other" when unsure, until the real device tells us which numbering it uses.
- `handshakeOptions(...)` and `userUpsertCommand(pin, name)`: the name is reduced to printable ASCII without tabs or line breaks (a name must never be able to inject a second command), at most 24 characters.
- `defaultStudentDeviceId(code)`, `nextStaffDeviceId(start, used, reservedForStudents)`, `deviceIdCollisions(...)`, `deviceUserIdSchema`.
- `outsideHours(localTime, hours)` → the `OUTSIDE_HOURS` flag; `countsForAttendance(punch)` (not held, not rejected) and `sendsSms(punch)` (counts, real time, no `NEW_IP` or `OUTSIDE_HOURS` flag, not reviewed away).
- `arrivalStatus(firstIn, shiftStart, graceMin)` → PRESENT | LATE; `cutoffAt(shiftStart, cutoffMin)`.
- `closeDecision({cutoffPassed, devicesSeenRecently, enrolled, arrived})` → `CLOSE | WAIT | DEVICE_OFFLINE | TOO_MANY_MISSING`.
- `staffDay(punchTimes, officeHours, graces)` → `{inAt, outAt, lateMinutes, earlyMinutes}`; `staffMonth(...)` for the grid and totals (one function for API, CSV and tests, like `buildRegister`).
- `deviceState(lastSeenAt, now, isActive)` → ONLINE (seen in the last 2 minutes) | OFFLINE | NEVER_CONNECTED | INACTIVE.
- `entrySmsText`, `exitSmsText`: fixed Bangla, checked with `smsLength` (at most 2 segments).
- zod schemas for every new endpoint in `devices-api.ts` and `staff-attendance-api.ts`; Bangla digits accepted wherever numbers are typed (`toAsciiDigits`).

## Data model

**New tenant tables (6).** Composite FKs, `ON UPDATE RESTRICT`, forced RLS, leading tenant index.

Corrections to the table below from the additions:

- `attendance_devices` also gets `last_flood_at`, `last_flood_dropped` (written by the receiver).
- `device_people.device_user_id` is `^[1-9][0-9]{2,8}$`; its unique index `(tenant_id, device_user_id)` covers students and staff together.
- `device_punches`: `clock_flag` becomes `flags text[]` (CHECK: a subset of `CLOCK_CORRECTED`, `CLOCK_FUTURE`, `STALE`, `NEW_IP`, `OUTSIDE_HOURS`, `BURST`), plus `source_ip inet`, and the review columns `review` (`OK|ACCEPTED|REJECTED`, NULL = not reviewed), `reviewed_by_id`, `reviewed_at`. `outcome` gains `HELD`. `jantrik_app` gets UPDATE on the review columns too, and DELETE limited by a restrictive policy to punches older than 30 days (retention).
- `device_commands`: DELETE for `jantrik_app`, used only by the retention job (done, failed or cancelled rows older than 90 days).
- **6th table, `device_source_ips`:** device (composite), `ip inet`, first and last seen, punch count, `trusted_at`, `trusted_by_id` (NULL when trusted automatically as the first address); unique (tenant, device, ip); at most 50 untrusted rows per device (later new addresses still flag their punches). `jantrik_app`: SELECT + UPDATE on the trust columns. `jantrik_ingest`: SELECT, INSERT, UPDATE on the counters.

| #   | Table                   | Key points                                                                                                                                                                                                                                                                                                                                                               | `jantrik_app`                                                                                           | `jantrik_ingest` (through the functions only)                     |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | `attendance_devices`    | brand (enum, `ZKTECO`); `serial_no` uppercase, CHECK `^[A-Z0-9]{6,32}$`, partial unique `(serial_no) WHERE is_active` across institutes; name 1–60; gate ≤ 60; direction `IN\|OUT\|BOTH`; `is_active`; written by the receiver: `last_seen_at`, `last_punch_at`, `last_ip`, `firmware`, `user_count`, `attlog_stamp`, `clock_offset_sec`, `clock_samples int[]` (≤ 5)    | S I + UPDATE on name, gate, direction, is_active, serial_no (service: only while never seen), updated_* | SELECT; UPDATE on the receiver's columns                          |
| 2   | `device_people`         | `device_user_id` CHECK `^[1-9][0-9]{0,8}$`, unique per tenant; `student_id` (composite → students) **or** `staff_user_id` (composite → `staff_profiles (tenant_id, user_id)`, so the database itself checks the person is this institute's staff), CHECK exactly one; partial uniques per student and per staff member                                                   | S I U D (audited)                                                                                       | none                                                              |
| 3   | `device_commands`       | device (composite); `seq bigint` identity, unique (the id on the wire); kind `USER_UPSERT\|USER_DELETE`; `device_user_id`; `payload` ≤ 200 printable ASCII (CHECK, no line breaks); status `PENDING\|SENT\|DONE\|FAILED\|CANCELLED`; attempts ≤ 5; sent/done at; return code                                                                                             | S I + UPDATE on status (cancel)                                                                         | SELECT; UPDATE on status, attempts, sent_at, done_at, return_code |
| 4   | `device_punches`        | **immutable raw punches:** device (composite), `device_user_id`, `device_time timestamp`, `punched_at`, `local_date`, `received_at`, `verify_type`, `state`, `direction`, `clock_flag` (`CORRECTED\|FUTURE\|STALE`); unique `(tenant, device, device_user_id, device_time)` = the dedupe; `processed_at`, `outcome` (`APPLIED\|UNMAPPED\|IGNORED\|STALE`) set by the job | SELECT + UPDATE on `processed_at`, `outcome` only; **no INSERT, no DELETE**                             | INSERT only (`ON CONFLICT DO NOTHING`)                            |
| 5   | `staff_attendance_days` | staff (composite → staff_profiles); date; status `PRESENT\|ABSENT\|LEAVE`; `in_at`, `out_at` (CHECK out ≥ in); `office_start`, `office_end` (the copy it was judged by); `late_minutes`, `early_minutes` ≥ 0; `source`; `reason` (CHECK: required, 3–200 characters, when MANUAL); `updated_by_id`; `version`; unique (tenant, user, date)                               | S I U, no DELETE (history)                                                                              | none                                                              |

**Changes to existing tables**

- `attendance_settings` gains (DDL defaults, no backfill; `load()` falls back to the same values; all in the first migration, because the receiver reads some of them): `device_auto_mark` (false), `device_grace_minutes` (10, 0–120), `device_cutoff_minutes` (60, 15–300), `device_default_start` (08:00, for sections without a shift), `entry_sms_enabled`, `exit_sms_enabled` (false), `staff_office_start` (08:00), `staff_office_end` (16:00), `staff_late_grace_minutes`, `staff_early_grace_minutes` (10), `device_hours_start` (05:00), `device_hours_end` (20:00), `device_max_punches_per_minute` (60, 10–240), `staff_device_id_start` (9001), `punch_retention_days` (730, 30–3650). `jantrik_ingest` may read only the hours and the cap (column grants and its own policy).
- `attendance_sessions`: `source attendance_source` (`MANUAL|DEVICE`, default MANUAL); `taken_by_id` and `updated_by_id` become nullable, with CHECKs that only a DEVICE register may have them NULL.
- `attendance_records`: `source` (default MANUAL).
- `staff_profiles`: `attendance_tracked boolean NULL` (NULL = the default rule above).
- `sms_purpose` gains `ATTENDANCE_ENTRY` and `ATTENDANCE_EXIT`, in their own migration.
- `jantrik_ingest` gets SELECT-only policies and column grants on `tenants (id, status, timezone)` and `tenant_modules (tenant_id, module_key, enabled)`.

**New roles and functions**

- `jantrik_ingest`: NOLOGIN, NOBYPASSRLS; owns the functions; sees rows only through its own `TO jantrik_ingest` policies; `jantrik_owner` may SET ROLE to it without inheriting it.
- `jantrik_ingest_app`: LOGIN (`DATABASE_INGEST_URL`); no table grants, not a member of `jantrik_app`; EXECUTE on the four functions only.
- Functions (SECURITY DEFINER, `search_path = pg_catalog, public, pg_temp`, REVOKE/GRANT before `OWNER TO`). Each takes the serial number and resolves it again itself, so no caller can name a device or institute id:
  - `ingest_resolve(sn, ip, info)` → accepted or the refusal reason (unknown, inactive, institute not ACTIVE/TRIAL, ATTENDANCE off), plus device id, institute id, timezone, direction, stamp, clock offset, the institute hours; touches `last_seen_at`.
  - `ingest_store_punches(sn, ip, rows jsonb, stamp, clock_sample)` → inserted, duplicate, held and dropped counts. It records the source address (first one trusted), adds `NEW_IP` for an untrusted one, and applies the per-minute cap against what is already stored for that minute (`BURST` and `HELD` over N, dropped over 5 × N). `OUTSIDE_HOURS` and the clock flags arrive already computed by the shared rules.
  - `ingest_take_commands(sn, max)` → marks PENDING (and SENT older than 5 minutes, up to 5 attempts) as SENT and returns `seq, payload`.
  - `ingest_command_results(sn, results jsonb)` → updates only that device's commands.
- `schema-safety.test.ts` gets an ingest family next to the platform one: owned by `jantrik_ingest`, executable only by `jantrik_ingest_app` (checked by owner, so a copied `GRANT … TO jantrik_app` fails), no uuid or tenant parameters, pinned `search_path`.

**Migrations:** `20261029000000_devices` (enums, tables 1–4 and `device_source_ips`, the settings columns, the roles' policies and grants, the retention policy), `…000100_devices_ingest_functions`, `…010000_attendance_device_rules` (sources, nullable takers), `…010100_attendance_sms_purposes`, `…020000_staff_attendance`.

## Parts (commit-sized, in order)

### Phase 0: groundwork

- **0.1 Shared rules, test-first:** everything in "Core rules", with `devices.test.ts` and `staff-attendance.test.ts` (see Verification).
- **0.2 Roles and config:** `01-roles.sh` (`jantrik_ingest`, `jantrik_ingest_app`, `DB_INGEST_PASSWORD`), `.env.example`, CI env, `src/config/env.ts` (`DATABASE_INGEST_URL`, `INGEST_PORT` 4080, `INGEST_IN_PROCESS` (default on outside production), `INGEST_PUBLIC_HOST` / `INGEST_PUBLIC_PORT` (shown in the setup guide), the limits), test env for vitest and Playwright. The one-off role commands on the local volume.
- **0.3 `Clock` provider** (`now()`), used by the device and staff services and the receiver, so tests can move time; the real one everywhere else.

### Phase A: database

- **A1:** tables 1–4 and `device_source_ips`, enums, the settings columns, policies for `jantrik_ingest`, grants. `packages/db/test/devices-rls.test.ts`: tenant B cannot read, change or point at A's rows (each table, each composite FK, staff FK to another institute's staff); SN unique across institutes only while active; one device ID refused for a student and a staff member; the app cannot insert punches, change their raw columns, or delete one younger than 30 days; schema-safety list.
- **A2:** the four `ingest_*` functions. `ingest-functions.test.ts`: as `jantrik_ingest_app` no table is readable (students, punches, devices); unknown, inactive, suspended or module-off serials are refused; duplicates are counted, not stored; first address trusted, the next flagged; the per-minute cap holds and drops; device A's serial cannot acknowledge device B's command `seq`; `jantrik_app` cannot run them; schema-safety ingest checks.

### Phase B: the receiver and the simulator

- **B1 Ingest app** (`apps/api/src/ingest/`: `ingest.module.ts`, `ingest.controller.ts`, `ingest.service.ts`, `ingest-prisma.service.ts`, `ingest-main.ts`; `main.ts` starts it when `INGEST_IN_PROCESS`): text body parser for ATTLOG only, drain-and-drop for other tables, the limits, the handshake, ATTLOG, getrequest, devicecmd, ping. Enqueues `process-punches {tenantId}` (job id per tenant, 1 s delay, so a burst is one job).
- **B2 Refusal log:** one line per serial per 10 minutes (`SET NX EX 600`), the capped Redis list `ingest:refused`.
- **B3 Simulator package** `packages/device-sim` (`@jantrik/device-sim`): `ZkDeviceSimulator` (handshake, poll and apply commands to its own user table, report results, punch, upload a backlog, clock skew, and "send biometric payloads" with a sentinel) and a CLI, `pnpm device:sim`:
  - `pnpm device:sim handshake --sn DEMO00000001`
  - `pnpm device:sim punch --sn … --pin 20260001 [--at 07:45] [--out]`
  - `pnpm device:sim morning --sn … --pins 20260001-20260035 --from 07:30 --minutes 40`
  - `pnpm device:sim listen --sn …` (polls, prints and applies commands)
- **Tests** (`apps/api/test/devices-ingest.e2e-spec.ts`, the harness also boots the ingest app): unknown serial 403 and logged; invalid serial 400 without a DB call; 429 per IP and per device; 413 for a large ATTLOG; non-ATTLOG tables answered `OK` and nothing stored; the biometric sentinel test; the same batch twice gives one row each; institute A's serial writes only A's punches and B's API never sees them; a second source address (`X-Forwarded-For` with `TRUST_PROXY`) flags `NEW_IP`; outside-hours and per-minute cap flags; the handshake text; commands delivered once, retried, acknowledged; a skewed clock gets corrected after 3 samples and a future punch is flagged; `ingest-isolation.spec.ts` code scan.

### Phase C: devices and people (API + web)

- **C1 API** (`apps/api/src/devices/`, OWNER/ADMIN):
  - `GET/POST /attendance/devices`, `PATCH /attendance/devices/:id`, `POST /attendance/devices/:id/sync` (queues USER_UPSERT for every mapped active person, skipping identical pending ones), `GET /attendance/devices/:id/commands`.
  - `GET /attendance/devices/punches?after=&limit=50&flagged=` (feed with person, class/section or role, gate, direction, verify type, flags, review and the computed status), `POST /attendance/devices/punches/:id/review` (`OK | ACCEPT | REJECT`, audited; ACCEPT and REJECT queue the person-day recompute), `GET /attendance/devices/:id/ips` and `POST /attendance/devices/:id/ips/:ipId/trust` (marks that address's punches reviewed), `GET /attendance/devices/unknown-ids` (IDs that punched in the last 30 days but belong to nobody), `GET /attendance/devices/alerts` (offline devices, new addresses, floods, held punches; for the devices screen and the dashboard).
  - `GET /attendance/device-people?kind=&unmapped=&sectionId=`, `PUT /attendance/device-people` (set or clear one person's ID; a change queues USER_UPSERT after commit), `GET /attendance/device-people/collisions`, `POST /attendance/device-people/defaults` (dry run, then apply; returns assigned and conflicts; staff from `staff_device_id_start`, skipping student-code numbers), `GET /attendance/device-people/csv?locale=` (everyone with their ID or suggested default), `POST /attendance/device-people/import?apply=0|1` (CSV columns `student_code`, `staff_phone`, `device_id`; preview with per-row errors; apply re-checks and writes in one transaction, at most 5000 rows), `POST /attendance/device-people/remove-from-devices`.
  - Adding a device puts the institute in the Redis ZSET `devices:tenants` after commit.
  - Tests: `devices-api.e2e-spec.ts` (roles: teacher 403, guardian 403; module off 403; SN taken; defaults, the staff range and collisions; CSV preview and apply with clashes; sync queues commands; review and trust; audit rows); the new endpoints join `no-global-names` (names only from `students` and `staff_profiles`).
- **C2 Web** (v3 kit, `messages/devices/*.json` merged into a `devices` namespace like fees and exams; `AttendanceTabs` gains **ডিভাইস** and **কর্মীদের হাজিরা** for admins):
  - `/attendance/devices`: device list (state pill: অনলাইন / অফলাইন ২৫ মিনিট / এখনো যুক্ত হয়নি / বন্ধ; gate, direction, last seen, last punch, people on the device, pending commands, clock warning), add/edit dialog, deactivate, "send people to this device"; **setup guide in Bangla** per device (server address and port with copy buttons, the device menu path for the cloud server / ADMS setting, HTTPS off, timezone +6, automatic in/out state, "the serial number must match exactly", a "waiting for the device…" state that turns online by itself); **live feed** (polls every 5 s while the tab is visible; last 50 punches; unknown IDs called out with a link to the people screen; a "flagged" filter, flag chips and the review actions); an **alerts** strip (offline, new address with "trust", flood, held punches); each device's addresses.
  - `/attendance/devices/people`: Students / Staff tabs, "unmapped only" filter with a count, section filter, inline ID editing, "assign default IDs" (shows conflicts), the **Collisions** panel, CSV download and upload (preview, then apply), "send to devices", and the "no longer active, still on devices" list.
  - Dashboard (owner/admin): "Gate device offline for 25 minutes" alert while a device is offline more than 10 minutes on a working day, from an hour before the earliest start to office end; also new addresses, floods and held punches.

### Phase D: students from punches

- **D1 DB:** the settings columns, `source` on sessions and records, nullable takers with their CHECKs, the SMS purposes. Tests in `attendance-rls.test.ts`.
- **D2 Processing** (`DevicePunchProcessor` on queue `devices`, `DeviceAttendanceService`), inside `TenantJobRunner`, 500 punches per transaction, a per-institute advisory lock:
  - resolve the device ID through `device_people`; unknown → `UNMAPPED`; inactive or deleted person → `IGNORED`; older than 7 days → `STALE`;
  - students: entry SMS on the first IN of the day, exit SMS on the first OUT after it (rules above; none for a flagged punch); after the cutoff, a still-DEVICE ABSENT record becomes LATE (version bump, audit with `source: DEVICE`);
  - staff: recompute that day's row unless it is MANUAL;
  - held (`BURST`) and rejected punches never count; every punch gets `processed_at` and its `outcome`;
  - a review (accept or reject) recomputes that person's day the same way.
- **D3 Cutoff** (scheduler `devices-tick`, every minute): for each institute in `devices:tenants` (ATTENDANCE on, auto-mark on, DAILY mode, today a working day): process leftover punches, then for each current-year section past its cutoff without a register, apply `closeDecision`. `CLOSE` writes the register (source DEVICE, no taker, PRESENT/LATE/ABSENT, audited) and runs the absent SMS through the same code as a submit (`queueAbsentSms` moves to an `AbsentSmsService` both use). `POST /attendance/sections/:id/close-from-device` (admin, after a confirm) does the same for a held-back section.
- **D4 Register changes:** a submit marks changed records MANUAL and leaves the others' source; `sheet` returns each student's arrival time and late flag, and a register not yet taken starts from the device's view when auto-mark is on; the conflict dialog names "ডিভাইস" when the device changed it; the today report adds per section `arrived`, `late` and, after the cutoff, why it was not closed.
- **D5 Web:** take screen (arrival time chip "৭:৪৫" and a device tag on each student), Today (live "ডিভাইসে প্রবেশ ২৮/৩৫", the held-back reason and "close from device" for admins), register view (device tag per record, "ডিভাইস থেকে, সকাল ৯:৩০" in the header), student report (source column), settings page (cards: device attendance; device checks: institute hours, per-minute cap, retention; entry/exit SMS with the text preview and cost note; staff office hours and the staff ID range with its overlap warning).
- **Tests** (`devices-attendance.e2e-spec.ts`, with the clock moved): PRESENT/LATE at the grace boundary; per-shift cutoffs; ABSENT at the cutoff; absent SMS exactly once (closing twice, a late punch, a re-submit); a late punch after the cutoff cancels the pending absent SMS; MANUAL records never change; held back when devices are offline or more than half are missing, and "close from device" works after it; no marking on an off day, for PER_SESSION, or with auto-mark off; entry SMS once per direction per day, none for backlog punches, skipped at 90 % of the cap, cost logged when sent; isolation (institute B's job never touches A).
- **D6 Spoofing review** (`devices-review.e2e-spec.ts`): the addition 1 tests at the API level (flagged counts but sends no SMS; accept applies a held punch; reject recomputes register and staff day; absent SMS once; audit).
- **D7 Retention:** the `expire-punches` scheduler (00:40 Asia/Dhaka) and the settings field; `devices-retention.e2e-spec.ts` with the addition 3 tests.
- **Simulator end to end** (`devices-simulator.e2e-spec.ts`): the simulator package against the receiver in the harness: handshake → "send people" → the simulator applies the commands → a morning of punches (one skewed device, one backlog upload, one duplicate batch) → the job → the clock moved past the cutoff → the register, the arrival times and exactly the expected absent and entry SMS.

### Phase E: staff attendance

- **E1 DB:** `staff_attendance_days`, `staff_profiles.attendance_tracked`, office-hours settings. Isolation tests.
- **E2 API** (`apps/api/src/staff-attendance/`, OWNER/ADMIN): `GET /staff-attendance/day?date=`, `PUT /staff-attendance/:userId/:date` (status, in/out times, reason; `baseVersion`; audited as `staff_attendance_day`; MANUAL from then on), `PUT /staff-attendance/:userId/tracked`, `GET /staff-attendance/month?month=` (grid and totals: present, late, early, absent, leave days, late and early minutes), `GET /staff-attendance/month/csv?month=&locale=&kind=grid|days` (BOM, ASCII digits, CRLF, like the register CSV).
  - A day with no row is ABSENT once it is a past working day (or today after office end) on which the person was already staff; it is computed, not stored.
  - Tests (`staff-attendance.e2e-spec.ts`): late and early boundaries; no out punch; out less than 30 minutes after in; manual entry needs a reason, is audited and wins over later punches; owners untracked by default; month totals equal the CSV; teacher 403; isolation.
- **E3 Web:** `/attendance/staff` with a **day** view (each person's in, out, late/early chips, source tag, "enter manually" dialog with the reason) and a **month** view (people × days with codes উ / দে / আ / অ / ছু and totals; off days hatched; a side panel with that person's times; print on A4 landscape through `.print-area`; CSV in both shapes).

### Phase F: seed, docs, Playwright, closing

- **Seed** (`packages/db/src/seed/demo-devices.ts`): Shapla gets two devices (প্রধান ফটক, BOTH, `DEMO00000001`; শিক্ষকদের কক্ষ, BOTH, `DEMO00000002`), device IDs for every student and staff member, and staff punches for the working days of the month before the seed date (some late, an early leave, a manual leave with a reason), written the way a device would. Auto-mark stays **off** (so "today" can still be taken live); you switch it on to watch it with the simulator. Alo gets none (the empty states). `docs/demo-accounts.md` gets a Devices section with the simulator commands.
- **Docs:** new `docs/devices.md` (protocol, security model, setup, rules, simulator, "verify on the real device" list); `attendance.md` (device registers, source, cutoff, entry/exit SMS); `database.md` (tables, the ingest roles and functions, immutable punches, the one-off role commands); `auth.md` (the unauthenticated receiver and its limits); `decisions-pending.md` (#39 onwards, and the deployment items: the ingest port is plain HTTP, its own process, `DATABASE_INGEST_URL`, firewall); `backlog.md`; `CLAUDE.md` (a "Devices: docs/devices.md" line and `pnpm device:sim`); README env.
- **Report** `docs/reports/step-11-report.md`, this plan copied to `docs/plans/step-11.md`.

## Playwright (`apps/web/e2e/`)

The e2e API also starts the receiver (`INGEST_PORT=4280`); specs drive it with `@jantrik/device-sim`, sending punches dated `E2E_TODAY`.

- `devices.spec.ts`, bn, owner at **1366** then **390** (touch):
  - add a device; the Bangla setup guide shows the server and port; the simulator's handshake turns it online;
  - "assign default IDs" on the people screen, one ID edited by hand, a CSV upload with one bad row (preview shows the error, apply writes the rest);
  - "send people to this device": the simulator receives and acknowledges the commands, pending goes to 0;
  - simulator punches show up in the live feed with names within a few seconds; an unknown ID is called out;
  - a punch from a second address shows the নতুন IP chip and the alert; it is rejected, and the address is then trusted;
  - the Collisions panel shows a staff member whose default was taken, and an ID is set for them;
  - the simulator stops: the device turns offline in the list.
- `staff-attendance.spec.ts`, bn, admin at **1366** then **390**: the day view, a manual leave with a reason, the month grid with seeded late and early days, print (`emulateMedia('print')`, one A4 landscape page) and both CSVs (BOM, ASCII digits).
- The new pages join `layout.spec.ts` (no overflow at 360/390, 44 px targets), `themes.spec.ts` (dark) and `numerals.spec.ts`.

## Verification

1. **Per part:** drift check empty; `pnpm --filter @jantrik/shared test`, `pnpm --filter @jantrik/db test`, and the affected `pnpm --filter @jantrik/api test -- devices…`. The shared tests cover:
   - ATTLOG with CRLF, BOM, extra fields, a bad date, an over-long PIN, 10 001 lines;
   - Dhaka wall-clock to UTC and back, across midnight; skew from 3 samples, inconsistent samples ignored, a future punch clamped, pre-registration punches skipped;
   - a name with a tab or a newline cannot add a second command; non-ASCII names fall back;
   - `SHS-2026-0042` → `20260042`, `ALO-26-001` → `26001`, a code with no digits or more than 9 has no default, leading zeros dropped;
   - 08:10:00 vs 08:10:01 with grace 10; two shifts with different cutoffs; `closeDecision` for each outcome;
   - staff: late by 1 minute after grace, early leave, a single punch (no out), out 29 minutes after in.
2. **Final gates:** as in Workflow, including all of Playwright.
3. **Manual walkthrough** with `pnpm dev` (after your OK for a reseed): add a device, run `pnpm device:sim listen` and `morning`, watch the feed and the arrival times, switch auto-mark on with a near cutoff, see the register closed and the absent SMS in the console, override one student, enter a staff leave, print the staff month. Screenshots in bn at 1366 and 390 px.
4. **Performance:** `/attendance/devices` at 390 px, 4× CPU, slow 4G, reported as ranges; the dashboard (it gets the alert) interleaved A/B against main.
5. **Verify on the real device later** (in the report and `docs/devices.md`):
   - the `pushver` it sends (2.x expected; 3.x access firmware is not supported) and the menu path and fields for the server;
   - whether `TransFlag=TransData AttLog` really stops OPERLOG, BIODATA and photo uploads (we drop them either way);
   - what it does with `ATTLOGStamp=None` on first contact (it may send its whole history: we skip anything before the registration day);
   - `DATA UPDATE USERINFO` with only PIN and Name keeps the person's card and fingerprints; `DATA DELETE USERINFO` works (the old `DATA USER` form if not);
   - the status codes and which verify numbering it uses;
   - that its clock follows our `Date` header;
   - how many records it sends per upload, and whether it ever sends CRLF;
   - the PIN length it accepts and how much of the name it shows;
   - whether it offers HTTPS, and whether it sends a `pushcommkey` (the protocol says it binds device and server but does not document how it is made; worth supporting once we can see one).

## Risks

- **The protocol is checked only against published descriptions and the simulator.** Firmware differs between models. Everything firmware-dependent is isolated in the receiver and listed in the real-device checklist; the simulator is written from the same notes, so passing tests prove our side, not the device's.
- **Plain HTTP and serial-number-only identity** are limits of the protocol (see the security section). Devices that support HTTPS can use a TLS proxy in front of the ingest port.
- **Scope:** 6 new tables, 2 roles, 4 definer functions, 5 migrations, a second Nest app, a new package, about 28 endpoints and 3 new screens plus changes to 5. Committed part by part.
- **Dynamic addresses.** Many Bangladeshi connections change their public address often, so `NEW_IP` alerts may be frequent for some schools and entry SMS pause until the address is trusted. If that proves noisy, "trust a whole network range" is in the backlog.
- **Dropped flood punches are gone from our side** (the device still has them). Re-fetching a time range from the device (`DATA QUERY ATTLOG`) is in the backlog.
- **Load:** a school of 1500 students can send 1500 punches in 30 minutes; the receiver does two function calls per upload and the job batches 500 per transaction. Tested with a 2000-punch backlog upload.
- **The every-minute tick** opens one transaction per device institute. Fine at our size; noted for later.
- **The absent SMS refactor** touches working code (`queueAbsentSms`); the existing attendance and SMS tests must stay green unchanged.

## Deferred (to docs/backlog.md)

- A separate billable DEVICES module (if you choose that later).
- Marking coaching batches (PER_SESSION) from punches.
- A hard "accept this device only from IP x" lock, "trust a network range", re-fetching a time range from the device, and a platform screen of refused serial numbers.
- Editable entry/exit SMS texts; entry/exit notifications in the guardian app.
- Staff: per-person or per-shift office hours, half days, a leave register, staff seeing their own attendance.
- Other brands (the receiver is ZKTeco-only, behind a `brand` column).

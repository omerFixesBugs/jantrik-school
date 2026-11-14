# Attendance devices and staff attendance

ZKTeco fingerprint, card and face machines send their punches to Jantrik over the internet. A
student's punches give their arrival time, the day's register at the cutoff and optional entry
and exit SMS; a staff member's give their in and out times. Module `ATTENDANCE` (no separate
module). Built in step 11; the approved plan is [plans/step-11.md](plans/step-11.md), open
decisions are [decisions-pending.md](decisions-pending.md) #39 onwards, later work is in
[backlog.md](backlog.md).

No real device has been tested yet: everything was built against the simulator. See
"Verify on the real device" at the end.

## How it fits together

```
ZKTeco device ──HTTP (plain)──▶ device receiver :4080   (apps/api/src/ingest, login jantrik_ingest_app)
                                  │ serial number → device and institute, only inside the ingest_* functions
                                  │ ATTLOG lines parsed; every other upload drained and dropped
                                  ▼
                           device_punches (raw, immutable)  +  BullMQ job "process-punches" {tenantId}
                                                                      │
API devices worker ── TenantJobRunner.run(tenantId) ◀─────────────────┘
   ├─ each punch's outcome; students: entry/exit SMS, today's DEVICE register kept up to date
   ├─ staff: staff_attendance_days (in, out, late, early)
   ├─ every minute ("devices-tick"): leftover punches, then the cutoff → registers + absent SMS
   └─ 00:40 daily ("expire-punches"): punches and commands past retention
```

- The receiver is a separate Nest application: its own port, its own process in production, its
  own database login. It has no JWT, guards, CORS, cookies or tenant context, and never touches
  the API's `PrismaService` or `Db`.
- The institute in a job comes from the database's answer for the serial number, never from the
  request.
- Admins manage devices, device IDs, reviews and staff days through the normal API (OWNER/ADMIN,
  module ATTENDANCE).

## Where the code lives

- **The receiver** (protocol, limits, startup check):
  [`apps/api/src/ingest`](../apps/api/src/ingest), started by
  [`ingest-main.ts`](../apps/api/src/ingest-main.ts) in production or by the API's
  [`api.bootstrap.ts`](../apps/api/src/api.bootstrap.ts) in development. The API loads the
  receiver's code only when it runs it (`INGEST_IN_PROCESS`): importing it validates the
  receiver's environment, which a production API does not have.
- **Devices, the punch feed, reviews, alerts, device IDs, processing, the cutoff, retention:**
  [`apps/api/src/devices`](../apps/api/src/devices). Arrivals from punches (take screen, today
  report, cutoff):
  [`device-arrivals.service.ts`](../apps/api/src/attendance/device-arrivals.service.ts).
- **Staff attendance API:** [`apps/api/src/staff-attendance`](../apps/api/src/staff-attendance).
- **Pure rules, unit-tested:** [`devices.ts`](../packages/shared/src/devices.ts) (protocol, time,
  flags, IDs, arrival, cutoff, SMS text),
  [`device-people.ts`](../packages/shared/src/device-people.ts) (default IDs, CSV import),
  [`staff-attendance.ts`](../packages/shared/src/staff-attendance.ts) (staff day and month).
  Request and response shapes:
  [`devices-api.ts`](../packages/shared/src/devices-api.ts),
  [`staff-attendance-api.ts`](../packages/shared/src/staff-attendance-api.ts).
- **The simulator:** [`packages/device-sim`](../packages/device-sim).
- **Tables, roles, the ingest functions:** migrations `20261029000000_devices` to
  `20261029020000_staff_attendance` in
  [`packages/db/prisma/migrations`](../packages/db/prisma/migrations); described in
  [database.md](database.md) → Devices and Staff attendance.
- **Screens:** [`/attendance/devices`](<../apps/web/src/app/(app)/attendance/devices>) (devices,
  setup guide, live feed, alerts, addresses) and its `people` page (device IDs),
  [`/attendance/staff`](<../apps/web/src/app/(app)/attendance/staff>), device cards in the
  attendance settings, the today page, the take screen and a dashboard alert. Components:
  [`components/devices`](../apps/web/src/components/devices),
  [`components/staff-attendance`](../apps/web/src/components/staff-attendance).
- **Demo data:** [`demo-devices.ts`](../packages/db/src/seed/demo-devices.ts);
  [demo-accounts.md](demo-accounts.md) → Devices.

## The protocol

The receiver speaks ZKTeco's push protocol (ADMS / iclock), version 2.x, over plain HTTP. It was
written from ZKTeco's documents, ZKTeco's own iclock server and Java demo, and open-source servers
tested on hardware (sources below). The 3.x access-control firmware (`/iclock/registry`,
`/iclock/push`, `rtlog`) is not supported; the handshake records the `pushver` a device sends, so
we can see which one it speaks.

**Sources:**

- ZKTeco, "Attendance PUSH Communication Protocol", Doc V3.7 (2020-03-25, push 2.4.1):
  [archived copy](http://web.archive.org/web/20260211090505/https://www.scribd.com/document/604032067/Attendance-PUSH-Communication-Protocol-20200325).
- ZKTeco, "PUSH SDK Communication Protocol" Ver 2.0.1 (2011):
  [archived copy](http://web.archive.org/web/20260504083947/https://www.scribd.com/document/695654988/PUSH-SDK-Communication-Protocol-V2-0-1).
- ZKTeco's early Django iclock/ADMS server:
  [yongming/iclock-python](https://github.com/yongming/iclock-python) (`mysite/iclock/devview.py`,
  `models.py`).
- ZKTeco's PushSDK Java demo: [ftorino/attendance_java](https://github.com/ftorino/attendance_java)
  (`pushsdk/process/UploadProcess.java`, `DownloadProcess.java`, `PushCommServlet.java`).
- A transcription of the 2.x document:
  [docs.nufaza.com, archived](http://web.archive.org/web/20240913213844/https://docs.nufaza.com/docs/devices/zkteco_attendance/push_protocol/).
- Implementations tested on hardware: [s0x90/zkteco-adms](https://github.com/s0x90/zkteco-adms),
  [misaalanshori/admsjs `PROTOCOL.md`](https://github.com/misaalanshori/admsjs/blob/main/PROTOCOL.md).

| Request                                                                                                                        | Answer                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /iclock/cdata?SN=…&options=all&pushver=…` (handshake)                                                                     | `GET OPTION FROM: <SN>`, `ATTLOGStamp=<last stored, or None>`, `OPERLOGStamp=9999`, `ATTPHOTOStamp=9999`, `ErrorDelay=60`, `Delay=30`, `TransTimes=00:00;14:05`, `TransInterval=1`, `TransFlag=TransData AttLog`, `TimeZone=<the institute's offset>`, `Realtime=1`, `Encrypt=None`. Without `pushver`: the old names `Stamp`, `OpStamp`, `PhotoStamp` |
| `GET /iclock/cdata` without `options=all`                                                                                      | `OK`                                                                                                                                                                                                                                                                                                                                                   |
| `POST /iclock/cdata?SN=…&table=ATTLOG&Stamp=…`                                                                                 | Lines `PIN⇥time⇥state⇥verify⇥…` parsed and stored, then `OK: <non-blank lines received>` (duplicates and rejected lines included, so the device moves on). The `Stamp` is stored for the next handshake                                                                                                                                                |
| `POST /iclock/cdata` with any other `table` (OPERLOG, BIODATA, ATTPHOTO, IDCARD, ERRORLOG…) or `FPImage`; `POST /iclock/fdata` | Read off the socket without being parsed, stored, queued or logged, then `200 OK`: any other status makes a device send it again forever                                                                                                                                                                                                               |
| `GET /iclock/getrequest?SN=…&INFO=…` (every 30 s)                                                                              | Up to 20 waiting commands, one per line, `C:<seq>:DATA UPDATE USERINFO PIN=<id>⇥Name=<name>` or `C:<seq>:DATA DELETE USERINFO PIN=<id>`, or `OK`. Only to an address the device trusts. From `INFO` only the firmware and the user count are kept                                                                                                      |
| `POST /iclock/devicecmd?SN=…`                                                                                                  | Lines `ID=<seq>&Return=<code>&CMD=…`: 0 is done, anything else failed with its code (e.g. −1002 "not supported"); then `OK`. Only from an address the device trusts; from any other address the body is drained unread                                                                                                                                 |
| `GET /iclock/ping`                                                                                                             | `OK`                                                                                                                                                                                                                                                                                                                                                   |
| Any other path, and any method but GET and POST                                                                                | `404 Not Found` (a HEAD on getrequest would otherwise mark commands sent that never left)                                                                                                                                                                                                                                                              |

- **Every answer** is `text/plain; charset=utf-8` with a `Content-Length` (no chunking),
  `Cache-Control: no-store` and the `Date` header in GMT, which the protocol requires (devices set
  their clock from it). No ETag, no `X-Powered-By`.
- **Refusals:** `400 ERROR` for a serial number that is not `^[A-Za-z0-9]{6,32}$`, `403 ERROR`
  for a refused serial, `429 ERROR` with `Retry-After` over a limit, `413 ERROR` for an ATTLOG
  upload too large, `500 ERROR` for anything else. An answer given before the request's body has
  fully arrived closes the connection, so nobody can make the server read a huge body.
- **The handshake's stamp** is sent only when it is a positive whole number; otherwise `None`.
  Never `0`, which asks the device for its whole history again. `TimeZone` is in hours (minutes
  for a zone that is not on the hour).
- **The handshake asks for attendance only** (`TransFlag=TransData AttLog`): no users,
  fingerprints, faces or photos. Devices that send them anyway are drained, as the table says.
- **Commands** carry only `PIN` and `Name`, never card, password or privilege fields, so a push
  can never wipe a card or demote a device admin. The name is the person's English name in
  printable ASCII, at most 24 characters (devices cannot draw Bangla), else the student code, else
  the ID; a tab or line break can never reach a device, so a name cannot add a field or a second
  command (`deviceDisplayName`, and a CHECK on `device_commands.payload`).
- **A command's life:** PENDING → SENT (by getrequest; sent again if unanswered for 5 minutes, at
  most 5 times, then FAILED) → DONE or FAILED by the device's answer. Only that device's own
  commands can be answered.

## Security model

### What a serial number proves

The protocol identifies a device only by its serial number, sent in clear over plain HTTP. Anyone
who learns a registered serial number can post punches as that device. So:

- every punch is checked as it arrives and may be flagged (below); a flagged punch never sends an
  SMS;
- only device IDs mapped to a person count; at most one entry and one exit SMS per student per
  day, only for real-time punches, inside 90 % of the daily SMS cap;
- no register is closed by the device while more than half of a section's active students are
  missing;
- commands, which carry names, go only to an address the device trusts.

Nothing secret travels on the link: no tokens, and no names except the ones on the device's own
screen. Devices that support HTTPS can use a TLS proxy in front of the receiver's port
([decisions-pending.md](decisions-pending.md) → Deployment requirements).

### The receiver, its process and its database login

- **Own process.** `node apps/api/dist/ingest-main.js` in production; inside the API process in
  development (`INGEST_IN_PROCESS`, on by default outside production). Port `INGEST_PORT` (4080).
  No JSON body parser: the controller reads each body itself, within the limits below.
- **Own variables.** The receiver validates only its own environment
  ([`ingest-env.ts`](../apps/api/src/config/ingest-env.ts)): `NODE_ENV`, `DATABASE_INGEST_URL`
  (required), `REDIS_URL`, `QUEUE_PREFIX`, `INGEST_PORT`, `INGEST_TRUST_PROXY` and the limits.
  In production give it only these: never the API's logins or secrets (`DATABASE_URL`,
  `DATABASE_PLATFORM_URL`, `JWT_ACCESS_SECRET`, `OTP_PEPPER`, `PLATFORM_TOTP_KEY`), so code run
  in the receiver finds no login that can choose an institute and no key that signs sessions
  ([decisions-pending.md](decisions-pending.md) → Deployment requirements). The setup guide's
  `INGEST_PUBLIC_HOST` and `INGEST_PUBLIC_PORT` belong to the API, which refuses to start in
  production without the host (or with localhost or 0.0.0.0).
- **Own login.** `DATABASE_INGEST_URL` logs in as `jantrik_ingest_app`, which can read no table
  and run only four `SECURITY DEFINER` functions owned by `jantrik_ingest`: `ingest_resolve`,
  `ingest_store_punches`, `ingest_take_commands` and `ingest_command_results`. None takes a
  tenant or device id: each takes the serial number, finds and locks the device itself, and
  scopes every query by that device. Details: [database.md](database.md) → Devices.
- **Startup check.** The receiver refuses to start unless its login can run `ingest_resolve` and
  cannot read `students` or `device_punches` (so `DATABASE_URL` pasted by mistake fails): a check
  that answers otherwise stops the start at once. A check that fails (the database not reachable
  yet, or not migrated yet, e.g. 42501: the e2e run starts the API before its global setup
  migrates the e2e database) is asked again after 1, 2, 4 and 8 s, then every 15 s, about 3
  minutes in all, with one log line each naming the error's codes; still failing, the start
  fails. Each check has 10 s to answer: a database that accepts the connection and never answers
  counts as a failed check (`StartupCheckTimeout`), so the start fails within about 6 minutes
  instead of hanging. The receiver's pool also gives up opening a connection after 10 s and uses
  TCP keep-alive; queries themselves have no time limit yet (decision #79). Inside the API (development, e2e) the API is already listening meanwhile and
  the receiver comes up once the check passes; a receiver that finally refuses stops the API too.
- **Code scan.** [`ingest-isolation.spec.ts`](../apps/api/src/ingest/ingest-isolation.spec.ts)
  fails if receiver code imports the API's database access, or if anything outside the receiver
  provides its login; the receiver's e2e test checks that the running receiver has none of the
  API's database access.
- **Logs** carry the serial number (once validated), the address, a refusal's reason and error
  names and codes. Never a body, a query string, headers or an error's message (a CHECK's
  message repeats the row).

### Biometric data never lands anywhere

The owner's rule: fingerprint templates, face data, photos and user info (passwords, cards) from a
device are never stored, queued or logged.

- Only `table=ATTLOG` is parsed, and only four fields of each line are kept: the device user id,
  the time, the in/out state and the verify type. Work codes, temperature, mask and any other
  field are dropped.
- Every other upload is read off the socket and thrown away unseen (and the handshake asks the
  device not to send them).
- The test "biometric data never lands anywhere" in
  [`devices-ingest.e2e-spec.ts`](../apps/api/test/devices-ingest.e2e-spec.ts) sends fingerprint,
  face, photo and user-info payloads (and extra ATTLOG fields) carrying a sentinel string, then
  searches every text, json and bytea column of the database (as the owner role, with and
  without the institute's context), every Redis key (BullMQ jobs included) and everything logged
  (Nest logger and `console`, Buffers included), in plain, base64 and hex. Planted leaks prove the
  search works.

### Limits

Every request passes the first five checks in this order, and the first that fails answers; the
body limits follow. Counts are per minute unless shown, kept in Redis, and configurable.

| Check                                                                                              | Default                            | Variable                          |
| -------------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------- |
| Requests from one address                                                                          | 1200                               | `INGEST_PER_IP_PER_MIN`           |
| An address that sent refused serials: 429 with no database call                                    | 30 refusals per 10 min             | `INGEST_REFUSED_PER_IP_PER_10MIN` |
| The serial number's form (400, no database call)                                                   | `^[A-Za-z0-9]{6,32}$`, upper-cased |                                   |
| One serial number from one address                                                                 | 300                                | `INGEST_PER_DEVICE_PER_MIN`       |
| One serial number from all the addresses it does not trust, together (checked before the database) | 1200                               | `INGEST_PER_DEVICE_ALL_PER_MIN`   |
| ATTLOG body (413)                                                                                  | 512 KB and 10 000 lines            | `INGEST_MAX_ATTLOG_BYTES`         |
| Other uploads drained, then the connection is closed                                               | 2 MB                               | `INGEST_MAX_DRAIN_BYTES`          |
| A devicecmd body (413)                                                                             | 64 KB                              |                                   |
| A devicecmd body from an address the device does not trust: drained, then the connection is closed | 64 KB                              |                                   |
| Server: headers / whole request / idle connection / connections at once                            | 10 s / 30 s / 5 s / 1000           |                                   |

- **"An address"** is an IPv4 address, or an IPv6 address's /64 (one home or host usually holds
  a whole /64, so single addresses would be trivial to rotate). The full address still goes to
  the database and the logs. IPv4-mapped IPv6 (`::ffff:a.b.c.d`) counts as plain IPv4.
- **The per-address share** means requests from elsewhere can never use up the real device's
  share.
- **The untrusted budget** stops an attacker from multiplying shares by rotating addresses. It is
  charged only for addresses the device does not trust, after `ingest_resolve` answers, so
  outsiders can never starve a trusted device. Once it is spent, an address is refused before
  any database call unless Redis remembers it as trusted (`ingest:trusted:<SN>:<address>`, set
  when the database said so, renewed on each request, 7 days). So a flood records no addresses
  and touches no device. The one case this refuses a trusted device: it has not called for 7 days
  and comes back while others keep the budget spent; it gets through in the first minute they
  pause. Whether an address is trusted is always the database's answer; the Redis mark only
  skips the early check. Revoking an address does not clear its mark, so for up to 7 days after
  its last trusted request a revoked address (an IPv6 one: its whole /64) still skips the early
  check; after `ingest_resolve` it is charged to the budget like any untrusted one, refused once
  the untrusted budget is spent, and it gets no commands.
- **Behind a proxy**, `INGEST_TRUST_PROXY` decides which address is the client's (Express
  `trust proxy`). Use a hop count (`1`) or the proxy's address, never `true`, unless the proxy
  overwrites `X-Forwarded-For`: with `true` any client can claim any address, including a
  school's trusted one. The default `false` is right when devices connect directly.

### Source addresses and trust

Every request records the address it came from against the device (`device_source_ips`).

- **The first address** a device ever calls from is trusted automatically only if that first
  contact comes within **24 hours of the device's registration** and the device has no trusted
  address yet. Otherwise it is recorded untrusted, like every later new address, and an admin
  trusts it: from the setup guide ("Is this your institute's internet connection? Yes, trust
  it"), the alert or the device's address list. This narrows the race where someone who knows a
  serial number connects before the real device.
- **Trusting** an address (`POST /attendance/devices/:id/ips/:ipId/trust`, audited) lets commands
  go to it and marks its unreviewed `NEW_IP` punches OK. **Revoking** (`…/revoke`, audited) stops
  commands and flags its new punches `NEW_IP` again; past punches keep their review. (The Redis
  trusted mark is not cleared: it only skips the early budget check, see Limits; trust and
  command delivery are decided by the database on every request.) The list
  shows each address with first and last seen, punch count, and who trusted it (or
  "automatically").
- **Commands and their results go only through a trusted address**, enforced in the database:
  `ingest_take_commands` returns nothing and `ingest_command_results` changes nothing for any
  other address. Knowing a serial number is not enough to read a device's names or to fake its
  answers. After an ISP changes a school's address, commands and entry SMS wait until an admin
  trusts the new one; the alert says so.
- **Untrusted addresses are capped at 50 per device.** A new one evicts the least recently seen
  untrusted one, so nobody can fill the list and stop the school's real new address from being
  recorded. Trusted addresses are never deleted.
- **Known limit:** the real device re-records its address on every poll (every 30 s), so only a
  sustained flood of 50 or more new addresses per poll interval keeps it out of the list. While
  that lasts, the admin cannot trust the school's new address, and sees the NEW_IP alerts. The
  escape: switch the device off and register its serial number again (a new device row starts
  with no addresses and a fresh 24-hour window). The new row trusts its first caller
  automatically, and while the flood lasts that could be the attacker: check the address list
  afterwards and revoke anything that isn't the institute's. Protecting some rows from eviction
  was rejected: an attacker could pin 50 rows and recreate the "can never be recorded" problem.

### Punch flags and review

`device_punches.flags` (CHECK: a subset of these):

| Flag              | When                                                                                          | Effect                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `NEW_IP`          | uploaded from an address the device does not trust (the address is kept in `source_ip`)       | counts, no SMS, alert                                                                  |
| `OUTSIDE_HOURS`   | punch time outside the institute's device hours (setting, default 05:00–20:00, end inclusive) | counts, no SMS                                                                         |
| `BURST`           | more than N punches of this device stamped in the same minute (setting, default 60, 10–240)   | **held**: does not count until an admin accepts it; no SMS even then                   |
| (dropped)         | beyond 5 × N in that minute                                                                   | not stored; counted on the device (`last_flood_at`, `last_flood_dropped`), FLOOD alert |
| `CLOCK_CORRECTED` | the device's measured clock error was subtracted                                              | none                                                                                   |
| `CLOCK_FUTURE`    | more than 5 minutes ahead of when it arrived, even after correction                           | time set to arrival, no SMS                                                            |
| `STALE`           | its day is more than 7 days before the day it arrived                                         | shown only, never applied                                                              |

- A punch already stored (same device, ID and device time) is a duplicate: counted, not stored
  again, and not counted against the per-minute cap twice.
- **Review** in the live feed (`POST /attendance/devices/punches/:id/review`, audited as
  `device_punch`): **OK** ("looks right", clears it from review), **ACCEPT** (only a `BURST`
  punch: it counts from now), **REJECT** (it stops counting). Any punch may be reviewed again;
  the last decision wins.
- A review that changes whether a punch counts rebuilds that person's day at once: a staff day
  unless it is MANUAL (no punch left: a DEVICE day becomes ABSENT); with auto-mark on, a
  student's DEVICE record on today's DEVICE register (left ABSENT: the absent SMS through the
  usual pipeline, once by its dedupe key). A review never sends an entry or exit SMS. Before the
  cutoff nothing is stored yet: the arrivals are computed from the punches that count, so the
  review shows at once.
- The "flagged" filter and the NEW_IP and HELD alerts look back **7 days**.

### Alerts

On the devices screen and the owner's and admin's dashboard, for active devices
(`GET /attendance/devices/alerts`):

- **OFFLINE:** not seen (or never connected) for more than 10 minutes, on a working day, from an
  hour before the earliest start (any active shift's, or "school starts at") until the staff
  office end.
- **NEW_IP:** an untrusted address that sent punches in the last 7 days, with "trust".
- **FLOOD:** punches dropped in the last 24 hours.
- **HELD:** unreviewed `BURST` punches of the last 7 days.
- **CLOCK:** the device's clock is 2 minutes or more off.

### Serial numbers

- A serial number can be **active in one institute only** (a partial unique index across
  institutes). Adding one that is taken anywhere answers 409 `SERIAL_TAKEN` "This serial number
  can't be added; contact Jantrik", never saying where.
- A device is switched off, never deleted (its punches stay). The serial number of a device that
  has ever connected cannot be changed (409 `SERIAL_LOCKED`): add the new hardware as another
  device.
- **Squatting:** someone could register another school's serial number first. The real school
  then sees "contact Jantrik", and support resolves it (no platform screen yet: the latest 500
  refusals are in the Redis list `ingest:refused`). Jantrik never removes people from a device on
  its own; a squatter could only do so on purpose, and only once the device's address is trusted
  on their record.
- **Unknown or refused serials** (no such device, switched off, institute not ACTIVE or TRIAL,
  ATTENDANCE off) get 403 and nothing is written to the database. Each is logged once per serial
  number per 10 minutes and pushed to `ingest:refused`; an address with 30 refusals in 10 minutes
  gets 429 without any database call.

## Time

- **Devices send local wall-clock time without a zone.** It is read in the institute's timezone
  (`tenants.timezone`). The handshake's `TimeZone` and the `Date` header let a connected device
  keep its own clock right.
- Each punch keeps `device_time` (as sent, the dedupe key), `received_at` (our clock),
  `punched_at` (the time every rule uses) and `local_date`.
- **Clock error.** While a device is online (it called within the last 2 minutes) it uploads in
  real time, so each upload's newest punch gives a sample: device time minus our clock (samples
  over 6 hours are ignored). When the last 3 samples agree within 90 s, their median becomes the
  device's offset. An offset of 2 minutes or more is subtracted from every later punch
  (`CLOCK_CORRECTED`) and shown on the devices screen ("clock 7 minutes fast").
- **Future punches:** more than 5 minutes after their arrival (after correction) they get
  `punched_at = received_at` and `CLOCK_FUTURE`.
- **Old punches:** a punch dated before the day the device was registered is not stored at all
  (a device's first upload may be its whole history). One dated more than 7 days before it
  arrived is stored with `STALE`: shown, never applied.

## Device IDs

- **One ID per person** (`device_people`), the same on every device of the institute: digits
  only, 3 to 9 digits, no leading zero (`^[1-9][0-9]{2,8}$`; devices drop leading zeros, and IDs
  under 100 are left to the device's own admin users).
- **Unique across students and staff in the database:** one unique index on
  `(tenant_id, device_user_id)` covers both, whatever the screen or a CSV does.
- **Defaults** ("assign default IDs", a dry run first): a student gets the digits of their code
  (`SHS-2026-0042` → `20260042`, `ALO-26-001` → `26001`); none when the code has no usable
  digits or more than 9. Staff get the next free number from the staff range start (setting
  `staff_device_id_start`, default 9001), in the order they were added, skipping every number in
  use and every number a current student's code would give, mapped or not. The settings form shows
  how many student codes fall within the next 1000 numbers of a start.
- **Collisions** are reported, never resolved silently: a default someone else holds, two
  unmapped students whose codes give the same number, CSV rows that clash with each other or the
  database. Each gets "set an ID".
- **Who can hold an ID:** a student who exists (inactive too, so IDs can be prepared ahead) or a
  staff member with an active staff role and a profile. Lists, defaults and the CSV export cover
  this year's active students and active staff.
- **Who goes on the devices:** students ACTIVE and not deleted, staff with an active staff role.
  A new ID is sent (USER_UPSERT) to every active device after the change. **Send to devices** /
  **Send people to this device** queue everyone, skipping an identical command still waiting.
- **People are never removed from a device automatically:** that would delete their enrolled
  fingerprints. Clearing an ID sends nothing. People who are no longer active, or whose ID was
  changed or cleared, are listed under "IDs still on the devices"
  (`GET /attendance/device-people/stale`) with an explicit **Remove from devices** (USER_DELETE on
  every active device; refused with `PERSON_ACTIVE` for an active person). It also takes IDs
  nobody holds, e.g. one enrolled on the device outside Jantrik.
- **An ID still on a device stays reserved** (`ID_STILL_ON_DEVICE`). When an ID's last confirmed
  command on an active device was an add for someone else, giving it to another person is refused
  (409 on PUT, an error row in the CSV, a conflict in the defaults) until every such device
  confirms removing it. Otherwise the old person's finger would punch as the new holder. Giving
  the ID back to that same person is fine (no re-enrolment needed).
- **Known limit: a device switched off, then on again.** The "still on a device" rule reads
  active devices only. If a device is switched off while an ID it holds is given to someone else
  (the other devices confirm removing it), then switched on again, it still has the old person's
  fingerprints under that ID, and their finger punches as the new holder (sending people only
  changes the name). Before switching a device back on, check whether an ID was given to someone
  else meanwhile; if so, delete that user on the device itself and enrol the new holder again. The
  fix, counting inactive devices too, is in [backlog.md](backlog.md).
- **Changing someone's ID** asks for re-enrolment: their fingerprints stay on the device under
  the old ID. Punches are matched to people by their ID now, so punches made under an old ID no
  longer count for anyone.
- **The sync state** per person: on the devices once every active device confirmed the add,
  sending while one is waiting, not sent when one failed or never got it.
- **CSV:** export everyone with their ID or suggested default (`student_code`, `staff_phone`,
  `device_id`, then name, class, section, role and status; UTF-8 with a BOM, ASCII digits).
  Import finds `student_code`, `staff_phone` and `device_id` by their header names, in any order
  and case, and ignores other columns; it needs `device_id` and at least one of the other two
  (422 `MISSING_COLUMNS`). A preview with an error per row, then apply, which checks again under
  the institute's device-people lock and writes only the OK rows (swaps in one file work). At most
  5000 rows and 1 MB.

## Students: registers from punches

DAILY mode only, when **auto-mark** is on (setting, off by default). Coaching centres
(PER_SESSION) get punches, the live feed, arrival times, entry and exit SMS and staff attendance,
but no automatic registers.

**Only ACTIVE students count** wherever the device decides or reports: only they are sent to the
devices. A section's arrivals, its "enrolled" count, the missing half and `NOT_ON_DEVICE` are all
about its active students. An inactive student still enrolled gets no arrival (processing ignores
their punches); the register still lists them, ABSENT, and the device sends them no absent SMS. A
section with no active student gets no device view and no register from the device: take it by
hand.

- **Arrival** is an active student's first IN punch of the day that counts (not rejected, not a
  held `BURST`, not `STALE`). **LATE** when it is strictly after the shift's start + grace
  (setting, default 10 minutes): with a 08:00 start, 08:10:00 is PRESENT and 08:10:01 LATE. A
  section without a shift uses "school starts at" (setting, default 08:00).
- **In and out on a BOTH device** come from the state code the device sends (0, 3, 4, 9 → IN;
  1, 2, 5, 8 → OUT; anything else IN); the setup guide tells the admin to switch on the device's
  automatic state by time. An IN or OUT device decides by itself.
- **Before the cutoff** nothing is written. On working days with auto-mark on, the today page
  shows "punched in 28/35" per section (active students) with the late count and the cutoff. The
  take screen shows each active student's arrival time (late marked) in any mode, and with
  auto-mark on a register not taken yet starts from the device's view (arrived: PRESENT or LATE,
  the other active students ABSENT; a student not active gets no suggestion and starts as in a
  register taken by hand, PRESENT).
- **The cutoff** is per shift: its start + cutoff minutes (setting, default 60, 15–300). Every
  minute `devices-tick` looks at the current-year sections with no register today whose cutoff
  has passed, each in its own transaction, and writes the register (`closeDecision`) unless it
  holds it back:

  | State              | Why                                                                                                              |
  | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
  | `DEVICE_OFFLINE`   | no active device called in the last 15 minutes                                                                   |
  | `NOT_ON_DEVICE`    | an active student of the section cannot punch: no ID, or no add for their ID confirmed on any active device      |
  | `TOO_MANY_MISSING` | more than half of the section's active students have no arrival                                                  |
  | `AUTO_CLOSE_ENDED` | an hour or more has passed since the cutoff: from then on it waits for a person (no surprise absent SMS at noon) |

  While held back, the today page says why (with the count for `NOT_ON_DEVICE`); it rechecks
  every minute until an hour after the cutoff. Before the cutoff it shows `BEFORE_CUTOFF`, and
  `CLOSED` once the day has a register (the device's or a person's).

- **The register written** has `source = DEVICE` and no taker: every student on the roster,
  arrived PRESENT or LATE, the others (inactive ones included) ABSENT, each record DEVICE; audited
  as `attendance_session`. Then the absent SMS for the ABSENT students who are ACTIVE, through the
  same service as a submit (absent SMS setting, dedupe, cap, correction delay, relevance check).
  That service sends absent SMS only to ACTIVE students (not deleted) on every path, so a
  teacher's submit marking an inactive student absent sends their guardian nothing either.
- **Close from device:** an owner or admin can write a held-back section's register from the
  today page after a confirm that shows the counts, the students not on a device and the SMS rule
  (`POST /attendance/sections/:id/close-from-device`). The safety checks and the hour do not
  apply; the cutoff does (409 `BEFORE_CUTOFF`). DAILY mode is required, auto-mark is not. 409
  `REGISTER_EXISTS`, 422 `NON_WORKING_DAY`, `NO_STUDENTS`, `WRONG_PERIOD_FOR_MODE`. Same register
  as the cutoff's; the admin is the audit's actor; still no taker.
- **A teacher's register wins.** A register a teacher submitted before the cutoff is left as it
  is; if a submit and the cutoff race, the first one stands and the other gets nothing (the
  cutoff) or a conflict naming the device (the teacher). The take screen settles that conflict
  silently when the two agree on every student.
- **Manual wins.** A teacher's change to a record makes it MANUAL; the device never changes a
  MANUAL record. Records the teacher did not touch stay DEVICE; the register stays DEVICE and
  gets the teacher as its updater.
- **Late punches after the cutoff** (today only, with auto-mark on): a student still ABSENT on a
  DEVICE record who punches in becomes LATE (or PRESENT, when a delayed upload shows they came on
  time): version bump, audited with `source: DEVICE`. The register keeps its updater, so a
  teacher who edited it stays named on the today page ("edited by"), and it carries the device's
  submission id (`DEVICE_SUBMISSION_ID`), so the take screen names the device as its last change
  and a draft older than it gets a conflict that names the device. A pending absent SMS is then
  cancelled by the relevance check; one already sent cannot be taken back (the entry SMS follows
  it). With auto-mark off, punches and reviews never change a register, not even one an admin
  wrote with "close from device".
- **No marking** on weekly off days and holidays, in PER_SESSION mode or with auto-mark off.

### Entry and exit SMS

Two settings, off by default (they cost the institute money), in any mode:

- **Entry** for a student's first IN of the day that counts, **exit** for the first OUT that
  counts after it. A flagged punch that counts still takes the place, so a later one sends
  nothing either.
- **Only for real-time, unflagged punches** (`sendsSms`): received within 10 minutes of the punch
  (a device that uploads yesterday's backlog sends nothing), and no `NEW_IP`, `OUTSIDE_HOURS`,
  `STALE`, `CLOCK_FUTURE` or `BURST` flag (an accepted burst punch counts but sends none).
- Only on working days, only for active students, to the primary guardian; at most one per
  student per day and direction (dedupe keys `entry:<student>:<date>`, `exit:<student>:<date>`).
- **Never over 90 % of the daily SMS cap.** Past it they are skipped (no `sms_logs` row), never
  held, so the last 10 % stays for absent alerts and fee receipts.
- Fixed Bangla text, e.g. "তাসনিম প্রবেশ করেছে সকাল ৭:৪৫ — শাপলা উচ্চ বিদ্যালয়" / "… বের হয়েছে
  …", at most 2 SMS: when longer, the institute's name is dropped first, then the student's name
  is shortened. Sent at once; once queued they stay wanted (the punch happened).

## Processing punches

- After storing new punches the receiver queues `process-punches {tenantId}` (job id
  `punches-<tenant>`, 1 s delay, so a burst of uploads is one job). The API's devices worker
  lists the institute (below), then, while ATTENDANCE is on, processes its unprocessed punches,
  100 per transaction (the slowest kind takes about 45 ms each; the job transaction's limit is
  15 s).
- While such a job waits, runs or is kept as failed, no new one can be queued for the institute,
  so `devices-tick` also processes every listed institute's leftovers each minute (institutes in
  the Redis set `devices:tenants`, with ATTENDANCE on). One institute failing stops none of the
  rest; it is logged by the error name only.
- **How an institute gets listed.** The tick and retention visit only the institutes in
  `devices:tenants`; no query crosses institutes to find them. An institute is listed again,
  after commit, on every path that needs it visited: a device added, changed (switched off or on
  too) or sent people ("Send people to this device"), the attendance settings saved with auto-mark
  on, and each `process-punches` job (its punches are already stored). Nothing removes it. A
  fresh seed (`pnpm db:seed` gives the demo institutes new ids and adds their devices as rows) or
  a Redis that lost the set relies on these paths: until one of them runs, the institute gets no
  cutoff, no leftover sweep and no retention. The demo walkthrough lists Shapla on its first step
  ([demo-accounts.md](demo-accounts.md) → Devices).
- **Each punch's outcome**, in this order: `STALE`; `IGNORED` (rejected); `HELD` (`BURST` not
  accepted); `UNMAPPED` (nobody has the ID); `IGNORED` (a student deleted, not ACTIVE or not
  enrolled this year; staff without an active staff role or whose attendance is not kept);
  otherwise `APPLIED`.
- **Applied:** with auto-mark on (DAILY), a student's DEVICE record on today's DEVICE register is
  rebuilt (registers themselves are written only at the cutoff); a staff day up to 7 days back is
  rebuilt; entry and exit SMS.
- **Locks.** Processing, reviews, the cutoff, close from device and manual staff days take the
  institute's advisory punch lock first (`device-punches:<tenant>`), then punch rows, then
  registers and staff days, then the SMS lock. Trusting an address locks the device row before
  the punch lock; nothing takes a device row after it. Inside, every lock wait is limited to 5
  seconds: a request that runs out (review, trust, manual staff day, close from device) answers
  **409 `BUSY` with `Retry-After: 2`** and changes nothing, and the web says "the system is busy
  right now, try again"; a job is retried by the next tick. Only such a lock wait (Postgres
  55P03) is `BUSY`: a transaction past its own time limit stays a logged 500.

## Staff attendance

OWNER/ADMIN, under Attendance → Staff (`/attendance/staff`).

- **Who is tracked:** everyone with an active staff role, except people whose only role is OWNER.
  Each person has a switch (`PUT /staff-attendance/:userId/tracked`, `true`, `false` or `null` for
  the default; audited). Untracked people show nothing (`NONE`). Switching someone on does not
  re-apply punches already ignored.
- **A day from punches** (`staffDay`): direction is ignored; the first punch that counts is the
  in, the last is the out if it is at least 30 minutes after the in. **Late** when the in is
  strictly after office start + late grace, counted in minutes from office start; **early leave**
  when the out is strictly before office end − early grace, counted to office end. Office hours
  are settings (default 08:00–16:00, 10 minutes' grace each way). Punches up to 7 days old rebuild
  their day.
- **Each day keeps the office hours it was judged by** (`office_start`, `office_end`), so
  changing the hours later never rewrites a past month. A day rebuilt by a new punch or a review
  is judged by the hours at that time.
- **Days without a row** are computed, never stored: ABSENT on a past working day (and today
  after office end) for a tracked person who was already staff (since their profile was made);
  not yet today before office end; OFF on a non-working day; NONE before they were staff.
- **Manual entries** (`PUT /staff-attendance/:userId/:date`): PRESENT (in time required, out
  optional), ABSENT or LEAVE, with a reason of 3–200 characters, based on the version the admin
  saw (409 `VERSION_CONFLICT` with the current day). The day becomes MANUAL with the admin as its
  updater, and punches never change it again. Typed times (Bangla digits accepted) are kept as
  typed, with no 30-minute rule; an out before the in is 422 `OUT_BEFORE_IN`, a future date 422
  `FUTURE_DATE`, someone not active staff here 422 `NOT_STAFF`. Audited as
  `staff_attendance_day`.
- **The month** (`GET /staff-attendance/month?month=`): people × days with the codes
  উ / দে / আ / দেআ / অ / ছু (P / L / E / LE / A / LV), off days hatched, totals (present, late,
  early, absent, leave days, late and early minutes), a person's days beside it, print on A4
  landscape, and two CSVs (`month/csv?kind=grid|days`: UTF-8 with a BOM, ASCII digits, CRLF), all
  from `staffMonth`.
- The device never writes LEAVE; it writes PRESENT, and ABSENT only when a review rejected every
  punch of an existing device day.

## Retention

- **Raw punches** are kept for the institute's `punch_retention_days` (setting, default 730,
  30–3650). The daily `expire-punches` job (00:40 Asia/Dhaka) visits every institute in
  `devices:tenants`, attendance on or not, each in its own transactions, and deletes punches whose
  day is before today − that setting, oldest first, 5000 per transaction. An institute that no
  longer exists is taken off `devices:tenants` instead (a warning names it).
- **The database floor:** the app can never delete a punch from the last 30 days (restrictive
  policy `retention_only`, by the database's own date, so it can be a day behind the institute's).
  Raw columns can never be updated.
- **Commands** (they carry names) unchanged for 90 days, counted from the latest of `updated_at`,
  `sent_at` and `done_at`, are deleted when FAILED or CANCELLED, or when DONE with a later DONE for
  the same device and ID. Each ID's latest DONE command per device is kept however old (it is what
  the device has, and the "still on a device" rule reads it), and so are PENDING and SENT ones.
  An old FAILED add that was the latest is deleted too; the person's sync state then shows "not
  sent".
- **Never deleted:** registers and their records, staff days, SMS logs and the audit log.
  Attendance made from deleted punches stays as it was.
- What each institute lost is logged as counts. One institute failing is logged (error name only)
  and visited again the next night.
- A deleted punch takes its dedupe row with it. A device that sends old punches again (e.g. after
  a stamp reset) gets them stored again; they are `STALE`, never count, and go again the next
  night.

## Setting up a device

The devices screen's setup guide (Bangla, per device) walks the admin through it:

1. Connect the device to power and the internet (cable or Wi-Fi).
2. Menu (`M/OK`) → **Comm.** → **Cloud Server Setting** (**ADMS** on some models).
3. **Server Address** and **Server Port**: the receiver's public host and port
   (`INGEST_PUBLIC_HOST`, required in production, and `INGEST_PUBLIC_PORT`), with copy buttons.
4. **Enable Domain Name** off for an IP address, on for a domain name.
5. **HTTPS** off, **Proxy Server** off.
6. **System → Date Time:** time zone GMT+6; check the date and time.
7. A BOTH device: **Personalize → Punch State Options**, the automatic state by time (e.g.
   Check-In until 12 noon, then Check-Out).
8. **System Info → Device Info:** the serial number must match exactly.
9. Save, then switch the device off and on once.

The guide then waits for the device and turns "connected" by itself. Then it shows where the
device called from, from its address list:

- **An address is trusted:** that address (the one seen last, if several), with when it was first
  and last seen, its punch count and "No, it isn't ours" (revoke).
- **None is trusted yet** (e.g. the device first called more than 24 hours after it was added):
  every address it called from, in the order they first called, each with when it was first and
  last seen, its punch count and its own "Trust" button, and the advice to trust only the one that
  is the institute's internet connection. No commands go to the device until one is trusted.

The guide never picks an address for the admin to trust: the latest caller (`last_ip`) can be
anyone who knows the serial number. Then give people IDs (People and device IDs), **Send to
devices**, and enrol each person's finger, card or face on the device under their ID. Enrolment
happens on the device itself; Jantrik never keeps the biometric data (above). Names show in
English on the device.

## Development

`pnpm dev` starts the receiver inside the API on port 4080 (`INGEST_IN_PROCESS` is on outside
production) and needs `DATABASE_INGEST_URL` in `.env`; the login comes from the init script, or
from the one-off commands in [database.md](database.md) on an older volume.

### The simulator

[`packages/device-sim`](../packages/device-sim) plays a device: handshake, polling, applying
commands to its own user list and acknowledging them, punches, backlogs, a skewed clock, and
biometric payloads with a sentinel. The API tests use it as a library; `pnpm device:sim` is its
command line (it talks to `http://localhost:4080` unless `--url` says otherwise; the e2e receiver
is on 4280). A fresh checkout needs `@jantrik/shared` built first: `pnpm build`, or start
`pnpm dev` once.

```sh
pnpm device:sim handshake --sn DEMO00000001           # print the options the server sends
pnpm device:sim listen --sn DEMO00000001              # poll for commands every 30 s, apply, acknowledge (Ctrl+C stops)
pnpm device:sim listen --sn DEMO00000001 --interval 5 # quicker (20 commands per poll)
pnpm device:sim punch --sn DEMO00000001 --pin 20260102 --at 07:45   # one punch; --out for an out
pnpm device:sim morning --sn DEMO00000001 --pins 20260102-20260127 --from 07:30 --minutes 40
pnpm device:sim --help                                # every command and option
```

- `--at` takes `HH:MM` (today) or `YYYY-MM-DD HH:MM:SS`; punches in the past are fine for
  arrivals but send no entry SMS (not real time).
- `--skew <seconds>` runs the device's clock fast or slow; `--legacy` handshakes without
  `pushver`; `--ip <address>` sends `X-Forwarded-For`, which the receiver believes only when
  `INGEST_TRUST_PROXY` is set (a hop count, `loopback` or the proxy's address; the e2e tests use
  `true`, safe only on this machine and never in production; see the limits above).
- Demo devices and IDs: [demo-accounts.md](demo-accounts.md) → Devices.

### Tests

Only the affected ones during work (the full API suite takes about 11 minutes):

```sh
pnpm --filter @jantrik/shared exec vitest run devices device-people staff-attendance
pnpm --filter @jantrik/device-sim test
pnpm --filter @jantrik/db exec vitest run devices-rls ingest-functions staff-attendance-rls attendance-rls demo-devices schema-safety
pnpm --filter @jantrik/api exec vitest run ingest devices- staff-attendance
```

- The API specs import the built simulator: run `pnpm build` first (or
  `pnpm --filter @jantrik/device-sim build`). `pnpm test` builds what it needs.
- `pnpm --filter @jantrik/api test -- <names>` passes the `--` on to Vitest, which then runs the
  whole suite: use `exec vitest run <names>`.
- The API specs share `jantrik_test` and the BullMQ prefix `jantrik-test`: run them from one
  terminal at a time.

| Spec (`apps/api/test`)           | Covers                                                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devices-ingest.e2e-spec.ts`     | the protocol, refusals, limits, addresses and trust, the per-minute cap, clock correction, commands, the biometric test                                                                     |
| `devices-ingest-env.e2e-spec.ts` | the stand-alone receiver starts in production from its own variables only and refuses (exits) without `DATABASE_INGEST_URL`; the API starts without it when the receiver is its own process |
| `devices-api.e2e-spec.ts`        | devices, sync, the feed, reviews, trust and revoke, alerts, roles                                                                                                                           |
| `devices-people.e2e-spec.ts`     | IDs, defaults, collisions, CSV, sync states, IDs still on a device, removal                                                                                                                 |
| `devices-processing.e2e-spec.ts` | outcomes, entry and exit SMS, the DEVICE register, staff days, the minute sweep                                                                                                             |
| `devices-review.e2e-spec.ts`     | what accept, reject and OK do                                                                                                                                                               |
| `devices-attendance.e2e-spec.ts` | the cutoff, hold-backs, close from device, races with a teacher, BUSY, the take screen                                                                                                      |
| `devices-retention.e2e-spec.ts`  | what retention deletes and keeps                                                                                                                                                            |
| `devices-simulator.e2e-spec.ts`  | the simulator against the receiver, end to end, to the register and the SMS                                                                                                                 |
| `staff-attendance.e2e-spec.ts`   | staff days, manual entries, the tracked switch, the day view, the month and its CSVs                                                                                                        |

## Verify on the real device

Nothing here has met real hardware (the protocol comes from the sources under "The protocol").
When the first device arrives, check:

- the `pushver` it sends (2.x expected; the 3.x access-control firmware is not supported), and
  the menu path and fields for the server (the setup guide's steps);
- whether `TransFlag=TransData AttLog` really stops OPERLOG, BIODATA and photo uploads (we drop
  them either way);
- what it does with `ATTLOGStamp=None` on first contact (it may send its whole history: anything
  before the registration day is skipped, older than 7 days is `STALE`), and what its `Stamp`
  values look like (only a positive whole number of up to 19 digits is echoed back; anything else
  makes the next handshake say `None`);
- that `DATA UPDATE USERINFO` with only `PIN` and `Name` keeps the person's card and
  fingerprints, and that `DATA DELETE USERINFO` works (the old `DATA USER` form if not); what it
  answers in `Return`;
- the state codes it sends on a BOTH device with the automatic state by time, and which verify
  numbering it uses (old: 0 password, 1 fingerprint, 2 card; newer: 1 fingerprint, 3 password,
  4 card, 15 face; until we know, only 1, 3, 4 and 15 get a name);
- that its clock follows our `Date` header and that it accepts our `TimeZone` value;
- how many records it sends per upload, whether it ever sends CRLF, and that `Realtime=1` uploads
  each punch at once (entry SMS and the clock estimate need it);
- the PIN length it accepts and how much of the name it shows;
- that its polls, uploads and command answers come from one public address (commands go only to
  a trusted address; a connection that balances over two lines would make them wait);
- how it behaves on our 403, 413, 429 (with `Retry-After`) and 500 answers, and with
  `Connection: close`;
- what `INFO` carries on getrequest (we keep the first field as the firmware, the second as the
  user count), and that the user count matches after "send to devices";
- whether it offers HTTPS, and whether it sends a `pushcommkey` (the protocol says it binds
  device and server but does not document how it is made; worth supporting once we can see one).

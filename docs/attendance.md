# Attendance

Module `ATTENDANCE`. API: [`apps/api/src/attendance`](../apps/api/src/attendance). Web:
[`apps/web/src/app/(app)/attendance`](<../apps/web/src/app/(app)/attendance>) and
[`apps/web/src/lib/attendance`](../apps/web/src/lib/attendance). Tables and RLS:
[database.md](database.md). Attendance devices (ZKTeco), registers from punches and staff
attendance: [devices.md](devices.md).

## Rules

- **Today** is the server's date in the tenant's timezone (`tenants.timezone`), returned by every
  attendance endpoint and by `GET /me/context` (the platform pages: `GET /platform/auth/me`).
  Clients never use the device date. End-to-end tests fix it with `JANTRIK_TEST_TODAY` (see
  `todayIn` in `packages/shared/src/dates.ts`); timestamps stay real.
- **Who:** teachers mark only the sections assigned to them (`section_teachers`); OWNER/ADMIN any.
- **When:** never a future date. Teachers: from `today − edit_window_days` to today. OWNER/ADMIN:
  any past date; outside the window it is audited as `lateEdit: true`.
- **Holidays and weekly off days** are refused (`NON_WORKING_DAY`) unless an OWNER/ADMIN sends
  `allowNonWorkingDay`; the register is then marked `on_non_working_day`.
- **Mode:** `DAILY` registers use period 0; `PER_SESSION` registers use periods 1–20. The default
  comes from the institute type (data, not code).
- **Who is on a register:** exactly the students enrolled in that section in the current year.
  Unknown students → 422 `UNKNOWN_STUDENT`; a changed roster → 409 `ROSTER_CHANGED` with the
  current list.
- **Audit:** every submit writes `audit_logs` (entity `attendance_session`), with only the
  students that changed.
- **Source:** every register and every record is `MANUAL` (a person's) or `DEVICE` (written from
  punches, see below). The take screen tags device records and says "from the device, 9:30" when
  the device changed the register last; the student report shows who set each day.
- **Present %:** `(PRESENT + LATE) / (total − LEAVE)`; with `leave_counts_as_absent`, LEAVE stays
  in the total. One function: `attendancePercent()` in `@jantrik/shared`.

## Submitting: idempotent, with conflicts

`PUT /attendance/sessions` creates or replaces one register (section + date + period).

- `submissionId`: new on every change on the client. A request whose `submissionId` is already
  the register's last one is a retry: the server answers with the saved state (`replayed: true`)
  and changes nothing (no audit row, no SMS).
- `baseVersion`: the version the client started from (0 = new). If it is stale → 409
  `VERSION_CONFLICT` with the current state, including who changed it and when.

## Drafts on the phone (never lose a teacher's work)

`RegisterController` (`lib/attendance/register-controller.ts`) holds the rules; the screen only
renders its state.

- Every tap writes the draft to `localStorage` at once (`jantrik.att:<user>:<tenant>:<section>:<date>:<period>`).
  It holds only student id, roll and name: never phone numbers, photos or guardian details.
- Submit marks the draft `pending`. Only the server's answer for that exact `submissionId`
  deletes it. Drafts older than 7 days are removed.
- Network errors and 5xx retry with backoff (2 s … 60 s), on `online`, and when the tab becomes
  visible. A `pending` draft found when the register opens is sent again automatically.
- A conflict with the teacher's own earlier submit (its answer was lost) is resolved silently.
  So is one where the saved register and the draft agree on every student (e.g. a draft started
  from the device's suggestion, then the device wrote the same register at the cutoff): the
  screen takes the saved one. Any other change opens a dialog: "X changed this at 10:30" (or
  "The device changed this…"), only the students that differ, and two buttons, keep mine / keep
  theirs.
- More than half absent asks for confirmation before sending.
- The screen always says where the work is: kept on this phone / sending / couldn't send,
  trying again in N s / submitted at 10:42.

## Registers from devices

With attendance devices and **auto-mark** on (DAILY mode only; off by default), the day's
period-0 register can be written from punches. Full rules: [devices.md](devices.md) → Students.

- **Only ACTIVE students count** for the device: only they are sent to the devices. Arrivals,
  the counts and the reasons below are about a section's active students; a section with none
  gets no device view and no register from the device (take it by hand).
- **Before the cutoff** nothing is written. The take screen shows each active student's punch-in
  time (late marked; in any mode) and, with auto-mark on, starts an untaken register from the
  device's view (arrived PRESENT or LATE, the other active students ABSENT, one not active as by
  hand), saying so. The today page shows the
  arrivals per section ("punched in 28/35", late count, cutoff).
- **At the cutoff** (each shift's start + `device_cutoff_minutes`, default 60) the minute job
  writes the register: `source = DEVICE`, **no taker** (`taken_by_id` and `updated_by_id` NULL;
  the API returns `updatedByDevice: true`), every enrolled student PRESENT, LATE or ABSENT (an
  inactive one still enrolled always ABSENT), audited. Its absent SMS go to the ACTIVE absent
  students only.
- **Held back** instead, with the reason on the today page: `DEVICE_OFFLINE` (no device seen in 15
  minutes), `NOT_ON_DEVICE` (an active student has no ID confirmed on a device; with the count),
  `TOO_MANY_MISSING` (more than half of the active students without an arrival),
  `AUTO_CLOSE_ENDED` (an hour past the cutoff, it waits for a person). The teacher takes it by
  hand, or an owner/admin uses **Take from the device** after a confirm
  (`POST /attendance/sections/:id/close-from-device`): the same register, written after the
  cutoff whatever the reason.
- **A person's register wins.** A register submitted before the cutoff is never replaced. A
  submit that loses the race to the cutoff gets `VERSION_CONFLICT` naming the device (settled
  silently when nothing differs, see above).
- **A teacher's edit:** each record whose status they change becomes `MANUAL`, and the device
  never changes it again. Records they leave alone keep their source; the register stays
  `DEVICE` and gets the teacher as its updater. A student enrolled after the device wrote the
  register gets a `MANUAL` record from the teacher's submit.
- **A punch after the cutoff** (today, with auto-mark on) turns a still-DEVICE ABSENT into LATE;
  a pending absent SMS is then cancelled by the relevance check. The teacher who edited the
  register stays its updater; the take screen names the device as the last change (a stale
  draft's conflict says so). With auto-mark off, punches never
  change a register, not even one written by "take from the device".
- Lock waits on these paths are limited to 5 s: a request that runs out answers 409 `BUSY` with
  `Retry-After` and changes nothing, and the screen says "the system is busy right now, try
  again".

## Absent SMS

Off by default (it costs the institute money). When on, after a submit **commits**, one SMS per
absent student per day goes to the primary guardian, only for today's registers, and only for
ACTIVE students (not deleted): a student transferred, dropped out or otherwise inactive but still
enrolled gets none, whoever marks them absent. A register written from the device (at the
cutoff, or by "take from the device") queues them the same way (`AbsentSmsService`); an inactive
student still enrolled is written ABSENT there. See
[auth.md](auth.md) → `TenantSmsService` for dedupe (`absent:<student>:<date>`), the daily cap
(`HELD_OVER_LIMIT`) and the correction delay (`absent_sms_delay_minutes`, default 10): just
before sending, the worker checks the student is still absent, otherwise the SMS is `CANCELLED`.

### Held over the daily cap

Over the cap, an SMS is stored as `HELD_OVER_LIMIT` and the dashboard shows the owner/admin a
warning with the count. **Send held SMS** (`POST /attendance/sms/held/send`, after a confirm
dialog) releases only **today's** held SMS, over the cap; each one is re-checked first and is
`CANCELLED` if the student is no longer absent. The release is audited (`sms_logs`).

Held SMS not released by the end of their day become `EXPIRED` and are never sent:

- a daily BullMQ job (`expire-held`, 00:05 Asia/Dhaka) visits only the tenants recorded in the
  Redis set `sms:held-tenants:<date>` (added after commit when an SMS is held, 3-day TTL), each
  inside its own RLS context via `TenantJobRunner`. No cross-tenant query.
- as a fallback, the tenant's next SMS queue or `GET /attendance/sms/today` expires them too.

### Entry and exit SMS (devices)

Next to the absent SMS, two more settings (off by default, any mode): "entered at 7:45" for a
student's first IN punch of the day and "left at" for the first OUT after it. At most one of each
per student per day (`entry:<student>:<date>`, `exit:<student>:<date>`), only on working days,
only for punches received within 10 minutes of being made and without a flag that stops SMS
(any but `CLOCK_CORRECTED`), and **never over 90 % of the daily cap**: past it they are skipped
(no row, never held), so the rest stays for absent alerts and receipts. Fixed Bangla text. Details: [devices.md](devices.md) →
Entry and exit SMS.

## Reports

Every report uses each day's **first** register (lowest period) as that day's roll call, like
the dashboard. Present % = (PRESENT + LATE) / (all − LEAVE), or with LEAVE as absent when
`leave_counts_as_absent` is on. The calculation lives in `@jantrik/shared` (`attendancePercent`,
`buildRegister`) so the API, the CSV and the tests agree.

| Screen                                                                     | Endpoint                                                      | Who                                             |
| -------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------- |
| Today (`/attendance/today`): every section, counts, absent students        | `GET /attendance/reports/today`                               | teachers (their sections), admins (all)         |
| Trend (dashboard): present % per day, the last 7–90 days                   | `GET /attendance/reports/trend?days[&sectionId][&bySection]`  | teachers (their sections), admins (all)         |
| Monthly register (`/attendance/register`): students × days, totals, print  | `GET /attendance/reports/register?sectionId&month[&periodNo]` | the section's teachers, admins                  |
| CSV of the register                                                        | `GET /attendance/reports/register/csv?…&locale=bn\|en`        | same                                            |
| One student over a date range (`/attendance/students/:id`), at most a year | `GET /attendance/reports/students/:id?from&to`                | the section's teachers, admins                  |
| Guardian month calendar (dashboard)                                        | `GET /me/children/:id/attendance?month`                       | the guardian of that child only (404 otherwise) |

- **CSV:** UTF-8 with a BOM (so Excel shows Bangla), **ASCII digits always**, CRLF, cell codes in
  the chosen language (উ/অ/দে/ছু or P/A/L/LV), per-student totals and %. The web app downloads
  it with an authenticated fetch (a plain link would carry no token).
- **Print:** only the register is printed (`.print-area`), A4 landscape, with the institute,
  section and month as a heading; off days are hatched so they show without colour.
- **Calendar:** Saturday first; weekly off days and holidays greyed; future days dimmed.
- **Today, with devices:** in DAILY mode with auto-mark on, on a working day, each section with
  active students also has `device`: enrolled, arrived and late so far (active students only),
  how many cannot punch (`notOnDevice`), its cutoff and its state (`BEFORE_CUTOFF`, `CLOSED` once
  any register exists, or the reason it was held back). A register written by the device says
  "taken from the device" (and who changed it since).
- **Student report:** each day's status comes with its `source` (MANUAL or DEVICE).
- **Absence streak:** each absent student on the today report has `streak`, the school days
  absent in a row up to today (`absenceStreak`). Days without a register are skipped, so a
  holiday never breaks it; PRESENT or LATE ends it, and so does LEAVE unless leave counts as
  absent. It stops at 30 and looks back at most 60 calendar days, never before the year's start
  (so after a long closure it can be shorter than the real run).
- **Trend:** every date from `days` back (today included, never before the year's start), each
  with the day's first registers added up, `null` where none was taken, and the off day or
  holiday marked. `bySection=1` adds each section's own line over the same dates (`buildTrend`).
  `sectionId` must be a section the caller takes attendance for (403 otherwise; 422 when it is
  not in the current year).

## Settings (`/attendance/settings`, owner/admin)

Mode, weekly off days, teacher edit window, LEAVE rule, absent SMS on/off, the SMS text (with
`{student}`, `{date}`, `{institute}`, a live preview and the SMS count, Bangla = 70 characters
per SMS, 67 per part), the correction delay, the daily cap (automatic = 2 × active students, or
a number), holidays, and who takes attendance for each section (`GET /attendance/staff` lists
active owners, admins and teachers). The dashboard checklist's last step, "turn on absent SMS",
links here.

Device cards on the same page ([devices.md](devices.md)): **device attendance** (auto-mark,
grace minutes 0–120, cutoff minutes 15–300, "school starts at" for sections without a shift),
**punch checks** (the institute's hours, default 05:00–20:00; punches per device per minute,
10–240, default 60; punch retention in days, 30–3650, default 730), **entry and exit SMS** (with
the text preview and the cost note) and **staff** (office hours, late and early grace, the staff
ID range start with how many student codes fall in its next 1000 numbers). Bangla digits are
accepted.

## Retention

Raw device punches (`device_punches`) are kept for the institute's `punch_retention_days`
(attendance setting, default 730, 30–3650). The daily `expire-punches` job (00:40 Asia/Dhaka,
devices worker) visits every institute listed for devices (Redis set `devices:tenants`), whether
attendance is on or not, each in its own transactions, and deletes the punches whose day is before
today − that setting, 5000 per transaction. The database never lets the app delete a punch from
the last 30 days (policy `retention_only`, [database.md](database.md)). The same job deletes device
commands that failed, were cancelled, or are done with a later done command for the same device
and ID, once 90 days have passed since the latest of their `updated_at`, `sent_at` and `done_at`
(the receiver sets the last two, never `updated_at`). Each ID's latest done command on a device
(what the device has) and commands still waiting are kept however old. Registers and their
records, staff days, SMS logs and the audit log are never deleted: attendance made from deleted
punches stays as it was. What each institute lost is logged as counts; one institute failing is logged
(error name only) and tried again the next day.

## Demo data

`pnpm db:seed` adds about 30 working days of past attendance before the seed date for every
demo section (off days and holidays skipped, today left to take live), deterministic so every
seed is the same. No SMS are queued for it.

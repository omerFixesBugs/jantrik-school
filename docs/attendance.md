# Attendance

Module `ATTENDANCE`. API: [`apps/api/src/attendance`](../apps/api/src/attendance). Web:
[`apps/web/src/app/(app)/attendance`](<../apps/web/src/app/(app)/attendance>) and
[`apps/web/src/lib/attendance`](../apps/web/src/lib/attendance). Tables and RLS:
[database.md](database.md).

## Rules

- **Today** is the server's date in the tenant's timezone (`tenants.timezone`), returned by every
  attendance endpoint and by `GET /me/context`. Clients never use the device date.
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
  Someone else's change opens a dialog: "X changed this at 10:30", only the students that
  differ, and two buttons, keep mine / keep theirs.
- More than half absent asks for confirmation before sending.
- The screen always says where the work is: kept on this phone / sending / couldn't send,
  trying again in N s / submitted at 10:42.

## Absent SMS

Off by default (it costs the institute money). When on, after a submit **commits**, one SMS per
absent student per day goes to the primary guardian, only for today's registers. See
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

## Reports

Every report uses each day's **first** register (lowest period) as that day's roll call, like
the dashboard. Present % = (PRESENT + LATE) / (all − LEAVE), or with LEAVE as absent when
`leave_counts_as_absent` is on. The calculation lives in `@jantrik/shared` (`attendancePercent`,
`buildRegister`) so the API, the CSV and the tests agree.

| Screen                                                                     | Endpoint                                                      | Who                                             |
| -------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------- |
| Today (`/attendance/today`): every section, counts, absent students        | `GET /attendance/reports/today`                               | teachers (their sections), admins (all)         |
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

## Settings (`/attendance/settings`, owner/admin)

Mode, weekly off days, teacher edit window, LEAVE rule, absent SMS on/off, the SMS text (with
`{student}`, `{date}`, `{institute}`, a live preview and the SMS count, Bangla = 70 characters
per SMS, 67 per part), the correction delay, the daily cap (automatic = 2 × active students, or
a number), holidays, and who takes attendance for each section (`GET /attendance/staff` lists
active owners, admins and teachers). The dashboard checklist's last step, "turn on absent SMS",
links here.

## Demo data

`pnpm db:seed` adds about 30 working days of past attendance before the seed date for every
demo section (off days and holidays skipped, today left to take live), deterministic so every
seed is the same. No SMS are queued for it.

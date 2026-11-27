# Notices

The institute's notice board (sprint 1 P6a). OWNER and ADMIN write notices; every member reads
the board (staff and guardians; S20). Module CORE (S3). Tables: [database.md → Notices](database.md).

## Who sees a notice

A notice is **live** when it is published, its `publish_at` has come, and it has not expired. A
live notice is shown to:

- **staff** (any of OWNER, ADMIN, TEACHER, ACCOUNTANT, STAFF here): audience `ALL` or `STAFF`,
  **whatever its targets** (targets narrow only the guardians part, P6-G);
- **guardians**: audience `ALL` or `GUARDIANS`, and either no targets, or a target matching one of
  their children's **current-year** enrolments: the class, or the class and section when the
  target names a section. Only ACTIVE, not deleted children count;
- a person with both roles sees the union, each notice once.

The rule is one pure function, `noticeVisibleTo()` in `packages/shared/src/notices.ts`
(unit-tested), applied in SQL by `NoticesService.visibleWhere()` (API-tested in
`apps/api/test/notices.e2e-spec.ts`). The board, one notice, marking read and the unread count all
use it; a notice the caller may not see is 404, as is another institute's.

## Writing and publishing

- **Drafts** are written at `/notices/manage/new`: title (≤ 150), body (≤ 5 000, plain text with
  line breaks; links are shown as text, never clickable: P6-J), audience, optional class/section
  targets (not on a `STAFF` notice: 422 `TARGET_INVALID`; only this institute's classes and
  current-year sections of that class), an optional last day, and a pin.
- **Publish now or later** (`POST /notices/:id/publish {publishAt?}`): later means at most 30 days
  ahead (422 `SCHEDULE_OUT_OF_RANGE`). Nothing is scheduled: visibility is computed when read, so
  the notice simply appears when its time comes, and a lost job can never hide one (P6-A). A
  scheduled notice can be published again to move its time; a live one cannot (409
  `NOT_EDITABLE`).
- **Expiry**: the day picked is the last day on the board (Asia/Dhaka); it must be after the
  publish time (422 `EXPIRY_INVALID`). Expired notices stay in the management list.
- **Edit**: allowed until withdrawn. Editing a published notice marks it "edited" and keeps who
  read it (P6-N). Targets are replaced whole; targets the notice already had are kept as they are
  (a section of last year, after the year changed, does not block a typo fix), new ones are checked.
- **Withdraw** (`POST /notices/:id/withdraw {reason}`): off every board at once, kept for the
  record, never edited again (409 `NOT_EDITABLE`). Notices are never deleted (no DELETE grant).
- Every create, edit, publish and withdrawal writes an audit entry (title, audience, targets, pin,
  expiry and the body's length; never the body itself).

## Reads and the unread count

- Opening a notice marks it read (`POST /notices/:id/read`, idempotent, only for oneself: the
  database refuses a read row for anyone else).
- `GET /notices/unread-count` is cached in Redis per person for 2 minutes under two versions: the
  institute's notice version (`tenant:<id>:notices:ver`), which every publish, edit and withdrawal
  bumps after commit, and the person's own read version, which each read bumps after commit (P6-I).
  A count computed just before a read is cached under the old pair, which nobody reads again. A scheduled notice that
  becomes live, or a child changing class, shows within those 2 minutes.
- The web app asks for the count after first paint (the sidebar badge) and again on focus at most
  every 5 minutes, so it never delays a page. The dashboard shows a "Notices" card (pinned first,
  then the newest three) below the role's own cards.
- `GET /notices/:id/reads` (OWNER/ADMIN): how many of the audience opened it: staff = ACTIVE staff
  members (for `ALL`/`STAFF`), guardians = people with a login linked to a current-year ACTIVE
  child the targets name (for `ALL`/`GUARDIANS`).

## Routes

| Route                        | Who          | What                                   |
| ---------------------------- | ------------ | -------------------------------------- |
| `GET /notices`               | every member | the board, pinned first, then newest   |
| `GET /notices/:id`           | every member | one live notice (404 when not visible) |
| `POST /notices/:id/read`     | every member | mark read (204)                        |
| `GET /notices/unread-count`  | every member | `{count}`, cached                      |
| `GET /notices/manage[/:id]`  | OWNER/ADMIN  | every notice, with state and reads     |
| `POST /notices`              | OWNER/ADMIN  | a draft                                |
| `PUT /notices/:id`           | OWNER/ADMIN  | edit (not withdrawn)                   |
| `POST /notices/:id/publish`  | OWNER/ADMIN  | now or within 30 days                  |
| `POST /notices/:id/withdraw` | OWNER/ADMIN  | with a reason                          |
| `GET /notices/:id/reads`     | OWNER/ADMIN  | read counts                            |

Pages: `/notices` (board), `/notices/[id]`, `/notices/manage` (list with publish and withdraw),
`/notices/manage/new`, `/notices/manage/[id]` (edit).

## SMS broadcasts (P6b)

An SMS to guardians or staff, written by OWNER/ADMIN at `/broadcasts` (S20). In development and
tests SMS go only to the console, memory or outbox providers; production sends nothing until the
gateway exists.

### Who receives it

Resolved when it is previewed, and again **when it is sent** (S19):

- `PRIMARY_GUARDIANS`: the primary guardian's phone of each targeted ACTIVE, not deleted student
  enrolled in the current year;
- `ALL_GUARDIANS`: every linked guardian's phone of those students;
- `STAFF`: the login phone of every ACTIVE staff member, once per person (P6-H). A staff broadcast
  takes no class targets (422 `TARGET_INVALID`).

Phones are merged: siblings sharing a guardian's phone get one SMS. Every SMS has the dedupe key
`broadcast:<id>:<phone>`, so nothing is ever sent twice to one phone for one broadcast.

### Preview, cost and the cap (S18)

`POST /broadcasts/:id/preview` answers the recipients (after merging), the students or staff
without a phone, the merged phones, the segments per SMS (`smsLength`: GSM-7 160/153, otherwise
UCS-2 70/67; Bangla is UCS-2), the cost (recipients × segments × the platform's rate, integer
paisa), today's cap left, `fits`, whether it is quiet hours now and the next allowed time.

- **The text** is exactly what the admin types (P6-M; the composer starts it with the institute's
  name and a colon, and from a notice with its title). 1 to 3 segments: more is 422
  `SMS_TOO_LONG`.
- **The cap** is the institute's daily SMS cap (shared with every other SMS; it counts messages,
  not segments). **All or nothing:** a send that does not fit is refused (422 `OVER_CAP`); at send
  time a broadcast that no longer fits sends **nothing** and becomes `FAILED_OVER_CAP`, which the
  OWNER/ADMIN dashboard shows for 3 days (P6-D).
- **What was confirmed:** the preview returns a token (a hash of the text, the recipient kind, the
  targets, the notice, the count, the segments and the cost). Send and schedule carry it with the
  count; anything changed since is 409 `PREVIEW_CHANGED` with the new segments and cost.

### Quiet hours, sending and scheduling

- **Quiet hours** are 21:00–08:00 in the institute's timezone (`inQuietHours`, `nextAllowedAt` in
  `packages/shared/src/broadcasts.ts`; fixed for every institute this sprint, P6-E). "Send now"
  inside them is 422 `QUIET_HOURS` with the next allowed time (P6-F); so is scheduling into them.
- **Schedule**: between 5 minutes and 30 days ahead (422 `SCHEDULE_OUT_OF_RANGE`).
- **Editing** a draft keeps it a draft; editing a scheduled broadcast puts it back to draft (its
  job stops by itself), so it is previewed and scheduled again with every check.
- **Cancel** a draft or a scheduled broadcast; 409 `ALREADY_SENDING` while the send job holds it,
  409 `NOT_EDITABLE` once sent. A sent broadcast cannot be stopped (P6-L); a queued SMS of a
  broadcast that is no longer `SENT` is dropped before sending (the relevance check).

### The job and the sweep

- Send now and schedule both store `SCHEDULED` and, after commit, add the job `broadcast-send`
  (queue `notices`, job id `broadcast-<id>`, delayed to the time) and a member
  `<tenantId>|<broadcastId>` scored by the time in the Redis sorted set `notices:due`. Job data is
  ids only.
- **The job** (acting as the admin who scheduled it, `scheduled_by_id`, which the database lets a
  request set only to its own signed person, P6-b21): locks the broadcast; stops unless
  `SCHEDULED`; cancels it (`ACTOR_NOT_ADMIN`, nothing sent) when that admin is no longer OWNER or
  ADMIN; waits (the same job is delayed) when it runs early or inside quiet hours (a job due at
  23:30 sends at 08:00); resolves the audience; and queues every SMS in **one transaction** with
  `TenantSmsService.queueAll`, which holds the institute's SMS lock, skips known dedupe keys and
  stores either every new SMS or none. Then `SENT` with the count and the institute's day, or
  `FAILED_OVER_CAP` with `{needed, capLeft}`. Running it twice sends nothing more.
- **Late:** a broadcast whose job runs more than 3 hours after the time the admin chose, or would
  only go out more than 3 hours after it (waiting for 08:00), is not sent: it becomes `EXPIRED` with
  `{lateMinutes}` and shows on the dashboard. The chosen time is never overwritten.
- **Dearer than confirmed:** the audience is resolved again at send time (S19). When that would
  cost more than the confirmed cost by over 10% **and** by more than one SMS, nothing is sent: it
  becomes `COST_CHANGED` with `{confirmedCostPaisa, costPaisa, recipients}` and shows on the
  dashboard. Otherwise it is sent and its real cost is stored (`sent_cost_paisa`); the broadcast's
  page shows "previewed N, sent to M" with that cost.
- **Never sent** (`FAILED_OVER_CAP`, `EXPIRED`, `COST_CHANGED`): "Edit and send again" turns it back
  into a draft (audited with the old status and reason), to preview and confirm again.
- **Its SMS:** the SMS jobs (one per SMS, job id = the SMS id) have a lower BullMQ priority than
  login codes and other single SMS, which always go first. After a send, and whenever the job runs
  again, the jobs of the broadcast's QUEUED SMS are re-added before its due entry is dropped; so
  does opening the broadcasts list, for SMS still waiting 10 minutes later outside quiet hours. An
  SMS still waiting at 21:00 waits (still QUEUED) until 08:00. Fee reminders and exam result SMS
  use the same lower priority. A sent broadcast cannot be stopped (P6-L, a follow-up).
- The send job retries 3 times with backoff; the sweep replaces a failed one. The due entry is
  dropped only if no new schedule changed it meanwhile.
- **The sweep** (`notices-sweep`, every 5 minutes) re-adds the job of every due member of
  `notices:due` that Redis lost; members older than 7 days are dropped. No SQL runs outside an
  institute.
- **Heal on read:** opening the broadcasts list re-queues the institute's `SCHEDULED` broadcasts
  more than 2 minutes overdue (the sorted set itself could be lost with Redis, P6-K). The
  dashboard lists one more than 10 minutes overdue.
- Sent, waiting and failed counts are read live from `sms_logs` (`related_entity =
'broadcast:<id>'`), never stored (P6-C).
- Every create, edit, schedule, cancel, send and outcome is audited with counts and cost, never
  phone numbers.

| Route                                                             | What                               |
| ----------------------------------------------------------------- | ---------------------------------- |
| `GET /broadcasts`                                                 | list (heals overdue ones)          |
| `GET /broadcasts/alerts`                                          | the dashboard warning              |
| `GET /broadcasts/:id`                                             | one, with SMS counts by state      |
| `POST /broadcasts`, `PUT /broadcasts/:id`                         | a draft (edit: draft or scheduled) |
| `POST /broadcasts/:id/preview`                                    | the preview                        |
| `POST /broadcasts/:id/send {expectedRecipients}`                  | now                                |
| `POST /broadcasts/:id/schedule {scheduledAt, expectedRecipients}` | later                              |
| `POST /broadcasts/:id/cancel`                                     | a draft or a scheduled one         |

All OWNER/ADMIN, module CORE. Pages: `/broadcasts`, `/broadcasts/new` (`?notice=<id>` from a
notice), `/broadcasts/[id]` (a draft opens in the composer).

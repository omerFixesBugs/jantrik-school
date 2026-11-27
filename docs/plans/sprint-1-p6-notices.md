# Sprint 1, P6: notices and SMS broadcasts (implementation plan)

**Status: plan only (day run 2026-11-16), not approved, no code yet.** It details
[sprint-1.md](sprint-1.md) → "P6: Notices and broadcast", which the owner approved on 2026-11-14
with decisions S18 (all or nothing over the cap; quiet hours 21:00–08:00), S19 (the audience is
resolved at send time) and S20 (OWNER/ADMIN publish and send). Nothing here reopens those. The new
decisions this plan needs are P6-A to P6-N at the end; each has a recommended default.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an admin publishes a notice to staff, guardians or both (optionally only some classes or
sections), now or at a set time, and can also send it, or any short text, as an SMS to guardians
or staff. Before sending they see how many SMS, how many segments, the cost and what today's cap
leaves; a send either goes out whole or not at all. Everyone sees the notice board and an unread
count.

**Architecture:**

- **Notices** (`notices`, `notice_targets`, `notice_reads`) are plain rows. Visibility is computed
  when read from `status`, `publish_at` and `expires_at`, so a scheduled notice needs no job and a
  lost job can never hide one (P6-A).
- **Broadcasts** (`sms_broadcasts`, `sms_broadcast_targets`) are sent by a queue job
  `broadcast-send` (new `notices` queue), job id `broadcast-<id>`, delayed to the scheduled time;
  "send now" is the same job with no delay. The job resolves the audience at that moment (S19) and
  queues every SMS **in one transaction** through a new `TenantSmsService.queueAll()`, which holds
  the institute's SMS lock once and inserts all rows or none (S18). A Redis sorted set
  `notices:due` lets a 5-minute sweep re-queue a job Redis lost, without any cross-institute SQL.
- **Dedupe per phone:** every SMS has the key `broadcast:<id>:<phone>`, so siblings sharing a
  guardian's phone get one SMS, and a re-run sends nothing twice.
- **Quiet hours** (21:00–08:00 in the institute's timezone) are pure functions in
  `@jantrik/shared`: scheduling into them is refused; a job that comes due inside them waits until
  08:00.
- **Unread count:** one cheap endpoint, cached per user in Redis under the institute's notice
  version, which every publish, edit and withdrawal bumps.

**Tech stack:** NestJS, Prisma/PostgreSQL 16, BullMQ, Redis, Next.js (v3 kit), next-intl, Vitest
and Playwright. No new dependency.

**Branch:** `feature/sprint-1-p6-notices` from `main`. P6 depends on no other phase (sprint plan →
phase table) and may run in parallel with others (S2).

## What exists today (verified in the code on 2026-11-16)

- **Tenant SMS:** `TenantSmsService.queue()` (`apps/api/src/sms/tenant-sms.service.ts:91-136`)
  takes the institute's advisory lock
  (`pg_advisory_xact_lock(hashtextextended('sms:' || app_current_tenant_id()::text, 0))`), skips
  a known `dedupe_key` (`DUPLICATE`), counts today's `QUEUED`/`SENT` rows against `dailyCap`, and
  either stores the row `QUEUED` (job queued after commit, `jobId = smsLogId`) or, over the cap,
  `HELD_OVER_LIMIT` (`overCap: 'HOLD'`) or nothing (`'SKIP'` → `OVER_CAP`). It works **one SMS at
  a time**: a chunked job calling it cannot be all-or-nothing.
  - Relevance checks per purpose run just before sending
    (`registerRelevanceCheck`, `tenant-sms.service.ts:85`; used by fees reminders and exam results).
  - `sms_logs` has `related_entity`/`related_id`, a partial unique index on
    `(tenant_id, dedupe_key)` (`schema.prisma:1820-1853`), no DELETE grant (history, billing).
- **The cap** is `AttendanceSettingsService.smsDailyCap()`
  (`apps/api/src/attendance/attendance-settings.service.ts:188-208`): the institute's own setting
  or 2 × active students, never above the plan's ceiling. It counts **messages, not segments**.
- **Preview → send:** `FeeRemindersService.preview()`/`send()`
  (`apps/api/src/fees/reminders/fee-reminders.service.ts:153-213`) and `ResultSmsService`
  (`apps/api/src/exams/results/result-sms.service.ts:75-140`): count, segments
  (`smsLength`), cost (`platform_settings.sms_cost_per_segment_paisa`), cap left; sending with a
  different count → 409 `PREVIEW_CHANGED`; the job runs as the admin and first checks they are
  still OWNER/ADMIN (`fee-dues.processor.ts: actorMayStill`).
- **`smsLength()`** (`packages/shared/src/sms.ts:22-43`): GSM-7 160/153, otherwise UCS-2 70/67
  counted in UTF-16 units (Bangla is UCS-2). Three Bangla segments hold 201 units.
- **`sms_purpose`** values: `ATTENDANCE_ABSENT`, `FEE_RECEIPT`, `FEE_REMINDER`, `EXAM_RESULT`,
  `ATTENDANCE_ENTRY`, `ATTENDANCE_EXIT` (`schema.prisma:306-320`); each new value was added in its
  own migration (e.g. `20261028040100_exams_sms_purpose`).
- **Queues:** per-module `BullModule.registerQueue`, `WorkerHost` processors started by
  `QueueWorkers` (`apps/api/src/queue-workers.ts`), schedulers by `upsertJobScheduler`
  (`tenant-sms.service.ts:77-83`); a job runs in a tenant through `TenantJobRunner.run`
  (15 s transaction, `apps/api/src/tenancy/tenant-job-runner.service.ts`). Job ids use `-`
  (`devices.constants.ts:25`).
- **Time:** the API has an injectable `Clock` (`apps/api/src/common/clock.ts`) that tests move
  (`apps/api/test/support/clock.ts`, `test/clock.e2e-spec.ts`); `wallClockToUtc`, `localTimeOf`,
  `localDateOf` in `packages/shared/src/dates.ts:126-175`; `tenants.timezone`.
- **Who sees what:** `users_visible` lets the app read the users of the current institute;
  `app_current_user_id()` exists (migration `20261017054031_…`). Guardians' children come from
  `student_guardians` → `guardians.user_id` = the caller (`apps/api/src/me/me.module.ts:122-160`).
- **Web:** navigation in `apps/web/src/lib/navigation.ts` (items with module and roles), the shell
  `components/app-shell.tsx`, the dashboard `app/(app)/dashboard/page.tsx` and
  `components/dashboard/*`.
- **Nothing for notices exists** (no table, route or page).

## Global constraints

- **Module:** CORE (S3: no new module key).
- **Roles:** OWNER/ADMIN create, edit, publish, withdraw, broadcast (S20). Every member (staff
  roles and GUARDIAN) reads the board. STUDENT has no login use yet.
- **Recipients:**
  - `PRIMARY_GUARDIANS`: the primary guardian's phone of each targeted ACTIVE, not deleted student
    enrolled in the current year;
  - `ALL_GUARDIANS`: every linked guardian's phone of those students;
  - `STAFF`: the login phone (`users.phone`) of every ACTIVE staff membership (OWNER, ADMIN,
    TEACHER, ACCOUNTANT, STAFF), once per person (P6-H).
  - Phones are deduplicated before counting; students without a phone are counted as
    "without phone".
- **Text:** a notice title ≤ 150 characters, body ≤ 5 000, plain text with line breaks (no HTML,
  links shown as text: P6-J). A broadcast body is 1 to 3 segments (`smsLength`), refused above
  with 422 `SMS_TOO_LONG`.
- **Cap (S18):** the preview refuses a send that does not fit today's cap left
  (`fits: false`, the send button disabled, the API 422 `OVER_CAP`); at send time a broadcast
  that no longer fits sends nothing and becomes `FAILED_OVER_CAP`.
- **Quiet hours (S18):** 21:00–08:00 in the institute's timezone, constants in `@jantrik/shared`
  (P6-E). Scheduling a time inside them → 422 `QUIET_HOURS` with `nextAllowedAt`; "send now"
  inside them → the same 422 (P6-F); a due job inside them is delayed to the next 08:00.
- **Scheduling window:** at least 5 minutes ahead, at most 30 days (422 `SCHEDULE_OUT_OF_RANGE`).
- **Audit:** create, edit, publish, withdraw, targets of notices; create, edit, schedule, cancel,
  send and the outcome of broadcasts (counts and cost, never phone lists).
- **Logs and jobs:** job data carries ids only (`{tenantId, broadcastId}`); no phone numbers or
  text in Redis except the SMS layer's existing rules.
- **Strings:** bn and en through a route namespace `notices`; Bangla digits for counts, amounts
  and times in bn.
- **Screens:** v3 kit, light-first; screenshots bn at 1366 and 390 px. The board is part of the
  guardian's everyday path: the unread count is fetched after first paint and never blocks it
  (design.md → performance budget).
- **Errors (new codes):** 409 `PREVIEW_CHANGED` (existing), 422 `OVER_CAP`, 422 `QUIET_HOURS`,
  422 `SMS_TOO_LONG`, 422 `SCHEDULE_OUT_OF_RANGE`, 409 `NOT_EDITABLE` (a sent or cancelled
  broadcast, a withdrawn notice), 409 `ALREADY_SENDING`.
- **Gates:** affected tests during the phase; at the end the full gates, Playwright (CI or a
  scratch database), the review subagent (SMS money, DB), the PR.

## Review focus

1. **All or nothing over the cap** (S18). The cap left is 5 and the audience is 6. Expected: the
   preview says it does not fit; a scheduled send that comes due inserts **zero** `sms_logs` rows
   and becomes `FAILED_OVER_CAP`, and the admin sees it on the dashboard. Test: Task 5.
2. **A job run twice, or a job lost.** Expected: exactly one SMS per phone (dedupe keys and the
   status check under `FOR UPDATE`); a job Redis lost is re-queued by the sweep and sends once.
   Test: Task 6.
3. **Quiet hours across midnight** in the institute's timezone (20:59 allowed, 21:00 refused,
   07:59 refused, 08:00 allowed; a job due at 23:30 sends at 08:00). Test: Tasks 2 and 6.
4. **Audience at send time** (S19): a student admitted between scheduling and sending gets the
   SMS; one who left does not; an admin who lost their role → nothing is sent. Test: Task 6.
5. **Who sees a notice:** a guardian of class 6 sees a class 6 notice and not a class 7 one; a
   guardian with children in both sees both once; staff never see a guardians-only notice; other
   institutes' notices are 404. Test: Task 4.

---

## Database

Migrations, in order:

1. `<ts>_sms_purpose_broadcast`: `ALTER TYPE "sms_purpose" ADD VALUE 'BROADCAST';` alone (a new
   value cannot be used in the transaction that adds it).
2. `<ts>_notices`: enums, the five tables, RLS, policies, grants, CHECKs.

No tenant backfill. All foreign keys composite, `ON UPDATE RESTRICT ON DELETE RESTRICT` unless
noted.

### Enums

- `notice_audience`: `ALL`, `STAFF`, `GUARDIANS`.
- `notice_status`: `DRAFT`, `PUBLISHED`, `WITHDRAWN` (P6-A: "scheduled" is a PUBLISHED notice whose
  `publish_at` is still ahead).
- `broadcast_recipients`: `PRIMARY_GUARDIANS`, `ALL_GUARDIANS`, `STAFF`.
- `broadcast_status`: `DRAFT`, `SCHEDULED`, `SENT`, `CANCELLED`, `FAILED_OVER_CAP` (P6-C: SENT means
  every SMS was handed to the SMS queue; delivery progress is read from `sms_logs`).

### `notices` (S I U)

| Column                     | Type              | Notes                                 |
| -------------------------- | ----------------- | ------------------------------------- |
| `id`, `tenant_id`          | uuid              |                                       |
| `title`                    | text              | 1–150 characters                      |
| `body`                     | text              | 1–5 000 characters                    |
| `audience`                 | `notice_audience` |                                       |
| `status`                   | `notice_status`   | default DRAFT                         |
| `publish_at`               | timestamptz(3)?   | set at publish (now or later)         |
| `expires_at`               | timestamptz(3)?   | hidden from the board after it        |
| `pinned`                   | boolean           | default false                         |
| `created_by_id`            | uuid              | → `users`                             |
| `published_by_id`          | uuid?             |                                       |
| `withdrawn_by_id`          | uuid?             |                                       |
| `withdrawn_at`             | timestamptz(3)?   |                                       |
| `withdrawn_reason`         | text?             | ≤ 300                                 |
| `edited_at`                | timestamptz(3)?   | last edit after publishing ("edited") |
| `created_at`, `updated_at` |                   |                                       |

- Unique `(tenant_id, id)`. Index `(tenant_id, status, publish_at DESC)`.
- CHECKs: `char_length(btrim(title)) BETWEEN 1 AND 150`; `char_length(body) BETWEEN 1 AND 5000`;
  `status <> 'PUBLISHED' OR (publish_at IS NOT NULL AND published_by_id IS NOT NULL)`;
  `status <> 'WITHDRAWN' OR (withdrawn_at IS NOT NULL AND withdrawn_by_id IS NOT NULL)`;
  `expires_at IS NULL OR publish_at IS NULL OR expires_at > publish_at`;
  `withdrawn_reason IS NULL OR char_length(withdrawn_reason) <= 300`.
- Grants: `SELECT, INSERT`, `UPDATE (title, body, audience, status, publish_at, expires_at, pinned,
published_by_id, withdrawn_by_id, withdrawn_at, withdrawn_reason, edited_at, updated_at)`. No
  DELETE: withdrawn, never deleted.
- A trigger-free rule in the service: a WITHDRAWN notice is never edited again (409
  `NOT_EDITABLE`), tested.
- RLS checklist: ☐ `tenant_id NOT NULL` ☐ `(tenant_id, id)` unique ☐ composite FKs ☐ index leading
  with `tenant_id` ☐ ENABLE + FORCE ☐ `tenant_isolation` ☐ grants ☐ `schema-safety.test.ts`
  ☐ `packages/db/test/notices-rls.test.ts`.

### `notice_targets` (S I D)

| Column                     | Type  | Notes                                                                                                           |
| -------------------------- | ----- | --------------------------------------------------------------------------------------------------------------- |
| `id`, `tenant_id`          | uuid  |                                                                                                                 |
| `notice_id`                | uuid  | → `notices (tenant_id, id)`                                                                                     |
| `class_level_id`           | uuid  | → `class_levels (tenant_id, id)`                                                                                |
| `section_id`               | uuid? | `(tenant_id, section_id, class_level_id)` → `sections (tenant_id, id, class_level_id)`: a section of that class |
| `created_at`, `updated_at` |       |                                                                                                                 |

- Index `(tenant_id, notice_id)`. No targets = everyone of the audience.
- Targets narrow only the guardians part (P6-G): staff see an `ALL` or `STAFF` notice whatever
  its targets.
- The service replaces a notice's whole target set on save (delete + insert in one transaction),
  so there is no UPDATE grant and no uniqueness over a nullable column to keep.
- Grants: `SELECT, INSERT, DELETE`. RLS checklist as above.

### `notice_reads` (S I)

| Column            | Type           | Notes                       |
| ----------------- | -------------- | --------------------------- |
| `id`, `tenant_id` | uuid           |                             |
| `notice_id`       | uuid           | → `notices (tenant_id, id)` |
| `user_id`         | uuid           | → `users (id)` (global)     |
| `read_at`         | timestamptz(3) | default now()               |

- Unique `(tenant_id, notice_id, user_id)`; index `(tenant_id, user_id)`.
- Policy `notice_reads_own_insert` AS RESTRICTIVE FOR INSERT WITH CHECK
  `(user_id = app_current_user_id())`: nobody marks a notice read for someone else. SELECT stays
  institute-wide, for the admin's read counts.
- Grants: `SELECT, INSERT` (history: no UPDATE, no DELETE). Writes use `ON CONFLICT DO NOTHING`.

### `sms_broadcasts` (S I U)

| Column                     | Type                   | Notes                                                |
| -------------------------- | ---------------------- | ---------------------------------------------------- |
| `id`, `tenant_id`          | uuid                   |                                                      |
| `body`                     | text                   | 1–480 characters as a backstop; 1–3 segments in code |
| `notice_id`                | uuid?                  | → `notices (tenant_id, id)`                          |
| `recipients`               | `broadcast_recipients` |                                                      |
| `status`                   | `broadcast_status`     | default DRAFT                                        |
| `scheduled_at`             | timestamptz(3)?        | when it should go out                                |
| `preview_count`            | int?                   | the count the admin confirmed (an estimate, S19)     |
| `segments`                 | smallint?              | per SMS, from `smsLength`                            |
| `estimated_cost_paisa`     | int?                   | preview count × segments × rate                      |
| `queued_count`             | int?                   | SMS queued at send time                              |
| `local_date`               | date?                  | the institute's day it was sent (cap and billing)    |
| `created_by_id`            | uuid                   |                                                      |
| `scheduled_by_id`          | uuid?                  | the admin the job acts for                           |
| `sent_at`                  | timestamptz(3)?        |                                                      |
| `cancelled_by_id`          | uuid?                  |                                                      |
| `cancelled_at`             | timestamptz(3)?        |                                                      |
| `cancel_reason`            | text?                  | `BY_ADMIN`, `ACTOR_NOT_ADMIN`                        |
| `failure`                  | jsonb?                 | `{needed, capLeft}` for FAILED_OVER_CAP              |
| `created_at`, `updated_at` |                        |                                                      |

- Unique `(tenant_id, id)`; index `(tenant_id, status, scheduled_at)`.
- CHECKs: `char_length(body) BETWEEN 1 AND 480`;
  `status NOT IN ('SCHEDULED','SENT','FAILED_OVER_CAP') OR (scheduled_at IS NOT NULL AND scheduled_by_id IS NOT NULL)`;
  `status <> 'SENT' OR (sent_at IS NOT NULL AND queued_count IS NOT NULL AND local_date IS NOT NULL)`;
  `status <> 'CANCELLED' OR (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL)`;
  `status <> 'FAILED_OVER_CAP' OR failure IS NOT NULL`;
  `queued_count IS NULL OR queued_count >= 0`; `segments IS NULL OR segments BETWEEN 1 AND 3`.
- Grants: `SELECT, INSERT`, `UPDATE` on every column except `id`, `tenant_id`, `created_by_id`,
  `created_at`. No DELETE (money history).
- Sent and failed counts are read live from `sms_logs` grouped by status where
  `related_entity = 'broadcast:<id>'` (as reminders do), not stored (P6-C).
- RLS checklist as above; `packages/db/test/notices-rls.test.ts` covers it.

### `sms_broadcast_targets` (S I D)

Same shape and rules as `notice_targets`, with `broadcast_id → sms_broadcasts (tenant_id, id)`.
Targets apply to guardian recipients; a `STAFF` broadcast refuses targets (422 `TARGET_INVALID`).

---

## API

### `TenantSmsService.queueAll()` (new)

```ts
queueAll(inputs: QueueTenantSmsInput[], opts: { dailyCap: number; localDate: IsoDate }):
  Promise<{ outcome: 'QUEUED'; queued: number; duplicates: number }
        | { outcome: 'OVER_CAP'; needed: number; capLeft: number }>;
```

- One advisory lock (the same key as `queue()`), the duplicates skipped (existing keys), today's
  count, then **either** `createMany` of every new row as `QUEUED` and one `addBulk` after commit
  (job id = each `smsLogId`, as today), **or** nothing at all when `count + new > cap`.
- `queue()` is unchanged for the other purposes.

### Notices (`NoticesController`, CORE)

| Route                                      | Roles        | Purpose                                                                  | Errors                      |
| ------------------------------------------ | ------------ | ------------------------------------------------------------------------ | --------------------------- |
| `GET /notices`                             | every member | the board: visible notices, pinned first, then newest; `read` per notice |                             |
| `GET /notices/:id`                         | every member | one visible notice                                                       | 404 when not visible        |
| `POST /notices/:id/read`                   | every member | marks read (204, idempotent)                                             | 404                         |
| `GET /notices/unread-count`                | every member | `{count}` (cached, P6-I)                                                 |                             |
| `GET /notices/manage`                      | OWNER/ADMIN  | every notice with status, schedule, read counts                          |                             |
| `POST /notices`                            | OWNER/ADMIN  | a draft with targets                                                     | 422 validation              |
| `PUT /notices/:id`                         | OWNER/ADMIN  | edit text, audience, targets, expiry, pin                                | 409 `NOT_EDITABLE`          |
| `POST /notices/:id/publish` `{publishAt?}` | OWNER/ADMIN  | now or later (≤ 30 days)                                                 | 422 `SCHEDULE_OUT_OF_RANGE` |
| `POST /notices/:id/withdraw` `{reason}`    | OWNER/ADMIN  | hides it everywhere                                                      | 409 when already withdrawn  |
| `GET /notices/:id/reads`                   | OWNER/ADMIN  | read counts: staff and guardians, of how many                            |                             |

**Visible to a person** = `status = 'PUBLISHED' AND publish_at <= now AND (expires_at IS NULL OR
expires_at > now)` and:

- as staff (any staff role here): audience `ALL` or `STAFF`;
- as guardian: audience `ALL` or `GUARDIANS`, and either no targets or a target matching one of
  their children's current-year enrolments (class, or class and section; children ACTIVE and not
  deleted);
- a person with both roles sees the union, each notice once.

The rule lives in one service method used by the board, the detail, the unread count and the
read endpoint, with a pure helper `noticeVisibleTo()` in `@jantrik/shared` for its unit tests.

### Broadcasts (`BroadcastsController`, CORE, OWNER/ADMIN)

| Route                                                               | Purpose                                                                                                                            | Errors                                                                |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `GET /broadcasts`                                                   | list with status and live counts                                                                                                   |                                                                       |
| `GET /broadcasts/:id`                                               | one, with counts by SMS status                                                                                                     | 404                                                                   |
| `POST /broadcasts`                                                  | a draft (body, recipients, targets, optional notice)                                                                               | 422 `SMS_TOO_LONG`, `TARGET_INVALID`                                  |
| `PUT /broadcasts/:id`                                               | edit a draft or a scheduled one (rescheduling re-checks everything)                                                                | 409 `NOT_EDITABLE`                                                    |
| `POST /broadcasts/:id/preview`                                      | `{recipients, withoutPhone, mergedPhones, segments, encoding, costPaisa, capLeftToday, fits, quietNow, nextAllowedAt, sampleText}` |                                                                       |
| `POST /broadcasts/:id/send` `{expectedRecipients}`                  | send now = schedule at now                                                                                                         | 409 `PREVIEW_CHANGED`, 422 `OVER_CAP`, 422 `QUIET_HOURS`              |
| `POST /broadcasts/:id/schedule` `{scheduledAt, expectedRecipients}` | later                                                                                                                              | 409 `PREVIEW_CHANGED`, 422 `QUIET_HOURS`, 422 `SCHEDULE_OUT_OF_RANGE` |
| `POST /broadcasts/:id/cancel`                                       | a SCHEDULED one                                                                                                                    | 409 `ALREADY_SENDING` (the job holds the row), 409 `NOT_EDITABLE`     |

- Send and schedule record `preview_count`, `segments`, `estimated_cost_paisa`, `scheduled_at`,
  `scheduled_by_id`, status SCHEDULED; after commit: `queue.add('broadcast-send', {tenantId,
broadcastId}, {jobId: 'broadcast-<id>', delay, removeOnComplete: true, removeOnFail: 50})` and
  `ZADD notices:due <scheduledAt ms> <tenantId>|<broadcastId>`.
- Cancel sets CANCELLED (`BY_ADMIN`); after commit it removes the job and the zset member. A
  removal that fails is harmless: the job finds the status and stops.

### Jobs (`notices` queue, `NoticesProcessor`)

- **`broadcast-send`** (`TenantJobRunner.run(tenantId, …, {actorUserId: scheduled_by_id})`):
  1. the broadcast `FOR UPDATE`; not SCHEDULED → stop (`ZREM`);
  2. the actor still OWNER/ADMIN? Otherwise CANCELLED with `ACTOR_NOT_ADMIN`, nothing sent (S19);
  3. inside quiet hours now (the `Clock`)? → move `scheduled_at` to the next 08:00, re-add the job
     with the new delay and the zset score, stop;
  4. resolve the audience now (S19), build texts and dedupe keys;
  5. `queueAll()`: `QUEUED` → SENT with `queued_count`, `sent_at`, `local_date`; `OVER_CAP` →
     FAILED_OVER_CAP with `{needed, capLeft}`, nothing inserted;
  6. audit; after commit `ZREM`.
- **`notices-sweep`**, a job scheduler every 5 minutes (`upsertJobScheduler('notices-sweep',
{every: 300000})`): `ZRANGEBYSCORE notices:due -inf <now>`; for each member re-add
  `broadcast-send` with the same job id (a no-op while the job still exists). Members older than
  7 days are dropped. No SQL outside a tenant.
- **Heal on read:** `GET /broadcasts` in an institute re-queues its SCHEDULED broadcasts more than
  2 minutes overdue (the zset itself could be lost with Redis; P6-K).
- The `BROADCAST` relevance check (registered at init) answers false when the broadcast was
  cancelled (P6-L), so nothing queued for a broadcast cancelled later is sent.

---

## Web

- **Board `/notices`** (every member; new nav item `notices`, group `overview`, module CORE, no
  role limit, with the unread badge): cards with title, date, "pinned", "edited", unread dot;
  `/notices/[id]` the full text (line breaks kept), marked read on open.
- **Manage `/notices/manage`** (OWNER/ADMIN): the table (status chips: draft, scheduled, published,
  expired, withdrawn; read counts); `/notices/new` and `/notices/[id]/edit`: title, body,
  audience, class and section picker (current year), expiry, pin, "publish now" or a date and time
  in the institute's timezone; "also send as SMS" opens the broadcast composer prefilled.
- **Broadcasts `/broadcasts`** (OWNER/ADMIN): list; `/broadcasts/new` composer with a live
  counter (characters, segments, encoding; the 3-segment limit), recipients and targets, the
  preview panel (recipients, without phone, merged phones, segments, cost in ৳ with Bangla
  digits, today's cap left, "does not fit" in red), send now or schedule (quiet hours greyed);
  `/broadcasts/[id]` status with live counts.
- **Shell:** the badge reads `GET /notices/unread-count` after first paint, and again on focus at
  most every 5 minutes.
- **Dashboard:** a "Notices" card (pinned and the 3 newest) for every role; for OWNER/ADMIN a
  warning card when a broadcast failed over the cap or was cancelled because its admin lost the
  role in the last 3 days (S18 "told in-app", P6-D).

---

## Files

| File                                                                         | Change                                                                                   |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `packages/db/prisma/schema.prisma` + 2 migrations                            | `BROADCAST`; the five tables and enums                                                   |
| `packages/db/test/notices-rls.test.ts`, `schema-safety.test.ts`              | DB tests                                                                                 |
| `packages/shared/src/notices.ts` (+ `.test.ts`), `index.ts`                  | quiet hours, `noticeVisibleTo`, schemas, `broadcastProblems` (segments)                  |
| `apps/api/src/sms/tenant-sms.service.ts` (+ spec)                            | `queueAll`                                                                               |
| `apps/api/src/notices/*`                                                     | module, controllers, `NoticesService`, `BroadcastsService`, `AudienceService`, processor |
| `apps/api/test/notices.e2e-spec.ts`, `broadcasts.e2e-spec.ts`                | API tests                                                                                |
| `apps/web/src/app/(app)/notices/**`, `broadcasts/**`, `components/notices/*` | pages                                                                                    |
| `apps/web/src/lib/navigation.ts`, `components/app-shell.tsx`, dashboard      | nav, badge, cards                                                                        |
| `apps/web/messages/notices/*.json`, `route-messages.ts`, `load-messages.ts`  | strings                                                                                  |
| `apps/web/e2e/notices.spec.ts`                                               | Playwright                                                                               |
| `docs/notices.md` (new), `docs/database.md`, `docs/decisions-pending.md`     | docs                                                                                     |

---

### Task 1: Database

**Files:** schema, the two migrations, `packages/db/test/notices-rls.test.ts`,
`schema-safety.test.ts`.

- [ ] **Step 1: Failing tests:**
  - isolation for all five tables (B sees none of A's rows; a target naming B's class or a
    section of another class → foreign key violation);
  - `notice_reads`: inserting a row for another user → refused by the restrictive policy; the
    same read twice with `ON CONFLICT DO NOTHING` → one row; no UPDATE or DELETE;
  - no DELETE on `notices` and `sms_broadcasts`; `notice_targets` DELETE allowed;
  - each CHECK (published without `publish_at`, withdrawn without who, expiry before publish,
    SENT without `queued_count`, CANCELLED without a reason, a 0- or 4-segment value, a 151
    character title);
  - the app may not change `created_by_id` of a broadcast (column grants);
  - `sms_purpose` has `BROADCAST`; the tables are in the tenant table list.
- [ ] **Step 2: Run** `pnpm --filter @jantrik/db exec vitest run test/notices-rls.test.ts`: FAIL.
- [ ] **Step 3: Schema and migrations** (`migrate dev --create-only` for each, `ls -t`; the enum
      value alone in the first).
- [ ] **Step 4: Pass**, then the db suite.
- [ ] **Step 5: Commit:** "Notices, reads, targets and SMS broadcasts with forced RLS; reads only
      for oneself; the BROADCAST SMS purpose (P6)".

### Task 2: Shared rules (quiet hours, visibility, SMS length)

**Files:** `packages/shared/src/notices.ts`, `notices.test.ts`, `index.ts`.

**Interfaces:**

- `QUIET_HOURS = { start: '21:00', end: '08:00' }`;
- `inQuietHours(at: Date, timeZone: string): boolean`;
- `nextAllowedAt(at: Date, timeZone: string): Date` (at itself when allowed, else the next 08:00);
- `noticeVisibleTo(notice, viewer, now): boolean` where `viewer = { staff: boolean; children:
{classLevelId, sectionId}[] }`;
- `broadcastProblems(body): ('EMPTY' | 'SMS_TOO_LONG')[]`;
- zod schemas for notices and broadcasts (server only; the web gets types).

- [ ] **Step 1: Failing tests:** Asia/Dhaka 20:59 → allowed, 21:00 → quiet, 23:30 → next 08:00 the
      next day, 07:59 → quiet, 08:00 → allowed; the same in a zone with summer time
      (`Europe/London` across the October change) so nothing assumes UTC+6; visibility for staff,
      guardian with a matching section, guardian with a matching class only, a both-roles viewer,
      expired, not yet published, withdrawn; a Bangla body of 201 UTF-16 units → 3 segments ok,
      202 → `SMS_TOO_LONG`; 459 GSM-7 characters ok, 460 refused.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit:** "Quiet hours in the institute's timezone, who sees a notice, and the
      3-segment SMS limit, as shared pure functions (S18)".

### Task 3: `TenantSmsService.queueAll`

**Files:** `apps/api/src/sms/tenant-sms.service.ts`, `apps/api/test/sms-queue-all.e2e-spec.ts`.

- [ ] **Step 1: Failing tests:** cap 10 with 4 used → 6 new rows QUEUED and 6 jobs after commit;
      7 new → `OVER_CAP {needed: 7, capLeft: 6}` and zero rows; 2 of the 7 already sent (their
      dedupe keys) → 5 new fit; rolled back with the transaction → no rows and no jobs; a
      concurrent `queue()` (an absent SMS) waits on the lock and is counted.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit:** "TenantSmsService.queueAll: a batch of SMS queued whole or not at all
      under the institute's SMS lock (S18)".

### Task 4: Notices API

**Files:** `apps/api/src/notices/{notices.module,notices.controller,notices.service}.ts`,
`apps/api/test/notices.e2e-spec.ts`.

- [ ] **Step 1: Failing tests** (review focus 5): the visibility cases above through the API;
      a scheduled notice invisible until its time (fake `Clock`), then visible without any job;
      withdrawn and expired hidden from the board but in `/notices/manage`; another institute's
      id → 404; a teacher cannot create (403); a guardian cannot read `/notices/manage` (403);
      read marks are idempotent and the unread count follows; editing a withdrawn notice → 409
      `NOT_EDITABLE`; a published notice edited → `edited_at` set, reads kept; every change
      audited; the unread count is served from Redis on the second call and changes after a new
      publish (version bump) and after a read (own key dropped).
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit:** "Notices: drafts, publish now or later, withdraw, targets by class and
      section, the board, reads and a cached unread count (S20)".

### Task 5: Broadcasts API (draft, preview, send, schedule, cancel)

**Files:** `broadcasts.controller.ts`, `broadcasts.service.ts`, `audience.service.ts`,
`apps/api/test/broadcasts.e2e-spec.ts`.

- [ ] **Step 1: Failing tests:**
  - preview: two siblings with one guardian phone → 1 SMS (`mergedPhones: 1`); a student without
    a guardian phone → `withoutPhone`; ALL_GUARDIANS counts each guardian; STAFF counts each
    staff person once; segments and cost from the platform rate; `fits` against the cap left;
  - review focus 1: cap left 5, audience 6 → preview `fits: false`, send → 422 `OVER_CAP`, no
    rows;
  - send with a different count → 409 `PREVIEW_CHANGED`;
  - quiet hours: scheduling at 22:00 → 422 `QUIET_HOURS` with `nextAllowedAt` 08:00; send now at
    21:30 (fake clock) → 422; at 08:00 → accepted;
  - schedule in 3 minutes or in 31 days → 422 `SCHEDULE_OUT_OF_RANGE`;
  - a 4-segment body → 422 `SMS_TOO_LONG`; targets on a STAFF broadcast → 422;
  - cancel a scheduled one → CANCELLED, the job gone, no SMS later; cancel a sent one → 409;
  - teacher → 403; another institute's broadcast → 404; audit rows with counts and cost and no
    phone numbers.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit:** "SMS broadcasts: preview with segments, cost and the cap left; send now
      or schedule outside quiet hours; cancel (S18, S20)".

### Task 6: The send job and the sweep

**Files:** `notices.processor.ts`, `broadcasts.service.ts`, `apps/api/test/broadcasts-job.e2e-spec.ts`.
The tests call the processor's handlers directly with the fake `Clock` (BullMQ's own delays run
on real time).

- [ ] **Step 1: Failing tests:**
  - due job → SENT, one `sms_logs` row per phone with key `broadcast:<id>:<phone>`, purpose
    BROADCAST, `related_entity = 'broadcast:<id>'`;
  - review focus 1 at send time: the cap used up meanwhile → FAILED_OVER_CAP, zero rows, the
    dashboard warning lists it;
  - review focus 2: the handler run twice → the second is a no-op; the job removed from Redis
    by hand → the sweep re-adds it and it sends once; the zset member removed after success;
  - review focus 3: due at 23:30 Dhaka → rescheduled to 08:00 the next day with a new delay and
    score; at 08:00 it sends;
  - review focus 4: a student enrolled after scheduling gets the SMS, one who left before
    sending does not; the scheduling admin demoted to TEACHER → CANCELLED `ACTOR_NOT_ADMIN`,
    nothing sent;
  - cancelled after SENT is not possible, but a queued SMS of a broadcast later marked cancelled
    by a test is dropped by the relevance check (P6-L);
  - Bangla segment counts on the stored rows match `smsLength`.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit:** "The broadcast job: audience at send time, whole or nothing over the cap,
      quiet hours respected, safe to run twice, and a sweep for lost jobs (S18, S19)".

### Task 7: Web

**Files:** pages, components, navigation, shell, dashboard, messages, `apps/web/e2e/notices.spec.ts`.

- [ ] **Step 1: Failing Playwright spec** (bn; 1366 and 390 px): the admin publishes a notice for
      class 6 → a class 6 guardian sees the badge `১`, opens it, the badge goes; a class 7
      guardian does not see it; the admin composes a Bangla broadcast (the counter shows 2
      segments), previews (cost in Bangla digits, cap left), sends; the SMS outbox has one SMS
      per phone (siblings merged).
- [ ] **Step 2–4:** FAIL, implement (v3 kit), PASS; screenshots bn 1366 and 390 px; the guardian
      dashboard's time to interactive unchanged (the badge loads after first paint).
- [ ] **Step 5: Commit:** "The notice board with unread badge, notice management and the SMS
      broadcast composer".

### Task 8: Docs

- `docs/notices.md` (new): who sees what, scheduling, quiet hours, the cap rule, the job and the
  sweep, cancel, costs.
- `docs/database.md`: the five tables, the own-reads policy, no DELETE on notices and broadcasts.
- `docs/decisions-pending.md`: P6-A to P6-N as decided.
- [ ] `pnpm format:check`; commit "Docs for notices and SMS broadcasts (sprint 1 P6)".

### Task 9: Gates, review, PR

- [ ] Full gates; review subagent (SMS money, DB): review focus 1–5 and that no path inserts part
      of a broadcast.
- [ ] Fix with failing tests first; PR; CI green; not merged by Claude.

## Size and split

**Medium**, as the sprint plan says, but with two different risks. Recommended as **two PRs**
(P6-split): **P6a notices** (Tasks 1 without the broadcast tables, 2, 4, the board half of 7)
and **P6b broadcasts** (the broadcast tables and `BROADCAST`, 3, 5, 6, the composer half of 7).
P6a costs no money and can merge first.

## Risks

- **No SMS gateway yet:** broadcasts are tested with the memory and outbox providers; production
  sends nothing until the gateway exists (the existing go-live blocker).
- **The cap counts messages, not segments** (existing rule): a 3-segment broadcast costs three
  times but uses one place per phone. The preview shows both.
- **A large audience in one transaction:** 3 000 phones → one `createMany` and one `addBulk`,
  well inside 15 s; measured in Task 6 with a 3 000-recipient fixture.
- **Redis loss:** with AOF `everysec` (deploy.md) a crash loses at most a second; a wiped Redis
  loses jobs and the zset together, which heal-on-read and the dashboard's "overdue scheduled"
  line cover until an admin opens the page (P6-K).
- **Guardian performance:** the unread count is one indexed query per user every few minutes
  (cached); the board is not on the dashboard's critical path.

## Self-review

- **Spec coverage (sprint-1.md P6):** tables (Task 1, with P6-A and P6-C refinements); BROADCAST
  in its own migration (Task 1); reuse of the SMS service with dedupe per phone (Tasks 3, 6);
  preview → send with `PREVIEW_CHANGED`, count, segments, cost, cap left (Task 5); all or nothing
  with FAILED_OVER_CAP and an in-app warning (Tasks 3, 5, 6, 7); quiet hours (Tasks 2, 5, 6);
  3 segments (Task 2); delayed job with the id, the zset sweep, no cross-tenant SQL (Task 6);
  audience at send time and the actor check (Task 6); the board, guardians by children's
  classes, unread count cached per user, dashboard card, no push (Tasks 4, 7); OWNER/ADMIN (all
  tasks); the listed tests (Tasks 2–7).
- **Names:** `queueAll`, `inQuietHours`, `nextAllowedAt`, `noticeVisibleTo`, `broadcast-send`,
  `broadcast-<id>`, `notices:due`, `notices-sweep`, `broadcast:<id>:<phone>`, `OVER_CAP`,
  `QUIET_HOURS`.

## Decisions for the owner

S18–S20 stand. These are new; each default is what the plan builds unless you change it.

| #     | Decision                                     | Recommended default                                                                                                                                                                                                              | Alternative                                                                      |
| ----- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| P6-A  | Scheduled notices                            | No `SCHEDULED` status for notices: a PUBLISHED notice with a future `publish_at` is "scheduled", visible when its time comes, no job (a refinement of the sprint plan's table, which listed SCHEDULED and a job for notices too) | Keep SCHEDULED with a job that flips it                                          |
| P6-B  | How a broadcast is sent                      | One transaction for the whole audience through a new `queueAll` (the only way to be all or nothing; the reminders' 25-per-transaction pattern cannot be)                                                                         | Chunks with a cap reservation row                                                |
| P6-C  | Broadcast statuses and counts                | `SENDING` is not stored (sending happens inside one transaction); sent, failed and cancelled counts are read from `sms_logs`, not stored on the broadcast                                                                        | Store counts, updated by the SMS worker                                          |
| P6-D  | "Told in-app" when a send fails over the cap | A dashboard warning card for OWNER/ADMIN for 3 days, plus the status on the broadcasts page                                                                                                                                      | An SMS to the admin (costs the cap it just ran out of)                           |
| P6-E  | Quiet hours                                  | Fixed 21:00–08:00 for every institute this sprint                                                                                                                                                                                | A per-institute setting now                                                      |
| P6-F  | "Send now" during quiet hours                | Refused with the next allowed time offered (schedule for 08:00)                                                                                                                                                                  | Allowed for OWNER as "urgent" (e.g. a closure announced at night)                |
| P6-G  | What targets narrow                          | Only guardians; staff see ALL/STAFF notices whatever the targets                                                                                                                                                                 | Class teachers only for targeted staff notices                                   |
| P6-H  | Staff phone for SMS                          | The login phone (`users.phone`) of each ACTIVE staff member                                                                                                                                                                      | The staff profile's phone when set                                               |
| P6-I  | Unread count freshness                       | Cached 2 minutes per user under the institute's notice version (bumped on publish, edit, withdraw); own reads drop the cache                                                                                                     | No cache (one query per page view)                                               |
| P6-J  | Links in notices                             | Shown as text, not clickable (phishing in a school's name)                                                                                                                                                                       | Clickable links                                                                  |
| P6-K  | A Redis that lost everything                 | Re-queue on the next admin visit (`GET /broadcasts` heals overdue ones) and show "overdue scheduled" on the dashboard                                                                                                            | A narrow definer function listing due broadcasts across institutes for the sweep |
| P6-L  | Stopping SMS already queued                  | Not offered in P6 (only a scheduled broadcast can be cancelled); the relevance check is ready for it                                                                                                                             | "Stop" for a sent broadcast's still-queued SMS                                   |
| P6-M  | SMS text                                     | Exactly what the admin types; the composer starts it with the institute's short name and a colon, which they may delete                                                                                                          | A fixed prefix added by the server                                               |
| P6-N  | Editing a published notice                   | Allowed (audited, marked "edited", reads kept)                                                                                                                                                                                   | Withdraw and publish a new one                                                   |
| split | One PR or two                                | Two: P6a notices, P6b broadcasts                                                                                                                                                                                                 | One PR                                                                           |

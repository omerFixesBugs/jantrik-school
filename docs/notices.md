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
  read it (P6-N). Targets are replaced whole.
- **Withdraw** (`POST /notices/:id/withdraw {reason}`): off every board at once, kept for the
  record, never edited again (409 `NOT_EDITABLE`). Notices are never deleted (no DELETE grant).
- Every create, edit, publish and withdrawal writes an audit entry (title, audience, targets, pin,
  expiry and the body's length; never the body itself).

## Reads and the unread count

- Opening a notice marks it read (`POST /notices/:id/read`, idempotent, only for oneself: the
  database refuses a read row for anyone else).
- `GET /notices/unread-count` is cached in Redis per person for 2 minutes under the institute's
  notice version (`tenant:<id>:notices:ver`), which every publish, edit and withdrawal bumps after
  commit; marking a notice read drops the person's own entry (P6-I). A scheduled notice that
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

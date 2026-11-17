# Admission (sprint 1 P3)

Guardians apply for a child during an institute's admission window; staff see the applications,
shortlist or reject them, and approve them into a student and guardian with today's `admit()`.
This file is the staff side (P3a). The public form (P3b) adds its own section.

Plan: `docs/plans/sprint-1-p3-admission.md` (PR #15). Decisions taken while building:
[decisions-pending.md](decisions-pending.md) → "Sprint 1, P3: online admission".

## Who and where

- **Module and roles:** every route is `@RequireModule('CORE')` and `@Roles('OWNER', 'ADMIN')`.
  Teachers, accountants and guardians get 403; another institute's ids are 404.
- **Web:** `/admission` (cycles), `/admission/cycles/[id]` (`new` makes one),
  `/admission/applications` (list, search, CSV, bulk approval), `/admission/applications/new`
  (walk-ins), `/admission/applications/[id]` (detail, edit, status, photo, approve). The menu item
  "ভর্তি / Admission" is shown to OWNER/ADMIN only. Texts: `messages/admissions/staff.*.json`
  (namespace `admissions.staff`), plus the student form's `admission` labels.

## Cycles

- A **cycle** admits for one academic year (usually next year). It starts as `DRAFT`; `OPEN`
  needs at least one class (422 `CYCLE_HAS_NO_CLASSES`); `CLOSED` stops the form. The public form
  takes applications while the cycle is `OPEN` and `opens_at <= now < closes_at`
  (`takingApplications` in the API; the window is typed in Bangladesh time).
- **Classes:** `PUT /admission/cycles/:id/classes` replaces the list (each class, and group, once).
  A class with applications cannot be removed (409 `CLASS_HAS_APPLICATIONS`). Seats are shown to
  staff only; a closed class takes no applications.
- **The admission test** (`requires_test`, P4) and the year cannot change once applications
  exist (409 `CYCLE_HAS_APPLICATIONS`).
- **Form fields** (`fields`, decision P3-Q): each optional field is `HIDDEN`, `OPTIONAL` or
  `REQUIRED` (a CHECK allows only the known keys and these values). Always asked: a name (Bangla or
  English), the date of birth, the gender, the guardian's name, relation and phone. Defaults: all
  optional, blood group hidden; the photo only when the cycle collects photos (S9).

## Applications

- **Numbers** are `<year>-<NNNN>` (the year the cycle's academic year starts; more digits past
  9999), unique per institute and year (decision P3-G), from `admission_counters` (one
  `INSERT … ON CONFLICT … RETURNING`, so concurrent takers get distinct numbers with no gap).
- **Walk-ins** (decision P3-J): staff type an application (`source STAFF`); the cycle's required
  fields apply except the photo, which is added afterwards (`PUT …/photo`, the P2 upload pipeline:
  re-encoded JPEG ≤ 600×800 and ≤ 200 KB, no EXIF). Staff may fill fields the cycle hides.
- **Duplicates and the phone cap** (shared with the public form): under a per-institute, per-phone
  advisory lock, then one per birth registration number in the cycle (two phones, one child, at
  the same moment; backed by the unique index `admission_applications_birth_reg_live`), an application in the same cycle (not withdrawn) with the same birth registration
  number, or the same phone + name key + date of birth, is a duplicate: 409 `ADMISSION_DUPLICATE`
  with its number (P3-S). A phone may have three live applications (not withdrawn, not rejected)
  per cycle: the fourth is 422 `ADMISSION_PHONE_CAP`. The name key is the Bangla name (else the
  English one) in NFC, lower case, without spaces.
- **History:** applications are never deleted (no DELETE grant); the number, source, cycle and
  submission time never change (column grants). Edits are audited with old and new values; a class
  may move only within the cycle (the composite foreign key). An admitted application cannot be
  changed (409 `APPLICATION_ADMITTED`).
- **Status:** staff set `SUBMITTED`, `SHORTLISTED`, `SELECTED` (only in a cycle without an
  admission test: with one, the merit list selects, P4; 409 `SELECTED_BY_TEST`), `REJECTED`
  (reason required) or `WITHDRAWN` (reason required). `ADMITTED` is set by approval only. Each
  change keeps who, when and why, and is audited. Any move out of `WITHDRAWN` (to `REJECTED`
  too: a rejected application still counts as a duplicate) runs the duplicate check again, and
  bringing a withdrawn or rejected application back to a live status also runs the per-phone cap
  (review S1, round 2 NIT 5). An edit cannot empty a field the cycle requires (422
  `ADMISSION_FIELDS_REQUIRED`). A staff entry takes the cycle's shared lock before it reads the
  cycle (round 2 NIT 2), so a cycle edit that commits first is always seen.
- **List and CSV:** filters (cycle, class, status, source) and a search on the names, the phone
  (Bangla digits accepted) and the number. The CSV has a BOM and ASCII digits, at most 10 000
  rows.

## Approval

- `POST /admission/applications/:id/approve` `{sectionId?, roll?, studentCode?, guardianId?,
createNew?}` runs in the staff member's request transaction: the application row is locked
  (`FOR UPDATE`), it must be approvable (without a test: `SUBMITTED`, `SHORTLISTED` or `SELECTED`;
  with one: `SELECTED`, P3-H) and not yet a student, then `StudentAdminService.admit()` makes the
  student in the cycle's year and class, with the application's guardian as primary guardian
  (and a login). All of `admit()`'s checks apply (student limit, section, capacity, roll, birth
  registration and code unique). A phone the institute already knows answers 409
  `GUARDIAN_CHOICE_REQUIRED` with nothing written; the dialog then offers that phone's guardians
  or a new one.
- **The photo** moves into `FileStore` as the student's photo and the application's copy is
  deleted (decision P3-B). When the institute's image storage is full the student is made without
  it and the photo stays on the application (P3-V, `photo: 'STORAGE_FULL'`).
- **One application, one student:** two approvals at once, or an approval during a bulk run, make
  one student; the other gets 409 (`ALREADY_ADMITTED`), or the bulk job skips it (review focus 5).
- **Bulk approval** (decision P3-T) approves the class's **SELECTED** applications only (the
  approved sprint plan; review S2): `POST /admission/cycle-classes/:id/bulk-approve {sectionId}`
  queues one job per class (`admission` queue, job id `admission-approve-<class id>`; 409
  `BULK_RUNNING` while one runs). The job acts as the admin who started it (their OWNER/ADMIN role
  is checked again for each application) and approves each application in its own transaction,
  only if it is still `SELECTED` under the row lock (round 2 NIT 7: one moved back to shortlisted
  meanwhile is skipped). A guardian choice or a duplicate birth registration number is recorded on that
  application (`approval_problem`) and skipped; the student limit, a full section or a deactivated
  class or section stops the run and marks the rest. A re-run picks up what is left. `GET` the same
  path for `{running, admitted, problems}`.

## Dues for a December admission (review focus 5)

A child admitted (by staff or from an application) into a year that has not started and is not
current yet (in December, for January) owes from that year's start: `admit()` records it in
`students.admission_date_for_dues` (decision P3-K, as fixed after the review: M1). An approved
application records it even when the institute already marked that year current (round 2 NIT 6,
P3-a18: an application is always a new child). So the admission fee is due `year start + offset`
(not already late) and the first month is not extended as for a late joiner. The recorded date
counts only for a year that starts on or after it; for an earlier year the dues count from the day
the child joined (P3-a19). Nothing is derived for anyone else: imports, existing students and staff
admissions into the current year keep the creation day, exactly as before. See [fees.md](fees.md).

## Database

Tables (all with `tenant_id`, forced RLS calling the signed context wrapped, composite foreign
keys `ON UPDATE/DELETE RESTRICT`):

| Table                          | jantrik_app      | Notes                                                    |
| ------------------------------ | ---------------- | -------------------------------------------------------- |
| `admission_cycles`             | S I U            | window CHECK, fields CHECK (keys and values), no DELETE  |
| `admission_cycle_classes`      | S I U D          | each class and group once per cycle; DELETE while empty  |
| `admission_applications`       | S I, U by column | history (no DELETE); CHECKs mirror the shared schemas    |
| `admission_application_photos` | S I D            | JPEG ≤ 200 KB, until approval moves it to `stored_files` |
| `admission_counters`           | S I U            | last number per institute and year                       |

`sms_purpose` gains `ADMISSION_OTP` and `ADMISSION_SUBMITTED` (used by P3b).

## The public form (P3b)

A guardian applies from a phone, without an account: `/apply/<institute slug>` (bn by default,
an en switch; light, no app shell, no session restored) and `/apply/<slug>/status`. The cycle page
shows the address to share.

- **Steps:** class → phone → code → the form → check → submitted, with the slip (application
  number; print or save). The status page asks for the number, then a code to the phone that
  applied (decision P3-F).
- **The database** is reached only through three `SECURITY DEFINER` functions owned by the
  NOLOGIN role `jantrik_admission` and run by `jantrik_app` with no institute and no person
  (decision S4; a public request never opens an institute's transaction, P3-C):
  - `admission_public_form(slug, now)`: the institute (ACTIVE or TRIAL) and its cycles taking
    applications now, with their open classes; no person's data. (It also returns the
    institute's id and timezone, which the API keeps to itself.)
  - `admission_submit(slug, cycle class, phone, payload, photo, width, height, now)`: one row,
    `CREATED` with the number, or `UNKNOWN`, `CLOSED` (also for another institute's class),
    `INVALID`, `PHONE_CAP` (checked first) or `DUPLICATE`, with the earlier number **only when that
    application has the same phone** (otherwise "already applied, contact the institute": a
    stranger who types another family's birth registration number learns nothing). The same
    duplicate and per-phone rules as the staff entry, under the same locks in the same order (the
    cycle's, shared; the phone's; one per birth registration number).
  - `admission_lookup(slug, number, phone)`: the status, only for that phone.
    The role sees rows only through `TO jantrik_admission` policies and column grants
    (`schema-safety.test.ts` pins them exactly).
  - `admission_submit` resolves the class's cycle, takes the cycle's shared lock, and only then
    reads the cycle to check it (status, window, open class; review round 2): a cycle edit that
    committed while it waited is always seen.
- **Changing these functions later** (P4's `admission_lookup`, for one): only the owner,
  `jantrik_admission`, can replace them, and migration `20261117110100` revoked its `CREATE` on
  schema `public`; `jantrik_owner` holds the role `WITH INHERIT FALSE, SET TRUE`. So the migration
  does, in one transaction:

  ```sql
  GRANT CREATE ON SCHEMA public TO jantrik_admission;
  SET ROLE jantrik_admission;
  CREATE OR REPLACE FUNCTION public.admission_lookup(...) ...;  -- the same signature
  RESET ROLE;
  REVOKE CREATE ON SCHEMA public FROM jantrik_admission;
  ```

  The same signature keeps the grants (`EXECUTE` to `jantrik_app` only). A new signature is a new
  function: drop the old one under the same `SET ROLE`, then `REVOKE ALL … FROM PUBLIC` and
  `GRANT EXECUTE … TO jantrik_app` on the new one, and update the exact privilege list in
  `schema-safety.test.ts`.

- **The phone:** `POST /public/admission/:slug/otp {phone, turnstileToken}` sends a 6-digit code
  (5 minutes, 5 attempts, single use; HMAC in Redis) to any valid Bangladeshi mobile;
  `POST …/otp/verify {phone, code}` returns a phone token (HS256 with its own key derived from
  `JWT_ACCESS_SECRET`, `typ: admission-phone`, audience the institute, 30 minutes, decision P3-N)
  for the `X-Admission-Token` header. It is never an access token, and an access token never works
  here. A status code (below) has its own slot in Redis and verifies only with
  `purpose: 'status'`, into a **status token** (`typ: admission-status`): only `POST …/status`
  accepts it, and `…/status` accepts nothing else; the submit (and its upload guard, before the
  body is read) accepts only the form's token (review round 2, second follow-up).
- **Limits (review focus 1):** a code request first passes a per-address limit (60 an hour,
  before the database or Cloudflare is reached), then Turnstile (a refused token uses no code
  counter), then per address 20 an hour and per phone one a minute
  (`ADMISSION_OTP_PHONE_COOLDOWN_SEC`, 60); the shared budgets, per phone 5 a day (across
  institutes) and per institute the form's share of `ADMISSION_OTP_PER_TENANT_PER_DAY` a day
  whatever the phones and addresses, are checked together and spent **only by a code that is
  sent** (one atomic Redis script), so refused requests can never exhaust an institute's day.
  `ADMISSION_OTP_PER_TENANT_PER_DAY` (300) caps **all** of an institute's codes in a day: the
  status page has a fixed fifth (60), the form the rest (240), so the total never exceeds it
  (`admissionOtpCeilings`).
- **The status page** asks for a code with the application number (`purpose: 'status'`): it
  works after the form closed, and the code is sent only when that phone made that application;
  the answer is the same either way, **in every budget state, and leaves no trace** (review
  round 2 and its follow-ups): a status code spends budgets of its own (per phone 5 a day across
  institutes, per institute the status page's fifth of the ceiling), which the form's code
  requests never read, and it is sent after the answer (not awaited). So neither the answer (202 `{expiresIn: 300}`, no
  `Retry-After`), nor its time, nor any later request's answer depends on whether the pair
  matched; a spent status budget sends nothing (the guardian tries the next day). The form: 60 a
  minute per address; submit 10 an hour per address and 10 a day per phone; status 30 an hour per
  address and 20 a day per phone.
- **Bots (S6):** Turnstile on every code and every submit (each needs its own token); a hidden
  `website` field (the honeypot); and the form ticket from `GET`: a submit under 15 s or over 2 h
  after the form opened gets the same vague 422 `ADMISSION_REJECTED` as a filled honeypot
  (decision P3-L). Turnstile fails closed: Cloudflare unreachable in 5 s → 503.
- **The photo:** multipart, read only after a guard checked the per-address submit limit and the
  phone token's signature and expiry; at most 5 MB (refused while it streams), re-encoded by P2's pipeline
  (JPEG ≤ 600×800, ≤ 200 KB, no EXIF), at most two decodes at a time per process. Only the
  re-encoded bytes reach the database.
- **SMS** (decision P3-C, queue `admission-sms`, run by the worker in the institute's own
  context): the code is logged in the institute's `sms_logs` (`ADMISSION_OTP`, the code masked),
  sent outside the institute's daily cap but counted in the day's total (P3-D); "application
  received" (`ADMISSION_SUBMITTED`, S11) goes through the normal per-institute queue and is skipped
  over the cap (the slip is on screen). In development and tests the SMS go to the console, memory
  or outbox providers only.
- **Turnstile checks** a real widget's answer for our action (`admission-otp` or
  `admission-submit`) and the web app's host (from `WEB_PUBLIC_URL`); Cloudflare's test secrets
  report neither and are accepted only outside production.
- **Public answers** carry `Cache-Control: no-store`.
- **Turnstile keys:** development uses Cloudflare's published always-pass **test keys**
  (`.env.example`); the API and Playwright tests use a fake verifier (`TURNSTILE_PROVIDER=fake`,
  test only) and never call Cloudflare; production needs a real widget's keys (the API refuses the
  test secrets there). Without a site key built into the web app, the form shows a plain
  "I am not a robot" box that only the fake verifier accepts.

## The admission test (P4)

For a cycle with `requires_test` (P3), per class: staff (OWNER/ADMIN only, decision P4-L) set the
test, issue rolls, print admit cards, enter one total score per applicant (S12), build and publish
the merit list, tell applicants by SMS, and move the waitlist up. Applicants see the published
result on the status page behind their status code (S13). Routes under `/admission`, page
`/admission/cycle-classes/[id]/test` (linked from the cycle page).

- **Setup** (`PATCH /admission/cycle-classes/:id/test`): date, time (the institute's local time),
  venue (bn/en), full marks (1–1 000), pass marks (empty: nobody fails), seats (`select_count`) and
  the waitlist size. 422 `TEST_NOT_REQUIRED` on a cycle without a test, `PASS_ABOVE_FULL`; 409
  `SCORES_ABOVE_FULL` when the full marks would drop below (or away from) a score already entered
  (a trigger, `full_marks_keep_test_scores`, backs it). Audited (`admission_test_setup`).
- **Rolls** (`POST …/test-rolls {startAt?}`, decision P4-C): SUBMITTED and SHORTLISTED
  applications without a roll, by application number (year, then number), from the last roll + 1
  (or `startAt`, 1 by default, the first time). An issued roll never changes, and an application
  with a roll cannot move to another class (409 `HAS_TEST_ROLL`). Unique per class.
- **Admit cards** (`GET …/admit-cards?from&to`, P4-K, staff print only P4-N): the institute's
  name and logo (P2), cycle, class, name, application number, the roll (large, ASCII), the photo
  when there is one, date, time and venue, a note and two signature lines; two to an A4 inside the
  exams' print area (`@page exam-a4`). 422 `ROLLS_NOT_ISSUED`.
- **Scores** (`GET`/`PUT …/scores`, up to 500 rows, all checked before any is saved): as typed
  (Bangla digits, two decimals at most, `a`/`অ` for absent; `parseMarks`), in hundredths within
  the full marks (the trigger `test_score_within_full_marks` backs it). 422 `NO_ROLL`,
  `SCORE_OUT_OF_RANGE`, `SCORE_INVALID`, `SCORE_AND_ABSENT` (each with the `applicationId`),
  `TEST_NOT_CONFIGURED` (no full marks). Every change is audited with old and new values
  (`admission_test_score`, rule 6); the grid saves the changed rows in chunks of 500.
- **The merit list** (`POST …/merit`, a draft; `GET …/merit`): `admissionMerit()` in
  `packages/shared/src/admission-test.ts`. Absent and below the pass marks are unranked (ABSENT,
  FAILED, P4-D). The rest by score, then the cycle's tie-break (`OLDER_FIRST` default,
  `YOUNGER_FIRST`, each then the earlier submission; `NONE`: shared places, P4-A); equal rows share
  a place and the next skips (1, 2, 2, 4). Places up to the seats are SELECTED, everyone tied on
  the last of them too (a warning: `boundaryTie`, P4-B); the next ones WAITLISTED with positions
  (ties shared the same way, `waitlistTie`), the rest NOT_SELECTED. 422 `SCORES_MISSING {count}`.
  **No status changes** (P4-E). In the list: applicants with a roll and a status in play
  (SUBMITTED, SHORTLISTED, SELECTED, WAITLISTED, ADMITTED) or REJECTED by an earlier publish;
  withdrawn ones and those rejected by staff for another reason are left out (P4-a4).
- **Publish** (`POST …/publish {builtAt}`): refused unless the draft the admin saw is the latest
  and still matches every input (409 `MERIT_NOT_BUILT`, `MERIT_STALE`: a hash of the settings, the
  tie-break and each ranked applicant's score, absence, date of birth and submission time, P4-a3).
  It locks every applicant with a roll (id order) before reading them, so a withdrawal or an
  approval that commits while it waits is seen: the inputs differ (`MERIT_STALE`) or the
  ADMITTED status is kept; its update also requires the status it read. A build is published
  once (409 `ALREADY_PUBLISHED`; build again after a change).
  Version + 1; statuses become SELECTED, WAITLISTED or REJECTED with the reason `NOT_SELECTED`,
  `FAILED` or `ABSENT` (P4-E); the published snapshot is copied (`result_*`); an ADMITTED applicant
  keeps their status and, when the list no longer selects them, is flagged
  `ADMITTED_NOT_SELECTED` for staff (P4-F); one audit row (`admission_merit_publish`: version,
  counts, the ids by outcome). Republishing after a correction is allowed (P4-F, P4-J: the page
  shows "changed since publish" until then). Only a published SELECTED applicant can be approved
  (P3-H); the tie-break of a cycle is fixed once any of its classes published (409
  `RESULTS_PUBLISHED`).
- **The result SMS** (`GET …/result-sms/preview`, `POST …/result-sms {expected}`,
  `GET /admission/result-sms/:runId`): the exams' pattern. Recipients: applicants of the published
  version whose status (SELECTED, WAITLISTED, or REJECTED by the test) differs from what their last
  result SMS told them (the first time: everyone). Told means an SMS that went out, or one of this
  version still waiting: a cancelled (by a republish) or failed one is owed again, and each run
  has its own dedupe key, so it really goes. The text has the outcome, the place or waitlist
  position, the application number and the status link, never the score (P4-H). The preview shows
  the count, the segments and cost of what the cap lets through today, the cap left and how many
  would be skipped; the send must match
  (409 `PREVIEW_CHANGED`); a job on its own queue (`admission-results`, 25 per transaction, acting
  as the admin, role checked again) queues them with `overCap: SKIP` (over the cap they are
  skipped, never held, and stay in the next preview). An SMS still waiting is cancelled when its
  version is no longer published or the applicant's status moved on. **The daily cap is the
  institute's shared one** (2 × active students unless set): an institute with no students yet must
  set a cap before result SMS can go out (the preview shows 0 left; P4-a11).
- **Waitlist** (`POST …/move-up`, P4-G): a staff action. When a seat is free (selected + admitted
  below the seats), the first on the published waitlist becomes SELECTED (everyone sharing that
  position, P4-a7), the rest renumber; the applicant is then in the result SMS preview. 422
  `NOT_PUBLISHED`, `WAITLIST_EMPTY`, `NO_SEAT_FREE`. A selected applicant gives the seat up through
  the status route (`WITHDRAWN` with a reason).
- **The status page** (`admission_lookup`, replaced with the same signature): `test` (roll, date,
  time, venue) once a roll is issued (P4-M); `result` (version, place, waitlist position, score,
  full marks, absent, published at) only from the published snapshot of the class's published
  version, so a draft, a later score or an unpublished correction never shows (review focus 3).
  The status itself is the outcome. The status route takes a status token only (P3-b16), so results
  stay behind the status code; the code request still uses the lookup as a yes/no only, and every
  answer there is unchanged (no new oracle).
- **Locks:** every test operation on a class takes the cycle's advisory lock shared (P3's key),
  then the class row `FOR NO KEY UPDATE` (and applicant rows the same way), so they run one at a
  time per class and a cycle edit waits, while a new application's foreign key (KEY SHARE) never
  waits on them (no lock cycle with P3's phone lock). A deadlock or a serialization failure
  anywhere answers 409 `BUSY` with Retry-After, never a 500. Once a result is published, staff may
  withdraw, reject or approve an applicant but not put them back to submitted or shortlisted (409
  `TEST_RESULT_PUBLISHED`).
- **Database** (migrations `20261117300000`–`300200`): `admission_cycles.merit_tie_break`
  (`admission_tie_break`); on classes the test's settings, `merit_built_at` + `merit_inputs_hash`,
  `scores_changed_at`, `results_version` / `results_published_at` / `results_full_marks`; on
  applications `test_roll`, `test_score_h`, `test_absent`, the draft (`test_result`
  `admission_test_result`, `merit_position`, `waitlist_position`), the published snapshot
  (`result_version`, `result_merit_position`, `result_waitlist_position`, `result_score_h`,
  `result_absent`) and `result_flag`; `sms_purpose` gains `ADMISSION_RESULT`. `jantrik_admission`
  reads `test_roll` and the published snapshot only (pinned in `schema-safety.test.ts`). The lookup
  was replaced as "Changing these functions later" says (CREATE granted back around `SET ROLE`).

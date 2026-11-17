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
  change keeps who, when and why, and is audited. Bringing a withdrawn or rejected application back
  runs the duplicate and per-phone checks again (review S1). An edit cannot empty a field the cycle
  requires (422 `ADMISSION_FIELDS_REQUIRED`).
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
  is checked again for each application) and approves each approvable application in its own
  transaction. A guardian choice or a duplicate birth registration number is recorded on that
  application (`approval_problem`) and skipped; the student limit, a full section or a deactivated
  class or section stops the run and marks the rest. A re-run picks up what is left. `GET` the same
  path for `{running, admitted, problems}`.

## Dues for a December admission (review focus 5)

A child admitted (by staff or from an application) into a year that has not started and is not
current yet (in December, for January) owes from that year's start: `admit()` records it in
`students.admission_date_for_dues` (decision P3-K, as fixed after the review: M1). So the admission
fee is due `year start + offset` (not already late) and the first month is not extended as for a
late joiner. Nothing is derived for anyone else: imports, existing students and admissions into the
current year keep the creation day, exactly as before. See [fees.md](fees.md).

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

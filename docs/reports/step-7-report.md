# Step 7 report: setup, staff, students, import (overnight run)

Branch `feature/step-7-setup-students` (pushed, not merged). Plan:
[docs/plans/step-7.md](../plans/step-7.md). Decisions taken without you, each with how to change
it: [docs/decisions-pending.md](../decisions-pending.md) (23 entries). **Please read #15, #18 and
#19 first.**

## Commits

| Phase | Commit    | What                                                                           |
| ----- | --------- | ------------------------------------------------------------------------------ |
| A     | `f75814b` | add-tenant-table skill, plan, decisions log, CI on `feature/**` pushes         |
| B     | `96d2de2` | institute setup: years, classes and sections, shifts, subjects, groups, labels |
| C     | `58897b2` | staff: add by phone, roles, deactivate, sections                               |
| D     | `64ce30c` | students: admission, profile, guardians, transfer, deactivate, codes           |
| E     | `772c076` | Excel/CSV import                                                               |
| -     | (this)    | this report                                                                    |

Every commit was made only after lint, typecheck, format:check, all unit/db/API tests and the
full Playwright suite passed locally, and after an independent review subagent (tenant
isolation, RLS, roles, validation) whose findings were fixed first.

## Tests

| Suite                       | Before | After |
| --------------------------- | -----: | ----: |
| `@jantrik/shared` (Vitest)  |    123 |   154 |
| `@jantrik/db` (Vitest, RLS) |     91 |    97 |
| `@jantrik/api` (Vitest e2e) |    128 |   169 |
| Playwright e2e              |     29 |    35 |

**CI:** on GitHub every step passes on this branch (lint, typecheck, format, migrations, tests,
build) except **End-to-end tests**, which already failed on `main` at `5a9fcde` before this run
and passes locally (also with `TZ=UTC CI=1`). The logs need a GitHub login I don't have here, so
see decision #18: the `playwright-report` artifact of a failed run will show which tests fail.

## What was built

### A. Project skill

- `.claude/skills/add-tenant-table/SKILL.md`: the docs/database.md checklist as a procedure,
  plus three gaps the review found: plain FKs to `users` need a membership check, definer
  functions need their own role policies, and changing a definer's parameters leaves an overload.
- Used for all three new tables (`student_settings`, `student_code_counters`, `student_imports`):
  RLS enabled and forced, `tenant_isolation` policy with USING and WITH CHECK, explicit grants
  (none with DELETE), CHECK constraints, drift check, schema-safety list, isolation tests.

### B. Institute setup (`/setup`, OWNER/ADMIN)

- **Academic years:** create, edit, make current (always exactly one), "open the next year"
  (name and dates suggested, active sections copied, no students), delete only when unused.
- **Classes and sections:** class levels, and the sections of a chosen year with an optional
  shift and capacity (never below the number already enrolled).
- **Shifts** (times typed with Bangla digits work), **subjects** per class level (optional group,
  optional-subject flag), **study groups**.
- **Labels** (Section → Batch etc.) with a live Bangla/English preview and "reset".
- Anything in use cannot be deleted (409 `IN_USE` with the counts). The menu explains why and
  offers **deactivate** instead (new `is_active` columns). Inactive items cannot be picked for new
  sections, subjects, admissions or imports.
- A student-ID tab (from phase D): prefix and pattern with a preview.
- Everything is audited. A global filter now turns Prisma unique/foreign-key violations into 409s
  instead of 500s (decision #13).

### C. Staff (`/staff`, OWNER/ADMIN)

- List with roles, phone, sections and status. Add by phone (Bangla digits) + name + Bangla name
  - roles: the person is found or created, no SMS, and the dialog says they can log in with OTP.
- Change roles (guardian memberships of the same person untouched), deactivate/activate (access
  ends on their next request), assign current-year sections.
- Only an owner grants OWNER or changes an owner; the last active owner can't be removed or
  deactivated, even when two owners demote each other at the same moment (tested); nobody changes
  themselves. The roles cache is dropped after every change. Everything is audited.
- `app_find_or_create_user` gained `name_bn`, stored only for a **new** person (decision #3).

### D. Students

- **Admission** (`/students/new`): every field, including board registration (17-digit birth
  registration, parents' names in both languages, addresses with "same as present"); Bangla
  digits in phone, roll, dates and numbers; 1–4 guardians, exactly one primary, each picked from
  this institute's guardians on that phone (siblings share) or created, each with an OTP login
  (decisions #5, #6).
- **Enrolment:** year, active class, a section of that year and class, optional group, roll that
  must be free in the section, capacity enforced (section row locked).
- **Student ID:** `{PREFIX}-{YEAR}-{NNNN}` by default, per-tenant prefix and pattern, an atomic
  per-year counter (concurrent admissions get distinct codes, tested), or typed by hand.
- **Profile** (`/students/[id]`): details, enrolments, guardians; edit, change guardians (primary
  swap, at least one), transfer to another section of the same year and class, deactivate (soft
  delete; the current-year roll is freed, older years keep theirs). List rows link to the profile.
- Every change is audited.

### E. Import (`/students/import`)

- Templates: `.xlsx` (Bangla/English headers, text-formatted ID/phone/birth-registration
  columns, an instructions sheet listing your classes and sections) and `.csv` (BOM).
- Upload `.xlsx`/`.csv` up to 5 MB / 5000 rows, parsed on the server with maintained libraries
  (`read-excel-file`, `csv-parse`), pinned versions; formulas are never evaluated. Zip-bomb
  protection counts the bytes that really inflate (the first version trusted the zip's directory;
  the review showed that could be faked, now covered by a real-bomb test).
- Column mapping auto-detects Bangla and English headers (and common spellings); you can change
  any column and re-check.
- Preview: each row is OK / already exists / error with the exact problem and the cell value
  (bad phone, unknown class or section, roll taken or twice in the file, birth registration
  invalid or twice, missing name, new guardian without a name, section full, bad date…).
- Run: a background job in the tenant's RLS context, acting as the uploader (role re-checked per
  chunk), with progress in the page. Re-importing the same file creates no duplicates (matched
  on student ID, then birth registration). Creates guardians and enrolments too.
- Result report CSV (Bangla or English). Every CSV export (report, template, attendance
  register) is protected against formula injection (`csvCell`).

## Skipped or not done

- Nothing in the brief was skipped. Photo upload, fees, bKash and deployment were out of scope.
- No scheduled job clears stale import data; it is cleared lazily (decision #23).
- Teachers can read any student's profile, as the list already allows (decision #19).

## Things to know

- **Port 3000** on this machine is used by another project's dev server, so I checked the app on
  3100/4100 and ran e2e on 3200/4200 with a local, uncommitted copy of the Playwright config
  (`apps/web/playwright.alt.config.ts`, listed in `.git/info/exclude`; decision #14).
- **Disk:** C: had about 3 GB free all night; nothing outside the repo was deleted.
- The local `jantrik` database was reset once (pre-approved) and has all 13 migrations; it also
  holds a few test imports and students from the visual checks. `pnpm db:reset` gives clean data.

## Screenshots (before/after)

New screens, checked with Playwright MCP at 360 px and 1440 px in Bangla and English, all with
the overflow check passing (104 states):

- After: `D:\work-softwares\jantrik-school\.playwright-mcp\step7\after-B` (setup, 40),
  `after-C` (staff, 20), `after-D` (admission, profile, student ID, 32), `after-E` (import, 12).
- Before: `D:\work-softwares\jantrik-school\.playwright-mcp\step7\before` (students list and
  dashboard as they were; the other screens did not exist yet).

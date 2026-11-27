# Decisions pending review (step 7, overnight run)

Each entry: what needed deciding, the default taken (safe and reversible), and how to change it.

**Review (2026-10-20):** each entry is marked _Approved_ (kept as is), _Resolved_ (fixed after the
first review) or _Changed_ (done differently, as described).

1. **_Approved._ CI did not run on pushed feature branches (only `main` and PRs).**
   - Default: Added `feature/**` to the `push` trigger in `.github/workflows/ci.yml`.
   - To change: Remove the line, or open a PR instead.
2. **_Noted (environment only, no code)._ Disk: C: had ~3 GB free at the start (Docker's data lives there).**
   - Default: Kept going; nothing deleted outside this repo. If Docker stops, the phase is marked blocked here.
   - To change: Free space on C:.
3. **_Approved._ Staff Bangla name: RLS lets the app update only the user's own row, so a new staff member's `name_bn` could not be stored.**
   - Default: `app_find_or_create_user` gets an optional `p_name_bn`, written only when the person is new. An existing person's names are never changed (they may belong to other institutes).
   - To change: Drop the parameter; staff then set their own Bangla name.
4. **_Approved._ Granting OWNER.**
   - Default: Only an OWNER can grant or remove OWNER; ADMINs manage the other roles. Nobody can change their own roles or deactivate themselves.
   - To change: Relax in `StaffService`.
5. **_Approved, and checked after review._ Guardians added at admission/import.**
   - Default: Each gets a login (user + GUARDIAN membership), as the demo seed does, so they can log in with OTP. No SMS is sent.
   - Checked: no API response returns a person's global `users.name` / `name_bn` / `email` to anyone else; guardians, students and staff are shown by their institute's own rows (`guardians`, `students`, `staff_profiles`). The staff-name fallback to `users` was removed, "updated by" no longer reads the user relation, and a login created for a known guardian takes the guardian's stored names (never the phone number). Only the self endpoints (`/auth/me`, login, refresh) show a person their own name. Tests: `apps/api/test/no-global-names.e2e-spec.ts` (raw JSON/CSV of every endpoint with person data, as admin, assigned teacher and the person) and a code scan, `apps/api/src/common/global-names.spec.ts`.
   - To change: Skip membership creation in `GuardianLinker`.
6. **Guardian phone match.** _Changed after review:_ a phone is never linked silently.
   - **Admission form and "add guardian":** when guardians of this institute have the typed phone, the form lists them (their names in this institute and their children with class, from `GET /guardians?phone=`, admins only) and the admin picks one or adds a new guardian. Without a choice the API answers 409 `GUARDIAN_CHOICE_REQUIRED`; a picked guardian must have that phone (422 `GUARDIAN_MISMATCH`) and keeps their stored names. A new guardian on a used phone shares that phone's login.
   - **Import:** with a guardian name, the row links only when the phone **and** the name match (case, spaces and dots ignored); otherwise a new guardian is added (note `GUARDIAN_NEW_SAME_PHONE`). Without a name (coaching lists): exactly one guardian on the phone is linked with a warning note `GUARDIAN_LINKED_BY_PHONE_ONLY`; several give the error `GUARDIAN_NAME_NEEDED`; an unknown phone creates a guardian named "<student>-এর অভিভাবক" / "Guardian of <student>" (note `GUARDIAN_NAME_GENERATED`, rename later). Guardians added by earlier rows of the same file count, so siblings share one. Notes show in the preview, the rows list and a "Notes" column of the report. The run decides again on the database as it is then and refuses the row (`GUARDIAN_CHANGED`) when that differs from what the preview showed. A generated name is only the institute's label: the person's own login name stays neutral ("Guardian").
   - **Known limit:** guardians on one phone share one login (the OTP goes to that phone), so whoever holds it sees all their children; the form says so next to "Add as a new guardian". Separate logins per guardian would need a different sign-in than phone OTP.
7. **_Approved._ Deactivating a student frees their roll (set to NULL) so the number can be given to someone else; the old roll is in the audit log.**
   - Default: As described.
   - To change: Keep the roll and require a new number for newcomers.
8. **_Approved._ Inactive class levels/sections/subjects/shifts/groups.**
   - Default: Hidden from pickers for new admissions, transfers and imports; existing records and attendance keep working.
9. **_Approved._ Import: a row matching an existing student (student_code, then birth registration no.).**
   - Default: Skipped and reported as "already exists"; the existing record is not updated.
   - To change: An "update existing" option later.
10. **_Approved._ Import: formula cells in .xlsx.**
    - Default: The value Excel saved is used; formulas are never evaluated.
    - To change: Reject formula cells instead.
11. **_Approved._ Student code year.**
    - Default: `{YEAR}` = the calendar year the enrolment's academic year starts in.
12. **_Approved._ Default student code prefix before an admin sets one.**
    - Default: Uppercase initials of the tenant slug's words (`shapla-school` → `SS`), falling back to `STU`.
    - To change: Set it in student settings.
13. **_Approved._ Constraint violations that slip past a service's checks (races).**
    - Default: a global filter maps Prisma P2002 → 409 `DUPLICATE` and P2003 → 409 `REFERENCE_CONFLICT` (both were 500s before, in every module). No constraint names are returned.
    - To change: scope `PrismaErrorFilter` to the new controllers only.
14. **_Approved._ Port 3000 is taken on this machine by another project (`hishab-nikash`'s Next dev server).**
    - Default: left it running; local dev checks ran on 3100/4100 and e2e on 3200/4200 with an uncommitted copy of the Playwright config (`apps/web/playwright.alt.config.ts`, listed in `.git/info/exclude`). CI uses the normal config.
15. **Adding staff by phone.** _Resolved after review:_ staff are invited, not linked. The institute only ever sees the name it typed (`staff_profiles`); the response is identical whether the phone exists or not; the person sees "<institute> added you as <role>: accept / decline" after their next login and gets access only on accept (no SMS). Invitations expire after 14 days; admins can cancel a pending one and re-invite. Additions are rate-limited per institute. See `auth.md` (Staff invitations).
16. **Roles cache race.** _Changed after review:_ the roles cache is versioned per member (`tenant:{tid}:user:{uid}:roles:v{n}`). Every role or status change bumps the version after commit, and readers take the version before loading, so a request that loaded the old roles just before the change can only re-cache them under a version nobody reads. A demoted or deactivated person loses the role on their next request, also when they are still an active guardian (before, any demotion, pure staff included, could last up to the 5-minute TTL). Tests: `apps/api/test/roles-cache.e2e-spec.ts`.
17. **_Approved._ Deactivated staff keep their section assignments** (restored on reactivation); they do not count when choosing a section's class teacher.
18. **CI: the end-to-end step failed on GitHub.** _Resolved after review:_ the logs (`gh run view --log-failed`) showed a test race (`layout.spec.ts` typed into the OTP tab while the password panel was still mounted) and a job hitting the 10-minute limit while waiting out OTP cooldowns. Fixed in the tests; e2e now runs as its own CI job (20-minute limit) next to the checks job.
19. **Teachers and student data.** _Resolved after review:_ teachers list every student with the basics; date of birth, birth registration no., addresses, parents' names and guardians (incl. phones) only for OWNER/ADMIN and the teachers of the student's current-year section (`StudentAccess`), in the list, the profile and today's attendance report (absentees' guardian phones). Search by guardian phone is admin-only. Exports (attendance register CSV) carry no such fields; import reports are admin-only.
    - _Step 9 (approved by the owner):_ the ACCOUNTANT may search fee students by a **whole** guardian phone (never part of one) and sees phones masked (`018•••••101`) at the counter, in reports and on transfers; no full phones on ledgers or receipts. OWNER/ADMIN see them in full.
20. **_Approved._ A revoked (DISABLED) GUARDIAN membership is not reactivated** when that person is added as a guardian again; an admin has to restore access deliberately.
21. **_Approved._ Imports go into the current academic year only.**
    - To change: add a year picker to the upload step.
22. **Possible duplicates in an import.** _Changed after review:_ rows with a student ID or birth registration number that is already here are still skipped as "already exists". Other rows are flagged **possible duplicate** when the name (Bangla or English; case, spaces and dots ignored), the class and a guardian phone match an active student of this year, or an earlier row of the same file. They are skipped by default; per row the admin can choose **Import anyway** (`PUT /student-imports/:id/rows/:row/duplicate`, audited, kept in `student_imports.duplicate_overrides`; a new column mapping clears the choices). The preview, the counts, a "Possible duplicates" filter and the report show who the row looks like (the matched student's ID and name stay in the import's results as history). Only rows without errors count as earlier rows; an imported-anyway duplicate takes a seat in its section like any other row.
23. **Import data retention.** _Changed after review:_ raw rows (phones, birth registration numbers) are cleared when an import finishes or fails, after 7 days unfinished, or after a day stuck in a run, by a daily BullMQ job (`expire-imports`, 00:20 Asia/Dhaka, so at most a day after those limits) as well as lazily on upload and listing. Like the held-SMS job it never queries across institutes: uploads record the institute in a Redis sorted set (`imports:raw-tenants`; before the rows are stored, so a Redis outage fails the upload rather than leaving rows unswept, and again after commit), and the job visits only those, one institute per RLS transaction (`TenantJobRunner`), forgetting an institute once none of its imports hold raw rows (and only if it did not upload again meanwhile). The per-row results (row number, status, name, the offending value) are kept as history.
    - To change: also drop names and values from results after N days.

24. **_Approved (step 9)._ Fees: who changes where money goes.** Only the OWNER adds or (de)activates the institute's bKash/Nagad numbers (the bKash merchant credentials too, when the gateway is built); ADMIN sees them.
25. **_Approved (step 9)._ Receipt numbers restart every calendar year** (by the day the payment is recorded, Asia/Dhaka): `2026-000123`.
26. **_Approved (step 9)._ Late fines can be waived** (part or all) by OWNER/ADMIN with a reason; audited and shown on the ledger.
27. **_Approved (step 9)._ Receipt SMS is on by default** (each institute can switch it off).
28. **_Approved (step 9)._ Siblings are confirmed, not automatic:** a shared guardian phone is only a suggestion; the sibling discount applies after an OWNER/ADMIN confirms the family (stored, audited, removable).
29. **Fees: decided in step 9 (open to change).**
    - One receipt per student (no family receipts yet).
    - In a confirmed family the student in the highest class pays full; ties go to the earlier admission.
    - Concessions never stack: a due gets the larger of the manual concession and the sibling discount.
    - Fee SMS texts are fixed Bangla (`receiptSmsText`, `reminderSmsText`); editable templates later.
    - Teachers without ACCOUNTANT get no fee route; a teacher may also hold ACCOUNTANT.
    - The daily closing counts a payment on the day it was recorded and a void on the day it is made, so a closed day never changes.
    - The sender's number of a bKash/Nagad transfer is masked for the accountant (the TrxID and amount suffice to check it).
30. **_Approved (step 9)._ The bKash gateway (tokenized checkout) is a later step:** plan in [backlog.md](backlog.md).

## Deployment readiness (day run 2026-11-13)

Runbook: [deploy.md](deploy.md). Decided without the owner (unattended day run, PR "Deployment
readiness without a provider"); each is reversible.

How the "Deployment requirements (step 11)" below are now covered:

- **1. Platform subdomain:** `deploy/Caddyfile` serves the web app's `/platform` pages only on
  `platform.<domain>` and redirects them away from `app.<domain>`; the platform cookie keeps its
  flags. The `Origin` allowlist in `PlatformAuthGuard` is **not** built (an auth change for the
  owner); meanwhile Caddy refuses `/platform/*` API calls from any other browser origin (D9).
- **2. Redis:** the production compose runs `--appendonly yes --appendfsync everysec
--maxmemory-policy noeviction` with a `--maxmemory` (D10), so noeviction applies, plus a password.
- **3. Roles and deploy order:** `deploy/postgres/create-roles.sh` creates every role before the
  first migration (D7); the compose starts the apps only after the one-shot `migrate` service
  succeeded, and the runbook's upgrade is migrations first, then restart. The optional
  `REVOKE TEMPORARY` hardening is applied in production (D7).
- **4. The device receiver:** its own service (`node dist/ingest-main.js`) with its own variables
  only (it now refuses to start with any of the API's logins or secrets, D4), port 4080 published
  as plain HTTP (IPv4), `INGEST_TRUST_PROXY=false` fixed in the compose file (D18; `true`
  refused), `INGEST_PUBLIC_HOST` from `DEVICE_HOST`; `INGEST_IN_PROCESS=true` is refused in
  production.

D1. **SMS without a gateway.** Every provider refused production, so the API could not start
there at all. New `SMS_PROVIDER=none`: every send fails, is retried and recorded as FAILED;
nothing is sent, kept or printed. **Until a gateway exists no institute user can sign in**
(revised after review): guardians and staff alike need an OTP, as no production path sets a
staff member's password (invitations and first logins go through an OTP; only the demo seed and
the tests set passwords). Only platform admins can sign in. A go-live blocker for the owner; no
password path was built.

- To change: build the gateway provider and set it; `none` can stay for staging servers.

D2. **A separate queue worker.** The BullMQ processors ran only inside the API. `node
dist/worker-main.js` boots the same modules without HTTP; AppModule starts the workers itself
(BullModule `manualRegistration`) unless `QUEUE_WORKERS=false`. Default on, so the API, the tests
and `pnpm dev` behave as before; the production compose runs the API with `false` next to a
`worker` service. The worker refuses `QUEUE_WORKERS=false`. It gets the API's environment (it
runs the API's modules, so the same validation).

- To change: run jobs in the API again (drop the worker service, `QUEUE_WORKERS=true`), or give
  the worker a smaller module and environment later.

D3. **Templates in production.** Institute types, templates and grading schemes came only from
`pnpm db:seed`, which refuses production. `packages/db/dist/cli/seed-templates.js` runs the same
idempotent `seedTemplates` as the owner after every `prisma migrate deploy` (the `migrate`
service). Without it no institute could be registered.

- To change: load them in a migration instead.

D4. **Production environment checks** (deploy.md → Environment checks): with
`NODE_ENV=production` the API, the worker and the receiver refuse development SMS providers,
`TRUST_PROXY`/`INGEST_TRUST_PROXY` `true` or a `/0` range, `INGEST_IN_PROCESS=true`, non-https or
local CORS origins, example or reused secrets, runtime logins as `jantrik_owner` or `postgres`,
`REDIS_URL`/`TRUST_PROXY` left unset, an example or short password inside `REDIS_URL`, and
`DATABASE_MIGRATION_URL`, `POSTGRES_PASSWORD` or any `DB_*_PASSWORD` in their environment (added
after review); the receiver also refuses any of the API's logins or secrets. The API tests and Playwright's API run with `NODE_ENV=test` (and the
web app has no env validation), so nothing was relaxed for them and there is no override flag.

- To change: `apps/api/src/config/production-env.ts` (each rule is a few lines with a test).

D5. **`TRUST_PROXY` must be set in production** (the compose sets `1` for Caddy). Its default
`false` behind a proxy would make every visitor one address for the per-IP rate limits.

- To change: remove it from `API_PRODUCTION_REQUIRED` in `production-env.ts`.

D6. **Example secrets** are recognised by markers (`change-me`, `CHANGE_ME`, `dev-only`,
`test-only`, `ci-only`, `dev_password`, `ci_password`, `placeholder`, `example`), and the three
secrets must differ. The same list in `production-env.ts`, `deploy/compose.sh` and
`create-roles.sh`.

- To change: `isPlaceholderSecret` in `production-env.ts` and the two scripts together.

D7. **The production roles script** is separate from `docker/postgres/init/01-roles.sh`
(unchanged for development and CI) and creates the production database only. Passwords: at
least 24 URL-safe characters, distinct, no example values; existing roles keep their passwords,
but every role's attributes and memberships are checked on each run. The production database
also gets `REVOKE TEMPORARY ON DATABASE ... FROM PUBLIC` (requirement 3's optional hardening;
nothing in the app makes temporary tables) and `timezone UTC`. A non-superuser admin (a managed
Postgres) gets SET-only membership of `jantrik_owner` to create and set up the database.

- To change: `deploy/postgres/create-roles.sh` and `database-setup.sql`.

D8. **Backups and restores run as the superuser.** `jantrik_owner` cannot dump forced-RLS
tables, and only a superuser restores every owner and grant. Restores go into a missing or empty
database only, or replace one with `--drop-existing=<name>` when nothing is connected to it;
extensions are created as the owner first so it keeps owning them. Retention 14 days; the
off-site upload is a documented placeholder (`BACKUP_UPLOAD_CMD`). The restore check runs in CI
on every pull request, on a fresh cluster set up by `create-roles.sh`, with demo data.

- To change: `deploy/backup/*.sh`; the job "Production roles, backup and restore" in `ci.yml`.

D9. **Caddy is the reverse proxy** in the production compose (automatic Let's Encrypt). On
`api.<domain>` it answers 403 to a browser request to `/platform/*` from any origin other than
the platform's: a stopgap for the `PlatformAuthGuard` `Origin` check (owner).

- To change: drop the `@platformFromElsewhere` rule once the guard checks the origin; another
  proxy needs the same routing (deploy.md → HTTPS).

D10. **Redis has a password** (`REDIS_PASSWORD`), though only the compose network reaches it,
and a memory ceiling, `REDIS_MAXMEMORY` (default `512mb`): without one `noeviction` never applies
and Redis grows until the kernel kills it. At the ceiling writes fail loudly.

- To change: drop `--requirepass` and the password in `REDIS_URL`; size `REDIS_MAXMEMORY` to the
  server (about an eighth of its memory to start, leaving room for the AOF rewrite).

D11. **Next.js standalone output only in the image** (`NEXT_OUTPUT=standalone`, set by the
Dockerfile): `next start`, which CI's Playwright run uses, refuses standalone output.

D12. **Images are built on the server** (`deploy/compose.sh build`); CI does not build them (it
would add several minutes to every run). They were built and run locally.

- To change: build them in CI and push to a registry; the compose then pulls `IMAGE_TAG`.

D13. **No health route on the receiver.** Its Docker health check asks for an unknown path and
expects 404 (no database, no log line), so the internet-facing receiver gets no new route. The
worker has no health check (no HTTP); Docker restarts it if it exits.

D14. **The `migrate` image carries the dev tools** (about 950 MB): the Prisma CLI is a
devDependency of `@jantrik/db`, so its deploy includes all of them.

- To change: move `prisma` to `dependencies` (a lockfile change) and deploy with `--prod`.

Added after the review of the PR (2026-11-14):

D15. **`deploy/compose.sh` checks the settings file first** and refuses, for every command, a line
that is not plain `KEY=value`, a value still holding `CHANGE_ME` or `example.com`, a `*_PASSWORD`
under 24 characters, with characters a URL cannot carry, with an example marker or equal to
another, a secret with an example marker, and a key also set in the shell (compose prefers the
shell). So the superuser's password is checked before Postgres's first start sets it.
`create-roles.sh` checks `POSTGRES_PASSWORD` (when given) and the roles' again. Second review
round: the parsing follows compose's (`export`, quotes, inline comments).

- To change: the loop at the top of `deploy/compose.sh`.

D16. **The Postgres health check is a query** over TCP, without a password (127.0.0.1 is trusted
inside the image): the roles exist and `database-setup.sql` ran (schema owner, no USAGE or
TEMPORARY for PUBLIC, the UTC setting). A first start that failed half-way stays unhealthy and the
apps never start against it. The runbook's recovery is a new volume (or rerunning the script and
setting the superuser's password by hand).

D17. **Backups belong to the deploy user and live outside the checkout:** the `backup` service
runs as `BACKUP_UID:BACKUP_GID` (default 1000:1000) and writes to `BACKUP_HOST_DIR` (default
`/srv/jantrik-backups`), so the deploy user's cron jobs can copy the private (600) files away and
a `git clean` cannot delete them.

- To change: the `backup` service's `user` and volume; or run the cron jobs as root.

D18. **`INGEST_TRUST_PROXY` is fixed to `false`** in the compose file and gone from the
settings file: nothing proxies port 4080, and a hop count with direct devices trusts the
client-written `X-Forwarded-For` as much as `true` does.

- To change: only behind a proxy you run in front of port 4080, in
  `deploy/docker-compose.override.yml`.

D19. **IPv4 only for now:** no AAAA records (never for `device.`). The compose network has no
IPv6, so Docker would show every IPv6 visitor to the API as one address (one rate-limit bucket);
port 4080 is published on IPv4 only.

- To change: an IPv6 compose network (checked end to end), then AAAA records for `app.`,
  `platform.` and `api.`.

Recorded for the owner, not built:

- **A Redis user for the receiver** limited to its own keys (Redis ACL). _Built in sprint 1, P0_
  (`jantrik_ingest`, deploy.md → Redis users).
- **A start-up check that fails when the app's database login is a superuser or BYPASSRLS** (and
  the same for the platform and receiver logins). _Built in sprint 1, P0_ (database.md →
  Database roles).
- **CI coverage** of the compose Postgres's first start (initdb), the non-superuser branch of
  `create-roles.sh`, `deploy/compose.sh`'s settings check and the image builds (each checked by
  hand for this PR). The CI restore job makes fresh random passwords each run.

## Exams and results (step 10)

Rules: [exams.md](exams.md). Owner decisions of 2026-10-23: browser print / Save as PDF; an
elective pool with a choice per student for the 4th subject; 1st/2nd papers as one subject with
paper parts and a PER_COMPONENT or COMBINED pass rule (COMBINED by default for BAN and ENG in
classes 9–10); a teacher may fix and resubmit until the sheet is locked; GPA rounding TRUNCATE by
default (#38).

31. **Results are a snapshot taken at publish** (`exam_results`). Guardians, report cards and SMS read it, so merit places never shift silently. A correction or remark after publishing shows "changed since publish" (computed, not stored) until the admin republishes, which bumps the version. Before publishing the tabulation is live and marked "preview".
    - To change: read live results everywhere (places would move under guardians' eyes).
32. **Merit order is per exam**, prefilled from the last exam with the same result mode. Default: passed first, then GPA (GPA exams) or total marks, then total marks, then the lower roll. Students tied on every key share the place (1, 2, 2, 4). Failed students are ranked after the passed ones (or left unranked). Total marks include the 4th subject.
    - To change: the exam's `merit_order` and `failed_ranking`.
33. **No implicit 4th subject.** A pool subject without a recorded choice is not taken; the choices screen has "set for the whole section" and the publish check warns. The NCTB 9–10 template also puts **BIO** in the Science pool next to HMATH (new institutes; the demo picks it up on reseed).
    - To change: treat a missing choice as "takes every pool subject as compulsory".
34. **Absent is per part.** The row's Ab sets every part; absent counts 0 and fails the subject; all parts absent shows "absent". Blank means not entered, and a sheet with blanks cannot be submitted. There is no "exempt" marker yet ([backlog.md](backlog.md)).
35. **Class teachers enter marks only for subjects they are assigned to.** Every teacher of a section may print its tabulation and report cards; only the class teacher (or the office) writes remarks. The web shows the results screens to OWNER/ADMIN in this release (teachers reach them by link).
    - To change: `section_subject_teachers` per subject, or a teacher results view ([backlog.md](backlog.md)).
36. **Result SMS is manual and skipped over the cap, not held**, so a skipped student can be sent another day (a held message's dedupe key could never be resent). A failed result SMS counts as sent for that version; resending needs a republish.
37. **Decision #19 for exams:** mark sheets carry id, roll, name and student ID only; subject-only teachers get no tabulation or report cards; the CSV carries no phones or parents; report cards show parents' names only to those who may see them (and to the guardian of their own child); staff names come from the institute's staff rows.
38. **To verify with a real board/school marksheet** (all data, editable per institute):
    - **GPA rounding: TRUNCATE** (4.958 shows 4.95; never more than was earned). The alternative is ROUND_HALF_UP (4.96). Below 5 never shows as 5.00 either way (grade points are multiples of 0.5, so a GPA under 5 is at most 4.9…; tested).
    - **Percentage to grade:** compared exactly (79.5 % is A under NONE). The scheme's `rounding_mode` can round half up or ceil to whole percent instead.
    - **Pass marks** are prefilled as round-half-up(33 % × full): 70 → 23, 30 → 10, 25 → 8, 50 → 17, 100 → 33, and compared with the raw marks (22.5 of 70 against 23 fails).
    - **Combined pass marks (COMBINED rule):** Bangla 9–10 CQ 46 of 140 and MCQ 20 of 60; English 9–10 WRITTEN 66 of 200. Each part's own pass mark is not used under COMBINED.
    - **Absence under COMBINED:** absent in any part (one paper's MCQ, say) fails the subject, even if the combined sum would pass.
    - **Component defaults** (the NCTB template):

      | Classes | Subjects                      | Parts (pass mark)                        |
      | ------- | ----------------------------- | ---------------------------------------- |
      | 9–10    | BAN (COMBINED: CQ 46, MCQ 20) | P1_CQ 70, P1_MCQ 30, P2_CQ 70, P2_MCQ 30 |
      | 9–10    | ENG (COMBINED: WRITTEN 66)    | P1 100, P2 100 (both WRITTEN)            |
      | 9–10    | ICT                           | MCQ 25 (8), PRACTICAL 25 (8)             |
      | 9–10    | PHY, CHEM, BIO, HMATH         | CQ 50 (17), MCQ 25 (8), PRACTICAL 25 (8) |
      | 9–10    | the rest                      | CQ 70 (23), MCQ 30 (10)                  |
      | 6–8     | ENG                           | WRITTEN 100 (33)                         |
      | 6–8     | the rest                      | CQ 70 (23), MCQ 30 (10)                  |

    - To change: Exams → Setup → Grading (rules and rounding) and Subject marks (parts, pass rule, combined marks); the template in `packages/db/src/reference-data/templates.ts` for new institutes.

## Performance (step 12, day run of 2026-11-13)

Decided while the owner was away (each one in PR #9, which is not merged):

- **P1. Where the measurements ran.** Prisma refuses `migrate reset` from an AI agent without the
  owner's consent, so `jantrik_e2e` was not reset. The measurements use a new scratch database,
  `jantrik_perf` (created, `migrate deploy`, seeded with the e2e day 2026-10-21), and Redis DB 3;
  the three tasks' tests used new scratch databases `jantrik_t1_test`, `jantrik_t2_test`,
  `jantrik_t3_test` (Redis DBs 11-13). The owner's `jantrik` and `jantrik_test` were not touched.
  - To change: drop them when done (`DROP DATABASE jantrik_perf;` and the three `_test` ones, as
    the `postgres` user).
- **P2. The Bangla faces carry only their Bangla subset** (owner decision of 2026-11-14: drop the
  Latin faces of Noto Sans Bengali and Anek Bangla). Next/font/google emitted every Google subset,
  so Latin text on Bangla pages was drawn by Noto's and Anek's Latin faces (26 + 19 KB), not by
  Plus Jakarta Sans as design.md says. The two faces are now Google's own Bengali subset files in
  `apps/web/src/fonts` (next/font/local, with their OFL licences), and Latin letters, ASCII digits
  and punctuation on a Bangla page render in Jakarta (a visible change). Their unicode-range is
  Google's Bengali range plus the space and no-break space (both in the files), so Bangla word
  spacing and Noto's line metrics stay as they were.
  - Measured on the Bangla login page (cold): 4 font files, 210 KB → 3 files, 192 KB, because
    Jakarta's Latin face (27 KB) now loads instead. A page that never fetched Anek's Latin face
    comes out about even (Jakarta's 27 KB for Noto's 26 KB), so the saving is at the low end of
    the 18-45 KB estimated; the gain is mainly that Latin text renders as design.md describes.
  - To change: back to `next/font/google` for both faces (one commit in PR #9).
- **P3. The command palette loads on first use** (on the shortcut, or when a pointer, finger or
  focus reaches its button). On a slow network the very first Ctrl/⌘ K can take a moment.
  - To change: load it after the page is interactive instead (`requestIdleCallback`).
- **P4. `@jantrik/shared` is split so the browser never loads zod:** `*-schema.ts` hold the
  schemas, `*-values.ts` and the rules modules hold what the web uses; the package is marked
  `sideEffects: false`. The API imports from the barrel as before. A web test fails when a value
  the web imports reaches zod (the platform area may).
- **P5. Translations per route:** `apps/web/src/i18n/route-messages.ts` lists what each area
  sends; a test fails when a page's client code asks for a namespace its route does not send.
  `nav.students` duplicates `students.title` so the shell needs no `students` namespace.
- **P6. The size budget** is this build's first-load JavaScript + 5 % for the budget pages and
  the login, and the largest other route + 5 % for every other route; CI fails above it.
  - To change: `apps/web/perf/budget.json` (`node perf/check-budget.mjs --update` after a
    deliberate change).
- **P7. The "start the session refresh earlier" idea is not built:** the plan is in
  [plans/step-12-auth.md](plans/step-12-auth.md), with the CORS preflight cache and the
  same-origin API as related options. Of these the owner approved part B on 2026-11-14: the API
  lets browsers cache its CORS preflight answers for 2 h (`maxAge: 7200` in
  `apps/api/src/app.setup.ts`, with a test). Parts A and C are still open. No other auth, CORS or
  database change is in PR #9.

### The boot refresh (part A of the plan, 2026-11-14)

The owner approved part A with the early `/me/context`, on conditions (plan → Status). Decided
while building it (`perf/step-12-boot-refresh`):

- **B1. Where it runs:** only the `(app)` layout renders the script, so only a full load of an
  institute app page. Not `/select-institute`: it is signed in but has no institute yet, and it
  lives in the `(auth)` group.
  - To change: render `BootRefreshScript` in another layout.
- **B2. The switch:** `JANTRIK_BOOT_REFRESH` on the web server, read per request (`off`, `false`,
  `0` or `no` turn it off; anything else, or unset, is on). The production compose passes it to
  the web container; `deploy/compose.sh up -d web` applies a change with no rebuild.
  - To change: `bootRefreshEnabled` in `apps/web/src/lib/auth/boot-refresh.ts`.
- **B3. Who wins at the hand-over:** anything the script hears after sending its refresh beats
  that refresh's result, which is then neither used nor broadcast: a logout (it probably revoked
  the session), or another tab's login or institute switch (refreshes take the lock, so a
  session heard then is one of those). Anything `AuthClient`'s own channel heard before it took
  the result over beats the result, and a session that reaches `AuthClient` before its restore
  drops the hand-over. In the plan's words "the boot result is checked against a logout
  broadcast"; the other rules keep a tab that was still loading in step with the others (the
  review found an institute switch heard mid-refresh sent the switching tab back). A client
  React builds and then throws away can take the hand-over the same way; the kept client then
  refreshes the usual way (safe, only slower).
- **B7. HTTP failures are reported like AuthClient's own:** a 429 or 5xx from the boot refresh
  shows "unreachable" and retries with backoff (no second request at once, so a 429's wait or an
  overloaded API is respected). A network error, seconds old by the time `AuthClient` looks and
  no load on the API, or a failure of the script itself (an unreadable answer) makes
  `AuthClient` refresh at once.
- **B8. Not done: `keepalive` on the refresh.** A refresh aborted after the API rotated the token
  but before the cookie arrived (the tab closed mid-load) leaves the old token in the browser;
  presented again after 30 s it revokes the session. That was already true of `AuthClient`'s
  refresh; the boot refresh runs in the first second of a load, when people abandon more often.
  `fetch(…, { keepalive: true })` would let the browser finish it, but keepalive with a CORS
  preflight is not dependable on every browser the app targets, so it is in backlog.md →
  Performance for a check on real phones first.
- **B9. The hand-over global (`window.__jantrikBoot`) is a plain property.** Replacing it needs
  script in the page, which could already broadcast a session on the BroadcastChannel or call
  `/auth/refresh` itself; a frozen property would also stop the tests from running the script
  more than once.
- **B4. The early `/me/context` is used only for the exact session it was fetched with** (same
  access token) **and the page's institute;** otherwise the shell fetches it as before. A tab
  that was still loading during an institute switch therefore opens on the new institute, with
  its own context.
- **B5. No script element on client-side renders:** after a login the app layout renders in the
  browser, where React never runs a script it creates (and development reports one as an
  error), so `BootRefreshScript` renders it only in the server HTML and during hydration.
- **B6. It starts after the CSS:** an inline script waits for the stylesheets in `<head>`
  (24 KB), so the refresh starts once they arrive, still well before the JavaScript.

## Devices and staff attendance (step 11)

Rules: [devices.md](devices.md). Owner decisions of 2026-10-24, approved as recommended:

| #   | Question                             | Decision                                                                                                                                                                                                      |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Which module?                        | ATTENDANCE. A separate billable DEVICES module can be split out later ([backlog.md](backlog.md)).                                                                                                             |
| Q2  | When do punches become the register? | At the cutoff, in one go. Before it the today page and the take screen show arrivals live; the register stays "not taken".                                                                                    |
| Q3  | Should the cutoff ever hold back?    | Yes: no device seen in the last 15 minutes, or more than half the section without a punch. An admin then closes it from the device after a confirm, or the teacher takes it (#42 and #43 add two more cases). |
| Q4  | Coaching centres (PER_SESSION)?      | No automatic marking. Punches, the live feed, arrival times, entry and exit SMS and staff attendance work; registers stay manual.                                                                             |
| Q5  | Which name goes onto the device?     | The English name, printable ASCII, at most 24 characters; the student code when there is none (devices cannot draw Bangla).                                                                                   |
| Q6  | The receiver: own process and role?  | Yes: its own Nest app, port and database login (`jantrik_ingest_app`, four `ingest_*` functions only); inside `pnpm dev`, its own process in production.                                                      |

Additions (owner, the same day):

1. **Spoofing defence:** punches from a new address (`NEW_IP`), outside the institute's hours
   (`OUTSIDE_HOURS`) or over the per-minute cap (`BURST`, held until accepted) are flagged and
   reviewed in the live feed (looks right, accept, reject); everything else counts unless
   rejected, and a flagged punch sends no entry or exit SMS.
2. **Device IDs unique across students and staff, in the database:** one unique index on
   `(tenant_id, device_user_id)` for both.
3. **Raw punch retention:** `punch_retention_days` (default 730, 30–3650), a daily job, and a
   database floor that never lets the app delete a punch from the last 30 days.

Decided during the build (open to change):

39. **Manual wins.** The device never changes a record or a staff day a person set (MANUAL). A teacher's change makes only the records they changed MANUAL; the others stay DEVICE. A student enrolled after the device wrote the register gets a MANUAL record from the teacher's submit.
    - To change: let the device overwrite (not advised: the next punch would undo a teacher's correction).
40. **A punch after the cutoff** (today only, with auto-mark on) turns a still-DEVICE ABSENT into LATE. A pending absent SMS is cancelled; one already sent cannot be taken back (the entry SMS follows it). With auto-mark off, punches never change a register, not even one written by close from device (#44).
    - To change: `PunchProcessingService.applyDay` (when a punch or a review rebuilds a student's day: DAILY, auto-mark on, today) and `DeviceAttendanceService.recomputeStudentDay` (what it changes, e.g. leave registers alone after the cutoff).
41. **LATE is strictly after start + grace** (grace 10: 08:10:00 is PRESENT, 08:10:01 LATE). A section without a shift uses "school starts at" (08:00). The cutoff is per shift: start + 60 minutes.
    - To change: the attendance settings (grace 0–120, cutoff 15–300, "school starts at").
42. **A third reason to hold back, `NOT_ON_DEVICE`:** a section is not closed while an active student cannot punch (no ID, or no add for their ID confirmed on an active device). Otherwise a student without an ID would be marked absent, with an SMS, every day. Inactive students still enrolled never hold a section back (#45).
    - To change: `closeDecision` in `packages/shared/src/devices.ts`. Cost now: more held-back sections until everyone's ID is on a device.
43. **The device closes a register by itself only within an hour of the cutoff.** After that the today page shows `AUTO_CLOSE_ENDED` and it waits for a person, so no absent SMS arrives as a surprise at noon.
    - To change: `AUTO_CLOSE_WINDOW_MIN` in `devices.ts`.
44. **Close from device** is OWNER/ADMIN, after a confirm with the counts, the students not on a device (marked absent too) and the SMS rule. It skips the safety checks and the hour, never the cutoff; DAILY mode is required, auto-mark is not.
    - To change: `DeviceRegistersService.closeFromDevice`.
45. **The device counts only ACTIVE students** (only they are sent to the devices): a section's arrivals, the "more than half missing" check, `NOT_ON_DEVICE` and the today page's counts leave out inactive students still enrolled, and their punches give them no arrival. They are still written on a device register, ABSENT; the take screen suggests nothing for them (they start as by hand). Absent SMS go only to ACTIVE students on every path, a teacher's submit too (revised in the final fixes; it used to send them for everyone on a teacher's register). A section with no active student gets no device view and no register from the device.
    - To change: `DeviceArrivalsService.sectionDays` (who counts), `AbsentSmsService.queue` (who gets the SMS) and `AttendanceService.sheet` (the suggestion).
46. **Entry and exit SMS:** off by default; at most one per student per day and direction; working days only; only for punches received within 10 minutes; none for a punch flagged `NEW_IP`, `OUTSIDE_HOURS`, `STALE`, `CLOCK_FUTURE` or `BURST` (an accepted burst punch counts, but sends none); skipped, never held, once the day's SMS reach **90 % of the cap**; fixed Bangla text.
    - To change: `sendsSms` and `REALTIME_WINDOW_MS` in `devices.ts`, `MOVEMENT_SMS_CAP_SHARE` in `punch-processing.service.ts`. Editable texts: [backlog.md](backlog.md).
47. **In and out on a BOTH device** follow the state code it sends (0, 3, 4, 9 → IN; 1, 2, 5, 8 → OUT; anything else IN); the setup guide asks for the automatic state by time. A student's arrival is the first IN, the exit the first OUT after it.
    - To change: `punchDirection`; check on the real device ([devices.md](devices.md) → Verify).
48. **Staff days:** direction ignored; the first punch is the in, the last the out if it is at least 30 minutes later; late after office start + grace, early before office end − grace (counted from the start and to the end); each day keeps the office hours it was judged by. A manual entry keeps typed times as typed (no 30-minute rule); an out before the in is refused.
    - To change: `staffDay` in `staff-attendance.ts`; the hours and graces in the settings.
49. **Who counts as staff:** everyone with an active staff role except people whose only role is OWNER, with a per-person switch (active staff only). Untracked people show nothing, not absent. A day without a row is computed as absent on past working days since the person's staff profile was made.
    - To change: `staffAttendanceTracked`, `staffDayState`.
50. **Device IDs:** digits only, 3 to 9, no leading zero; one per person on every device. Defaults: a student's code digits; staff from 9001 in the order added, skipping every number a current student's code gives. Taken or clashing defaults are reported, never guessed. Punches are matched by the ID a person has now, so after a change, punches under the old ID count for nobody.
    - To change: `staff_device_id_start` in the settings; `defaultStudentDeviceId`, `nextStaffDeviceId`.
51. **Any student who exists, inactive too, may be given an ID** (one at a time or by CSV), so IDs can be prepared ahead. Lists, defaults and the export cover this year's active students and active staff.
    - To change: limit `DevicePeopleService.set` and the import lookup to active students.
52. **Nobody is removed from a device automatically** (it deletes their fingerprints). "IDs still on the devices" lists people no longer active and IDs taken from someone; "Remove from devices" is explicit, refuses active people, and also takes IDs nobody holds (e.g. enrolled on the device outside Jantrik).
    - To change: `DevicePeopleService.removeFromDevices`.
53. **An ID still on a device goes to nobody else** (`ID_STILL_ON_DEVICE`, also in defaults and the CSV) until every active device that had it confirms removing it; otherwise the old person's finger would punch as the new holder. Giving it back to the same person is fine.
    - To change: `DevicePeopleRoster.onDevice` (not advised).
54. **Serial numbers:** active in one institute only; a taken one answers "can't be added; contact Jantrik" without saying where; devices are switched off, never deleted; a device that has connected keeps its serial number.
    - To change: `DevicesService`.
55. **Unknown or refused serial numbers** get 403 and nothing in the database; one log line per serial per 10 minutes, and the latest 500 in the Redis list `ingest:refused` for support.
    - To change: `IngestService.recordRefusal`. A platform screen is in the backlog.
56. **Punch age:** a punch dated before the device's registration day is not stored; one more than 7 days old is stored as `STALE` and only shown. Staff days are rebuilt for punches up to 7 days old, student registers only today.
    - To change: `interpretPunch` (`staleDays`) and `STAFF_DAYS_BACK` in `punch-processing.service.ts`.
57. **A device's first address is trusted automatically only within 24 hours of its registration** (revised during the build; the plan trusted the first address ever). The first contact within 24 hours of `created_at`, while no address is trusted, trusts its address; any other first address waits for an admin (alert, setup guide). Every trusted address is listed (automatically, or by whom) with "revoke".
    - To change: the window in `ingest_find_device_at` (a migration). Cost now: a device installed more than a day after it was registered needs one admin click before commands and entry SMS flow.
58. **Commands and their results go only through a trusted address**, enforced in the database, so a sniffed serial number can neither read the names in a device's commands nor fake its answers. After an ISP changes the school's address, commands and entry SMS wait until an admin trusts the new one.
    - To change: `ingest_take_commands` and `ingest_command_results` (not advised).
59. **At most 50 untrusted addresses per device; a new one evicts the least recently seen one**, so the school's real new address can always be recorded. Known limit: a sustained flood of 50 or more new addresses per poll interval (30 s) keeps it out; the escape is to switch the device off and register its serial number again, then check the address list and revoke anything that isn't the institute's (the new row trusts its first caller within 24 hours, which during a flood could be the attacker). Protecting rows from eviction was rejected: an attacker could pin all 50.
    - To change: `ingest_find_device_at` (a migration).
60. **Receiver limits:** 1200 requests a minute per address (IPv6 by its /64); 300 per serial number and address, so others cannot use up the device's share; one budget of 1200 per serial number for all the addresses it does not trust, charged only to them (a trusted device is never starved) and checked before any database call (an address Redis remembers as trusted, for 7 days, skips that check; a revoke does not clear that mark, so a revoked address may skip it for up to 7 days, but is still charged after the database answers, refused once the untrusted budget is spent, and gets no commands); 30 refused serials per 10 minutes per address.
    - To change: the `INGEST_*` variables (`.env.example`).
61. **The per-minute cap:** 60 punches per device per minute (setting, 10–240). Over it punches are held (`BURST`) until an admin accepts them; beyond 5 times it they are dropped and counted (a flood alert). A punch sent again is a duplicate and does not count against the cap.
    - To change: the setting; the factor 5 in `ingest_store_punches` (a migration).
62. **Reviews look back 7 days:** the flagged feed and the new-address and held-punch alerts cover punches received in the last 7 days (older ones stay in the normal feed). The 5-second feed poll asks from 60 s before its newest row, so punches committed out of order are not missed.
    - To change: `REVIEW_WINDOW_MS` in `devices.constants.ts`.
63. **Batches:** punches are processed 100 per transaction (500 passed the 15 s job limit on the slowest kind), and the cutoff writes one section per transaction, so one failing section never stops the others.
    - To change: `PUNCH_BATCH` in `devices.processor.ts`.
64. **A lock wait over 5 s answers 409 `BUSY`** with `Retry-After: 2` (review, trust, manual staff day, close from device): nothing was changed, and the screen says "the system is busy right now, try again". Only a lock timeout (Postgres 55P03) does: a transaction past its own time limit stays a logged 500.
    - To change: `lockPunches` (`lock_timeout`) and `PrismaErrorFilter`.
65. **Retention details:** the 30-day database floor uses the database's date, so it can be a day behind the institute's. Commands: FAILED, CANCELLED and superseded DONE rows go 90 days after the latest of their `updated_at`, `sent_at` and `done_at`; each ID's latest DONE per device and waiting commands stay however old; an old FAILED add that was the latest goes too (the person's sync state then shows "not sent").
    - To change: `COMMAND_RETENTION_DAYS` in `device-retention.service.ts`.
66. **The take screen settles a conflict silently when nothing differs** (e.g. a draft started from the device's suggestion, then the device wrote the same register at the cutoff).
    - To change: `RegisterController` in `apps/web/src/lib/attendance/register-controller.ts`.
67. **The today report** says `CLOSED` whenever the day has a register (a teacher's too) and `BEFORE_CUTOFF` until the minute job writes it; it shows no device view on off days or for sections without students.
68. **Staff punches in the live feed say "staff"**, without their roles (the feed has none). Roles in the feed: [backlog.md](backlog.md).

## Deployment requirements (step 11)

Recorded during step 8; to be done when the production setup is built.

1. **Platform UI on its own subdomain** (e.g. `platform.<domain>`), separate from the institute app.
   - Why: today `/platform` shares an origin, and the CORS allowlist, with the institute app. The
     platform session cookie is httpOnly, so an XSS bug in the institute app could not steal it,
     but it could still use it from the victim's browser. A separate origin, plus an `Origin`
     allowlist check in `PlatformAuthGuard`, removes that path.
   - Also: the platform cookie keeps `Path=/platform`, `SameSite=Strict`, `Secure`.
2. **Redis: `maxmemory-policy noeviction` and persistence (AOF, `appendfsync everysec` or
   stricter).**
   - Why: Redis holds state that must not silently disappear. The roles-cache versions (an evicted
     or lost version could re-serve stale roles), revoked sessions, rate-limit counters, OTP
     codes, platform login challenges, the held-SMS and raw-import sets, and the BullMQ queues.
     Eviction or a restart without persistence weakens these.
   - Local `docker-compose.yml` already runs Redis with `--appendonly yes` and the default
     `noeviction`.
3. **Database roles:** create `jantrik_auth`, `jantrik_search`, `jantrik_platform` and
   `jantrik_platform_app` as in `docker/postgres/init/01-roles.sh`, with strong passwords, and set
   `DATABASE_PLATFORM_URL` and `PLATFORM_TOTP_KEY` for the API.
   - The roles must exist **before** the first `prisma migrate deploy`: migrations grant to them,
     and migration `20261021020000` fails without `jantrik_platform_app`.
   - Deploy order: migrations first, then restart the API. A platform function's signature can
     change between versions (e.g. `platform_list_institutes` in part 3), so an old API instance
     still running after the migration gets errors on that screen until it restarts.
   - Optional hardening: `REVOKE TEMPORARY ON DATABASE <db> FROM PUBLIC`. The definer functions
     already ignore temporary tables (`pg_temp` last), but the app's own raw SQL (e.g. the
     per-request tenant check) does not name its schema; a temporary table created through an SQL
     injection would live on that pooled connection. Not done locally: the DB tests create
     temporary tables on purpose.
4. **The device receiver** (step 11, [devices.md](devices.md)):
   - **Its own process** next to the API: `node apps/api/dist/ingest-main.js` (from `pnpm build`).
     Set `INGEST_IN_PROCESS=false` for the API (it is off by default when `NODE_ENV=production`,
     so the API alone never listens for devices).
   - **Only its own variables** (`apps/api/src/config/ingest-env.ts`): `NODE_ENV=production`,
     `DATABASE_INGEST_URL` (required), `REDIS_URL`, `QUEUE_PREFIX`, `INGEST_PORT`,
     `INGEST_TRUST_PROXY` and the limits below. **Never** give it `DATABASE_URL`,
     `DATABASE_PLATFORM_URL`, `JWT_ACCESS_SECRET`, `OTP_PEPPER` or `PLATFORM_TOTP_KEY`, and no
     `.env` holding them where it starts (it reads `../../.env` from its working directory). It is
     the one internet-facing parser without a login: code run in it must find no login that can
     choose an institute (`jantrik_app` can) and no key that signs sessions.
   - **Its port** (`INGEST_PORT`, 4080) must be reachable from schools over **plain HTTP**: open it
     in the firewall. Devices that support HTTPS can go through a TLS proxy in front of it
     (optional). Set `INGEST_PUBLIC_HOST` and `INGEST_PUBLIC_PORT` **for the API** to what
     devices dial (the setup guide shows them): a fixed IP address or a domain name. The API
     refuses to start in production without `INGEST_PUBLIC_HOST`, or with localhost or 0.0.0.0.
   - **Database:** create `jantrik_ingest` (NOLOGIN) and `jantrik_ingest_app` (LOGIN, a strong
     `DB_INGEST_PASSWORD`) as in `docker/postgres/init/01-roles.sh`, **before the first
     `prisma migrate deploy`** (the migrations grant to them), and give the receiver
     `DATABASE_INGEST_URL`. It refuses to start if that login can read a table.
   - **`INGEST_TRUST_PROXY`:** `false` when devices connect directly. Behind a proxy or load
     balancer: a hop count (`1`) or the proxy's address, **never `true`** unless the proxy
     overwrites `X-Forwarded-For`. With `true`, Express believes the left-most
     `X-Forwarded-For`, which any client writes: an attacker could claim a school's trusted address
     (and receive its commands, with names) or slip past every per-address limit.
   - **Redis:** the same Redis and `QUEUE_PREFIX` as the API (the `devices` queue, the limits,
     `ingest:refused`); item 2 applies.
   - **Deploy order** as in item 3: migrations first, then restart the API and the receiver.
   - **New variables** (`.env.example`): `DB_INGEST_PASSWORD` (the init script). The API:
     `INGEST_IN_PROCESS`, `INGEST_PUBLIC_HOST`, `INGEST_PUBLIC_PORT`. The receiver:
     `DATABASE_INGEST_URL`, `INGEST_PORT`, `INGEST_TRUST_PROXY`, and the limits
     `INGEST_PER_IP_PER_MIN`, `INGEST_PER_DEVICE_PER_MIN`, `INGEST_PER_DEVICE_ALL_PER_MIN`,
     `INGEST_REFUSED_PER_IP_PER_10MIN`, `INGEST_MAX_ATTLOG_BYTES`, `INGEST_MAX_DRAIN_BYTES`.

## Backlog fixes (day run 2026-11-13)

Taken without the owner during the unattended backlog run (branch `chore/backlog-fixes`, PR #7).
Each is a small default; how to change it is given.

69. **The receiver's start-up check gives each attempt 10 s** (`StartupCheckTimeout`, then retried like any other failure). The check answers in milliseconds on a working database; with the existing waits (about 3 minutes) a database that never answers fails the start within about 6 minutes.
    - To change: `checkTimeoutMs` in `apps/api/src/ingest/ingest-prisma.service.ts`.
70. **The fees setup's switch-off confirm for a bKash/Nagad number reads "নম্বর বন্ধ করুন" / "Turn off number"** (the menu item stays "বন্ধ করুন" / "Turn off"). English was not ambiguous ("Close" vs "Turn off") but follows the Bangla, so both say what is switched off.
    - To change: `numbers.deactivateConfirm` in `apps/web/messages/fees/setup.{bn,en}.json`.
71. **`wallClockToUtc` refuses a date or time that does not exist** (2026-02-30, 24:00:00) with its usual "Not a wall-clock time" error, rather than moving it to another day. Every caller already passes real times; the simulator CLI now refuses `--from 25:00` instead of using 01:00 the next day.
    - To change: the check in `packages/shared/src/dates.ts`.
72. **The entry and exit SMS cut a long name by grapheme cluster** (`Intl.Segmenter`, code points where it is missing) and drop a trailing hasant, zero-width joiner or space. Only names too long for two segments are cut.
    - To change: `nameLetters` / `cutName` in `packages/shared/src/devices.ts`.
73. **A devicecmd body from an address the device does not trust is cut at 64 KB by closing the connection** (as every drain past its limit is), not answered 413: nothing is answered to an untrusted address's command results anyway.
    - To change: `commandResults` in `apps/api/src/ingest/ingest.controller.ts`.
74. **The device hardening migration (`20261113000000_devices_hardening`)**: the reviewer CHECK goes one way only (`reviewed_by_id` needs a `review`; a review without a reviewer stays allowed, as today: requiring one would be a new rule); the serial number index is a plain index on all rows (the table is small; a partial `WHERE NOT is_active` index would also serve); each CHECK is added `NOT VALID` and then validated (a brief lock instead of a scan under an exclusive lock on `device_punches`). No app path writes a violating row, so only hand-made data in a local database could make the migration fail. Prisma does not wrap a migration in a transaction, so every statement in it can run again (`DROP … IF EXISTS` before each policy and CHECK, `CREATE INDEX IF NOT EXISTS`) and a failed deploy can be finished (tried on the scratch test database). No `lock_timeout`: `SET LOCAL` has no effect outside a transaction, and a session-wide `SET` would also bound the later migrations of the same deploy.
    - Recovery after a failed deploy ("check constraint … is violated by some row"; the error does not name the row). The migration login (`jantrik_owner`) cannot see or fix the rows: these tables force RLS and it does not bypass it. As the Postgres superuser (`POSTGRES_USER`, `postgres` locally) or another role with BYPASSRLS, on that database:
      1. Find the rows: `SELECT tenant_id, id FROM device_punches WHERE reviewed_by_id IS NOT NULL AND review IS NULL;` and `SELECT tenant_id, id FROM staff_attendance_days WHERE source = 'DEVICE' AND reason IS NOT NULL;`
      2. Fix them as that role, e.g. `UPDATE device_punches SET reviewed_by_id = NULL WHERE reviewed_by_id IS NOT NULL AND review IS NULL;` and `UPDATE staff_attendance_days SET reason = NULL WHERE source = 'DEVICE' AND reason IS NOT NULL;` (or make such a day MANUAL with its `updated_by_id`, if the reason is worth keeping).
      3. From the repository root: `pnpm --filter @jantrik/db exec prisma migrate resolve --rolled-back 20261113000000_devices_hardening`, then `pnpm db:deploy`.
    - To change: a later migration.
75. **The today page's line for a device register a person changed drops the time** ("ডিভাইস থেকে নেওয়া; {name} বদলেছেন"), rather than labelling it as the register's last change: the person's own time is not stored apart from the device's later changes.
    - To change: `reports.takenByDeviceEdited` in `apps/web/messages/{bn,en}.json`.
76. **Teachers' text for a register held back because students are not on a device ends "হাতে হাজিরা নিন।" / "Take it by hand."**, without "ask an admin to give IDs" (owners and admins keep the give-IDs advice and link).
    - To change: `reports.deviceNotOnDevice` (teachers) and `reports.deviceNotOnDeviceAdmin` in `apps/web/messages/{bn,en}.json`.
77. **The device people page keeps the staff list in the URL as `kind=staff`** (students need no parameter), next to `unmapped=1` and `section`.
    - To change: `peopleFilterFromUrl` / `peopleFilterUrl` in `apps/web/src/lib/devices/people.ts`.
78. **An institute that no longer exists leaves `devices:tenants` during the nightly retention job** (once a day, not every minute in the tick), found by its own `tenants` row being gone in its context, with a warning naming it. A failing or switched-off institute stays listed as before.
    - To change: `expireAll` in `apps/api/src/devices/devices.processor.ts`.
79. **Open for the owner: a time limit on the receiver's live database calls, and its pool size.** The receiver's pool (`INGEST_POOL` in `apps/api/src/ingest/ingest-prisma.service.ts`) now gives up getting a connection after 10 s, which covers both opening one and waiting for a free one while all 10 (node-postgres' default `max`) are busy: with more than 10 device calls in flight and a wait over 10 s, the waiting requests fail with 500 and the devices send them again (nothing is lost). TCP keep-alive probes an idle connection after 30 s (`keepAliveInitialDelayMillis`; without it the operating system waits about 2 hours). A device request's query still has no time limit: a database that answers the connection and then hangs a query keeps that request, and its pool connection, waiting. Not changed here: a `statement_timeout` or the driver's `query_timeout` would bound every `ingest_*` call, and the value must leave room for the largest upload (10 000 lines take about 2 s to store) under load. Defaults until decided: no query limit and a pool of 10, as before.
    - To decide: a value (e.g. 15–30 s) for `statement_timeout` on the `jantrik_ingest_app` role (`ALTER ROLE … SET statement_timeout`, a migration) or `query_timeout` in `INGEST_POOL`; and whether the receiver needs more than 10 connections (`max` in `INGEST_POOL`, within the database's `max_connections`) once many schools' devices call at once.
    - **_Decided by the owner (sprint 1, 2026-11-14): 5 s._** Built in P0: `statement_timeout: 5000` in `INGEST_POOL` (sent when a connection opens, enforced by the server) and `ALTER ROLE jantrik_ingest_app SET statement_timeout = '5s'` in both role scripts (not a migration: `jantrik_owner` cannot alter another role). The receiver refuses to start unless its login shows `5s`. An upload cut by the limit stores nothing and its resend stores each punch once (tested). The pool size stays 10.

## Sprint 1, P0: security follow-ups (2026-11-15)

Plan: [plans/sprint-1-p0-security.md](plans/sprint-1-p0-security.md), approved by the owner with A1–A4.

P0-1. **(A1) The login check refuses more than superuser and BYPASSRLS:** also a login that can become `pg_read_all_data`, `pg_write_all_data`, `pg_read_server_files`, `pg_write_server_files` or `pg_execute_server_program`, which pass every grant the platform and receiver isolation rely on.

- To change: `PRIVILEGED_PREDEFINED_ROLES` in `packages/db/src/login-privileges.ts`.

P0-2. **(A2) Fail closed means waiting for the database:** the API, the worker and the platform module now check their login at start-up and exit after about 3 minutes of retries when the database never answers (they used to start and fail per request; the platform module only warned). `pnpm dev` without Docker running exits after about 3 minutes with a message naming `DATABASE_URL`.

- To change: `STARTUP_RETRY_DELAYS_MS` in `apps/api/src/common/startup-check.ts`.

P0-3. **(A3) P0's branch starts from the plan branch** (`feature/sprint-1-admission`), so the sprint plan and P0's plan travel in P0's PR.

P0-4. **(A4) The Redis ACL test adds `+select`** for its throwaway user: the API tests use Redis database 1. The production rules have no `select` (the test asserts it); production URLs name no database.

P0-5. **The receiver's Redis rules are narrower than the plan's starting point:** explicit `eval`/`evalsha` instead of the whole scripting category, no connection category, `-function` (`FUNCTION LOAD`/`FLUSH` are in `@write`), no `SCAN`/`RANDOMKEY`/`DBSIZE` (key names hold phone numbers; found by the automated security review), `multi`/`exec`/`discard` by name for the rate limiter. The test runs every Redis call the receiver makes as that user, its queue add with the receiver's own options (`processPunchesJobOptions`: delayed, one job id per institute, the duplicate path), and the production receiver's boot test logs in as such a user; destructive commands are asked of `ACL DRYRUN`, never run, so a wrong rule cannot flush the Redis the tests share with development.

- To change: `deploy/redis/ingest-user.acl` (and its test, `apps/api/test/redis-acl.e2e-spec.ts`).

P0-6. **The production Redis check never runs a destructive command:** `check-ingest-acl.sh` proves the login with one write to the user's own key (expires in 5 s) and asks `ACL DRYRUN` (as the default user) about everything the user must not do.

P0-7. **The API test env allows `http://app.test` for CORS** (`apps/api/vitest.config.ts`), standing for the institute app's own origin: the env is validated once when `AppModule` is imported, so the "allowed by CORS, refused by the platform" test cannot set it per file.

P0-8. **Known flaky test, not caused by P0:** `appearance.e2e-spec.ts` → "the owner picks a preset and an accent" once got 403 on `/me/context` for a new owner in the full API suite and passed alone three times. Likely cause: `randomPhone()` draws from 10⁸ numbers and a full run makes thousands of users, so two can share a phone; that user then has two memberships and is not switched into an institute at login. To fix later: unique test phones per run.

P0-9. **The login check reads `session_user`** (the login), never `current_user`: a URL's `options=-c role=…` or a role default (`ALTER ROLE … SET role`) runs the session as another role, which any SQL can `RESET ROLE` away from. Found by the final review; tested with a superuser login that switches role when connecting.

Left by the final review for later (not built, each small):

- **Redis runs as root ~~and its image floats~~** (the image is pinned since the follow-ups of 2026-11-16, F-4 below; running as root is still open). `start-redis.sh` is started with `sh`, which skips the image's entrypoint (it drops to the `redis` user), as the earlier `sh -c` command did; `redis:7-alpine` is never pulled by the upgrade steps. The receiver can run Lua (`eval`), as it could before P0 with all of Redis. To do: end the script with `exec docker-entrypoint.sh redis-server …`, and pin a patched image or add `compose.sh pull redis` to the upgrade.
- **Done 2026-11-16 (F-3 below).** **`CORS_ORIGINS` is compared normalised by the start-up check but raw by the CORS middleware:** an upper-case or slash-ended `CORS_ORIGINS` entry passes start-up while the browser's preflight fails. The compose file derives both lists from `PLATFORM_DOMAIN`, so only a hand-written setting can hit it. To do: normalise `CORS_ORIGINS` in `env.ts` too.
- **The receiver's key scope `~<prefix>:devices:*` includes the worker's job schedulers** (the devices tick, expire-punches): code run in the receiver could delete them until the worker restarts and recreates them. Accepted for now (the scope the plan set); narrower read/write key selectors are possible at some cost across BullMQ upgrades.
- **Done 2026-11-16 (F-5 below).** **Refuse REPLICATION logins too** (`rolreplication`, and possibly `rolcreaterole`) in the login check; every production role is already created without them.
- **Local Playwright configs** that are not in git (`playwright.alt*.config.ts`, `dbg`, `shots`) set `CORS_ORIGINS` but not `PLATFORM_ORIGINS`: their platform specs now get 403 until they set it.

## Small follow-ups (day run 2026-11-16)

Branch `chore/small-followups`, one PR. Decided by the agent alone (the owner was away); each can
be changed in review.

F-1. **P1-I is built as the owner answered:** a password is also refused when it contains a
distinctive word of an institute's name. The name is split at spaces, punctuation, symbols and
zero-width spaces; generic words and words of digits only (`2026` in "Udvash 2026 Batch") are
dropped; every remaining word of 4 or more code points (the whole-name rule's counting) is
refused. The whole-name rule stays (digits included). Both sides are compared like the phone rule:
NFKC (full-width letters and digits), lower case, ASCII digits, khanda ta in its old encoding
(ত + ্ + ZWJ) read as ৎ, and without spaces, punctuation, symbols or invisible characters (soft
hyphen, zero-width space and joiners, word joiner…), so `ko.dom2026` or `k-o-d-o-m` count as
`kodom`. **Glued endings:** generic words glued to the end of a word are cut off only when they
are 6 or more code points together (`শাপলাউচ্চবিদ্যালয়` → `শাপলা`, `Kodomtolaschool` →
`kodomtola`), so a short generic ending leaves no fragment (`Australia` keeps its `alia`; `austr`
is not a word of the name). The error code stays `HAS_INSTITUTE_NAME` (its message now says "the
name or a word from it"), so the web and the API did not change shape.

F-2. **The generic words** (`GENERIC_NAME_WORDS` in `packages/shared/src/password.ts`), chosen
from the owner's examples "and similar": the kind of institute (school, college, madrasa, academy,
coaching, centre, institute, kindergarten, polytechnic, pathshala…), its level (high, secondary,
primary, junior, dakhil, alim, fazil, kamil…), who it is for (girls, boys, mohila…), its medium and
standing (english, bangla, version, international, model, ideal, public, government/govt, cadet,
residential, pilot, memorial, smriti, shaheed…), madrasa name words (darul, uloom, jamia, hafizia,
nurani, qawmi, islamia, quran, ebtedayee…), nursery and shishu, `and` written in Bangla, each in
Bangla and in English letters with common spellings (madrasah, madrassa, bidyalay, uchcha,
balika, madhyamik, prathomik, adarsha, sarkari, মাদরাসা, সরকারী, একাডেমী…). Not generic: place
names and people's names (`Dhaka`, `Motijheel`, `Cantonment`, `Salim`): they point at the
institute, so they are refused. Choices beyond the owner's words:

- **Generic words glued to the end of a word** are cut off too (6 or more code points together,
  F-1), and the whole glued word is still refused as well, so the rule never refuses less than
  splitting at spaces alone. Only endings: a generic word at the start of an ordinary word is not
  cut (`Highland` stays `highland`, so `highschool2026` is allowed).
- **Invisible characters and other ways of writing** are ignored on both sides, for whole names
  too (F-1). Unicode forms (য় as one code point or two) were already unified.
- **The slug is not checked** (the decision mentioned it as a "perhaps"; the owner's answer did not
  ask for it).

F-3. **`CORS_ORIGINS` is normalised in `env.ts`** like `PLATFORM_ORIGINS` (lower-case host, no
trailing slash or default port). An entry that is not exactly an origin (`*`, a bare host, or a
URL with a login, a path, a query or a fragment) is kept as written instead of stopping the start:
it matches no browser's Origin, production refuses it, and a developer's existing `.env` keeps
working. **Also fixed for `PLATFORM_ORIGINS`** (they share the helper, which used `URL.origin`):
`https://app.jantrik.com.bd@evil.example` used to become `https://evil.example` and pass the
production check (in both lists, since before this PR for `PLATFORM_ORIGINS`). Such an entry is
now no origin: production refuses it in either list, and `PLATFORM_ORIGINS` refuses it everywhere,
as it already refused entries that are not URLs.

F-4. **Redis is pinned to `redis:7.4.11-alpine`**, the version of the image this PC had (built
2026-09-17; the tag exists on Docker Hub), in the production compose, the development compose and
both CI jobs; a test checks the four agree and are exact. The exact tag, not a digest: Docker's
patched rebuilds of the same version can still be taken (`compose.sh pull redis`, deploy.md §
11). Your local Redis container keeps running `redis:7-alpine` until the next
`docker compose up -d`, which pulls 7.4.11 and restarts it on the same volume. Postgres
(`postgres:16-alpine`) and Caddy (`caddy:2-alpine`) still float: not asked, same fix if wanted.

F-5. **The login check refuses REPLICATION and CREATEROLE** for the runtime logins, and a login
that can become a role with either. CREATEROLE is refused too (the decision said "possibly"): no
runtime login has or needs it, the local init script creates none with it, and `create-roles.sh`
already refuses both for every role it makes, so no correct setup stops starting.

F-6. **Test users' phones are unique per database, across runs too** (the appearance flake,
P0-8). A per-run counter is not enough: the test database keeps every run's users, and Vitest
gives each test file its own module (no shared memory). So one counter per database lives in a
file in the OS temp folder (`jantrik-test-phones/`), taken 200 numbers at a time under a lock, and
never behind a clock that moves 1 number a second (a deleted file restarts ahead of older runs,
given about an hour and a half per 5 000 phones they used). New phones use operators no test used
before (API +88013, db package +88014, 50 000 000 to 98 999 999; the seeds' fixed numbers are lower
and the old random phones were 017/018), so they cannot meet old test users either. **The numbers
never wrap:** when the 49 million are used up (the clock alone gets there in about May 2028),
drawing stops with a message to recreate the test database and move the start date, instead of
repeating numbers older runs gave out. The lock is taken over only when stale (10 s), by moving it
aside first and checking its owner, and Windows' "being removed" answers (EPERM, EACCES) mean
"busy". `randomPhone` kept its name (about 40 files call it).

## The refresh race fix (2026-11-15)

Plan: [plans/fix-refresh-race.md](plans/fix-refresh-race.md), approved by the owner with conditions.

R-1. **Refreshes of one token are serialised by a Redis lock** (`rt:lock:<hash>`): a second refresh waits up to 10 s (`REFRESH_LOCK_WAIT_MS`), then 503 `REFRESH_BUSY`; the lock expires after 15 s should its holder die.

- To change: the constants in `apps/api/src/auth/session.service.ts`.

R-2. **The answer is stored before the rotation is committed**, and every Redis call on the refresh path has a 2 s limit (`REDIS_TIMEOUT_MS`): a Redis failure or silence is 503 `REFRESH_UNAVAILABLE` and leaves the token unrotated, never a sign-out or a revocation (the owner's condition 2). A stored answer whose rotation then failed is never served: an answer is read only for a token the database shows rotated.

R-3. **The stored answer names its session** (`{v: 2, sessionId, response}`, inside the encryption), and its replacement token must belong to that session too. One that cannot be opened with the presented token, names another session, or hands out another session's token is no answer, so the token counts as reused, as a missing answer always did. Answers stored by the previous release (no session named) are not read: there is no production yet.

R-4. **B8 is unchanged** (the owner's decision): a refresh lost when a tab closes during load, presented again more than 30 s later, is still revoked as reuse.

R-5. **The lock is fenced, not renewed.** A refresh checks, before storing its answer, that storing (≤ 2 s) and committing (the transaction: ≤ 3 s waiting for a connection, ≤ 3 s running; `COMMIT_TIMEOUT_MS`) can finish 0.5 s before its 15-second lock expires, i.e. within 6.5 s of asking for the lock; if not, 503 `REFRESH_BUSY` and nothing changed. A commit that finds the token already rotated (a lost lock) is 503 too, never 401. From the final review.

- To change: `COMMIT_TIMEOUT_MS`, `LOCK_MARGIN_MS` in `session.service.ts`.

R-6. **The global rate-limit guard answers 503 `SERVICE_UNAVAILABLE`** when Redis fails or does not answer within 2 s, on every route (it used to wait for ioredis to give up, about 10 s, then 500, or hang). A rate limit's own 429 is unchanged. From the final review (the owner's condition 2 is about the refresh; the guard runs before it).

- To change: `apps/api/src/common/guards.ts` → `RateLimitGuard`, `apps/api/src/redis/redis-deadline.ts`.

R-7. **Smaller changes from the final review:** the rotation time is taken before the answer is stored (the stored answer outlives the database's 30-second window); a session revoked while a refresh builds its answer rolls the rotation back (401, no new pair); a stale institute is cleared only if the session still has it (an institute switch made meanwhile stays); the revoked-session marker on the reuse path is bounded like the other Redis calls (503; the database revocation stands); the lock's release is sent without delaying the answer, and a lock request that timed out is released behind itself.

## Sprint 1, P1: staff set their own password (2026-11-15)

Plan: [plans/sprint-1-p1-staff-password.md](plans/sprint-1-p1-staff-password.md), approved by the owner with P1-A to P1-E and one addition to P1-D.

P1-A. **The routes need the current institute and a staff role there** (`OWNER`, `ADMIN`, `TEACHER`, `ACCOUNTANT`, `STAFF`), so each change is audited in that institute. Someone who is staff elsewhere switches institute first; a guardian gets 403 and no menu item.

P1-B. **The app login may update only some columns of `users`:** `locale`, `color_scheme`, `name_bn`, `password_hash`, `password_changed_at`, `updated_at`. No app code can change a login's phone, email or global name.

- To change: a migration granting the column (`GRANT UPDATE (<column>) ON users TO jantrik_app`), and `packages/db/test/users-rls.test.ts`.

P1-C. **Passwords are NFC-normalised** before hashing and verifying (the API and the platform-admin CLI), so a Bangla password typed on another keyboard still matches. Existing hashes are unaffected (the demo password is ASCII).

P1-D. **The rules:** 10 to 128 code points; not containing the person's phone number in any written form; not containing the whole name (4 characters or more) of an institute they are an active member of (the owner's addition); not on the common-password list (SecLists' 10,000 most common, MIT, plus jantrik/bangladesh/password variants), checked on the server only.

- To change: `PASSWORD_RULES` and `passwordProblems` in `packages/shared/src/password.ts`; the list in `apps/api/src/auth/common-passwords.txt`.

P1-E. **Password codes cost Jantrik, as login codes do** (`platform_sms_logs`), not the institute's SMS budget.

P1-F. **Each code purpose has its own 60-second cooldown; the 15-minute and daily caps are shared** (a change to the plan, which shared the cooldown too). With a shared cooldown, a staff member who has just signed in with a code would always wait up to a minute before the password code could be sent: the first thing most of them do. The SMS cost is still bounded by the shared caps (5 per 15 minutes, 10 a day, for both purposes together).

- To change: `cooldownKey` in `apps/api/src/auth/otp.service.ts` (one key for both purposes shares it again).

P1-G. **The rules are checked before the code** (a change to the plan's order, which verified the code first): a refused password, e.g. one on the common list that the form cannot check, does not use up the code, so the person does not need another SMS. Nothing secret is revealed by checking the rules first: the route needs a signed-in staff member, and the rules are public.

P1-H. **`GET /me/password` also returns the person's own phone** (an addition to the plan), so the form can check the phone rule as they type. It is their own number, returned only to them.

P1-I. **Built in the follow-ups PR (`chore/small-followups`, the owner's answer of 2026-11-16; see F-1): a distinctive word of an institute's name is refused too.** The rule refuses a password containing an institute's whole name (spaces and case ignored), as planned. The review found that the likely weak form, the name's distinctive word plus a year (`শাপলা২০২৬১২৩৪` for "শাপলা উচ্চ বিদ্যালয়", `kodomtola@2026` for "Kodom Tola School"), passes. Catching it means dropping generic words (school, coaching, centre, college, academy, madrasa, high, model, উচ্চ, বিদ্যালয়, কোচিং, সেন্টার, মাদ্রাসা, একাডেমি…) and refusing what remains (4 characters or more), perhaps the slug too. It widened the rule you set, so it waited for your answer.

- To change: `passwordProblems` in `packages/shared/src/password.ts` (the server and the form share it).

P1-J. **Built (day run 2026-11-16), for the owner's review with its PR: no ordinary request can read a password hash.** Plan: [plans/sprint-1-p1j-password-hash.md](plans/sprint-1-p1j-password-hash.md), written and built while the owner was away, as asked, then changed after the database-security review (P1-J7). `jantrik_app` lost SELECT on `users.password_hash` (granted column by column; UPDATE kept), its login lookup returns no password data, and the password login looks the hash up on its own database login (`jantrik_login_app`, `DATABASE_LOGIN_URL`) through one function only that login may run. Every Prisma client omits the hash. **Setup on your machine, in this order:** create the role once (docs/database.md → Database roles, the `CREATE ROLE jantrik_login_app …` line), add `DATABASE_LOGIN_URL` to `.env` (from `.env.example`), then `pnpm db:migrate`. Decisions taken alone, each the safest option (P1-J1 to P1-J7):

P1-J1. **The app's login lookup returned any user's hash, so it changed too.** `auth_find_user_for_login`, which `jantrik_app` may run, returned `password_hash` for any phone or email, whatever the institute: hiding the column alone would have closed nothing. It now returns id, name and locale only (the OTP login never needed more).

P1-J2. **`hasPassword` comes from `auth_my_password_is_set()`**, a definer function for `app.user_id` with no parameter. **It leaks one bit:** any SQL in a request can set `app.user_id` with `set_config`, so an injection can learn whether a given person has a password (yes or no; nothing about the password). Moving it to the login's own login would close that too; not done, to keep that login used by the password login only.

P1-J3. **Every Prisma client omits `passwordHash`** (a global `omit` in `createPrismaClient`), instead of a `select` at each call site. The package's `PrismaClient` type is that client's, so a read without `select` has no `passwordHash` and `new PrismaClient` from the package does not type-check (the test helper's one-connection client now comes from the factory, with a new `max` pool option). Not stopped by TypeScript, only by the database: an explicit `select: { passwordHash: true }`, and the generated class, which the package's `export *` still exports at runtime.

P1-J4. **A cost ceiling for stored hashes at login:** at most 64 MiB, 10 passes, 4 lanes (today's hashes: 19 MiB, 2, 1). Above it, or unreadable, the stored hash counts as no password (the dummy check runs, so the time is the same). Before, argon2 verified whatever parameters a stored hash named, so someone who wrote a huge-cost hash into their own row could make each of their login attempts arbitrarily expensive.

P1-J5. **(Dropped after the review.)** The first version accepted only argon2id v19 with a 32-byte digest, because the API recomputed the hash. With argon2's own verify back (P1-J7) any argon2 hash within the ceiling works again.

P1-J6. **Not changed: the platform admins' login** (`platform_find_admin_for_login` returns `platform_admins` hashes and TOTP secrets to `jantrik_platform_app`). It is a separate login with no tenant traffic; the same change can follow if you want it.

P1-J7. **Built after the review; you may drop these commits:** the first version kept the hash in the database and compared a digest there (`auth_my_password_matches`). The review showed that an injection could read any user's salt, set `app.user_id` to them and check 200,000 offline-computed guesses in one 6.4-second statement: close to reading the hash. Now a dedicated login, `jantrik_login_app`, is the only one that may run the hash lookup (`auth_find_user_for_password_login`); `jantrik_app` has neither the lookup nor any comparison function, and the API verifies with argon2 as before. It follows the platform and receiver logins: its own env URL (required, refused in production as the owner or superuser, never given to the receiver), its own small pool, the fail-closed privilege check and a mixed-up-URLs check at start-up, and the role in `01-roles.sh`, `create-roles.sh`, the production compose, CI, the restore check and the docs. **Upgrade:** the migration first checks that `jantrik_login_app` exists and refuses to run otherwise (Prisma does not run a migration in one transaction, so a failure half-way would leave the first statements applied); every statement can run again after `prisma migrate resolve --rolled-back`. On a server the role is created after the checkout and before `migrate` (docs/deploy.md → Upgrades). Between `migrate` and the restart, the old API fails whole-row reads of `users` (the refresh, `/auth/me`) and both logins; a failed refresh is retried and nobody is signed out.

P1-J8. **Built (day run 2026-11-17), for the owner's review with its PR: an SQL injection can no longer pose as another person or enter another institute.** Plan: [plans/sprint-1-p1j8-verified-context.md](plans/sprint-1-p1j8-verified-context.md), written and built while the owner was away, as asked ("the option that closes it most completely without weakening anything"). Before, the request's identity was `app.user_id` and `app.tenant_id`, which any SQL in the transaction could change with `set_config`: an injection could write a victim's `password_hash` or insert a session for them, read or write any institute's rows, and make itself OWNER of any institute (`packages/db/test/account-takeover.test.ts`: six of its seven attacks succeeded on integration/sprint-1). Now the API signs one setting, `app.context` (institute, person, the connection's backend pid and the transaction's start), with a key the database generates and only `jantrik_login_app` (and the owner) may read; `app_current_tenant_id()` / `app_current_user_id()` believe nothing else and raise 42501 on a value that does not verify for this very transaction. **No setup step for the owner beyond #16's:** no new role, no new `.env` line; `pnpm db:migrate`, then restart `pnpm dev`. P1-J2's one-bit leak is closed by the same change. Decisions taken alone, each the safest option found (P1-J8a to P1-J8g):

P1-J8a. **The verified context, not narrower write rules.** Moving only password and session writes behind definer functions (the other option recorded) would have left an injection free to enter any institute and make itself OWNER there through `memberships`. The signed context closes every path that goes through `set_config`, and with it an injection can only do what its own person could already do through RLS.

P1-J8b. **The key lives in the database, made by the migration** (`pg_strong_random`, 48 bytes; the HMAC pads stored next to it so the check needs only the built-in `sha256()`; pgcrypto stays out). The API and the worker read it through the password-login login (`auth_context_key()`, executable by `jantrik_login_app` only) at start-up and refuse to start without it; the seed and the tests read the table as the owner. No env var, so nothing to set up, copy or leak in `.env`; a restore keeps the key (it is in the dump, like every row). Rotation has no command yet (database.md → The request context); see P1-J8h.

P1-J8c. **A bad context raises 42501 instead of meaning "no context".** Unset or empty still means no context (nothing visible). A forged, tampered, copied or malformed value fails the statement loudly, so an attempt shows in the logs.

P1-J8d. **Bound to the backend pid and the transaction start**, so a value that leaks (a log, an error) is useless in any other transaction or connection. It costs one more round trip for a context with only a tenant or only a person (jobs, login steps); the request's tenant-and-person context needs no more than before.

P1-J8e. **Every policy rewritten to call the functions wrapped, `(SELECT app_current_tenant_id())`**, in the same migration (76 of 124 policies), so the check runs once per statement, not per row; the four definer functions that call them are recreated wrapped, and `schema-safety.test.ts` fails on a bare call. `tenant_modules.provisioning_only` read its own table in a subquery, which PostgreSQL now refuses as policy recursion; the same check moved into a STABLE plpgsql function (`app_tenant_has_modules`, the caller's RLS as before). Measured on the scratch database: about 38 µs per check; ten statements in one transaction 26.7–27.9 ms against 25.9–26.1 before.

P1-J8f. **`tenantClient` kept, but each model call now runs in its own `withTenant`** (a batch transaction cannot read the backend and start first). Only tests and the docs use it.

P1-J8g. **`app_verified_context()` is runnable by the roles whose queries meet a policy** (the app, the owner, and the owners of the definer functions), not by PUBLIC, like every definer function; it returns only the caller's own verified context.

P1-J8h. **Production refuses to start without the key; development and tests only log it, and a changed key is reloaded.** CI's Playwright starts the API before its global setup migrates and resets `jantrik_e2e`, so a start-up that required the key failed there, and the reset would have made a new key under the running API. Now: in production (migrations run before the apps) no key → no start, as before; elsewhere an error in the log and the key is loaded on the first institute transaction. Every signed transaction also reads a one-way fingerprint of the database's key (`app_context_key_id()`, runnable by `jantrik_app`; it reveals nothing that helps forge a signature) in the round trip it already makes, and reloads the key once when it changed (a reset, a restore from another server, a rotation); if it still differs, the transaction fails before its work runs. Without a key nothing can be signed, so every institute transaction fails: closed and loud either way.

P1-J8i. **From the review: no temporary objects for the runtime logins.** The signed context assumes an injection cannot leave anything behind on a pooled connection; the review planted a temporary view `tenants` and the victim's next request on that connection ran it in the victim's context (password hash changed, attacker OWNER of the victim's institute). Production revoked TEMPORARY already; development, the test databases, CI and Playwright did not. Now the P1-J8 migration revokes TEMPORARY on its database from PUBLIC (so does `docker/postgres/init`), the API refuses a `DATABASE_URL` login with TEMP in production and warns elsewhere, and the request path's SQL is schema-qualified. **For your existing local databases** the migration does it when you migrate each one; to do it at once, as the Postgres superuser: `REVOKE TEMPORARY ON DATABASE jantrik FROM PUBLIC; REVOKE TEMPORARY ON DATABASE jantrik_test FROM PUBLIC; REVOKE TEMPORARY ON DATABASE jantrik_e2e FROM PUBLIC;` (the merge runbook has the exact command). The definer functions already list `pg_temp` last (schema-safety checks it).

P1-J8j. **From the review: the upgrade stops the API and the worker before `migrate`, and the caches have a new generation.** Between `migrate` and the restart an old API reads no institute data; it would have cached empty roles and modules for 5 minutes under keys the new API reads (403s, skipped device jobs, an import left queued). The roles and modules cache keys and the fees "dues ensured today" marker carry a new generation, and docs/deploy.md stops api and worker first.

P1-J8k. **From the review: identities a job signs come from rows the app cannot forge.** `student_imports.created_by_id` (the import job signs as that person) is no longer updatable by `jantrik_app`, and a request can only create an import as its signed person (a trigger). Accepting an invitation checks it in the person's own context before signing the URL's institute. The other jobs take their person from job data in Redis, not from a row.

P1-J8l. **From the review: the HMAC pads are derived from the key by a trigger**, so they cannot drift and a rotation is one UPDATE (docs/database.md → The request context).

P1-J8m. **Recorded, not changed (from the review):** `jantrik_auth` (the owner of the auth functions) can read the key table. A dedicated NOLOGIN owner for the key would follow least privilege more closely but needs a new role, i.e. a setup step on every machine; not worth it now (`jantrik_auth` is NOLOGIN and runs only reviewed definer functions). What an injection can still leave on a pooled connection is listed in docs/database.md → The request context: session settings, session advisory locks, signals to other app backends, and stored role settings, all denial of service or wrong output, none another person's data; stored role settings are refused at start-up in production (P1-J8p). **Not preventable in PostgreSQL:** a login may change its own password (`ALTER ROLE jantrik_app PASSWORD …`); the services then fail to connect until the password is set back. Denial of service only.

P1-J8n. **Open for the owner (from the review): planner estimates on large institutes.** The policies compare `tenant_id` with a parameter the planner cannot see, so it estimates an average institute. Measured on a skewed scratch dataset (plan → Performance): one real plan change, the student list page of a 3,030-student institute, 0.8–1.2 ms before, 5.0–6.2 ms after (a full sort instead of reading the first 50 in order); the attendance, exam and search reads are the same or faster. Options: (a) accept it (default for now; the cost grows with the institute: perhaps 15 ms at 10,000 students); (b) **recommended:** pass the institute explicitly (`tenantId` in `where`) in the paged lists (students first, then enrolments and dues lists): shown to bring the old plan back (0.9–1.4 ms), RLS still applies, a small change per query, in its own PR; (c) not an option: reading the unsigned setting for estimates (any SQL could change it mid-statement).

P1-J8o. **From the review, round 2 (must-fix): a transaction left open on a pooled connection.** SQL the app sends outside a transaction may carry several statements, so an injection there could end with `BEGIN; DECLARE c CURSOR WITH HOLD FOR SELECT … FROM students` and leave the transaction open. The next request on that connection (another institute's) signed that transaction, and the cursor was filled with that institute's rows at its COMMIT; the attacker read them later with FETCH (reproduced). Fixed twice: the pool of every client `createPrismaClient` makes closes a connection released with a transaction open (`pg` is now a direct dependency of the db package, the same version Prisma's adapter already used), and `withContext` refuses to sign a transaction that is not fresh (a transaction id assigned, or a cursor declared in it before signing), which rolls it back. The three app queries that ran outside a transaction (the refresh-token lookup, the SMS rate, the health check) run in one. Not adopted: also refusing when the transaction started more than a margin before the signing statement (a busy event loop would refuse honest requests; the two checks are exact). The reviewer's probe is `packages/db/test/leftover-transaction.test.ts`.

P1-J8p. **From the review, round 2: stored role settings.** `jantrik_app` may run `ALTER ROLE jantrik_app [IN DATABASE …] SET statement_timeout = '1ms'` for itself (reproduced): every new connection of the API and the worker takes it, even after restarts. Every runtime login's start-up check now reads the settings stored for it (for every database or this one): production refuses settings the login should not have (the receiver's `statement_timeout=5s` is expected), development and tests warn. The same check now reads TEMP through roles the login can only SET ROLE to, and the platform, receiver and password-login logins run both checks too.

P1-J8q. **From the review, round 2: only the uploader may start an import or include a possible duplicate.** The worker runs the import as its uploader and audits it in their name, so another admin of the institute starting it (or changing which duplicates it imports) would act in the uploader's name. Recorded, not changed: an SQL injection in an admin's request can still change another admin's queued import content in the table (rows, mapping, results); that is P1-J10 (RLS does not separate people inside an institute).

P1-J9. **Follow-up for the owner (not built): email login lookups are case-insensitive but not indexed.** Both login lookups compare `lower(u.email) = lower(p_email)`; `users_email_key` is case-sensitive, so that comparison scans the table (an unknown email takes longer as the table grows) and two emails differing only in case can coexist. The fix: check for such duplicates first, then a unique index on `lower(email)` (and drop the old one). Not in this PR, because existing data could hold duplicates.

P1-J10. **Follow-up for the owner (not built, not set_config): RLS does not separate roles inside an institute.** With P1-J8 an injection is the person whose request it rides in, in their institute. But the policies isolate institutes, not roles: an injection in a teacher's or a guardian's request can still write any row of its own institute that `jantrik_app` may write, e.g. insert an OWNER membership for itself in `memberships`, change marks or fee rows. The API checks roles; the database does not. Options, each larger: (a) role-aware policies on the most sensitive tables first (`memberships`, marks, payments), reading the role from the signed context (the API would sign the person's roles too); (b) writes to `memberships` only through definer functions that check the caller's role; (c) leave it to the API and code review (today). Recommended: (a) for `memberships` first, since it is the path to taking an institute over.

P1-K. **Fixed from the review** (each with a test that failed first): a code is single use even when two requests race with it (login codes too); the phone rule ignores every punctuation mark and symbol between the digits; the other sessions are revoked in one statement; the common-password list is read at start-up; password login accepts up to 512 code points (a 128-character password typed decomposed); the wrong-code message asks to check the code before sending a new one. Kept as they are: the staff check after a correct password costs one extra query (it only confirms a password the caller already has); the login page's hint sits under the password tab, which guardians do not use.

## Sprint 1, P2: institute profile, files, photos (2026-11-16)

Plan: [plans/sprint-1-p2-files.md](plans/sprint-1-p2-files.md), written and built during the unattended day run of 2026-11-16 (the owner asked for it while away). The PR is the approval step. Each decision below is the safe default; all are reversible.

F1. **Who sees what.** A student's photo is part of the full record, as on the student's page today (the basic view for a teacher of another section already left it out): OWNER and ADMIN for every student, a TEACHER for the students of their current sections, a guardian for their own children only (`GET /me/children/:id/photo`). Anyone else gets 404, as for a student that does not exist. The logo: every member, guardians too. The head's signature and the seal: OWNER and ADMIN only (they could be misused on forged papers; P8/P9 widen this for printing). The profile fields: OWNER and ADMIN.

F2. **Lists keep initials.** The student list, the cards view and other lists do not load photos: fifty photos of up to 200 KB would not fit the 3 s budget on slow 4G. Photos show on the student's page and side peek, the guardian's child card and the report card. A small thumbnail kind for lists is a follow-up.

F3. **`photoId` replaces `photoUrl`** in every API type (student list, profile, guardian children, report cards, admit cards): the stored file's id or null. The web fetches the image with the bearer token from the entity route and caches it by that id.

F4. **EIIN is exactly 6 digits** (BANBEIS), optional. One CHECK to widen if an institute has another form.

F5. **The institute's phone** may be a mobile (stored as E.164) or a landline (5–15 digits, optional `+`).

F6. **An image uploaded before the first save** creates the profile with the registered name (`tenants.name`) in its script (Bangla or English), so the "one name" rule holds.

F7. **Formats.** JPEG, PNG and WebP only, by content. HEIC is refused (iPhones send JPEG to the browser's file picker; sharp's prebuilt build cannot decode HEVC). A transparent photo is flattened on white. Truncated files are refused; other decoder warnings are tolerated (some phone JPEGs have harmless ones).

F8. **60 uploads per person per 10 minutes** (`file-upload:<userId>`), on top of the general limits: each upload costs CPU.

F9. **A deactivated student's photo** can be viewed by OWNER/ADMIN but not changed (409 `DEACTIVATED`, like other student writes).

F10. **Replacing an image deletes the old file** in the same transaction; there is no image history. The audit row keeps the old and the new file id.

F11. **The per-institute total is counted, not recomputed**, under the institute's advisory lock; tests check it equals the sum of the files after puts, replaces, deletes and two uploads at once.

F12. **No institute header or logo on the report card yet.** The profile and images exist for P3 (the admission slip), P8 and P9 (documents); the report card gains only the student photo, as the sprint plan says.

Changed after the review (each code fix with a test that failed first; R3 is checked by Playwright
in CI; R9 and R10 are docs and tests only; details in the plan → "Changed after the review"):

- **R1. Uploads no longer run inside the request transaction** (must-fix). `TenantContextInterceptor`
  (a global interceptor) opened the 15 s transaction and took a pool connection before multer read
  the body: a 2–5 MB photo on slow 4G took longer than 15 s (a 500 every time), and ten slow
  uploads could hold all 10 connections (every other institute failing). The two upload routes
  are now `@OwnTransaction()`: the body is read, the upload limit applied and the image decoded
  with no connection; then `RequestTransaction.run` (the interceptor's own logic, moved into a
  service) opens the same tenant transaction for the short store. The image queue is bounded (8
  waiting; more get 503 `IMAGE_BUSY`), and the browser shrinks a chosen image to 1600 px on the
  long side (JPEG 0.85 for photos, PNG for the others) before sending, so a phone sends about
  300 KB. Test: while a slow body arrives, no session of the app login is idle in a transaction.
- **R2. The code scan also catches Prisma relation fields** (`photoFile`, `logoFile`,
  `signatureFile`, `sealFile`, `storedFiles`, `storedFileUsage`, `storedFilesCreated`, the
  `profile*` back-relations).
- **R3. The guardian's report card shows the photo** through `/me/children/:id/photo`
  (`ReportCardsPrint as="guardian"`); Playwright checks it in the exams spec.
- **R4. The web address's scheme is stored in lower case** (`HTTPS://x` → `https://x`), as the
  database CHECK is case-sensitive; it was a 500.
- **R5. The image queue hands a freed slot straight to the next waiter**, so it can never run
  three at once.
- **R6. A file reference is tied to its kind in the database.** `stored_files` has
  `UNIQUE (tenant_id, id, kind)`; `students.photo_file_kind` (always `STUDENT_PHOTO`) and
  `institute_profiles.logo_file_kind`, `head_signature_file_kind`, `seal_file_kind` (always
  `LOGO`, `SIGNATURE`, `SEAL`, by CHECK) are part of each foreign key, so a photo column can only
  hold a photo, a logo column a logo, and so on.
- **R7. Replacing an image near the cap is allowed** when the total would not grow: `put` takes the
  id it replaces (read under the file lock) and counts it.
- **R8. The first image and the first save cannot collide:** the row an image creates is inserted
  with `ON CONFLICT DO NOTHING`.
- **R9.** F1 above now says what the code does (a teacher sees photos of their own sections only).
- **R10.** The database tests name the rule that refuses each write; a PNG `eXIf` GPS case was
  added to the image tests.

- **For the owner (backlog): the CSV imports read their uploads inside the request transaction
  too** (student import up to 5 MB, device people up to 1 MB). Smaller and rarer than photos, so
  not changed here; they can move to `@OwnTransaction()` the same way.

Changed after the review, round 2 (each code fix with a test that failed first):

- **R11. Uploads in flight are bounded.** With R1 nothing limited how many upload bodies could be
  in memory. `UploadGuard` (before multer) allows 16 per process and 2 per person, refuses more at
  once with 503 `IMAGE_BUSY`, gives the slot back when the response closes (sent, failed or
  dropped by the client), and drops a body not received within 60 s.
- **R12. `RequestTransaction.run` refuses to nest** inside a request transaction (it would replace
  the outer one in the request context). The interceptor itself uses an unchecked entry (`around`): it is the outermost transaction, and a request made from inside a running job (as some tests do) inherits that job\'s request context.
- **R13. The upload's transaction re-checks the session and the route's roles** (OWNER/ADMIN),
  read in the transaction, besides the institute's status and the membership: an admin
  downgraded, or a session revoked, while the body arrives stores nothing (403 / 401).
- **R14. The target is checked before decoding:** a student photo for an unknown or deactivated
  student, or any upload in a suspended institute or by someone who lost the role, is refused
  before the image is decoded or the upload quota is used.
- **R15. sharp's own 10 s timeout** on the decode and each encode → 422 `IMAGE_TIMEOUT`.
- **R16. A replacement no bigger than the old file is never refused**, even when the total is over
  a lowered cap; `FileStore.put`'s contract says the caller deletes the replaced file in the same
  transaction.
- **R17. A profile save takes the file lock before reading the row**, so a first save racing a
  first image is audited as an UPDATE (one CREATE per institute).
- **R18. The browser asks for the EXIF orientation explicitly** (`imageOrientation:
'from-image'`); an engine without it sends the original, which the server turns upright.
- **Tests:** a deterministic database test of the ON CONFLICT path (an insert held uncommitted);
  the slow-body check sampled every 100 ms, for the logo route too; suspended institute and
  disabled member → 403 with nothing stored; the signature column's wrong kind; the exams spec
  removes the demo child's photo in an `afterEach`.
- **Migrations edited in place:** both migrations of this PR changed after it was first pushed
  (R6). Nothing outside this run's scratch databases applied them; any database that did needs
  a fresh one (or a reset) before applying the final versions.

Changed after the review, round 3 (each code fix with a test that failed first):

- **R19. No upload slot leaks when the client leaves early** (must-fix). If the socket closed while
  the global guards awaited Redis, the response's one 'close' event was already past when
  `UploadGuard` listened for it, so the slot was never given back. A client already gone (the
  test on-finished uses: the request or response destroyed, the answer sent, or the socket no
  longer writable) now gets no slot, and every slot is given back after 5 minutes at the latest
  (a backstop).
- **R20. The revoked-session check runs before the transaction**, with Redis's 2 s deadline (503
  `SERVICE_UNAVAILABLE`), so a slow Redis never holds a pooled connection; the roles are still
  read in the transaction.
- **R21. A browser that predates `imageOrientation`** (a TypeError) decodes without it when the
  photo needs no turning (no EXIF orientation, or 1; a small JPEG reader checks), and sends the
  original otherwise (the server turns it upright).
- **R22.** The timeout test uses sharp 0.35.5's real message (`timeout: N% complete`).

Also decided while building:

- The migrations were written by hand (no development database is used in this run) and checked with `prisma migrate diff` against a scratch database: empty.
- `sharp` 0.35.5 was already in the lockfile through Next.js; the API now depends on it directly (S8).
- Encoding effort is moderate (PNG palette effort 4, WebP effort 4): the worst case (pure noise) stays well under the request's 15 s; a test pins it under 8 s per image on this PC.

## Sprint 1, P3: online admission (2026-11-17)

Built during the unattended day run of 2026-11-17 from the P3 plan (`docs/plans/sprint-1-p3-admission.md`,
PR #15) with its recommended defaults P3-A to P3-V, on top of P1-J8 (#20). Staff side and the
December dues rule: P3a (this PR). Decisions taken alone, each the safest option found:

- **P3-a1. Field lengths follow the student's fields**, not the plan's numbers: names 120
  characters (plan 100), addresses 300 (plan 500), date of birth from 1920 (plan 1990), so an
  approved application always fits a student (`admit()` would refuse a longer value).
- **P3-a2. Blood group is hidden by default** (P3-Q did not list it): less personal data unless
  the institute asks for it.
- **P3-a3. "Live" for the three-per-phone cap** is "not withdrawn and not rejected"; the duplicate
  check counts every application not withdrawn (as the plan).
- **P3-a4. Staff entry is JSON; the photo is a separate upload** (`PUT /admission/applications/:id/photo`,
  P2's upload pipeline and `@OwnTransaction`), instead of one multipart request. The cycle's
  required fields apply to staff except the photo; staff may fill fields the cycle hides.
- **P3-a5. Staff may enter applications in any cycle status** (draft, open or closed): paper forms
  arrive after the deadline.
- **P3-a6. Three extra read routes for the pages:** `GET /admission/options` (years, classes,
  groups), `GET /admission/cycles/:id`, `GET /admission/cycle-classes/:id/sections` (where to
  approve into).
- **P3-a7. Bulk approval:** STUDENT_LIMIT, SECTION_FULL and INACTIVE stop the run and mark the
  rest; GUARDIAN_CHOICE_REQUIRED and DUPLICATE skip one; an unexpected error is recorded as a new
  problem `INVALID` (logged by its error name only, never the message: it can hold personal data).
  The job id is `admission-approve-<class id>` (BullMQ refuses `:`), removed when done so a re-run
  can start; "running" is the job's state.
- **P3-a8. Status changes** go between any statuses except out of `ADMITTED` (final), each with
  who, when and the reason, audited; no further state machine (P4 adds SELECTED/WAITLISTED).
- **P3-a9. The message namespace is `admissions.staff`**: `admission` is the student admission
  form's (its field labels are reused).
- **P3-a10 (money). The December rule is recorded, never derived** (changed after the review,
  M1): the first version treated any student created before the year's start with no earlier
  enrolment as a December admission, which back-dated an admission fee, with fines, for imported
  students and for students of an institute's first year. Now `admit()` records
  `students.admission_date_for_dues` only for a child admitted into a year that has not started
  and is not current yet; every other student keeps the creation day exactly as before, and the
  column starts empty for all existing students (no data check needed before deploying).
- **P3-a11. No trigram index on application names:** 2 000 applications list in well under
  300 ms with `ILIKE` (the API test measures it).
- **P3-a12 (review S2). Bulk approval approves SELECTED applications only** (the approved sprint
  plan's "bulk approve for SELECTED rows"); staff may mark an application SELECTED by hand in a
  cycle without an admission test (with one, the merit list selects). Approving one at a time keeps
  P3-H (submitted, shortlisted or selected).
- **P3-a13 (review S1). Bringing back a withdrawn or rejected application** runs the duplicate and
  per-phone checks under the row lock; a status change clears a bulk approval problem.
- **P3-a14 (review S3). One application per birth registration number per cycle, not withdrawn:**
  an advisory lock per number (after the phone's, the same order in the public function) and a
  partial unique index as the backstop.
- **P3-a15 (review N2, N7, N4).** Updates of cycles and their classes by column; a cycle edit takes
  the cycle's lock exclusively and new applications take it shared, so turning the admission test
  on cannot race the first application; a bulk problem is audited, and problems of applications
  later rejected or withdrawn are not listed.
- **P3-a16 (review N5, N3, recorded only).** A photo left on an application after a STORAGE_FULL
  approval stays there (the student's own photo can be uploaded on the student page); the tests do
  not force a bulk/single overlap or a second start while one runs (timing-dependent); one-row
  locking is what guarantees both.
- **P3-a17 (review N6).** The admission Playwright spec uses its own phone and birth registration
  number per run and deactivates the student it made in a `finally` (the suite shares one database
  and other specs count the demo school's students).
- **P3-a18 (money, review round 2 NIT 6). An institute that marks next year current in December:**
  an approved application still records the year's start (an application is always a new child, so
  its admission fee is charged from the year's start instead of never). The staff "new student" form
  and imports keep `!isCurrent`: they cannot tell a new child from an existing student typed in by
  an institute in its first year (current from the day it was made), which P3-a10 protects from a
  back-dated admission fee. **Owner:** a December admission typed on the staff form after an early
  switch owes no "from the year's start" admission fee, as before P3; staff can approve it through
  an application instead, or a later "new admission" switch on the form can decide it.
- **P3-a19 (money, review round 2 NIT 6). The recorded date counts only for a year that starts on
  or after it:** for an earlier year (the child also enrolled there, e.g. moved back by staff), or a
  year whose start was moved earlier, the dues count from the later of the creation day and that
  year's start, never from a date after the child joined (which would skip months: an under-charge).
- **P3-a20 (review round 2 NIT 5, NIT 2, NIT 7).** Any move out of `WITHDRAWN` runs the duplicate
  check (`REJECTED` counts as a duplicate and in the unique index); moving from `WITHDRAWN` or
  `REJECTED` to a live status also runs the per-phone cap. A staff entry takes the cycle's shared
  lock before reading the cycle. A bulk run approves an application only if it is still `SELECTED`
  under the row lock.

The public form, P3b (its own PR, stacked on P3a):

- **P3-b1. Turnstile keys (the owner's instruction):** development uses Cloudflare's official
  always-pass **test keys** (`.env.example`); the API and Playwright tests use a fake verifier
  (`TURNSTILE_PROVIDER=fake`, refused outside `NODE_ENV=test`) and never call Cloudflare;
  production refuses a missing or published test secret. A web build without a site key shows a
  plain "I am not a robot" box whose token only the fake verifier accepts, so such a build fails
  closed in production. The production compose requires `TURNSTILE_SITE_KEY` (a build argument).
- **P3-b2. `admission_public_form` also returns the institute's id and timezone**, which the API
  keeps (never sent to the browser): the code request then needs no fourth function.
- **P3-b3. `admission_submit` hashes the photo itself** (no `p_photo_sha256` parameter) and
  takes the name key from the API (`p_name_key`, made by the same `nameKey` as staff entries; review
  N8: PostgreSQL's `lower` and `\s` could differ from JavaScript's and miss a duplicate).
- **P3-b4. The two SMS jobs have their own queue, `admission-sms`** (the plan said `sms`): the
  API's SMS processor is unchanged and the admission module owns its jobs. A code's log row is
  kept across a send retry (no second row).
- **P3-b5. A value the tables refuse answers `INVALID`** inside `admission_submit` (an exception
  block around the inserts), never an error: the counter increment rolls back with it (no gap).
- **P3-b6. The public calls run in a transaction with no institute and no person**
  (`withContext({})`), following P1-J8's rule that no query runs outside a transaction.
- **P3-b7. `/apply` restores no session** (the auth provider is inactive there, as on `/platform`):
  the page never calls `/auth/refresh`.
- **P3-b8. The "received" SMS** is in the institute's default language and carries the status
  link only when `WEB_PUBLIC_URL` is set (required in production).
- **P3-b9. The per-phone daily code limit counts across institutes** (5 a day per phone in all),
  stricter than per institute: SMS pumping through many institutes' forms gets nothing extra.
  **Owner, by design (review round 2):** anyone who knows a family's phone can spend its five
  codes with five requests (each passes Turnstile and is one minute apart) and so shut that family
  out of every institute's form for up to 24 hours (not the status page: its codes have their own
  budget, P3-b16); the family still gets the five SMS, which shows something is wrong. The
  alternative (per institute) multiplies what SMS pumping can send by the number of institutes.
  Walk-in entry by staff (P3-J) is the fallback.
- **P3-b10. Not measured here:** the 3-second budget on a throttled phone for `/apply/[slug]`
  needs a running web app and API, and this run starts no servers (ports and memory). The page
  loads no Turnstile script until the phone step; the build's size budget applies.

After the security review of P3b (round 1):

- **P3-b11 (review M1). Refused code requests never spend the shared budgets:** the per-address
  and per-phone-cooldown limits are counted first; the phone's 5 a day and the institute's daily
  ceiling are checked and counted together, atomically, only for a code that is sent
  (`RateLimiter.consumeIfAllowed`, a Lua script). Before, one phone could shut an institute's form
  for the day.
- **P3-b12 (review S1; a change to P3-S for the owner). A duplicate tells its number only to the
  same phone:** an application found by another family's birth registration number answers
  "already applied, contact the institute" with no number; a phone at its cap is told so before any
  duplicate check (no oracle).
- **P3-b13 (review N5).** An injection as `jantrik_app` can call the public functions with any
  phone and `p_now` (documented in database.md); `p_now` stays a parameter (the tests move time).
- **P3-b14 (review S2). Turnstile:** with a real secret, the answer must name our action and the
  web app's host; Cloudflare's test secrets report neither and are refused in production anyway.
- **P3-b15 (review S3). The submit's upload is read only after a guard** checked the per-address
  limit and the phone token (signature, expiry); the route then checks its institute.
- **P3-b16 (review S4; for the owner). The status page's code works after the form closed**, but
  is sent only when the phone made that application (same answer otherwise); `purpose: 'status'`
  with the application number. The answer is the same in every budget state too, and a probe
  leaves no trace (review round 2 and its follow-up): status codes spend **budgets of their own**
  (per phone 5 a day across institutes; per institute a fixed fifth of the ceiling), never the
  form's five a day or its share, which a later ordinary request would read; the code is sent
  after the answer (not awaited), so the response time does not depend on a match either. A spent
  status budget sends nothing and still answers 202 with no `Retry-After`. **A status code proves
  the phone for the status only** (second follow-up): its own Redis slot, verified with
  `purpose: 'status'` into a status token (`typ: admission-status`) that only `POST …/status`
  accepts; that route refuses the form's token, and the submit and its upload guard refuse a
  status token. **`ADMISSION_OTP_PER_TENANT_PER_DAY` caps all codes together**: the status page a
  fixed fifth (60 of 300), the form the rest (240); fixed shares, because a shared counter would
  let an ordinary request see whether a status code was sent. **Owner:** the form now has 240
  codes a day per institute by default instead of 300 (raise the setting to 375 to keep 300 for
  the form); with a setting under 5 the status page sends no codes. The status page never says
  "try later" (the form's code request still answers 429 with `Retry-After`: it reveals nothing
  about an application).
- **P3-b17 (review S5, S6, N1, N2, N6).** The role's privileges are compared to an exact list; the
  public folder's code scan also refuses `withTenant`/`tenantClient` and any `withContext` that
  is not empty; the no-op `GRANT EXECUTE … app_verified_context() TO jantrik_admission` is gone
  (nothing needed it); the role loses `CREATE` on the schema after taking its functions over;
  public answers are `no-store`. `ADMISSION_OTP_PHONE_COOLDOWN_SEC` (60) is new (the Playwright
  suite sets 1).
- **P3-b19 (review round 2 NIT 2; for P4).** `admission_submit` takes the cycle's shared lock
  before it reads the cycle. Replacing an `admission_*` function later needs `CREATE` on `public`
  granted back to `jantrik_admission` around a `SET ROLE` (admission.md, "Changing these
  functions later").
- **P3-b18 (review N3, N4, N7, recorded).** A per-address limit runs before Turnstile and the
  database on `/otp` (60 an hour) and `/otp/verify` (60 a quarter hour). The decompression-bomb
  test is in; ten parallel uploads (at most two decoding) are covered by P2's `image.service.spec`;
  codes and tokens are never logged (only error names are). Per-address limits are generous on
  purpose: many guardians share one address behind mobile carriers' NAT (CGNAT); the per-phone and
  per-institute limits are the real bounds.

## Sprint 1, P5: promotion and new session (2026-11-17)

**Built (day run 2026-11-17), for the owner's review with its PRs; nothing merged.** Plan:
`docs/plans/sprint-1-p5-promotion.md` (PR #15, not approved yet). Built with the plan's
recommended defaults for P5-A to P5-Q and its split: **P5a** (this PR: leaving, runs, apply and
resume, numbering, the switch check, leave/return on the student page) and **P5b** (stacked on it:
fee and teacher copies, previous-year dues markers, the leavers report, the new-year wizard).
Rules as built: [promotion.md](promotion.md).

Where the plan and the code disagreed (the code wins; recorded here):

- **No P3 yet.** Built on `integration/sprint-1` (main + #16, #18, #17) without online admission:
  new admits for the new year come from staff admission only, and numbering treats every
  enrolment no run created as a new admit.
- **The student list has no default ACTIVE filter** (the plan assumed one). Leavers stay in the
  list, marked with their status; the status filter shows one kind at a time. Not changed (a
  product decision: hide leavers by default?).
- **Validation errors answer 400**, as everywhere in this API (zod), not 422: a leaving row
  without a date, two equal numbers in one numbering request.

Decided alone, each the safer option:

- **P5-a1. A failed student of the top class repeats** instead of graduating (the plan: the top
  class leaves as GRADUATED). Repeating keeps them; graduating someone by mistake removes them
  from attendance and dues at apply.
- **P5-a2. Leaving keeps the rolls** (one student's leave and the run's leavers alike): history,
  and a return finds them in place. The plan said this for apply only.
- **P5-a3. A new apply outcome, `SKIPPED_LEFT`:** a student who left another way after the run
  was made is not enrolled into the new year (the plan only knew `SKIPPED_DEACTIVATED`).
- **P5-a4. The roll strategy is optional when a run is made:** MERIT when a merit exam is found,
  NAME_BN otherwise. MERIT without a published exam answers `422 MERIT_NEEDS_EXAMS` with
  `reason: NO_EXAM` (`MODULE` without EXAMS); a given exam that is not published for that class
  and year answers `422 MERIT_EXAM_INVALID` (new code).
- **P5-a5. Permanent stops are not retried:** `SECTION_FULL`, `TARGET_INVALID` and
  `ACTOR_NOT_ADMIN` end the job at once (BullMQ `UnrecoverableError`; the run stays APPLYING
  with the code); other errors are retried 5 times with backoff, as planned.
- **P5-a6. Resume is refused while the job is still in the queue** (`409 RUN_APPLYING`); a
  finished or failed job of the same id is removed before the new one is queued (BullMQ would
  ignore a second job with the same id).
- **P5-a7. The apply-check `version` also covers the target sections' capacities and
  enrolments**, so a run being applied into the same sections makes another admin check again
  (`409 PREVIEW_CHANGED`) instead of applying on stale capacity figures.
- **P5-a8. PROMOTE may go into any other active class** (skipping a class too); REPEAT must stay
  in the run's class. Rows into a class or section deactivated since are refused at apply
  (`422 TARGET_INVALID`).
- **P5-a9. Numbering's PROMOTED strategy** is that of the run that promoted most of the class's
  students (normally the class below); REPEATER: the class's own run; NEW: Bangla name.
- **P5-a10. The study group is kept only while it is active.** Changing the merit exam takes the
  results of pending rows again but never changes a decision.
- **P5-a11. Audit names:** runs and their steps under `promotion_run` (create, rows, refresh,
  apply, resume, each apply section, APPLIED); numbering under `class_level` (`step:
number_rolls`); each leaver under `student` (old and new status).
- **P5-a12. Setup's "in use" counts do not include promotion rows:** deleting a year, class,
  section or group a row names answers `409 REFERENCE_CONFLICT` (the foreign key), as for other
  references the counts do not list.

### P5a after the review (round 1)

What changed is listed in the PR's review comment. Decided alone:

- **P5-a13. No removal of a run-created enrolment.** Correcting a placement (class, section,
  group) covers a promotion or repeat applied by mistake; leave and return cover someone who
  should have left. Removing the enrolment would leave its applied row (immutable history,
  `ENROLLED`) pointing at nothing.
- **P5-a14. Registers:** a student not ACTIVE without a leaving date (only possible for data set
  before P5) stays on registers as before; only a leaving date takes someone off, from that day.
- **P5-a15. A placement change is refused once that year has attendance, an exam roster or fee
  dues for the student.** The fee dues are counted from the students module (a read of the fees
  module's table, like the student limit's read of the subscription).
- **P5-a16. Numbering while runs into the class are not applied** needs an explicit `force` (the
  wizard asks).
- **P5-a17. The CI checks job may take 20 minutes** (it takes 8–10 now; at 10 it was cancelled).
- **P5-a18. Subject choices** are copied and removed through `SubjectChoicesModule` (exams), a
  module with no imports, so students and promotion can both use it without a cycle.

### P5a after the review (round 2)

Decided alone:

- **P5-a19. `left_on` is the last day on the register** (a leaver is marked that day and gone from
  the next). The run's default leaving date stays the old year's last day, so graduates are on its
  register; a leave today keeps the student on today's register.
- **P5-a20. Roll groups follow the current class:** a row's student now in its run's own class is a
  repeater, in any other class promoted (S15's "promoted" covers everyone who came up from another
  class); old roll and merit place only within the run that orders the group.
- **P5-a21. Capacity counts only students still here.** A student who returns is not checked
  against the section's capacity again (return checks the student limit only), so a return can
  take a section over its capacity; the apply-check and the next admission see it.
- **P5-a22. The device day** uses the same register filter as the daily register (`on-register.ts`)
  and is covered by the existing device-register tests; no separate leaver test there.
- **P5-a23. "In use" readers** (`AttendanceUsage`, `ExamUsage`, `FeeUsage`) live in their modules,
  each a module with no imports, so students reads them without a cycle.

### P5b: the wizard, copies and dues markers (stacked PR)

Built in `feature/sprint-1-p5b-promotion-wizard` (on top of P5a). Decided alone:

- **P5-b1. Teacher copy:** "class teachers" copies every section teacher of a section (the class
  teacher and the others), keeping the class-teacher flag unless the new section already has one.
  Staff counted: ACTIVE OWNER, ADMIN, TEACHER or ACCOUNTANT memberships.
- **P5-b2. Concession copy** also skips students who left (only ACTIVE students enrolled in the new
  year), and one already on that head in the new year, ended or not.
- **P5-b3. Term copy** matches existing terms by Bangla name (the table's unique key).
- **P5-b4. The leavers report** sums every open due of every year (not only earlier years), with
  fines up to today, and lists each student's latest enrolment.
- **P5-b5. Phones (P5-Q):** the decision grid stacks each row's controls instead of a sheet per row
  (one layout for every width; checked at 390 px in Playwright).
- **P5-b6. The wizard never switches the year by itself**, and its Playwright spec does not switch
  either (the specs after it live in the seeded current year).

After the review (round 1), decided alone:

- **P5-b7. Teacher copy uses the assignment paths' rule:** an ACTIVE OWNER, ADMIN or TEACHER
  membership and a staff profile (P5-b1 counted accountants and skipped the profile check).
- **P5-b8. Fee copies only go forward in time** (`422 YEAR_ORDER` when the target year does not
  start after the source year). Two concession copies at once never double a concession (the
  second skips what the first made); the audit row lists the copied student and head pairs, the
  term copy the copied term names.
- **P5-b9. A concession that ends after the new year's first day is copied with its end date**
  (and who ended it, and why); one ending on or before that day is not copied (it does not run in
  the new year).
- **P5-b10. The run page's "leaves" defaults the date to the old year's last day.**

After the review (round 2), decided alone:

- **P5-b11. A copied concession that ends in the new year keeps who ended it and why** (the
  original's `ended_by`/`ended_reason`): the end date was their decision; the copy's own audit
  row names the admin who copied it.
- **P5-b12. Terms and concessions copy only from the year just before the target** (`422
YEAR_ORDER`); amounts from any earlier year (they carry no dates). The wizard copies from the
  new year's previous year.
- **P5-b13. Concession copies into one year take turns** (an advisory lock per target year):
  only open concessions are unique, so two copies at once could each add an ended one. No test
  forces the race.
- **P5-b14. The teacher copy follows each assignment path's own rule** (instead of making the
  section-teacher route stricter): a section teacher needs an ACTIVE OWNER, ADMIN or TEACHER
  membership, legacy teachers without a staff profile included, as
  `PUT /attendance/sections/:id/teachers` allows and its tests rely on; a subject teacher also a
  staff profile, as the exams setup requires. P5-b7's single rule (profile for both) dropped
  legacy class teachers.
- **P5-b15. The run page lets a stopped run be fixed** (APPLYING with an error): rows edited,
  refreshed, the run deleted when nothing is applied; the API refuses while a retry is queued.

## Sprint 1, P4: admission test and merit list (2026-11-18)

Built on P3b (`feature/sprint-1-p3b-admission-public` at `faefd06e`, stacked: PR #24). The plan's
recommended defaults **P4-A to P4-N are adopted as written** (tie-break `OLDER_FIRST` default with
`YOUNGER_FIRST` and `NONE`; everyone tied on the last seat selected with a warning; rolls for
SUBMITTED and SHORTLISTED by application number, never renumbered; absent and below the pass marks
unranked; statuses change only at publish; republish allowed, ADMITTED never demoted; move-up a
staff action; the SMS without the score; hundredths up to 1 000 full marks; scores editable after
publish, audited; the fixed admit card; OWNER/ADMIN only; nothing but the test's details before
publish; staff print the cards). Decisions taken alone, and where the code differs from the plan:

- **P4-a1 (privacy). A published snapshot, separate from the draft.** The plan wrote the draft's
  places on the same columns the status page would read, so a rebuild (or a score edited after
  publish) would have shown before republishing, against its own test ("a correction built but not
  republished: still version 1's values"). Now a build writes the draft (`test_result`,
  `merit_position`, `waitlist_position`) and a publish copies the snapshot (`result_*`, and
  `results_full_marks` on the class). The lookup reads only the snapshot and the roll; the role
  cannot even read the draft or a live score.
- **P4-a2. The lookup replaced with P3-b19's recipe:** `GRANT CREATE ON SCHEMA public TO
jantrik_admission; SET ROLE jantrik_admission; CREATE OR REPLACE …; RESET ROLE; REVOKE CREATE`
  (same signature, grants kept). Classes were already readable as a whole by the role (P3b), so the
  plan's column grants on classes were not needed.
- **P4-a3. A build is stale when anything it read changed:** a hash of the settings, the
  tie-break and each ranked applicant's score, absence, date of birth and submission time
  (`merit_inputs_hash`), plus the `builtAt` the admin saw. The plan's `scores_changed_at` alone
  missed a withdrawal, a corrected date of birth or a changed seat count; it is kept for "changed
  since publish" (P4-J).
- **P4-a4. Who is in the list:** a roll and SUBMITTED, SHORTLISTED, SELECTED, WAITLISTED or
  ADMITTED, or REJECTED by an earlier publish (reason NOT_SELECTED, FAILED or ABSENT, so a
  correction can move them up). Withdrawn applicants and those rejected by staff for another
  reason are left out (and keep their old result version, so the status page shows no result).
- **P4-a5. Who gets a result SMS** is read from the SMS log: the status each application was last
  told is in the dedupe key (`admission-result:<class>:v<version>:<application>:<status>`), so a
  move-up within a version is a new SMS; an SMS still waiting is cancelled when its version is no
  longer published or the status moved on. Its own queue `admission-results` (two processors on
  one queue would drop each other's jobs).
- **P4-a6. An application with a test roll stays in its class** (409 `HAS_TEST_ROLL`): a roll
  belongs to its class's sequence.
- **P4-a7. Move-up:** everyone sharing the first waitlist position moves together (ties exist
  only with `NONE`; a tie is never split, as P4-B); the rest renumber from 1. No SMS of its own:
  the moved applicant appears in the result SMS preview (count 1 when nobody else changed), the
  plan's "optional single SMS".
- **P4-a8. The waitlist boundary under `NONE`:** everyone tied on the last waitlisted place is
  waitlisted, at a shared position (`waitlistTie` warning), as P4-B for the seats.
- **P4-a9. Rolls need only a test cycle** (no other setting); the first roll is 1 unless
  `startAt` is given; 422 `ROLLS_EXHAUSTED` above 999 999.
- **P4-a10. Scores:** typing `a`/`অ` marks absent (the exams' `parseMarks`); a score with absent
  ticked is 422 `SCORE_AND_ABSENT`; scores need the full marks (422 `TEST_NOT_CONFIGURED`).
- **P4-a11 (owner, SMS). The result SMS share the institute's daily cap** (2 × active students
  unless set in the attendance settings): an institute admitting its first students has a cap of
  0, so every result SMS is skipped until it sets a cap; the preview says "0 left today" and how
  many would be skipped. Not changed here (the cap is the owner's money rule).
- **P4-a12. Withdrawing** is P3's status route (`WITHDRAWN` with a reason); no new route.
- **P4-a13. Publish** sets `status_by`/`status_at` and clears an approval problem only on rows
  whose status or reason changes; one audit row with the version, counts, the ids by outcome and
  the flagged ones.
- **P4-a14. The trigger functions are not named `admission_*`** (`test_score_within_full_marks`,
  `full_marks_keep_test_scores`): P3b's safety test reserves that prefix for the definer functions.
- **P4-a15. Not done here:** the bn screenshots at 390 px and the admit card's print check run in
  CI's Playwright only (this run starts no servers); per-subject marks stay for later (S12).
- **P4-a16 (review M1). Publish locks before it reads:** every applicant of the class with a roll,
  in id order (as move-up), then the inputs are checked under the locks; its UPDATE also requires
  the status it read (409 `MERIT_STALE` otherwise, nothing published). A withdrawal that commits
  while it waits makes the publish stale; an approval is kept (ADMITTED, flagged if needed).
- **P4-a17 (review S1, N3). Told = SENT, or QUEUED of the published version.** A result SMS
  cancelled by a republish or failed told nobody and is owed again; the dedupe key carries the run
  (`…:<status>:<run id>`), so the resend is a new SMS; a run takes the SMS writers' lock and checks
  who is still owed before queueing, so two runs never send one SMS twice.
- **P4-a18 (review S2). A build is published once** (`results_built_at`, 409 `ALREADY_PUBLISHED`,
  the button off): republishing needs a new build.
- **P4-a19 (review N1, N2, N4, N5, N6).** Rolls go only to the rows locked and still eligible, and
  the audit lists what was written; a renumbered waitlist position is audited; the preview's
  segments and cost count only what the cap lets through; the merit view's counts and warnings
  leave withdrawn applicants out at once; a safety test pins that `jantrik_admission` has no
  `CREATE` on `public` after the migrations.
- **P4-a20 (review round 2). No lock blocks a foreign key:** the class row and the applicant rows
  P4 locks are taken `FOR NO KEY UPDATE`, so a new application (its foreign key's KEY SHARE on the
  class) never waits on a test operation; that removed a three-way lock cycle with P3's phone
  lock (a 500 from a deadlock). A deadlock (`40P01`) or serialization failure (`40001`) anywhere in
  the API now answers 409 `BUSY` with Retry-After (the lock timeout's answer).
- **P4-a21 (review round 2 N1). A published result is not put back by hand** to SUBMITTED or
  SHORTLISTED (409 `TEST_RESULT_PUBLISHED`): the next rebuild would undo a move-up the applicant
  may already have been told about. Withdraw, reject and approve stay allowed.
- **P4-a22 (review round 2 N2, recorded, not changed).** An SMS the worker has taken (passed its
  relevance check, provider call in flight) is still QUEUED; if a republish keeps the status and a
  new run starts in that window, the applicant can get the same result twice. Closing it needs a
  SENDING state in the shared SMS pipeline (all purposes), which is beyond P4: a rare duplicate
  of the same news.
- **P4-a23 (review round 2 N3, N4).** The rolls' audit lists `{applicationId, roll}` in roll order;
  a run's `skipped` means "not queued": over the cap, or no longer owed when the run reached them.
- **P4-a24. The migration `20261117300100_admission_test` was edited in place** after the first
  review (`results_built_at`). No database outside scratch and CI ever applied it; any that applied
  the earlier version must be recreated (Prisma would refuse the changed checksum).

## Sprint 1, P6: notices and broadcast (2026-11-17)

Built during the unattended day run of 2026-11-17 from the P6 plan (PR #15,
`docs/plans/sprint-1-p6-notices.md`) with its recommended defaults P6-A to P6-N and its split
(P6a notices, P6b broadcasts). Decisions taken alone, each the safest option:

- **P6-a1. Notices have no `SCHEDULED` status** (P6-A as recommended): visibility is computed
  from `status`, `publish_at` and `expires_at` when read; no job. Publishing again moves a
  scheduled notice's time; a live notice cannot be "published" again (409 `NOT_EDITABLE`).
- **P6-a2. A publish time more than a minute in the past is refused** (422
  `SCHEDULE_OUT_OF_RANGE`), not treated as "now": a past date is a mistake in the form.
- **P6-a3. Targets on a `STAFF` notice are refused** (422 `TARGET_INVALID`) rather than ignored,
  and a target section must be a current-year section of the target class (sections belong to a
  year; one of another year would match no child).
- **P6-a4. The expiry is a last day** in the form (the notice leaves the board at the end of that
  day, Asia/Dhaka); the API stores the instant. It must be after the publish time (422
  `EXPIRY_INVALID`); an unchanged past expiry does not block other edits.
- **P6-a5. Only ACTIVE, not deleted children count** for a guardian's targeted notices and for the
  read counts (a child who left no longer brings their class's notices).
- **P6-a6. Audit entries hold the body's length, not the body** (a notice can be 5 000
  characters; the title, audience, targets, pin and expiry are recorded).
- **P6-a7. The dashboard card shows for staff and guardians** below the role's own cards, from
  the same query as the board (no extra request when both are open).
- **P6-a8. The Playwright spec signs in staff only** (owner and teacher by password): the demo
  guardians' OTP budget (one code a minute, 5 per 15 minutes) is already shared by other specs.
  Guardian visibility is covered by the API tests.
- **Plan and code differences:** the plan's `/notices/new` and `/notices/[id]/edit` live under
  `/notices/manage/` (one layout sends the management texts only to OWNER/ADMIN pages); the
  manage page lists notices as rows rather than a table (it works at 390 px without scrolling
  sideways).

Changed after the review of #25 (round 1, nits only):

- **P6-a9. The unread count's cache has a per-person read version** bumped after a read commits,
  instead of deleting the entry (a count computed just before the read could otherwise be cached
  again, stale, for 2 minutes).
- **P6-a10. An edit keeps the targets the notice already had** without the current-year check; new
  targets are still checked. An edit locks the notice before reading what the audit records.
- **P6-a11. The board excerpt is cut at 200 characters as people see them** (grapheme clusters:
  a Bangla conjunct or a multi-code-point emoji is never split; round 2).
- **P6-a12. The per-person read version expires after an hour** (set with the increment), longer
  than any count cached under it (round 2).

P6b (SMS broadcasts), taken alone:

- **P6-b1. Editing a scheduled broadcast puts it back to DRAFT** (its job stops by itself): the
  admin previews and schedules again, so the cap, the count and quiet hours are all checked again.
- **P6-b2. A draft can be cancelled too** (status CANCELLED): broadcasts are never deleted, so this
  is how an admin tidies one away.
- **P6-b3. A job that runs early or inside quiet hours delays itself** (BullMQ `moveToDelayed`
  on the same job id) and moves `scheduled_at` and the `notices:due` score to the new time; the
  sweep remains the safety net.
- **P6-b4. Who is "without phone":** a student with no guardian phone of the chosen kind (no
  primary guardian phone for `PRIMARY_GUARDIANS`), or a staff member with no login phone.
- **P6-b5. The relevance check sends a queued broadcast SMS only while the broadcast is `SENT`**
  (P6-L is ready: a later "stop" only has to change the status).
- **P6-b6. The composer's prefix is the institute's registered name** (`MeContext.tenant.name`),
  not the profile's short name (P2): the name is always there, and the admin may edit it.
- **P6-b7. The Playwright spec composes and previews but does not send:** CI runs at any hour, and
  inside Dhaka's quiet hours a send is refused by design. Sending, the cap, quiet hours and the
  job are covered by the API tests with a fake clock.

Changed after the review of #26 (round 1; each must/should fix with a test seen failing first):

- **P6-b8. The preview's token is what the admin confirms (must-fix B1).** It hashes the text, the
  recipient kind, the targets, the notice, the recipient count, the segments and the cost; send
  and schedule must present it with the count, and anything changed since (another tab, another
  admin, a new rate) is 409 `PREVIEW_CHANGED` with the new segments and cost. Before, only the
  count was compared: a draft edited after its preview could go out at three times the cost.
- **P6-b9. A broadcast found more than 3 hours late expires instead of sending (B3)**, measured from
  its stored time (a quiet-hours wait moves that to 08:00): new status `EXPIRED` with
  `{lateMinutes}`, on the OWNER/ADMIN dashboard for 3 days; a new preview and send is needed.
  The sweep and heal-on-read still re-add such jobs; the job then expires them.
- **P6-b10. Lost SMS jobs of a sent broadcast are re-added (B4):** after a send, and whenever its
  job runs again, the jobs of its QUEUED SMS are re-added (job id = the SMS id, so existing jobs
  are untouched) before its due entry is dropped; a failure keeps the entry and retries. Not
  built: a general sweep for QUEUED SMS of other purposes whose job was lost (single SMS rely on
  the after-commit add, as before P6); a follow-up if wanted.
- **P6-b11. Broadcast SMS have a lower queue priority (B5):** BullMQ takes jobs without a priority
  (login codes, receipts, absent SMS) before prioritised ones, so a large broadcast never delays a
  login code.
- **P6-b12. Quiet hours hold each broadcast SMS too (B8):** an SMS still waiting at 21:00 is delayed
  (still QUEUED) until 08:00 by the SMS worker, never cancelled. Other purposes are unchanged.
- **P6-b13. The send job retries with backoff; the sweep replaces a failed job (B2); the due entry is
  dropped only if no new schedule changed it meanwhile (compare-and-delete on its score, B7).**
  B7's race is narrow and has no deterministic test.
- **P6-b14. One grouped query counts the SMS of a page of broadcasts, with an index on
  `sms_logs (tenant_id, related_id)` (B6).**
- **P6-b15. Segment counts never split a character (N3).** `smsLength` (shared by every SMS cost)
  now counts parts the way gateways split them: a GSM-7 extension character or an emoji at a part's
  end starts the next part. In that rare case the count (and the cost shown in fee reminders and
  exam results too) is one higher than before; otherwise unchanged.
- **Small ones:** a text of spaces only is 422 `SMS_EMPTY` (N1); the job re-reads who scheduled it
  under the row lock and runs again for a new scheduler (N2); dashboard snippets are cut at whole
  characters (N4).
- **The migration `20261117410100_sms_broadcasts` was edited in place** (the `EXPIRED` value, its
  CHECKs, the index). Only scratch and CI databases had applied it.

Changed after the review of #26, round 2 (each should-fix with a test seen failing first):

- **P6-b16. A scheduled broadcast is not sent when it became much dearer (SF1, money; for you to
  confirm).** The audience is resolved again at send time (S19), so the confirmed token cannot
  cover it: when the real cost exceeds the confirmed one by more than 10% and by more than one SMS,
  nothing is sent (`COST_CHANGED`, on the dashboard; a new preview and confirmation is needed).
  Within that margin it is sent and its real cost is stored and shown next to the previewed one.
  Alternative: always send (as before) and only show the difference.
- **P6-b17. The lateness limit counts from the time the admin chose (SF2).** A wait for quiet hours
  no longer overwrites it; a broadcast that would go out more than 3 hours late expires instead.
  With 3 hours and quiet hours of 11, every quiet-hours wait now expires (a job found at 23:20 for
  20:30 is not sent the next morning); the early-run wait is unchanged.
- **P6-b18. A broadcast that was never sent can be edited back into a draft (N-a)**, rather than a
  "copy to a new draft" action: simpler, and nothing was sent, so no money history is lost (the
  audit keeps the old status and reason).
- **P6-b19. Opening the broadcasts list re-adds the jobs of sent broadcasts' SMS still QUEUED 10
  minutes later, outside quiet hours (N-c).** Stopping a sent broadcast is a follow-up (P6-L).
- **P6-b20. Fee reminders and exam result SMS get the bulk priority too (N-d):** they still queue
  one by one with the same rules; only their place behind single SMS changes.
- **P6-b21. The send job's person cannot be chosen by the app login (found by the merge check
  with P1-J8, fixed at the rebase, 2026-11-27).** The job signs its context as
  `sms_broadcasts.scheduled_by_id` and checks that person's roles; `jantrik_app` could write that
  column, so an SQL injection in one person's request could have a broadcast sent as another admin
  of the institute. Now two triggers (migration `20261117410200`) hold, for a request (a signed
  person): a row it leaves `SCHEDULED` is scheduled by that person; it sets the scheduler only to
  itself or clears it; it changes a `SCHEDULED` broadcast's targets only if it scheduled it. So an
  injection can neither name someone else nor edit, retarget or bring back (UPDATE, or INSERT … ON
  CONFLICT) a broadcast another person scheduled (the review's round 1 found the first trigger
  covered only writes of the column itself). Every app path already works this way: scheduling and
  send now set the caller; editing goes back to `DRAFT` before the targets change; cancelling and
  the job's outcomes leave `SCHEDULED`. The approach of P1-J8k (`student_imports.created_by_id`):
  no new role, no `.env` line, no API change. Like P1-J8k, a context with no person (only the
  worker and server code sign one) is not checked.
  - **Review round 2 (must-fix, fixed with a two-connection test):** the targets check locks the
    broadcast `FOR SHARE` by its id, so a target change racing the scheduling transaction waits
    for it and is then refused, instead of changing the audience of a broadcast its scheduler
    already confirmed. An API test now has a second admin cancel, edit and send a broadcast the
    first admin scheduled.
  - **Recorded (review round 2):** the platform routes (`InstituteProvisioning.inTenant`) and the
    fallback of `TenantAccessService.inTenant` run as `jantrik_app` with an institute and no
    person, so an injection there would not be checked by these triggers (P1-J8k has the same
    gap; none of those paths builds SQL from request input). The job also reads the audience at
    send time (enrolments, guardian phones, the current year, memberships), which `jantrik_app`
    can write: an injection could redirect a scheduled text to other phones within the 10 %
    cost check (S19 resolves the audience at send time; P1-J10).
  - **Only with #20:** before P1-J8, an injection can still set `app.user_id` itself, so the
    triggers are a barrier only once #20 is merged. The merge order already puts #20 first; #26
    must not go to production before #20.
  - **Recorded, not changed (P1-J10):** `cancelled_by_id`, `created_by_id` and the Redis due set
    give no such power (nothing acts as those people; only the API writes Redis). Inside its own
    institute, `jantrik_app` can still insert `memberships`, `audit_logs` and `sms_logs`, so this
    protects whom the job acts as, not SMS sending as such. P1-J8k has the same editing gap: a
    colleague can still change the rows, mapping and status of an import that runs as its uploader
    (already recorded under P1-J8q).
- **Recorded only (N-e, N-f):** the edited migration `20261117410100_sms_broadcasts` needs fresh
  databases wherever its earlier version was applied (only scratch and CI here); its new index on
  `sms_logs` is created without `CONCURRENTLY`, fine before launch.

## Sprint 1, P7a1: gateway accounts (day run 2026-11-27)

Online payments, part 1 ([payments.md](payments.md)): the gateway account table, the credentials
key, the SSLCommerz client and a fake SSLCommerz, the owner's account API and page, and the two
owner commands. No money moves yet. Built with the approved plan's recommended defaults for the
decisions it touches: **P7a-A** (two PRs; this is the first), **P7a-J** (the method mapping),
**P7a-K** (payer fields in the client's request; filled by P7a2), **P7a-L** (৳10 to ৳5 lakh
constants), **P7a-M** (on only after a passing test; the test is a query for a transaction that
never existed; saving switches it off), **P7a-P** (never deleted), **P7a-S** (the base URL override
outside production only). The rest are P7a2's. Taken alone during the run (owner away), each the
safer option:

- **P7a1-x1. `SSLCOMMERZ_BASE_URL` only names a fake on this machine:** outside production it must
  be `http://127.0.0.1:<port>`, `http://localhost:<port>` or `http://[::1]:<port>` (the plan only
  refused it in production). The API tests point it at `http://127.0.0.1:9`, where nothing listens,
  unless a test starts the fake, so no test can reach SSLCommerz by accident.
- **P7a1-x2. The ciphertext is left out of every Prisma read** unless a query names it
  (`CLIENT_OMIT`, as `users.password_hash`), on top of the plan's code scan: a service that does
  not name the column never holds it, even with a bare `findFirst()`.
- **P7a1-x3. Who saved the credentials may be empty when a command loaded them**
  (`payments:load-sandbox` audits with no person): the CHECK is "credentials, hint and time
  together; a person only with a time" instead of the plan's "both NULL or both set". Tests alike:
  a result and its time together, who asked only with a time.
- **P7a1-x4. Saving credentials clears all three `last_test_*` columns** (the plan named the result
  only), so the test CHECK holds and an old result never sits next to new credentials.
- **P7a1-x5. A failed test while the account is on switches it off** (recorded, audited with
  `enabled: false`). The database requires a passing last test while on; the alternative, keeping
  the old `OK` and hiding the failure, would show the owner a stale state.
- **P7a1-x6. The test job records nothing** if the person who asked is no longer the owner
  (checked before and after the call) or if the credentials were replaced while it ran (the row's
  `credentials_updated_at` must be the one it read): a result always belongs to what was tested.
- **P7a1-x7. A malformed save is a 400** (the API's validation pipe, which lists paths and never
  values), where the plan's table said 422. Store ID: 1 to 50 of `[A-Za-z0-9_-]` (trimmed);
  password: 1 to 100 printable ASCII characters without spaces (never trimmed).
- **P7a1-x8. The client never follows a redirect** (a 3xx is `HTTP_STATUS`: it could carry the
  password elsewhere) and reads at most 256 KB. A session `FAILED` is `AUTH_FAILED` when its reason
  mentions credentials, else `INVALID_REQUEST`; the free text is dropped. A validation answer for
  another `val_id` than the one asked is `BAD_RESPONSE`.
- **P7a1-x9. A JSON number where SSLCommerz documents a string counts as missing:** an amount sent
  as a number is "not a well-formed amount" (P7a2 will review it as `AMOUNT_MISMATCH`), a numeric
  `risk_level` is `HIGH`. Nothing is read through a float. The smoke run shows what the sandbox
  really sends.
- **P7a1-x10. The payer page check:** https on `sandbox.sslcommerz.com` or another
  `*.sslcommerz.com` host on port 443 (no login part); with the fake, exactly the fake's origin.
- **P7a1-x11. The smoke command skips with exit 0** when either sandbox variable is missing (it is
  not a failure), and refuses production with exit 1. It also asks once with a wrong password, to
  see SSLCommerz's answer for bad credentials (the test connection's mapping); nothing else.
- **P7a1-x12. `tsx` joins the API's dev dependencies** (the version the workspace already uses) to
  run the three scripts (`payments:sandbox-smoke`, `payments:load-sandbox`, `payments:fake`); no
  new package. The scripts are type-checked and linted with the API.
- **P7a1-x13. The database-backed credentials tests live in
  `apps/api/test/payments-credentials.e2e-spec.ts`**, not a `src` spec: the code scan forbids
  naming the column anywhere under `apps/api/src` but the service.
- **P7a1-x14. The account row is created on the first save;** reading the page creates nothing
  (no row: "not set up").
- **P7a1-x15. The fake for Playwright** listens on `127.0.0.1:4090` with store `jantrikfake01` /
  `jantrikfake01@ssl`; the suite's API gets `SSLCOMMERZ_BASE_URL` pointing at it and
  `API_PUBLIC_URL=http://localhost:4000`.
- **P7a1-x16. Screenshots:** the Playwright spec checks the page's layout and saves bn 1366 and
  390 px screenshots to its test output (CI artifacts). None were taken locally: this day run does
  not run a browser locally.
- **Recorded only:** the IPN address is shown from P7a1, but its route comes with P7a2 (pasting it
  into the SSLCommerz panel early is harmless). Key rotation is not built (`key_version` 1).

### P7a1 after the review (round 1)

No must-fix. Fixed: the test job locks the account row before it decides, and a result that is
not `OK` always sets the account off (an "enable" committed while a test ran could otherwise stay
on next to a stale passing test); the code scan also reads `apps/api/scripts` and fails on the
table's name in raw SQL. Recorded, not changed:

- **P7a1-x17. No database rule ties a passing test to the current credentials** (`last_test_at >=
credentials_updated_at`): with several servers, clock differences could refuse a valid "turn
  on". The service's guard (a test of replaced credentials records nothing) stays.
- **P7a1-x18. The payer page host check stays `*.sslcommerz.com`** in sandbox mode (P7a1-x10);
  narrow it to the hosts the owner's smoke run shows, if wanted.
- **P7a1-L1 (an older problem, every route):** a malformed JSON body gets a 400 whose message
  quotes part of the body back to its sender (Nest's body parser). Not logged, and the web app
  never sends malformed JSON, but a global filter with a fixed message would be cleaner; a
  follow-up of its own.

### P7a1 after the review (round 2)

No must-fix. Fixed, each with a failing test first:

- **P7a1-x19. The last failure is cleared by new credentials and by a passing test.** Saving
  credentials clears `last_failure_code` and `last_failure_at` in the same update that switches
  the account off; a test that passes clears them too. Before, a `CREDENTIALS_UNREADABLE` stayed on
  the page after the owner had saved the store again and its test had passed. No CHECK ties the
  two columns to any other (only to each other), so nothing else changes.
- **P7a1-x20. Each ciphertext names its credentials version, which a trigger alone sets**
  (migration `20261117500100_payment_credentials_version`, after P7a1's and before P7a2's).
  `jantrik_app` may write the ciphertext and the AAD had no version, so an SQL injection inside
  the institute (any role's request) could copy an older ciphertext of the same row back, e.g. a
  store a former owner once saved, and it still decrypted: once P7a2 moves money, payments would
  go to that store. Now `credentials_version` is 0 for a new account without credentials, 1 for
  one inserted with them, and one up whenever the ciphertext changes (unchanged by any other
  update); the app has no UPDATE on it and the trigger replaces an INSERT's value. The AAD is
  `payments:<provider>:<tenantId>:<accountId>:v<version>`. Saving locks the row, encrypts as its
  version + 1 and checks the version the update stored; reading uses the row's version. A
  ciphertext put back is `CREDENTIALS_UNREADABLE`, never the old store. Choices: the lock is
  `FOR NO KEY UPDATE` rather than `FOR UPDATE` (the lock the update takes anyway; it does not block
  a foreign key check on the row, as `FOR UPDATE` would); a
  ciphertext saved before this migration (development databases only) names no version, reads as
  unreadable and is saved again; no CHECK ties the version to the ciphertext, so the migration
  needs no backfill on those rows.

Tests added that pass as the code stood (`payments-account.e2e-spec.ts`): an account that is on and
then fails its test ends up off, audited `{ test, enabled: false }` (P7a1-x5); unreadable
credentials give `ERROR` and `CREDENTIALS_UNREADABLE` through the job without asking SSLCommerz;
"turn on" committed while SSLCommerz is asked is switched off by a failed result, and "turn on"
sent while the result is being recorded waits for the job's row lock and then finds no passing
test. Recorded, not changed:

- **(a) `enabled` and `last_test_*` are writable by an SQL injection inside the institute** (any
  role's request, as `jantrik_app`), within the CHECKs (on only with credentials and a last test of
  `OK`). The same gap as every other table the app writes: P1-J10, role-aware database rules later.
- **(b) The payer page host check accepts any `*.sslcommerz.com` host** (P7a1-x10, x18). Narrow it
  to the hosts the owner's sandbox smoke run shows, before any guardian is sent there (P7a2).
- **(c) Production checks the key only for its length** (at least 32 characters, no example marker,
  not equal to another secret): nothing measures its strength. Nor does it refuse
  `NODE_TLS_REJECT_UNAUTHORIZED=0`, which would switch off certificate checks for the calls to
  SSLCommerz. Both belong to the production environment checks (docs/deploy.md).
- **(d) With several workers, the test result recorded last wins:** two tests of the same
  credentials running at once each record theirs, and the later commit stays (each is a real
  answer from SSLCommerz, and each is audited).
- **(e) P7a2's `settle` must compare `tran_id`:** the validation answer's `tran_id` must be the
  payment's own before anything is settled (the client refuses an answer for another `val_id`,
  P7a1-x8, and returns the answer's `tran_id` for its caller to compare).

## Sprint 1, P7a2: checkout to receipt (day run 2026-11-27)

Online payments, part 2 ([payments.md](payments.md)): guardians pay chosen dues in full through
SSLCommerz's page (the fake in every test), the return and the IPN reach the database through one
definer function under the new NOLOGIN role `jantrik_payments`, every payment is confirmed with
SSLCommerz's validation API, and one decision table posts it or sends it to review. Stacked on
P7a1. Built with the approved plan's recommended defaults for every decision it touches: **P7a-B**
(the role and the definer function), **P7a-C** (documented addresses recorded and given a large
rate budget, never enforced), **P7a-D** (`verify_sign` not checked), **P7a-E** (paid on the
checkout day), **P7a-F** (one payment in progress per child for 60 minutes), **P7a-G** (voidable;
the intent back to review with `VOIDED`; one live payment per intent), **P7a-H** (another
`tran_id`'s `val_id` sends the named intent to review with no money on it), **P7a-I** (the
`bank_tran_id` as the TrxID with its own format), **P7a-J** (the method mapping), **P7a-K** (the
payer's fields), **P7a-L** (৳10 to ৳5 lakh), **P7a-N** (returns by POST or GET), **P7a-O** and
**P7a-R** (validated money posted whatever happened after the checkout), **P7a-Q** (no retry of a
failed session), **P7a-T** (P7b's statuses created now), **P7a-U** (the same receipt SMS),
**P7a-V** (no collector in the daily closing). S22 and S23 hold as approved: anything risky or
mismatched waits for review and is never posted automatically. Taken alone during the run (owner
away), each the safer option:

- **P7a2-x1. An amount (or any unknown key) in the checkout body is a 400**, the API's
  validation pipe (as P7a1-x7), where the plan's test said 422. Nothing from the body is used but
  the due ids, the amount the guardian was shown and the request id.
- **P7a2-x2. The money facts come only with their `val_id`, and once it is set none of them
  changes** (a CHECK and the guard trigger), stronger than the plan's "each written once": a fact
  missing from one validation can never be filled in from another.
- **P7a2-x3. A voided gateway payment cannot stay on its intent:** the gateway payment's deferred
  check also runs on the void (the plan had it on insert only), so a void that skipped the hook is
  refused by the database rather than leaving a `PAID` intent without a live payment.
- **P7a2-x4. The payer page CHECK allows plain http only on `127.0.0.1`/`localhost`** (the fake
  SSLCommerz of the tests and Playwright, refused in production by `SSLCOMMERZ_BASE_URL`'s rule);
  the API's host check is unchanged.
- **P7a2-x5. The fee module reads nothing of the payments tables:** the payments module registers
  `FeeOnlineHooks` at start (the counter's pending dues, the guardian's `online`, a gateway
  receipt's online part, the void). Without the module nobody can pay online and a gateway payment
  cannot be voided. FeesModule now also exports `FeeDuesService` and `FeeMobileService` (the
  guardian check).
- **P7a2-x6. What SSLCommerz is sent about the payer is ASCII:** the guardian's English name as the
  institute recorded it (else "Guardian"), the phone in local form, `noreply@jantrik.com.bd`, the
  institute's English address (else `N/A`), city and postcode `N/A`, country Bangladesh. A Bangla
  name is not sent (as "School fees" is sent in English, P7a1).
- **P7a2-x7. An IPN's status stays in its fields** (its `outcome` column is empty), an IPN
  without a well-formed `tran_id` is malformed (200 OK, nothing stored), and a RETURN row always
  names an intent (a CHECK).
- **P7a2-x8. The way back from the gateway is marked** (`?from=gateway` on the 303): the page then
  never sends the guardian to the gateway again, even when the return was over its limit and the
  payment still looks READY; it shows "confirming" and asks again.
- **P7a2-x9. `confirm` asks the query API** when there is nothing left to validate and the intent
  is still open (also after a made-up `val_id`), or when a signal without a `val_id` arrived after
  the last query (a late payment); once per job, up to three rounds for signals that arrive while
  it runs. The plan said "when there is none"; this also closes a failed return that carried a
  `val_id` of a failed attempt.
- **P7a2-x10. An unmatched IPN whose validated `tran_id` is one of ours** queues that intent's
  `confirm` instead of being marked `UNMATCHED` (the money is then posted or reviewed through its
  own intent).
- **P7a2-x11. A `tran_id` mismatch whose `tran_id` is no intent of this institute** also marks the
  VALIDATE event `UNMATCHED` (P7b's queue sees money with no intent), besides the named intent's
  `TRAN_ID_MISMATCH`.
- **P7a2-x12. A review also records the mismatches found** (an intent already in review, or a late
  success, gets e.g. `AMOUNT_MISMATCH` next to `LATE_SUCCESS`), so the person reviewing sees them.
- **P7a2-x13. A strange fact is stored as nothing, never fails the job:** a `store_amount` above the
  amount, a `currency_type` over 10 characters, a `bank_tran_id` over 100 characters or with spaces
  leave that column empty on the intent (and keep the reason it was not posted); the event keeps
  the reported value (at most 100 printable characters).
- **P7a2-x14. The init job fails an intent whose account was switched off meanwhile**
  (`ONLINE_PAYMENTS_OFF`, no call to the gateway, not recorded as the account's failure).
- **P7a2-x15. Online payments in the collections report** (by collector) are one "Online
  (SSLCommerz)" line, so the rows still add up to the total and no guardian appears as a
  collector; the CSV by method names every method (P7a-V carried over to the report).
- **P7a2-x16. Signal bodies are read by the module's own reader** (a flat form of at most 16 KB,
  read before the app's parsers); JSON, a larger body or a nested form is malformed.
- **P7a2-x17. The listed sources** are the five addresses SSLCommerz's docs have named (sandbox
  `103.26.139.87`, live `103.26.139.81`, `103.132.153.81`, the older sandbox `144.76.92.216`,
  `144.76.92.241`): a listed one only gets the larger budget.
- **P7a2-x18. The heal** also asks about a `CREATED` intent more than a minute old (nothing to
  validate: a query finds nothing and changes nothing), once a minute per payment.
- **P7a2-x19. `create-roles.sh` now checks `jantrik_admission` too** (it created the role but its
  checks did not list it), with `jantrik_payments`; `restore.sh` requires both.
- **P7a2-x20. Another guardian of the child cannot abandon a payment** (404; the plan said "the
  payer only"); they see it, without its gateway page.
- **P7a2-x21. The payer page must be `https://sandbox.sslcommerz.com` itself** (the review of
  P7a1, P7a1-x18): no other `*.sslcommerz.com` host is accepted now that guardians are sent there.
  If the owner's sandbox smoke run shows the payer page on another host, that host is added by
  name; until then such a session fails (`BAD_RESPONSE`) and nobody is sent anywhere.
- **P7a2-x22. `jantrik_payments` may run `app_verified_context()`:** every table's
  `tenant_isolation` policy applies to it, and an INSERT checks both permissive policies (a SELECT
  under `USING (true)` drops the other), so the role must be able to evaluate the verified context.
  It returns the caller's own: in the function's empty context, none. Granted by the function's
  owner (`SET ROLE jantrik_auth`), in the access migration; pinned in the role's privilege
  snapshot.
- **Recorded only:** a gateway payment's request id is its intent's id, so P7b's "apply again after
  a void" needs a request id of its own. Playwright was not run locally (CI runs it; the
  screenshots are its artifacts). Nothing called SSLCommerz: every test used the fake.

### P7a2 after the review (round 1)

No must-fix. P7a1's review round 2 was merged in first (each credentials ciphertext names its
trigger-owned version, P7a1-x20): nothing in P7a2 builds an AAD or writes the ciphertext itself
(every test saves credentials through the API, so through `PaymentCredentialsService`), so
nothing else changed. Fixed, each with a failing test first, taken alone during the run (owner
away), each the safer option:

- **P7a2-x23. No per-payment count before a signal is stored.** The first fix of the validation
  flood gave each payment a signal budget at the signal routes (10 an hour from anyone but
  SSLCommerz, whatever the address, and 10 of SSLCommerz's own). The automated security review
  of that fix (medium, denial of service): anyone with the `tran_id` (every guardian of the child;
  it is in the return URL) could spend the count the payer's own browser return depends on, so the
  honest payer's return was refused and "paid" waited for the IPN or a query. Replaced: a signal
  is refused only by the per-address limits (and the per-institute one for unlisted IPNs), as
  before; the payer's return is stored whatever others sent (a test sends 25 forged returns from
  25 addresses first). The bound lives where the gateway is asked (x24).
- **P7a2-x24. `confirm` bounds what signals make it ask SSLCommerz.** While the payment is open, at
  most **3** new `val_id`s are validated directly **per round** (those SSLCommerz's listed
  addresses brought first, then the oldest; each `val_id` once), and at most **10 an hour per
  payment** for the `val_id`s anyone but SSLCommerz brought, another **10** for those its listed
  addresses brought, so a flood never spends the real IPN's (Redis, counted in the job). The rest
  are left to the query by `tran_id`, which is never refused and is authoritative: it lists every
  attempt, so it answers for every signal stored before it was asked (such a `val_id` is
  validated only if the query lists it as a successful attempt). Once the payment is closed (paid,
  in review, failed, cancelled, expired), no `val_id` is validated directly: a new one makes the
  job query, and only a listed one is validated (a second payment: a `DUPLICATE` event). A query
  is recorded at the time it was asked, so a signal that arrives while SSLCommerz answers is not
  taken as answered for. The review's probe (40 returns with made-up `val_id`s, 46 validation
  calls) now makes at most 10 validations of made-up `val_id`s an hour per payment and at most one
  query per job; the payer's genuine return is recorded and posted (`payments-settle`).
- **P7a2-x25. An intent never lets go of a live payment** (`payment_intents_paid_check`, at
  commit): a live gateway payment that names an intent must be the one that intent holds as
  `PAID`; only the void (in the same transaction) lets it go. Before, an update could move `PAID`
  to `NEEDS_REVIEW` with `VOIDED` and no payment while the payment stayed `ACTIVE`. Edited in the
  P7a2 migration itself (the PR is a draft; only scratch and CI databases ran it).
- **P7a2-x26. A fail or cancel return closes a payment only when the query lists a failed or
  cancelled attempt** (and no successful or pending one); the signal's word when the query lists
  it, else the gateway's. Before, a forged return with only the `tran_id` (even by GET: an
  `<img>` link) closed a payment whose payer was still on the gateway's page whenever the query
  found nothing yet, and the real payment then waited for review as `LATE_SUCCESS` instead of
  getting its receipt. "Nothing found" now stays open for P7b's expiry (and the heal keeps asking).
  The fake SSLCommerz already lists the `CANCELLED` attempt of a session cancelled on its page, so
  the guardian's cancel still ends in "not paid" (an API test drives the fake's page through to a
  new checkout).
- **P7a2-x27. A `PENDING` answer settles nothing:** that `val_id` is validated again, from a later
  signal or once the query lists it as successful. Every successful attempt the query lists is
  validated until its money has been seen (an earlier `PENDING` or `INVALID` answer included).
  Before, a payment first answered `PENDING` was never validated again and never posted.
- **P7a2-x28. A gateway payment is its intent's money** (`fee_payments_gateway_check`, at commit):
  a live gateway payment has the intent's `amount_paisa`, its `bank_tran_id` as `trx_id` and its
  `priced_on` as `paid_on` (the app can change none of the three afterwards, on either row). The
  review committed a ৳0.01 gateway payment for a ৳1,000 intent. P7b's "apply again" after a void
  posts the same money (the same `bank_tran_id`, the voided payment no longer live), or changes
  this rule in its own migration.
- **P7a2-x29. Playwright, the cancelled payment** (CI: the test hung for 2.5 min, then 8.7 min on
  its retry, until the job's 20-minute limit): the accountant's password login was followed at
  once by a navigation, so the login could be cut off and `fees-search` never appeared, and
  `fill()` had no timeout of its own (the 90 s test plus the OTP cooldown the helper waits out).
  The retry then found the first attempt's payment still in progress (`child-online-continue`
  instead of `child-online-open`, with no timeout either). Now the login waits for the dashboard,
  every action and navigation in the P7a2 block fails within 30 s, and a payment an earlier
  attempt left at the gateway is continued. Reasoned from the CI log only (Playwright cannot run
  here: its ports are the developer's).

Tests added that pass as the code stood (`payments-settle.e2e-spec.ts`): the counter taking the
same due while `settle` posts, at once (one is posted, the other refused or in review, never
both); one `bank_tran_id` on two payments (the second a `DUPLICATE` review); two dues with only
the second changed (`DUES_CHANGED`); a due cancelled meanwhile (`DUES_CHANGED`); a perfect
validation for a payment already in review, through the IPN route (recorded, never posted). The
three-settles-at-once test now also counts the calls to `recordPayment` (one) and the receipt SMS
(one): with the student's and the intent's locks removed from `settle` it fails (checked by hand;
the payment count alone could not tell, as the unique index refuses the extras).

Recorded, review round 1 (not changed):

- **(a) An SQL injection inside the institute** (any role's request, as `jantrik_app`) can write
  the money facts on an open intent, insert `VALIDATE` events, and choose `priced_on`,
  `expires_at` and the payer on INSERT. This only ever blocks automatic posting (a review, a
  `DUES_CHANGED` from a wrong snapshot, a `val_id` written once), never makes `settle` post:
  `settle` posts only from the validation API's own answer, read under the intent's row lock, and
  the database ties the payment to the intent (x25, x28). The same gap as every table the app
  writes: P1-J10 (role-aware database rules later).
- **(b) Two institutes sharing one SSLCommerz store** see each other's money as `UNMATCHED` (the
  unmatched check validates the `val_id` with this institute's credentials: the same store says
  VALID, and no intent of this institute has that `tran_id`). P7b must never apply such money
  as-is: it may be another institute's.
- **(c) Queries are not counted per payment:** `confirm` asks the query API at most once per job
  (signals for one payment queue one job at a time), so a slow, steady flood from many addresses
  can still make about one query per signal it sends, bounded by the per-address limits. Each
  query lists only real attempts and posts nothing by itself.
- **(d) After a real failed attempt**, a forged fail or cancel return can still close a payment
  whose payer is trying again on the gateway's page (the query then lists `FAILED`); the later
  success waits for review as `LATE_SUCCESS`. No money risk; matching the return's `val_id` to the
  listed attempt would close that too, but whether SSLCommerz sends one on a failed return is not
  documented (the smoke run can show it).

### P7a2 after the review (round 2)

No must-fix: the final review (a fresh reviewer, the whole PR) found no path that posts twice,
posts without our own successful validation, or posts to the wrong institute, student or due.
Fixed, each with a failing test first, taken alone during the run (owner away), each the safer
option:

- **P7a2-x30. Another payment's `val_id` brought only by signals anyone can send leaves the
  payment open.** This narrows P7a-H for forgeable signals only; **an owner decision to
  confirm**. Every guardian of the child has the `tran_id`, and any real `val_id` of the store
  will do. A forged return (`GET …/return/<tranId>/success?val_id=…`, the review's probe P5) sent
  the payment in progress to `NEEDS_REVIEW` with `TRAN_ID_MISMATCH`. The payer's genuine payment
  was then never posted, and P7a cannot resolve reviews. Now, when every signal that brought that
  `val_id` is a return or an IPN from an address SSLCommerz does not list:
  - the validation is recorded as a `VALIDATE` event, marked `UNMATCHED` when no intent of the
    institute has that `tran_id` (P7b's queue; S23 keeps it from posting);
  - the payment stays as it is, and the payer's own validation still posts it.

  From SSLCommerz's listed address, from our own query, or from both in one round: P7a-H as
  before (review). Choices:
  - Unlisted IPNs count as forgeable too (the reviewer named returns): anyone can post one, and
    the attack would otherwise just move to the IPN route.
  - Another intent's money is not marked `UNMATCHED`, as before: it posts through its own intent,
    and P7b must not apply it here.

- **P7a2-x31. UNATTEMPTED and EXPIRED, as our query lists them, close a payment only past the
  session's lifetime.** SSLCommerz's query documents only VALID, VALIDATED, PENDING and FAILED,
  so a real cancel may be listed as UNATTEMPTED or EXPIRED. It then stayed in "confirming" with no
  way out, and a new checkout got 409 `PAYMENT_IN_PROGRESS`, for up to 60 minutes.
  - **The first fix** counted them as over at once. The automated security review of it (medium)
    pointed out that a forged return makes us ask while the payer is still on the gateway's page,
    where UNATTEMPTED is simply true. That was round 1's finding again (x26): the payer's real
    payment then waits for review as `LATE_SUCCESS`.
  - **Now:** with a fail or cancel return, or an IPN that said so, they close the payment only
    once the intent's `expires_at` has passed (an hour after the checkout, P7a-F). No shorter
    gateway session timeout is recorded, so this is the longer, conservative value. The closing
    word is the signal's: CANCELLED for a cancel, FAILED otherwise. FAILED and CANCELLED close
    as before (x26). Never a signal alone, and never a validation answer (it names no `tran_id`
    we could compare).
  - **Before that**, "confirming" offers its payer "give up this payment", then the sheet to
    start again, with a line that SSLCommerz shows no payment. This needs our own query, asked
    after the last return or IPN, to list nothing paid or pending (`noLiveAttempt` on the payment
    view). It is the payer's own abandon: anyone else gets 404 (x20).
  - A query's statuses are recorded in a fixed order, the live ones first, so the page's reading
    is never cut off at 40 characters.
- **P7a2-x32. One query per payment every 10 seconds** (`pay-query:<intent>`): at most 6 a
  minute, 360 an hour. Before (round 1's recorded note (c)), a slow flood from many addresses made
  about one per job, and a signal promoting a job delayed by its backoff skipped the wait.
  - A job that finds the slot taken is not refused. The same job is moved back to BullMQ's
    delayed set until the slot frees (at most 10 s), and that is not counted as an attempt.
  - A signal that promotes it meanwhile finds the slot still taken and asks nothing.
  - Cost: under a flood that has spent the other validation budget, a payer's return without the
    IPN waits up to 10 s for the next query. The IPN has a budget of its own.
- **P7a2-x33. CI: the guardian calendar's 7.9 minutes** (`reports.spec.ts`, 1.7 s on #36). The
  cause was the demo guardian's OTP budget, not the payments: 5 codes a phone per 15 minutes,
  where a request the 1-minute cooldown refuses still counts (`RateLimiter.consume`).
  - **The count** in run 46013055262: the window opened at 14:09:57 with the dashboard spec's
    sign-in. Then fees-mobile (14:13), then P7a2's two Playwright tests: the second asked 4 s
    after the first, was refused by the cooldown but counted, and asked again a minute later.
    That made five.
  - **The wait:** the calendar's sign-in at 14:17:06 was the sixth. The helper waited out the
    window (it ended at 14:24:57; the test finished at 14:25:00).
  - **Ruled out:** measured through the API with a payment open (a test now pins it), no guardian
    read asks SSLCommerz or waits for a job.
  - **Fix:** the P7a2 block signs in once, on one page shared by its two tests (serial), so the
    demo guardian uses four codes in the window, with one spare for a retry. At the end it gives
    up any payment a failed attempt left in progress, through the API with the page's own token
    (no further code).
  - **Also:** "heal on read" now queues its job after commit without the read waiting for it.

Fixed without a decision of their own (each with a failing test first):

- A `val_id` that SSLCommerz's listed address brought stays on that address's budget when the
  payer's return carries it too. Before, the return's entry overwrote it, so after a flood the
  real IPN's `val_id` waited for a query.
- A round stops validating `val_id`s directly once a validation posts the payment or sends it to
  review. The query's own list is still validated in full, so a second payment is a `DUPLICATE`
  event.

Tests added that pass as the code stood: a query listing a FAILED and a PENDING attempt together
(the pending one wins: nothing closes, and "start again" is not offered). The reviewer's other
two missing tests are the x30 tests (`TRAN_ID_MISMATCH` from an unlisted return) and the x31
tests (UNATTEMPTED and EXPIRED, during the session and after it).

Recorded, review round 2 (not changed):

- **(a) x30's order:** once a forged `val_id` has been validated, a later listed IPN carrying it
  is not validated again (its answer was final), so it does not send the payment to review. A
  genuine IPN never carries another `tran_id`'s `val_id`; the `UNMATCHED` event is in P7b's queue.
- **(b) "Start again" from "confirming"** may give up a payment whose money SSLCommerz had not
  listed yet. That money then waits for review as `LATE_SUCCESS`: never lost, never posted twice
  (S23). The page offers it only after our own query found nothing paid or pending.
- **(c) Past `expires_at`, a payment that no signal closes stays open** until P7b expires it.
  A new checkout is allowed by then anyway (P7a-F counts only unexpired payments).
- **(d) Playwright was not run here** (its ports are the developer's). The CI fix is reasoned
  from run 46013055262's timings and the OTP limits; CI shows it.

## Sprint 1, P7b: reconciliation and review queue (day run 2026-11-27)

Online payments, part 3 ([payments.md](payments.md)): SSLCommerz is asked about every online
payment by our `tran_id` at +5 min, +30 min, +2 h and +25 h (and once more at +7 days for one still
pending), healed after a Redis loss by a sweep, the nightly fee run and heal on read; the review
queue where an OWNER or ADMIN applies the money to chosen dues, records it as refunded outside the
app, or dismisses what holds no money; online money in the daily closing, a report and the
dashboard. Stacked on P7a2. S22 and S23 hold as approved: nothing in P7b posts money without a
person deciding, except a reconciliation that finds a payment passing every check, exactly as an
IPN would (through `confirm` and `settle`). Built with the plan's recommended default for every one
of **P7b-A to P7b-O**: A (a query answer only finds `val_id`s; the validation API decides), B (the
sweep, the nightly per-institute re-queue, heal on read), C (`payment_signal_reviews`), D (OWNER
and ADMIN decide; ACCOUNTANT reads and checks), E (money ends only applied or refunded outside; a
remainder recorded as refunded in the same action; dismiss only without money, after a fresh
check), F (the receipt dated the day SSLCommerz took the money), G (`CURRENCY_MISMATCH` refunded
only), H (money items never applied), I (refunds outside the app), J (posted payments asked only at
+25 h), K (`EXPIRED` at +25 h, one more query at +7 days), L (the online line in the
whole-institute closing only), M (the dashboard count and a tab badge, no SMS), N (no undo of
"refunded outside"), O (events kept for ever). Taken alone during the run (owner away), each the
safer option:

- **P7b-x1. Only a person's decision moves an intent out of review, in the database**
  (`payment_intents_resolution_guard`): the plan had the decision columns written only in that
  move; the trigger also refuses the move without a decision, so no job can ever post or close an
  item in review (S23).
- **P7b-x2. Back in review, the decision is cleared from the row by the same trigger** (a void of
  an applied payment, a success after a dismissal); P7a's `settle` and void hook are unchanged, and
  the audit log keeps the earlier decision.
- **P7b-x3. "Money" is a validated `val_id`:** money whose amount SSLCommerz did not report as a
  well-formed amount (P7a2-x13) can be refunded outside (its amount stays unknown, NULL) but never
  applied (422 `AMOUNT_UNKNOWN`) or dismissed. Apply is also refused when the `bank_tran_id` is not
  a usable TrxID (422 `TRX_ID_UNUSABLE`), or when that bank transaction is already a live payment
  (409 `TRX_ID_USED`, so a duplicate is never posted twice), or when it is more than the money (422
  `AMOUNT_EXCEEDS_MONEY`).
- **P7b-x4. A money item (UNMATCHED or DUPLICATE) is dismissed only as a repeat record** of money
  held elsewhere (an intent holds the same `val_id`, or another item records it and was not itself
  dismissed), else 422 `HAS_MONEY`; the plan's table offered "dismiss" for every money item, but
  each one is validated money and P7b-E says money is never dismissed. A deferred trigger checks the
  same at commit. With one SSLCommerz store shared by two institutes, each would see the other's
  money as UNMATCHED: here it can only be recorded as refunded outside (never applied, P7b-H).
- **P7b-x5. Every decision needs a note** (3 to 500 characters), apply included, and there is one
  note per decision: apply's `refundOutside` carries only the reference, and the note also says how
  the rest was given back (the plan had a second note for the refund).
- **P7b-x6. A live gateway payment and its `PAID` intent are matched in the database** (TrxID,
  amount, day), at commit and from both sides: `fee_payments_gateway_check` is redefined in P7b's
  migration (with the P7a2 review's match as the coordinator described it: settle's payments carry
  the intent's amount on its checkout day) and adds applied payments (the applied amount, on a day
  from the checkout day to the day recorded); `payment_intents_payment_match` checks the same when
  an intent changes. **Merge point:** P7a2's own fix to that function lands in its migration
  `20261117510100`; P7b's `20261117520000` redefines it afterwards, so the merge must keep the
  stricter union of both (P7b's applied branch included).
- **P7b-x7. Security review of P7b, finding 1 (write skew):** two dismissals of the two records of
  one payment at once could each see the other standing. The commit-time check now takes an
  advisory lock on `(institute, val_id)` before it reads, and the API takes the same lock before it
  inserts; a two-connection test shows one wins.
- **P7b-x8. Security review of P7b, finding 2 (the match from the intent's side):** the deferred
  `payment_intents_payment_match` (above), and the guard requires `PAID` → `NEEDS_REVIEW` to drop
  the payment and `NEEDS_REVIEW` → `PAID` to bring a new one (the CHECKs already implied both; the
  trigger says so first).
- **P7b-x9. Reconciliation's due times are counted from the intent's creation** (the plan said
  "after init"; the init job follows within seconds), so the sweep, the nightly run and the heal
  compute the same times from the row.
- **P7b-x10. Reconciliation validates only what the query lists** as VALID or VALIDATED whose
  `val_id` is not decided (a `VALIDATE` event saying VALID or VALIDATED; one that said PENDING is
  asked again), at most 5 per step; `val_id`s from signals stay `confirm`'s (with its own budget,
  P7a2's review), so nobody's made-up `val_id` costs a validation call here.
- **P7b-x11. Steps 1–3 close an open intent past its hour only when every attempt the query lists
  ended unpaid in a documented status** (FAILED, CANCELLED, EXPIRED, UNATTEMPTED; CANCELLED when
  each was cancelled); no attempt at all, a PENDING one or an undocumented status waits for +25 h.
  This matches the P7a2 review's rule for `confirm`.
- **P7b-x12. A close by reconciliation is audited with no person** (`{ status, by: 'RECONCILE',
step }`), as the nightly dues run is.
- **P7b-x13. "Check now" over its once-a-minute budget answers 429** (the plan said 202); the page
  says it was asked less than a minute ago. The answer arrives on `lastCheck`.
- **P7b-x14. The nightly re-queue runs for every institute the fee run visits, before its FEES
  check**: validated money is posted even with fees switched off (P7a-O).
- **P7b-x15. A count route for the fee tabs' badge**, `GET /fees/online-payments/review/count`
  (not in the plan), so every fee page does not load the whole queue.
- **P7b-x16. The report's charges cover all the money SSLCommerz validated for the day's
  payments** (`received`: amount, the store's share, charges), whatever happened since: SSLCommerz
  keeps its charge when a payment is later voided or refunded. The row also counts open and
  dismissed payments, so the columns add up to the started ones.
- **P7b-x17. The payment day when SSLCommerz sent no `tran_date`:** the day its validation was
  recorded; any day is kept between the checkout day and today (P7b-F).
- **P7b-x18. The closing's `online` is present for every whole-institute closing** (zeros on a
  quiet day); the page shows the card only when something happened.
- **P7b-x19. HTTP codes:** apply answers 201 with the receipt (as the counter); refunded outside
  and dismiss answer 200 with the item.
- **P7b-x20. Tests and the fake:** the fake SSLCommerz's payer page gains a **Risky** button
  (paid, reported with `risk_level` 1) for the browser test; the API test harness drops the payments
  queue's delayed jobs when a test file closes its app and removes the sweep's scheduler (tests call
  it); P7a2's heal-on-read test uses an intent 2 minutes old (it was 5, when reconciliation's first
  query now runs); a P7a2 database test's "applied again" now writes a decision; the closing test
  voids on the same day (a voided payment's void is never changed).
- **P7b-x21. P7a files edited** (small): `confirm.service.ts` (`validate` public for
  reconciliation), `checkout.service.ts` (the schedule once the session is made),
  `fee-online-hooks.ts` (the nightly re-queue and the dashboard count), `fee-dues.processor.ts`,
  `fee-collection.service.ts` (the online line), `fee-reports.service.ts` (`onlineToReview`), and the
  tests above. No P7a1 or P7a2 migration was edited; `PaymentCredentialsService` and
  `secrets.ts` were not touched.
- **P7b-x22. The nightly re-queue skips a step that already ran** (found in self-review, fixed
  test-first): an open payment whose latest due step already ran gets only its later steps, so
  one that stays open after +25 h (SSLCommerz listing a success its validation API does not
  confirm: never closed when in doubt) is not asked about every night; staff can still check it.
- **Recorded only:** Playwright was not run locally (CI runs it; the screenshots are its
  artifacts). Nothing called SSLCommerz: every test used the fake. The browser test used the
  seeded child `SHS-2026-0002` (as P7a2's does); since review round 1 it has its own (P7b-x33).

### P7b after the review (round 1)

P7a2's review round 1 was merged in first (`bd95464f`): its migration ties a live gateway payment
to its intent's money (P7a2-x28) and keeps an intent from letting go of a live payment (P7a2-x25);
`confirm` validates at most 3 new `val_id`s a round within hourly budgets, closes only when the
query lists a failed or cancelled attempt, and validates a `PENDING` one again. Fixed, each with a
failing test first, taken alone during the run (owner away), each the safer option:

- **P7b-x23. The merge: the stricter union.** P7b's migration redefines
  `fee_payments_gateway_check` after P7a2's: every P7a2 rule for a payment `settle` posts (the
  intent's amount, its `bank_tran_id` as the TrxID, paid on `priced_on`), and the applied branch
  only for an intent a person applied (`applied_paisa`, written only by that decision: the applied
  amount, a day from the checkout day to the day recorded, in taka, x28). P7a2's
  `payment_intents_paid_check` is not redefined and stands. Reconciliation follows `confirm`: at
  most 3 new `val_id`s a step (was 5; `confirm`'s bound per round), and its `QUERY` event is
  recorded at the time it was asked, so a signal that arrives while SSLCommerz answers is still
  `confirm`'s to take.
- **P7b-x24. A void after a partial apply keeps the refund** (finding 1, must-fix). ৳1 200 in
  review, ৳800 applied and ৳400 refunded outside, then the payment voided: the way back to review
  cleared the refund, so the whole ৳1 200 could be applied again (records of ৳1 600 for ৳1 200).
  Now only the applied part and the decision are cleared; `refunded_outside_paisa` and
  `refund_reference` stay ("refunded outside" is final, P7b-N), never shrink and never lose
  their reference (the guard trigger), and an intent in review may hold one below its validated
  amount (the CHECK). The money still to decide is the validated amount less what was refunded:
  apply refuses more (`AMOUNT_EXCEEDS_MONEY { moneyPaisa }`), a further remainder is added to the
  refund (a new reference replaces the old on the row; the audit keeps both), "refunded outside"
  records the whole amount (the audit names the rest). The staff view gains
  `refundedOutside { amountPaisa, reference }` (the card shows "Already refunded outside"; the
  dialogs offer only the rest) and the report counts the refund, the rest as to check.
- **P7b-x25. One payment is one item, refunded outside once** (finding 2). `settle` (and the
  unmatched check) record every validation, but give a `val_id` a review reason only the first
  time, under its advisory lock (`PaymentEventsService.record`), so an IPN's confirm racing "check
  now" or step 4 no longer makes two items of one second payment. A refund outside of a record
  whose money another record already refunded is 409 `ALREADY_REFUNDED` (it can be dismissed as a
  repeat), of money an intent holds 409 `HELD_BY_PAYMENT` (decided on that intent); the database
  checks both at commit (`payment_review_event_check`, under the same lock).
- **P7b-x26. A live gateway payment is never detached from its intent** (finding 3, P1-J10): the
  reviewer's probe (an applied intent moved back to review "voided" with its payment live, then
  refunded outside) is refused at commit by P7a2-x25 after the merge; no new rule was needed. The
  probe is a database test.
- **P7b-x27. A decision names the signed person** (hardening a, as P1-J8k and P6-b21): when a
  request's context signs a person, `resolved_by_id` on an intent leaving review and on a money
  item's decision must be that person (triggers); a context with no person is not checked.
- **P7b-x28. A refunded item's amount is its event's** (hardening b): `amount_paisa` is the
  event's `amount` read as the API reads it (at most 7 digits and 2 decimals), or NULL exactly
  when that was not well-formed (checked at commit).
- **P7b-x29. Applied only in taka, in the database too** (hardening c): the applied branch of the
  match requires `validated_currency = 'BDT'` (P7b-G), from both sides.
- **P7b-x30. An undocumented query status is UNKNOWN** (hardening d): an attempt in a status
  SSLCommerz does not document (the client's `OTHER`) makes the check `UNKNOWN`, not
  `NO_SUCCESS`: nothing closes on it before +25 h, a dismissal is refused (`CHECK_FIRST`), and at
  +25 h it expires with the +7 day query, as `PENDING` does. The page says "an attempt in a state
  SSLCommerz does not document".
- **P7b-x31. Money items in the online report** (hardening e): a second payment (`DUPLICATE`) on
  its payment's start day, money of no payment of ours (`UNMATCHED`) on the day it arrived; each
  payment's money once (by `val_id`; a dismissed repeat record or money an intent holds is not
  counted again); in received (amount, store share, charges), in "to check" while undecided, in
  refunded outside once refunded. So received = paid + to check + refunded outside.
- **P7b-x32. The nightly re-queue and the heal leave out, in the query, what has nothing to
  run** (hardening f): an open payment past +25 h whose +25 h step ran, a posted one whose +25 h
  query ran, an expired one whose +7 day query ran; the heal reads only payments whose latest due
  step has not run. Before, 500 payments that stay open (never closed when in doubt) filled the
  batch every night and crowded out newer ones.
- **P7b-x33. The browser test has its own child and guardian** (CI, run 46019544785: the spec
  failed after 12.9 s, its retry after 1.4 min, and P7a2's happy path after it took 8.1 min and
  failed). Replayed through the API on the e2e seed, every step works; the failure was in the
  browser, right after the admin's page opened: `passwordLogin` returns at once and the next
  `goto` cut the login off (the race of P7a2-x29), then a 10 s wait. The retry waited out the
  guardian's OTP cooldown and failed the same way. Sharing Tahmid (`SHS-2026-0002`) with
  payments.spec also took one of his three owed dues per attempt and the father's OTP budget,
  which that spec needs. Now: Rakib (`SHS-2026-0104`, `DEMO.rakibGuardian`, no other spec signs
  in as his father), the dashboard awaited after each staff login, the items picked by their
  intent id, the money applied to a month ahead, a payment left at the gateway continued, every
  action, navigation and wait bounded at 30 s; an API test replays the flow. Playwright was not
  run locally (its ports are the developer's).

Recorded, review round 1 (not changed):

- **(a) Tests the reviewer named, passing as the code stands** (`payments-review.e2e-spec.ts`):
  apply and the counter on one due at once (one is recorded; the other finds the due paid, a 404
  `Due not found` from either side, as the counter answers today); a void and a second apply at
  once (never two live payments); a dismissal and a late payment at once (never dismissed with
  money); a refund of an item while its twin is dismissed (one refund, one repeat); `TRX_ID_USED`,
  `AMOUNT_UNKNOWN` (then refunded with no amount) and `TRX_ID_UNUSABLE`; another child's due
  (404, nothing recorded). The report with an apply that has a refund part, and with refunded
  items, is tested with x24 and x31.
- **(b) Steps 1–3 still close on EXPIRED or UNATTEMPTED attempts after the hour** (P7b-x11),
  while `confirm` closes a signal's payment only when the query lists FAILED or CANCELLED
  (P7a2-x26): that rule is against forged returns while the payer may still pay; reconciliation
  closes only a payment past its hour whose every listed attempt ended unpaid.
- **(c) The loser of apply against the counter gets 404** (`openDues` finds the due paid), not
  409 `DUES_CHANGED`; the page reloads the item either way. A clearer answer is a fee-module change
  for later.

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
20. **_Approved._ A revoked (DISABLED) GUARDIAN membership is not reactivated** when that person is added as a guardian again; an admin has to restore access deliberately.
21. **_Approved._ Imports go into the current academic year only.**
    - To change: add a year picker to the upload step.
22. **Possible duplicates in an import.** _Changed after review:_ rows with a student ID or birth registration number that is already here are still skipped as "already exists". Other rows are flagged **possible duplicate** when the name (Bangla or English; case, spaces and dots ignored), the class and a guardian phone match an active student of this year, or an earlier row of the same file. They are skipped by default; per row the admin can choose **Import anyway** (`PUT /student-imports/:id/rows/:row/duplicate`, audited, kept in `student_imports.duplicate_overrides`; a new column mapping clears the choices). The preview, the counts, a "Possible duplicates" filter and the report show who the row looks like (the matched student's ID and name stay in the import's results as history). Only rows without errors count as earlier rows; an imported-anyway duplicate takes a seat in its section like any other row.
23. **Import data retention.** _Changed after review:_ raw rows (phones, birth registration numbers) are cleared when an import finishes or fails, after 7 days unfinished, or after a day stuck in a run, by a daily BullMQ job (`expire-imports`, 00:20 Asia/Dhaka, so at most a day after those limits) as well as lazily on upload and listing. Like the held-SMS job it never queries across institutes: uploads record the institute in a Redis sorted set (`imports:raw-tenants`; before the rows are stored, so a Redis outage fails the upload rather than leaving rows unswept, and again after commit), and the job visits only those, one institute per RLS transaction (`TenantJobRunner`), forgetting an institute once none of its imports hold raw rows (and only if it did not upload again meanwhile). The per-row results (row number, status, name, the offending value) are kept as history.
    - To change: also drop names and values from results after N days.

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

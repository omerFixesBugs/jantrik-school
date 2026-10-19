# Decisions pending review (step 7, overnight run)

Each entry: what needed deciding, the default taken (safe and reversible), and how to change it.

1. **CI did not run on pushed feature branches (only `main` and PRs).**
   - Default: Added `feature/**` to the `push` trigger in `.github/workflows/ci.yml`.
   - To change: Remove the line, or open a PR instead.
2. **Disk: C: had ~3 GB free at the start (Docker's data lives there).**
   - Default: Kept going; nothing deleted outside this repo. If Docker stops, the phase is marked blocked here.
   - To change: Free space on C:.
3. **Staff Bangla name: RLS lets the app update only the user's own row, so a new staff member's `name_bn` could not be stored.**
   - Default: `app_find_or_create_user` gets an optional `p_name_bn`, written only when the person is new. An existing person's names are never changed (they may belong to other institutes).
   - To change: Drop the parameter; staff then set their own Bangla name.
4. **Granting OWNER.**
   - Default: Only an OWNER can grant or remove OWNER; ADMINs manage the other roles. Nobody can change their own roles or deactivate themselves.
   - To change: Relax in `StaffService`.
5. **Guardians added at admission/import.**
   - Default: Each gets a login (user + GUARDIAN membership), as the demo seed does, so they can log in with OTP. No SMS is sent.
   - To change: Skip membership creation in `GuardianLinker`.
6. **Linking a guardian by phone when several guardians in the tenant share that phone.**
   - Default: The oldest one is linked; names are not overwritten.
7. **Deactivating a student frees their roll (set to NULL) so the number can be given to someone else; the old roll is in the audit log.**
   - Default: As described.
   - To change: Keep the roll and require a new number for newcomers.
8. **Inactive class levels/sections/subjects/shifts/groups.**
   - Default: Hidden from pickers for new admissions, transfers and imports; existing records and attendance keep working.
9. **Import: a row matching an existing student (student_code, then birth registration no.).**
   - Default: Skipped and reported as "already exists"; the existing record is not updated.
   - To change: An "update existing" option later.
10. **Import: formula cells in .xlsx.**
    - Default: The value Excel saved is used; formulas are never evaluated.
    - To change: Reject formula cells instead.
11. **Student code year.**
    - Default: `{YEAR}` = the calendar year the enrolment's academic year starts in.
12. **Default student code prefix before an admin sets one.**
    - Default: Uppercase initials of the tenant slug's words (`shapla-school` → `SS`), falling back to `STU`.
    - To change: Set it in student settings.
13. **Constraint violations that slip past a service's checks (races).**
    - Default: a global filter maps Prisma P2002 → 409 `DUPLICATE` and P2003 → 409 `REFERENCE_CONFLICT` (both were 500s before, in every module). No constraint names are returned.
    - To change: scope `PrismaErrorFilter` to the new controllers only.
14. **Port 3000 is taken on this machine by another project (`hishab-nikash`'s Next dev server).**
    - Default: left it running; local dev checks ran on 3100/4100 and e2e on 3200/4200 with an uncommitted copy of the Playwright config (`apps/web/playwright.alt.config.ts`, listed in `.git/info/exclude`). CI uses the normal config.
15. **Adding staff by phone links an existing person (as the brief asks: find-or-create).**
    - The review noted that an admin who types any phone then sees that person's real name (if they exist, e.g. as a guardian at another institute) and the person gets a membership without confirming. This is how the brief's find-or-create works.
    - Default: kept as briefed; the audit entry records the phone and whether a new person was created (`newPerson`). Owner/admin only.
    - To change (recommended before launch): require the person's confirmation (OTP/invite) before an existing user is linked, or show only the typed name until they accept.
16. **Roles cache race (pre-existing pattern).** A request by the target that loads roles just before a change commits can re-cache the old roles for up to the 5-minute TTL. Pure staff are still cut off at once (memberships are re-checked every request); someone who is also an active guardian keeps their old staff roles until the TTL.
    - Default: left as is.
    - To change: version the cache key, or check membership status in `RolesGuard` against the request transaction.
17. **Deactivated staff keep their section assignments** (restored on reactivation); they do not count when choosing a section's class teacher.
18. **CI: the end-to-end step failed on GitHub.** _Resolved after review:_ the logs (`gh run view --log-failed`) showed a test race (`layout.spec.ts` typed into the OTP tab while the password panel was still mounted) and a job hitting the 10-minute limit while waiting out OTP cooldowns. Fixed in the tests; e2e now runs as its own CI job (20-minute limit) next to the checks job.
19. **Teachers and student data.** _Resolved after review:_ teachers list every student with the basics; date of birth, birth registration no., addresses, parents' names and guardians (incl. phones) only for OWNER/ADMIN and the teachers of the student's current-year section (`StudentAccess`), in the list, the profile and today's attendance report (absentees' guardian phones). Search by guardian phone is admin-only. Exports (attendance register CSV) carry no such fields; import reports are admin-only.
20. **A revoked (DISABLED) GUARDIAN membership is not reactivated** when that person is added as a guardian again; an admin has to restore access deliberately.
21. **Imports go into the current academic year only.**
    - To change: add a year picker to the upload step.
22. **Import rows without a student ID or birth registration number cannot be matched**, so importing the same file twice creates them twice (rows with either are skipped as "already exists").
    - Default: kept; the template asks for birth registration numbers.
    - To change: also match on name + class + guardian phone, or warn in the preview.
23. **Import data retention.** Raw rows (phones, birth registration numbers) are cleared when an import finishes or fails, after 7 days unfinished, or after a day stuck in a run. The clearing runs lazily when that institute uploads or lists imports (no scheduled job). The per-row results (row number, status, name, the offending value) are kept as history.
    - To change: add a daily sweep job, and/or drop names and values from results after N days.

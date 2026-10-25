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
    - To change: `DeviceAttendanceService.recomputeStudentDay` (e.g. leave registers alone after the cutoff).
41. **LATE is strictly after start + grace** (grace 10: 08:10:00 is PRESENT, 08:10:01 LATE). A section without a shift uses "school starts at" (08:00). The cutoff is per shift: start + 60 minutes.
    - To change: the attendance settings (grace 0–120, cutoff 15–300, "school starts at").
42. **A third reason to hold back, `NOT_ON_DEVICE`:** a section is not closed while an active student cannot punch (no ID, or no add for their ID confirmed on an active device). Otherwise a student without an ID would be marked absent, with an SMS, every day. Inactive students still enrolled never hold a section back (#45).
    - To change: `closeDecision` in `packages/shared/src/devices.ts`. Cost now: more held-back sections until everyone's ID is on a device.
43. **The device closes a register by itself only within an hour of the cutoff.** After that the today page shows `AUTO_CLOSE_ENDED` and it waits for a person, so no absent SMS arrives as a surprise at noon.
    - To change: `AUTO_CLOSE_WINDOW_MIN` in `devices.ts`.
44. **Close from device** is OWNER/ADMIN, after a confirm with the counts, the students not on a device (marked absent too) and the SMS rule. It skips the safety checks and the hour, never the cutoff; DAILY mode is required, auto-mark is not.
    - To change: `DeviceRegistersService.closeFromDevice`.
45. **The device counts only ACTIVE students** (only they are sent to the devices): a section's arrivals, the "more than half missing" check, `NOT_ON_DEVICE` and the today page's counts leave out inactive students still enrolled, and their punches give them no arrival. They are still written on a device register, ABSENT, but get no absent SMS from the device; a teacher's submit follows the usual absent SMS rule for everyone on it. A section with no active student gets no device view and no register from the device.
    - To change: `DeviceArrivalsService.sectionDays` (who counts) and `WrittenRegister.absent` in `device-registers.service.ts` (who gets the SMS).
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
60. **Receiver limits:** 1200 requests a minute per address (IPv6 by its /64); 300 per serial number and address, so others cannot use up the device's share; one budget of 1200 per serial number for all the addresses it does not trust, charged only to them (a trusted device is never starved) and checked before any database call (an address Redis remembers as trusted, for 7 days, skips that check; a revoke does not clear that mark, so a revoked address may skip it for up to 7 days, but is still charged and refused after the database answers and gets no commands); 30 refused serials per 10 minutes per address.
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
     refuses to start in production without `INGEST_PUBLIC_HOST`, or with it set to localhost.
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

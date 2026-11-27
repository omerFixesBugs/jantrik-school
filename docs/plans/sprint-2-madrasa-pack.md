# Sprint 2: the madrasa pack (a plan for the owner's review)

**Status: plan only (day run 2026-11-16), not approved, no code yet.** Written while the owner was
away, at the sprint level, like [sprint-1.md](sprint-1.md). Each phase gets its own detailed plan
(exact columns, migrations, TDD tasks) at its start, approved before any code (as decision S1).
Every phase touches the database; M4 and M5 touch money. Facts about boards, grading and calendars
that could not be verified from the repository are marked **(verify)** and listed as decisions.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement each phase's detailed plan task by task.

**Goal:** a Qawmi, Aliya, Hafizia or Nurani madrasa signs up, gets its own classes, kitabs, grading
and labels, sees Hijri dates next to Gregorian ones, tracks each Hifz student's daily lesson, keeps
zakat, lillah and other donations in separate funds, runs its boarding and meals, and prepares its
board registration lists.

**Architecture:** the four institute types are **data** (templates in
`packages/db/src/reference-data/templates.ts`), never type checks in code. The Hijri calendar is a
global, platform-maintained table of month starts plus a pure conversion in `packages/shared`.
Hifz, boarding and donations are new modules with their own keys, Nest modules and web areas, each
a set of tenant tables with forced RLS. Money follows the fees module's rules (integer paisa,
gap-free receipt numbers, void instead of delete, audit). Board registration exports lists; it
never talks to a board's website.

**Tech stack:** unchanged. No new dependency is needed: Hijri dates come from our own table
(ICU's Islamic calendars are not used for conversion, see "What exists today").

**Spec:** the owner's day-run brief of 2026-11-16, task 5, restated below.

## Scope as asked

1. **Institute types** Qawmi, Aliya, Hafizia (Hifz) and Nurani, each with its template: classes
   (marhala), subjects (kitabs), grading (Qawmi divisions, Aliya GPA), labels and calendar.
2. **Hifz tracker:** daily sabaq, sabqi and manzil; para (juz) and page progress; revision; a
   teacher per halaqa; a guardian view.
3. **Kitab-based classes:** a class defined by the kitabs taught, mapped onto class levels and
   subjects without institute-type checks.
4. **Hijri calendar:** shown beside Gregorian; Hijri-dated holidays (Ramadan, the Eids) that move
   every year; how "today", attendance and fees interact; storage stays UTC/Gregorian; Bangladesh's
   moon sighting.
5. **Boarding and food:** rooms and seats, meal plans, meal attendance, boarding fees through the
   fees module. **CLAUDE.md puts hostel outside the Phase 1 MVP**: planned here, flagged as a scope
   decision (M-1).
6. **Lillah, zakat and donation accounts:** donors who are not students, receipts, separate funds
   (zakat never mixed with general money), reports.
7. **Board registration:** Qawmi boards (Befaq and the others) and the Bangladesh Madrasah
   Education Board for Aliya: registration and exam-candidate lists, export formats.

## What exists today (the plan builds on this)

Verified in the code on 2026-11-16 (branch `main` at `7de4f5a`).

- **Institute types are data already.**
  - `templates.ts:13-15` says a new type (QAWMI, ALIYA…) is an entry in that file, "never code
    branches on the type key".
  - Only three types exist: `COACHING`, `NCTB_SCHOOL_BN`, `NCTB_SCHOOL_EN` (`templates.ts:260-330`).
  - One grading scheme exists: `BD_GPA_5` (`templates.ts:75-99`), which Aliya can reuse.
  - `provisionTenant` copies labels, the default scheme and bands, study groups, class levels,
    subjects and their exam parts into the new institute (`packages/db/src/tenancy/provision.ts:28-140`);
    inactive types are refused (`provision.ts:52-54`).
- **Labels:** an institute can rename only `LABEL_KEYS` = class_level, section, academic_year,
  shift, study_group, student, roll (`packages/shared/src/setup-values.ts:39-47`). There is no
  `subject` label, so "Kitab" cannot be shown instead of "Subject" today.
- **Themes:** `theme_preset` already has `MADRASA` (`schema.prisma:270-278`; design.md:88: green,
  gold, the girih lattice, no living beings). Noto Naskh Arabic is loaded on demand for Arabic text
  (`apps/web/src/app/layout.tsx:68-73`).
- **Names:** class levels and subjects have `name_bn` and `name_en` only (`schema.prisma:845-938`);
  no Arabic name.
- **Grading engine:** a percentage gets the band with the highest `min_percent` ≤ it
  (`packages/shared/src/grading.ts:42-62`). Results have two modes, `GPA` and `MARKS`
  (`schema.prisma:139-145`; `exams-results.ts:154-197`). MARKS gives total and percentage but no
  overall band, so a Qawmi "division" (Mumtaz, Jayyid…) on the average has no home yet.
  `component_kind` already has `ORAL` (`schema.prisma:106-115`), useful for Hifz and kitab orals.
- **Modules:** `module_key` = CORE, ATTENDANCE, FEES, EXAMS (`schema.prisma:47-54`). Rows in
  `tenant_modules` are created only when an institute is provisioned (`provision.ts:82-88`), so a
  new key needs a backfill for existing institutes. Billing has one price column per module
  (`tenant_subscriptions`, `schema.prisma:2044-2078`) and one invoice line kind per module
  (`schema.prisma:2107-2116`). Sprint 1's decision S3 already records that module keys must exist
  before the first paid invoice.
- **Calendar:**
  - Dates are Gregorian everywhere. "Today" is `todayIn(tenant.timezone)`
    (`packages/shared/src/dates.ts:38`); formatters use `bn-BD`/`en-GB` Gregorian
    (`format.ts:17-60`).
  - Holidays are Gregorian date ranges typed by each institute (`holidays`, `schema.prisma:1331-1349`);
    the demo seeds three fixed national days (`seed/demo.ts:85-94`). No Hijri anything.
  - The weekly off day defaults to Friday (`attendance_settings.weekly_off_days`, `schema.prisma:1282`).
  - Node 24's ICU formats Hijri dates, but for 2026-11-16 its three Islamic calendars give
    ৬, ৫ and ৭ জমাদিউস সানি ১৪৪৮ (umalqura, civil, islamic), and the Bangla era word comes out as
    "যুগ" instead of "হিজরি". None follows Bangladesh's moon sighting. Conversion therefore cannot
    rely on ICU.
- **Attendance:** DAILY or PER_SESSION registers per section (`attendance_sessions`,
  `schema.prisma:1760-1794`), with offline drafts and idempotent submits (docs/attendance.md). A
  Hifz halaqa can use the same section register for presence; the lesson record is new.
- **Fees:** heads (`fee_head_kind` ADMISSION, TUITION, EXAM, SESSION, OTHER, `schema.prisma:2213-2221`),
  amounts per class level, dues generated per enrolled student, payments with gap-free receipt
  numbers per institute and year (`fee_receipt_counters`, `schema.prisma:2569-2584`), void only.
  **Every fee payment belongs to a student** (`fee_payments.student_id NOT NULL`,
  `schema.prisma:2586-2630`), so donations from non-students cannot be fee payments.
- **Sprint 1 pieces this pack reuses:** P2 files (institute profile on receipts and lists), P3
  admission (madrasa admissions after Eid-ul-Fitr), P5 promotion (the Qawmi year switch in
  Shawwal), P6 notices (Hijri dates on notices), P7 payments (online donations later), P8/P9
  documents (Hifz completion certificate, board registration cards, Qawmi testimonials).

## Phase order

Each phase is its own branch from `main` and its own PR, with tests and green CI, after Sprint 1
(or at least after the Sprint 1 phases it needs).

| #   | Phase                                                | Scope item | Size | Needs                | Review subagent         | Outside knowledge needed                                   |
| --- | ---------------------------------------------------- | ---------- | ---- | -------------------- | ----------------------- | ---------------------------------------------------------- |
| M0  | Module keys, labels, Arabic names                    | 1, 3       | S    | —                    | yes (DB, billing)       | —                                                          |
| M1  | Madrasa institute types, templates, division grading | 1, 3       | L    | M0                   | yes (DB, grading logic) | current class/kitab lists and division bands **(verify)**  |
| M2  | Hijri calendar and Hijri holidays                    | 4          | M    | —                    | yes (DB, platform)      | Bangladesh month starts (Islamic Foundation announcements) |
| M3  | Hifz tracker                                         | 2          | L    | M0, M1               | yes (DB)                | a Hafizia's daily register, to copy its terms              |
| M4  | Donations: funds, donors, receipts, disbursements    | 6          | L    | M0, P2               | yes (money, DB)         | a madrasa's receipt books and fund practice                |
| M5  | Boarding and food                                    | 5          | L    | M0, M4 (lillah link) | yes (money, DB)         | **scope decision M-1**                                     |
| M6  | Board registration lists                             | 7          | M    | M1, P8               | yes (DB, personal data) | each board's registration fields **(verify)**              |

M0 and M2 do not depend on each other and can run in parallel worktrees. If the sprint runs late,
M5 and M6 move to Sprint 3 (as Sprint 1's P8/P9 rule); tests are never reduced.

Why this order: without M1 no madrasa can sign up at all; M2 changes every madrasa's daily screens
(dates, holidays); M3 is what a Hafizia uses every day; M4 is most Qawmi madrasas' main income;
boarding (M5) is the largest and needs the scope decision; board registration (M6) is seasonal and
reuses the documents designer.

## Global constraints

Sprint 1's global constraints apply unchanged (new tenant tables, migrations, definer functions,
money, dates, data-not-types, modules and roles, slow work, audit, strings and digits, screens,
secrets, gates, local data). Additions for this pack:

- **No institute-type keys in business code.** A code-scan test (new in M1) fails if
  `QAWMI`, `ALIYA`, `HAFIZIA`, `NURANI` (or any `institute_types.key`) appear in `apps/api/src`
  or `apps/web/src` outside the template seed. Differences are template data, labels, scheme
  columns and module switches.
- **Arabic text:** kitab and class names may carry an Arabic name (`name_ar`), shown in Noto Naskh
  Arabic with `dir="rtl"` on that element only. The UI stays bn/en; Arabic UI is still "later".
  Arabic names are never used as identifiers or in search keys.
- **Hijri dates are for display and for generating holidays only.** Every stored date stays a
  Gregorian `date` or a UTC `timestamptz`. No due date, attendance day or receipt year is ever
  computed from a Hijri date at read time.
- **Fund separation is enforced by the database**, not only by the service (M4): a CHECK or
  trigger refuses any transfer out of a restricted fund.
- **Digits:** Hijri day and year numbers follow the Bangla-digit rule in the bn UI (they are
  dates). Para/juz and page numbers are counts (Bangla digits in bn). Board registration numbers,
  donor receipt numbers and seat numbers are identifiers (ASCII).

## Review focus

The failure modes most likely to bite. Each one's test is listed in the phase that owns the code.

1. **Zakat money leaks into another fund.** Through a transfer, a disbursement booked to the wrong
   fund, or a voided donation that still counts. Expected: the database refuses transfers out of
   a restricted fund; every fund's balance equals its donations minus disbursements plus or minus
   transfers, voids excluded (M4: balance property test, transfer refusal test as `jantrik_app`).
2. **A Hijri holiday moves after the moon is sighted.** Eid was entered tentatively for one day
   and the committee announces the next. Expected: the tentative holiday moves, nothing an admin
   typed is overwritten, registers already taken stay, admins see what moved (M2: confirm-month
   test with an edited and an unedited holiday).
3. **Hifz entries doubled or lost.** A teacher on a weak connection submits the halaqa twice, or
   two teachers enter the same student. Expected: one lesson per student, day and kind, idempotent
   by client request id, a second writer gets 409 with the newer version (M3: retry and conflict
   tests, as attendance does).
4. **Boarders charged for months they were not boarders**, or not charged. Expected: a boarding
   due exists for a month exactly when the student held a seat on that month's due date (M5: join
   and leave mid-month tests; money review).
5. **A board list with wrong data.** Names in the wrong script, a missing birth registration
   number, a student listed twice. Expected: the export refuses with a per-row list of problems
   before producing a file (M6: validation tests per board format).
6. **Type logic creeping in.** A "Qawmi" branch in a service. Expected: the code-scan test fails
   (M1).

---

## M0: Module keys, labels and Arabic names (groundwork)

**Goal:** the switches and names the later phases need, with no behaviour change for existing
institutes.

- **Module keys** (decision M-2): `HIFZ`, `BOARDING`, `DONATIONS`, each a billable module.
  - `module_key` gains the three values in their own migration.
  - The rest follows Sprint 1's S3 list: `platform_set_module`, price columns on
    `tenant_subscriptions` (`hifz_paisa`, `boarding_paisa`, `donations_paisa`, default 0),
    `invoice_line_kind` values, the billing SQL, and the platform screens.
  - **Backfill:** existing institutes need a `tenant_modules` row per new key (disabled). No tenant
    backfill in a migration (Sprint 1 rule), and the app role cannot insert module rows after
    provisioning. A platform definer function, `platform_backfill_module_rows()`, inserts the
    missing rows (disabled) for every institute and is run once by the deploy step; the module
    guard treats a missing row as disabled meanwhile, so nothing breaks before it runs.
  - If the owner wants Sprint 1's S3 keys (ADMISSION, NOTICES, DOCUMENTS, ONLINE_PAYMENTS) at the
    same time, they go into this same phase with the same backfill (decision M-3).
- **Labels:** `LABEL_KEYS` gains `subject` (default বিষয় / Subject) and `teacher` (default
  শিক্ষক / Teacher). Template labels for existing types get the defaults; existing institutes get
  rows through the same backfill function (labels are tenant rows, `provision.ts:90-99`). Every
  screen that says "subject" or "teacher" switches to `useLabel()`; a unit test lists the
  translation keys that must not contain the word any more.
- **Arabic names:** nullable `name_ar` on `template_class_levels`, `template_subjects`,
  `class_levels` and `subjects` (CHECK: length ≤ 120, and NULL or contains an Arabic-block
  character). The setup screens get an optional "Arabic name" field; the name shows beside the
  Bangla one where space allows (class and subject pickers, report cards).
- **Tests:** the guard with a missing module row (treated as disabled), the backfill function
  (idempotent, every institute, platform role only), invoice lines for the new modules, label
  fallback, `name_ar` CHECKs, RLS unchanged.
- **Docs:** database.md, platform.md (modules and billing), design.md (Arabic names).

## M1: Madrasa institute types, templates and division grading (scope 1 and 3)

**Goal:** four new types a platform admin can pick when creating an institute, each a complete,
editable template.

- **Types** (decision M-4), each an entry in `INSTITUTE_TYPES`, default theme `MADRASA`, default
  locale `bn`, attendance mode `DAILY`:
  - **`QAWMI`** — classes by marhala and kitab (below), scheme `QAWMI_DIVISION`, labels:
    class_level জামাত / Jamaat, subject কিতাব / Kitab, teacher উস্তাদ / Ustad, student ছাত্র /
    Student (decision M-6). Study groups: none.
  - **`ALIYA`** — Ebtedayee 1–5, Dakhil 6–10, Alim 1st and 2nd year; scheme `BD_GPA_5` (as NCTB);
    study groups for Dakhil/Alim (General, Science, Mujabbid **(verify)**); subjects: the general
    subjects as NCTB plus Quran Majid and Tajweed, Hadith Sharif, Aqaid and Fiqh, Arabic 1st and
    2nd paper, Islamic History **(verify against BMEB's current scheme of studies)**. Fazil and
    Kamil (now under the Islamic Arabic University) are not templated (decision M-5).
  - **`HAFIZIA`** — class levels Nazera, Hifz, Daur (revision) **(verify the names a Hafizia
    uses)**; labels: section হালকা / Halaqa, teacher উস্তাদ / Ustad; scheme `QAWMI_DIVISION` for its
    oral exams; module HIFZ suggested at creation (the platform form pre-ticks it from a new
    `institute_types.suggested_modules` column: data, not a type check).
  - **`NURANI`** — pre-primary Quran reading (Nurani method): levels such as শিশু, নূরানী ১ম–৩য়
    বর্ষ, নাজেরা **(verify against the Nurani Talimul Quran Board's levels)**; subjects Quran
    reading (Qaida/Nazera), Masala-Masail, Dua, Bangla, Arithmetic; scheme `QAWMI_DIVISION` or a
    simple marks scheme (decision M-7).
- **Kitab-based classes (scope 3):** no new tables.
  - A Qawmi class is a `class_level` named after its main kitab (e.g. মিজান, নাহবেমীর,
    হেদায়াতুন্নাহু, কাফিয়া, শরহে বেকায়া, জালালাইন, মেশকাত, দাওরায়ে হাদীস) with `name_ar`.
  - Its kitabs are its `subjects` (the label says "Kitab"), each with `name_ar`, its exam parts
    (`WRITTEN` and/or `ORAL`) and pass marks as data.
  - The marhala (Ibtidaiyyah, Mutawassitah, Sanaviya Ammah, Sanaviya Ulya, Fazilat, Takmil) is
    not a study group (those split a class by subjects). It is a new optional `class_level_groups`
    table (tenant, name bn/en/ar, sort order; class levels point to it), used for reports,
    promotion's "highest class" and board levels (M6). It is generic ("stage"), so schools can use
    it too (primary, secondary).
  - The exact kitab list per class differs between madrasas and changes over years: the template is
    a starting point the institute edits (it already can: tenant copies).
- **Division grading** (decision M-8):
  - `exam_result_mode` gains `DIVISION` (own migration): each subject is passed or failed on its
    pass marks as today; the student's overall letter is the scheme band of the **percentage of the
    total**, and any failed subject gives the scheme's fail band (decision M-9).
  - `grading_schemes` and the templates gain `default_result_mode` (copied into new exams; the
    exam setup can still change it) and `fail_letter` (the band letter used when a subject fails).
  - Scheme `QAWMI_DIVISION` (bn/en/ar letters as data): মুমতায / Mumtaz 80–100, জায়্যিদ জিদ্দান /
    Jayyid Jiddan 65–79, জায়্যিদ / Jayyid 50–64, মাকবুল / Maqbul 33–49, রাসিব / Rasib (fail)
    **(verify every band edge against a current Befaq marksheet)**.
  - `computeClassResults` gets a third branch keyed by the mode (a mode is data on the exam, not an
    institute type). Merit for DIVISION is by total, then the existing tie rules.
  - Report card and result SMS show the division name instead of GPA when the mode is DIVISION.
- **Calendar defaults per type** (data): weekly off day (Friday for all four **(verify; some
  Qawmi madrasas also close Thursday afternoon)**), `calendar_settings.show_hijri` on (M2), and the
  Hijri holiday set to load (M2).
- **Tests:** each new type provisions (classes, subjects with parts, scheme, labels, theme);
  `DIVISION` results with ties, a failed subject (fail band), an absent part (incomplete), rounding;
  the code-scan test for type keys; a Qawmi institute's report card snapshot; existing types
  unchanged.
- **Docs:** exams.md (DIVISION mode), database.md, a new `docs/madrasa.md` (the four templates,
  what each carries, how to edit them), demo-accounts.md if a demo madrasa is seeded (decision M-10).

## M2: Hijri calendar and Hijri holidays (scope 4)

**Goal:** every madrasa sees the Hijri date beside the Gregorian one, and Hijri-dated holidays
follow Bangladesh's moon sighting.

- **Month starts are data, kept by Jantrik** (decisions M-11, M-12):
  - New global table `hijri_months` (platform-owned; `GRANT SELECT` to `jantrik_app`):
    `hijri_year`, `hijri_month` (1–12), `starts_on` (Gregorian date in Bangladesh), `status`
    (`COMPUTED | ANNOUNCED`), who and when. Unique (year, month) and unique `starts_on`; CHECK that
    consecutive starts are 29 or 30 days apart (a trigger checks neighbours).
  - Pre-filled for about three years ahead from an astronomical computation (status COMPUTED).
  - A platform admin confirms each month after the national moon-sighting committee's
    announcement (Islamic Foundation Bangladesh), which turns it ANNOUNCED and may move it one day.
    Platform screen: the next three months, "confirm" or "move by one day", audited in
    `platform_audit_logs`.
  - Per institute: `calendar_settings` (≤ 1 per tenant; S I U): `show_hijri` (default from the
    type), `hijri_offset_days` (−1, 0 or +1, default 0) for the few institutes that follow another
    sighting (decision M-13).
- **Conversion:** a pure function in `packages/shared` (`hijriOf(date, months, offset)`) finds the
  last month start ≤ the date. Month names bn/en/ar and the era word "হিজরি" / "AH" are our own
  strings, not ICU's. The client gets the month table once (small, cached for a day) through
  `GET /calendar/hijri-months?from&to`. Dates past the table show nothing rather than a guess.
- **Display:** the app header's date, the dashboard, the attendance register's day, notices, and
  optionally printed documents (a per-document setting in P8/P9's designer: a bound field
  `date.hijri`). Each shows "১৬ নভেম্বর ২০২৬ · ৬ জমাদিউস সানি ১৪৪৮ হিজরি" style, Bangla digits in bn.
- **Hijri holidays:**
  - Global `hijri_holiday_templates` (seeded; keyed by institute type, null = every type; S only):
    name bn/en/ar, Hijri month and day, length in days, and whether a madrasa type closes for it
    (e.g. Eid-ul-Fitr, Eid-ul-Adha, Ashura, Shab-e-Barat, Shab-e-Qadr, Eid-e-Miladunnabi; for
    Qawmi the Ramadan vacation **(verify the usual lengths)**).
  - `holidays` gains `hijri_month`, `hijri_day`, `is_tentative`, `source_template_id` and
    `edited_by_admin` (all nullable or defaulted; CHECKs pair them).
  - A job (on month confirmation, and nightly) creates each institute's holidays for the coming
    months from the templates the institute keeps switched on, tentative while the month is
    COMPUTED. When a month is confirmed, its tentative holidays move to the announced dates and
    become firm; holidays an admin edited are left alone and listed for the admin instead.
  - The job runs per institute (one transaction each), queued by institute id; no cross-tenant SQL.
- **Attendance and fees:** unchanged rules, because holidays stay Gregorian rows. A day that turns
  into a holiday after registers were taken keeps its registers (they show as "taken on a non
  working day", the existing flag). Due dates and fines ignore Hijri; fees by Hijri month are a
  later decision (M-14).
- **Academic years:** Qawmi years usually run Shawwal to Sha'ban. Years stay Gregorian date ranges;
  the year form gets a helper "starts 1 Shawwal 1448" that fills the Gregorian date from the table.
- **Tests:** conversion at month edges, offsets, a date past the table; the neighbour CHECK; the
  confirm flow moving a tentative holiday and leaving an edited one; the job's idempotency; RLS of
  `calendar_settings`; platform-only writes to `hijri_months`.
- **Docs:** a new `docs/calendar.md`, attendance.md (holidays), platform.md (the monthly
  confirmation duty).

## M3: Hifz tracker (scope 2)

**Goal:** the halaqa's teacher records each student's daily lesson in under a minute per student
on a phone; guardians and the head see progress.

- **Model:** a halaqa is a **section** (label হালকা / Halaqa) and its teacher is the section teacher
  (`section_teachers`): no new halaqa table. A student in Hifz is a normal enrolled student.
- **Reference data** (in `packages/shared`, not tables: it never changes per institute):
  30 paras, their surah and ayah ranges, and the default mushaf layout "15-line Hafezi", 20 pages
  per para **(verify; decision M-15)**. Positions are recorded as para + page (+ optional line).
- **Tables** (all tenant tables, module HIFZ):
  - `hifz_settings` (≤ 1 per tenant; S I U): the quality scale (2–6 levels, bn/en names, data),
    whether lines are recorded, the daily guardian SMS switch (off by default), the expected new
    lines per day for reports.
  - `hifz_lessons` (S I, UPDATE by column, no DELETE; void with reason): student, date, `kind`
    (`SABAQ | SABQI | MANZIL`), from and to (para, page, line?), amount (pages or lines), quality
    level, mistakes (ভুল) and hesitations (আটকা) counts, `heard_by` (the teacher), note,
    `client_request_id`, `version`. Unique (tenant, student, date, kind) among live rows.
  - `hifz_para_status` (S I U): student, para 1–30, `status`
    (`NOT_STARTED | IN_PROGRESS | MEMORIZED`), `memorized_on`, `last_revised_on`, `weak` flag.
    Updated in the same transaction as a lesson (a SABAQ that finishes a para marks it MEMORIZED;
    a MANZIL updates `last_revised_on`).
  - `hifz_assessments` (S I U): periodic para tests (e.g. "5 paras heard by the head"): paras,
    examiner, mistakes, result band; feeds the Hifz completion certificate (P9 document kind
    `HIFZ_COMPLETION`).
- **Screens:**
  - Teacher (phone first): the halaqa list for today, one row per student with yesterday's
    position pre-filled, three quick blocks (sabaq, sabqi, manzil), quality chips, mistakes
    steppers. Drafts survive going offline, as attendance does; submit is per student.
  - Student page: a 30-cell para map (memorized, in progress, weak, not started), the last 30 days,
    the pace (lines per day) and the projected completion date.
  - Head (OWNER/ADMIN): halaqas compared, students without a sabaq today, weak paras, revision
    overdue.
  - Guardian: the child's daily lessons and para map (read only).
- **SMS** (decision M-16): off by default; when on, at most one SMS per student per day after the
  halaqa is submitted, purpose `HIFZ_REPORT` (own enum migration), through
  `TenantSmsService.queue()` with the daily cap and dedupe `hifz:<student>:<date>`.
- **Who:** the halaqa's teachers write their own halaqa; OWNER/ADMIN write any; guardians read
  their children; the API checks the section-teacher link like attendance does.
- **Tests:** a SABAQ completing a para; a retried submit (same client id) answered, not doubled; a
  stale version → 409; another halaqa's teacher → 403; a guardian of another child → 404; the para
  map after voiding a lesson; pace with weekly off days and holidays; SMS once per day under the
  cap; RLS of every table.
- **Docs:** a new `docs/hifz.md`; attendance.md (halaqa registers).

## M4: Donations — funds, donors, receipts, disbursements (scope 6)

**Goal:** a madrasa records every taka it receives from donors into the right fund, issues numbered
receipts, spends from each fund with a record, and can show that zakat stayed zakat.

- **Not the fees module:** fee payments always belong to a student (`fee_payments.student_id NOT
NULL`); donations come from anyone. Donations get their own tables and module (DONATIONS), with
  the fees module's money rules copied: integer paisa, gap-free receipt numbers, void (never edit
  or delete), audit, daily closing.
- **Tables** (all tenant tables):
  - `donation_funds` (S I U; deactivated, never deleted): name bn/en, `kind`
    (`ZAKAT | LILLAH | SADAQAH | GENERAL | CONSTRUCTION | HIDES | OTHER`, decision M-17),
    `restricted` (true for ZAKAT and LILLAH by default; once true never false: a trigger),
    receipt prefix. Created from defaults when the module is first enabled.
  - `donors` (S I U): name (optional: anonymous allowed), phone (normalised, optional), address,
    note. Search by phone or name.
  - `donations` (S I, UPDATE by column for void only, no DELETE): fund, donor?, amount paisa
    (> 0), method (`CASH | BKASH | NAGAD | BANK | OTHER`), TrxID, received on, collected by,
    receipt year and number, `client_request_id`, status ACTIVE/VOID with reason.
  - `donation_receipt_counters` (S I U): per tenant, fund and year (decision M-18), atomic in the
    same transaction like `fee_receipt_counters` (a rolled-back donation gives its number back).
  - `fund_disbursements` (S I, void only): fund, amount, date, purpose (a per-fund list, data),
    beneficiary (`student_id?` or a free-text name), approved by, note. ZAKAT and LILLAH
    disbursements require a beneficiary (CHECK through the fund's `restricted`, enforced by a
    trigger that reads the fund).
  - `fund_transfers` (S I, void only): from fund, to fund, amount, reason. **A trigger refuses any
    transfer out of a restricted fund** (review focus 1).
- **Balances:** a view `fund_balances` (security invoker, RLS applies): donations − disbursements ±
  transfers, voids excluded. A disbursement or transfer that would take a fund below zero is
  refused under the fund's row lock (decision M-19).
- **Screens** (OWNER/ADMIN record and void; ACCOUNTANT records and views):
  - "Receive a donation": fund, amount (Bangla digits accepted), donor lookup by phone, method;
    prints an A5/thermal receipt with the institute profile (P2) and the fund's name.
  - Funds overview: balance per fund, this month's in and out.
  - Disburse and transfer forms (transfer offers only unrestricted source funds).
  - Reports: by fund and day/month, by donor, zakat in/out with beneficiaries, CSV; the daily
    closing gets a "donations" section next to fees.
- **SMS receipt to the donor** (decision M-20): off by default; purpose `DONATION_RECEIPT` (own
  enum migration), only when a phone is given.
- **Later, not here:** online donations through P7's SSLCommerz provider (a public donation page),
  paying a poor student's fees from a fund (until then: a concession plus a disbursement, decision
  M-21), in-kind gifts (recorded when sold, decision M-22).
- **Tests:** receipt numbers gap-free under concurrency and rollback, per fund and year; void twice
  refused; the transfer trigger as `jantrik_app` (zakat → general refused, general → zakat
  allowed); a restricted disbursement without a beneficiary refused; the balance property over a
  random sequence of operations; below-zero refused under concurrency; RLS of every table; audit
  rows for every write.
- **Docs:** a new `docs/donations.md`; fees.md (what is not a fee); database.md.

## M5: Boarding and food (scope 5) — scope decision first

**CLAUDE.md:** "Do NOT build hostel, transport, AI tutor, virtual labs yet" (Phase 1 MVP). Boarding
is a hostel. This phase is planned so the owner can decide (decision M-1); it is not started
without that decision. The default keeps it light: seats, boarding/meal fees and meal absences, no
inventory, kitchen or purchasing.

- **Tables** (module BOARDING; all tenant tables):
  - `boarding_rooms` (S I U; deactivated): name, building, floor, `gender` (data), capacity.
  - `boarding_allotments` (S I, UPDATE by column to end it; no DELETE): student, room, seat label
    (ASCII), from and to dates; exclusion constraint: one live allotment per student, never more
    than the capacity per room at any date (checked under the room's row lock).
  - `meal_plans` (S I U): name bn/en (e.g. full board, lunch only), meals included (data),
    linked fee head.
  - `meal_plan_members` (S I, UPDATE to end): student, plan, from and to.
  - `meal_absences` (S I D): student, date, meal (`BREAKFAST | LUNCH | DINNER | SEHRI | IFTAR`,
    data-driven list per institute), reason. A boarder is assumed to eat; only absences are
    recorded (decision M-23).
- **Fees:** `fee_heads` gains `audience` (`ALL | BOARDERS | MEAL_PLAN`) and `meal_plan_id?`. The due
  generator charges a BOARDERS head for a month only if the student holds a live allotment on that
  month's due date (decision M-24: no proration). Money logic, so its own tests and review, in
  `packages/shared`'s fees calculation, with the generator's existing idempotency.
- **Lillah boarding:** poor boarders' boarding and meal dues are covered by a concession
  (`FREE_FULL`) with a reason; the madrasa records the cost as a lillah disbursement (M4). No
  automatic money movement between modules (decision M-21).
- **Screens:** rooms and seats (who is where, free seats), allot/move/end, meal plan members, the
  daily meal absence sheet (phone), the kitchen's count per meal for tomorrow, reports.
- **Tests:** capacity under concurrent allotments; overlapping allotments refused; dues for a
  student joining on the 10th and leaving on the 20th; meal counts with absences; RLS; audit.
- **Docs:** a new `docs/boarding.md`; fees.md (audience).

## M6: Board registration lists (scope 7)

**Goal:** the madrasa prepares its candidates for a board's registration or exam, checks the data,
prints the forms and exports the list the board asks for. Uploading to a board's portal stays a
manual step done by the madrasa.

- **What is known** (to confirm with the owner and a real institute):
  - Qawmi madrasas sit central exams of their board; the six Qawmi boards work under Al-Haiatul
    Ulya Lil-Jamiatil Qawmia Bangladesh, which holds the Dawrah-e-Hadith (Takmil) exam; Befaqul
    Madarisil Arabia Bangladesh is the largest board **(verify the list of boards and which
    marhalas each examines)**.
  - Aliya madrasas register Dakhil and Alim candidates with the Bangladesh Madrasah Education Board
    through its online student information forms **(verify the current system and its fields)**.
  - Hafizia candidates sit board Hifz exams (e.g. Befaq's Tahfizul Quran) **(verify)**.
  - No export format of any board could be verified for this plan. The design keeps formats as data
    so a format can be added without code.
- **Tables:**
  - Global `exam_boards` (S only; seeded after the owner confirms the list, decision M-25): key,
    names bn/en/ar, website.
  - Global `exam_board_levels` (S only): board, level key, names, the class-level-group (M1) it
    usually applies to, and `export_columns` (jsonb: ordered columns, each a whitelisted source
    field, a header, a format such as `UPPER_EN`, `DATE_DD_MM_YYYY`, `ASCII_DIGITS`; validated by
    a versioned zod schema in `packages/shared`).
  - `board_registrations` (S I U): student, board level, session (text, e.g. "1447-48 হি." or
    "2026"), `registration_no` (ASCII, unique per tenant, board and level once set), board roll,
    status (`DRAFT | SUBMITTED | REGISTERED | WITHDRAWN`), problems found at the last check.
- **Flow:** pick a board level and a class (or group) → the candidates list → a data check per
  row against the level's required fields (names in English capitals, father's and mother's
  names, birth registration number, date of birth, photo from P2) → fix in the student record →
  export CSV/XLSX in the level's column order, print the forms through P8's designer
  (`BOARD_FORM` kind) → after the board's acceptance, type or import the registration numbers.
- **Who:** OWNER/ADMIN; under module EXAMS (decision M-26).
- **Tests:** the column spec schema; the per-row check (missing field, wrong script, duplicate
  student); export bytes for a fixture level; registration number uniqueness; RLS; the student's
  board details reaching P9's testimonial.
- **Docs:** a new `docs/board-registration.md` (how to add a format, as data).

---

## New tables at a glance

All tenant tables have forced RLS, `tenant_isolation`, composite keys, `ON UPDATE RESTRICT` foreign
keys, an index leading with `tenant_id`, explicit grants, an entry in `schema-safety.test.ts` and an
isolation test in `packages/db/test/<area>-rls.test.ts` (the database.md checklist).

| Table                       | Phase | Kind   | Grants (jantrik_app)    | Note                                         |
| --------------------------- | ----- | ------ | ----------------------- | -------------------------------------------- |
| `class_level_groups`        | M1    | tenant | S I U                   | marhala / stage; class levels point to it    |
| `hijri_months`              | M2    | global | S                       | written by the platform role only            |
| `hijri_holiday_templates`   | M2    | global | S                       | seeded, keyed by institute type (null = all) |
| `calendar_settings`         | M2    | tenant | S I U                   | ≤ 1 per tenant                               |
| `hifz_settings`             | M3    | tenant | S I U                   | ≤ 1 per tenant                               |
| `hifz_lessons`              | M3    | tenant | S I, U by column        | history; void only                           |
| `hifz_para_status`          | M3    | tenant | S I U                   | 30 rows per Hifz student at most             |
| `hifz_assessments`          | M3    | tenant | S I U                   |                                              |
| `donation_funds`            | M4    | tenant | S I U                   | `restricted` can never be unset (trigger)    |
| `donors`                    | M4    | tenant | S I U                   | personal data (phone)                        |
| `donations`                 | M4    | tenant | S I, U by column (void) | money; gap-free receipts                     |
| `donation_receipt_counters` | M4    | tenant | S I U                   | per fund and year                            |
| `fund_disbursements`        | M4    | tenant | S I, U by column (void) | money                                        |
| `fund_transfers`            | M4    | tenant | S I, U by column (void) | money; trigger refuses restricted sources    |
| `boarding_rooms`            | M5    | tenant | S I U                   |                                              |
| `boarding_allotments`       | M5    | tenant | S I, U by column (end)  | capacity under the room lock                 |
| `meal_plans`                | M5    | tenant | S I U                   |                                              |
| `meal_plan_members`         | M5    | tenant | S I, U by column (end)  |                                              |
| `meal_absences`             | M5    | tenant | S I D                   |                                              |
| `exam_boards`               | M6    | global | S                       | seeded after the owner confirms the list     |
| `exam_board_levels`         | M6    | global | S                       | export columns as validated jsonb            |
| `board_registrations`       | M6    | tenant | S I U                   | registration numbers ASCII, unique once set  |

**Changed tables and enums:**

- `module_key` + `HIFZ`, `BOARDING`, `DONATIONS`; `invoice_line_kind` likewise;
  `tenant_subscriptions` price columns (M0).
- `template_class_levels`, `template_subjects`, `class_levels`, `subjects`: `name_ar` (M0);
  `class_levels.class_level_group_id` (M1).
- `institute_types.suggested_modules` (M1).
- `grading_scheme_templates`, `grading_schemes`: `default_result_mode`, `fail_letter` (M1);
  `exam_result_mode` + `DIVISION` (M1, own migration).
- `holidays`: `hijri_month`, `hijri_day`, `is_tentative`, `source_template_id`, `edited_by_admin`
  (M2).
- `sms_purpose` + `HIFZ_REPORT` (M3), `DONATION_RECEIPT` (M4), each in its own migration.
- `fee_heads`: `audience`, `meal_plan_id` (M5).
- Sprint 1 P8/P9 document kinds + `HIFZ_COMPLETION`, `DONATION_RECEIPT` (if receipts move to the
  designer), `BOARD_FORM`.

**New database roles:** none. The module-row backfill is a platform definer function owned by
`jantrik_platform` (the existing pattern), listed in `schema-safety.test.ts`.

## Environment variables

None. Hijri month starts are data, entered by platform admins.

## What needs outside knowledge

Nothing here needs an account. These need a person who knows a real madrasa or a board, before the
phase that uses them; until then the template values are placeholders marked "(verify)" in the seed.

| What                                                    | Needed for | Who                                      |
| ------------------------------------------------------- | ---------- | ---------------------------------------- |
| Current Qawmi class (jamaat) names and kitab lists      | M1         | Owner, from a Befaq madrasa's syllabus   |
| Befaq division band edges and the fail rule             | M1         | Owner, from a recent Befaq marksheet     |
| Aliya subjects and groups for Ebtedayee, Dakhil, Alim   | M1         | Owner, from BMEB's scheme of studies     |
| Hafizia and Nurani level names                          | M1         | Owner, from a Hafizia / the Nurani board |
| The mushaf most Hafizias use (lines, pages per para)    | M3         | Owner, from a Hafizia                    |
| Usual madrasa holidays and the Ramadan vacation         | M2         | Owner                                    |
| Receipt-book practice per fund (one series or per fund) | M4         | Owner, from a madrasa's accountant       |
| Each board's registration fields and file formats       | M6         | Owner, from a madrasa that registered    |

## Decisions for the owner

Nothing here is decided. The **blocks** column names the first phase that needs the answer.

| #    | Decision                                                                                 | Recommended default                                                                                                                                         | Blocks |
| ---- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M-1  | Boarding and food despite "no hostel in Phase 1"                                         | Plan kept; build M5 last and light (seats, boarder/meal fees, meal absences), only after you confirm; otherwise it moves to Phase 2                         | M5     |
| M-2  | New billable modules                                                                     | `HIFZ`, `BOARDING`, `DONATIONS`; Hijri calendar and board lists stay in CORE / EXAMS                                                                        | M0     |
| M-3  | Add Sprint 1's S3 keys (admission, notices, documents, online payments) at the same time | Yes, in M0 with the same backfill, so billing gets all keys in one change                                                                                   | M0     |
| M-4  | Which types                                                                              | Four: `QAWMI`, `ALIYA`, `HAFIZIA`, `NURANI`; a Qawmi madrasa with a Hifz department picks QAWMI and enables HIFZ                                            | M1     |
| M-5  | Fazil and Kamil (Aliya, university level)                                                | Not templated; an institute can add those classes by hand                                                                                                   | M1     |
| M-6  | Qawmi labels                                                                             | Class জামাত / Jamaat, subject কিতাব / Kitab, teacher উস্তাদ / Ustad, student ছাত্র / Student; editable per institute                                        | M1     |
| M-7  | Nurani grading                                                                           | The Qawmi division scheme; a plain marks-only result is one setting away                                                                                    | M1     |
| M-8  | How a "division" is computed                                                             | New result mode `DIVISION`: band of the percentage of the total, as data on the scheme; not a GPA                                                           | M1     |
| M-9  | A failed kitab under DIVISION                                                            | The student gets the fail band (Rasib) whatever the average, as Befaq does **(verify)**                                                                     | M1     |
| M-10 | A demo madrasa in the seed                                                               | Yes, one Qawmi demo with a Hifz halaqa (`nur-madrasa`), so screens and e2e have data                                                                        | M1     |
| M-11 | Where Hijri dates come from                                                              | A Jantrik-kept table of Bangladesh month starts: computed ahead, confirmed by a platform admin after each moon-sighting announcement; never ICU's calendars | M2     |
| M-12 | Who confirms each month                                                                  | Jantrik's platform admins, once for every institute (12 short tasks a year); a reminder on the platform dashboard 2 days before                             | M2     |
| M-13 | Institutes following another sighting                                                    | A per-institute offset of −1, 0 or +1 day, default 0                                                                                                        | M2     |
| M-14 | Monthly fees by Hijri month                                                              | Not now: fees stay on Gregorian months                                                                                                                      | M2     |
| M-15 | Hifz position unit                                                                       | Para + page (+ optional line) on the 15-line Hafezi mushaf, 20 pages per para **(verify)**                                                                  | M3     |
| M-16 | Daily Hifz SMS to guardians                                                              | Off by default; when on, one SMS per student per day, paid by the institute, inside its daily cap                                                           | M3     |
| M-17 | Fund kinds                                                                               | ZAKAT, LILLAH, SADAQAH, GENERAL, CONSTRUCTION, HIDES (Qurbani hides), OTHER; ZAKAT and LILLAH restricted                                                    | M4     |
| M-18 | Donation receipt numbering                                                               | One gap-free series per fund per year (matches separate receipt books); alternative: one series per institute                                               | M4     |
| M-19 | Spending more than a fund holds                                                          | Refused (no negative balances)                                                                                                                              | M4     |
| M-20 | SMS receipt to donors                                                                    | Off by default; only when the donor gives a phone                                                                                                           | M4     |
| M-21 | Paying poor students' fees from lillah/zakat                                             | Not automatic: a concession on the dues plus a recorded disbursement                                                                                        | M4     |
| M-22 | In-kind gifts (rice, Qurbani hides)                                                      | Recorded as cash when sold; no stock keeping                                                                                                                | M4     |
| M-23 | Meal attendance                                                                          | Record absences only; for counts and reports, no money effect                                                                                               | M5     |
| M-24 | Boarding fee for part of a month                                                         | Full month if the student holds a seat on the due date; no proration                                                                                        | M5     |
| M-25 | Which boards to seed                                                                     | Only after you confirm the list; until then an institute types its board's name                                                                             | M6     |
| M-26 | Module of board registration                                                             | EXAMS (no new key)                                                                                                                                          | M6     |
| M-27 | Board portals                                                                            | Export files and print forms only; never log in to or scrape a board's site                                                                                 | M6     |
| M-28 | Sprint split                                                                             | Sprint 2 = M0–M4; M5 and M6 in Sprint 3 unless time remains                                                                                                 | —      |

## How each phase runs

As Sprint 1's "How each phase runs": branch `feature/sprint-2-mN-<name>` from an up-to-date
`main`, a detailed plan approved first, TDD task by task, the full gates, the review subagent, the
PR with green CI, a report.

## Risks

- **Domain facts.** Most "(verify)" items are about real madrasas and boards; a wrong default only
  changes seed data, never code, but a wrong band edge on a report card is visible. Mitigation: the
  owner confirms M1's lists before its PR merges.
- **Moon sighting.** If nobody confirms a month, Hijri dates and tentative holidays may be one day
  off. Mitigation: the platform reminder, the "tentative" mark on screens, and the per-institute
  offset.
- **Scope.** Boarding and donations each approach the size of the fees module. If a detailed plan
  shows one is bigger than a reviewer can hold, it splits (as Sprint 1's risk rule).
- **Fiqh questions** (what zakat may be spent on, tamlik) are the madrasa's responsibility; the app
  keeps the money separate and reports it, and says so in docs/donations.md.
- **Labels sweep (M0).** Making "subject" and "teacher" renameable touches many screens and
  translation keys; a missed one shows "Subject" in a Qawmi madrasa. The unit test listing keys
  that must use the label limits that.
- **Billing.** New module keys change invoices; tested with the platform billing tests before any
  institute is invoiced.

## Sources

- In this repository: CLAUDE.md, docs/PRODUCT.md, docs/design.md (Madrasa theme), docs/database.md
  (new-table checklist), docs/fees.md, docs/exams.md, docs/attendance.md, docs/plans/sprint-1.md
  (S3 and the phase plans), `packages/db/src/reference-data/templates.ts`,
  `packages/db/src/tenancy/provision.ts`, `packages/db/prisma/schema.prisma`,
  `packages/shared/src/{grading,exams-results,dates,format,setup-values}.ts`.
- Node 24's ICU output for 2026-11-16 (checked during this plan) for the Hijri conversion note.
- Board structures, grading bands, class and kitab names: general knowledge, not verified against
  an official source during this run; every such item is marked **(verify)**.

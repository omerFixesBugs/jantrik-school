# An institute leaves: full export and permanent delete (plan)

**Status: plan only (day run 2026-11-27), not approved, no code.** The owner asked for it as a
plan: it is needed before go-live and is promised in the contract drafts (#30:
`school-data-custody-agreement.md` 8.4, 12.3, 13.1–13.3; `privacy-policy.md` → retention;
`docs/legal/README.md` questions 6 and the owner's list items 5 and 7). Every choice below has a
recommended default in "Decisions for the owner" (X-A to X-R). Facts are taken from
`integration/sprint-1-1127` (`main` + #20–#27 + #32): 83 tenant tables, 20 global ones.

## Goal

1. **Export:** an institute's OWNER (or Jantrik on its behalf) gets one complete, documented
   copy of everything the institute keeps in Jantrik, in common formats, at any time and in
   particular during the export window after it leaves.
2. **Permanent delete:** after the export window, Jantrik removes the institute's data from the
   live service, provably, without touching any other institute or any person's records that
   belong to another institute, keeps only what the law and Jantrik's own accounts require, and
   makes sure a restored backup never brings the data back.
3. **Retention limits** for the two logs that grow without end today (SMS log, audit log), which
   the legal drafts list as open.

**Not in this plan:** erasing one person on request (custody agreement 8.4; a smaller follow-up
that reuses the export and delete building blocks, X-R); live payment refunds; moving an
institute between Jantrik servers.

## What exists today

- `tenants.status`: `TRIAL`, `ACTIVE`, `SUSPENDED`, `ARCHIVED` (`suspended_from` for
  reactivation). No exit state, no dates for an export window or deletion.
- Per-screen exports only (attendance registers, fee reports, tabulation sheets, import reports:
  CSV or print). No full export.
- Students and staff are deactivated, never deleted. Money tables have **no DELETE grant** for
  `jantrik_app` (fees, broadcasts, payments), by design.
- Files (photos, logo, signature, seal, admission photos) are rows in `stored_files` (`bytea`),
  so they live in the database and its backups.
- Backups: a nightly `pg_dump`, kept `BACKUP_KEEP_DAYS` (14 by default), optional off-site copy
  (deploy.md → Backups). Redis is not backed up.
- Retention that already exists: device punches (setting, 730 days default), device commands
  (90 days), import rows (cleared when done, or after 7 days).
- Outside Jantrik: the SMS provider's own logs; SSLCommerz's transaction records (P7a); the
  hosting provider's snapshots, if any.

## Data inventory (the contract of the export and the delete)

Every table falls in exactly one class. A schema test (Task X1.1) fails when a new table is not
classified, the same way `schema-safety.test.ts` pins tables today.

| Class                               | Tables (examples; the test lists all)                                                                                                                                                                                                                                                                                                                                                | Export                             | Delete                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | ----------------------------------------------------------- |
| **Institute data** (tenant tables)  | setup (`branches`, `academic_years`, `class_levels`, `sections`, `subjects`, …), people (`students`, `guardians`, `student_guardians`, `memberships`, `staff_profiles`, `enrolments`), attendance, devices, exams and results, fees (dues, payments, receipts, concessions, mobile submissions), admission, promotion, notices, broadcasts, `sms_logs`, `audit_logs`, `stored_files` | yes                                | yes                                                         |
| **Working data**                    | `student_code_counters`, `fee_receipt_counters`, `admission_counters`, `onboarding_progress`, `student_imports` (rows already cleared)                                                                                                                                                                                                                                               | counters as context only           | yes                                                         |
| **Jantrik's own accounts**          | `tenant_subscriptions`, `platform_invoices`, `platform_invoice_lines`, `platform_payments` (tenant tables, but Jantrik's billing of the institute)                                                                                                                                                                                                                                   | yes (the institute's invoices)     | **kept** for the legal period (X-H), then deleted           |
| **Global, the institute's persons** | `users` (a person can belong to several institutes or be a guardian in several), `sessions`, `refresh_tokens`                                                                                                                                                                                                                                                                        | the institute's view of them       | only persons with no link left to any other institute (X-G) |
| **Global, Jantrik's**               | `tenants` (the row), `platform_audit_logs`, `platform_sms_logs`, `platform_*` admin tables, `platform_settings`, templates, `app_context_key`                                                                                                                                                                                                                                        | no                                 | `tenants` reduced to a tombstone (X-I); the rest kept       |
| **Never exported**                  | `users.password_hash`, OTP and session secrets, `payment_gateway_accounts` ciphertext (P7a), the context key                                                                                                                                                                                                                                                                         | no (listed in the export's README) | deleted with their rows                                     |

Outside the database: Redis keys of the institute (queues, rate limits, caches, the broadcasts
due set), log lines (rotated by Docker), backups (expire), the SMS provider and SSLCommerz
(their own retention; listed in the deletion certificate as outside Jantrik's control).

## The exit lifecycle

A new platform table `tenant_exits` (one row per exit; Jantrik's, not a tenant table):
`tenant_id`, `requested_at`, `requested_by` (platform admin), `reason`, `access_ends_on`,
`export_until`, `delete_after`, `deleted_at`, `deleted_by`, `certificate` (JSON counts),
`cancelled_at`. The tenant's status moves through:

1. **Notice given** (`ACTIVE`/`TRIAL`/`SUSPENDED` → unchanged): Jantrik records the exit with the
   agreed dates. Nothing is blocked; the OWNER sees a banner with the dates.
2. **Read-only** (`ARCHIVED`, from `access_ends_on`): staff and guardians are signed out and can
   no longer sign in; the OWNER can sign in read-only and export (X-B). No SMS, no jobs (the
   module guard and the workers skip `ARCHIVED` institutes; to verify per job in Task X2.2).
3. **Deleted** (after `delete_after`, by a platform admin's explicit command, X-F): the purge runs;
   `tenants` keeps only a tombstone row (status `DELETED`, a new enum value; slug, legal name and
   address for the kept invoices; everything else cleared).

An exit can be cancelled before the purge (back to the previous status, `suspended_from`
pattern). The purge never runs on a timer by itself (X-F).

## Export

- **Who:** the OWNER, from the institute's settings, at any time (data portability, not only at
  exit), and a platform admin on the OWNER's written request (the custody agreement's "on
  request" copy). Re-authentication with the password before starting (X-C).
- **How:** a queue job `institute-export` (ids only in job data; one at a time per institute;
  runs in the worker with a signed tenant context, so RLS applies as everywhere). It streams
  each table in id order in pages (never the whole table in memory), writes a ZIP to the
  export volume, and records `institute_exports` (tenant table: who, when, status, size,
  SHA-256, `expires_at`).
- **Format (X-D):** one ZIP:
  - `README.md` (bn and en): what each file is, the columns, what is not included and why,
    the export's time and institute.
  - `manifest.json`: schema version, per file the table, row count and SHA-256.
  - `data/<table>.csv`: UTF-8 with BOM (Excel opens Bangla correctly), one file per tenant
    table, ids kept so rows can be joined; money as integer paisa plus a taka column; dates as
    ISO dates, times in UTC plus an Asia/Dhaka column.
  - `people/`: friendlier CSVs for the common needs (students with guardians and class,
    staff, guardians), built from the same rows.
  - `files/<kind>/<id>.<ext>`: photos, logo, signature, seal, admission photos.
  - The institute's invoices from Jantrik as CSV.
- **Delivery:** a download link on the settings page, valid 7 days (X-E), OWNER only, served by
  the API from the export volume (never a public URL), each download audited. The file is
  encrypted at rest on the volume with a per-export key derived from a new secret
  `EXPORT_FILES_KEY` (X-E), deleted when it expires.
- **Size:** measured on a seeded large institute (Task X1.4) before choosing limits; the ZIP is
  streamed, so the limit is disk, not memory. One export per institute per day (X-C).

## Permanent delete (the purge)

- **Who and when:** a platform admin runs it, after `delete_after`, with the institute's slug
  typed twice (`pnpm platform:tenant purge --tenant <slug> --confirm <slug>` on the server, and
  the same as a button in the platform UI later). Never automatic (X-F).
- **How (X-F):** in the worker, as the schema owner login (`DATABASE_MIGRATION_URL`), with a
  signed context for that institute (the owner can read the key; P1-J8), so every statement is
  still limited by RLS to that one institute: a mistake cannot reach another. Tables are emptied
  in foreign-key order (children first), in batches of 5,000 rows per transaction, resumable
  (the job records the last finished table). `jantrik_app` keeps having no DELETE on money
  tables; only the purge (owner login) deletes them.
- **Shared persons (X-G):** memberships and guardian links of the institute go; a `users` row,
  its sessions and refresh tokens go only when that person has no membership and no guardian link
  left in any other institute and is not a platform admin. A person who stays keeps only their own
  account fields (name, phone, email, password); nothing of this institute remains linked to them.
- **What stays (X-H):** the tombstone `tenants` row, `tenant_exits`, Jantrik's invoices and
  payments for the institute (legal period, then a second purge), `platform_audit_logs`
  (Jantrik's actions, institute named, no student data). Counts kept for Jantrik's statistics are
  totals only (already the rule, custody agreement 4.4).
- **Outside the database:** the job deletes the institute's Redis keys (by prefix and the known
  sets; a list kept in code with a test that every Redis key pattern is covered), the export
  files, and refuses to finish while any job for that institute is still queued.
- **Certificate:** `tenant_exits.certificate` records per table the rows deleted, the time, who
  ran it, and what remains (the kept classes, backups until `<date>`, the SMS provider and
  SSLCommerz as outside parties). The platform UI prints it for the written confirmation the
  custody agreement promises (13.2).
- **Backups (X-I):** deleted data stays in backups until they expire (14 days + the off-site
  period). The restore runbook gets a mandatory step: after any restore, re-run the purge for
  every tombstoned institute (`pnpm platform:tenant purge --all-tombstoned`), and the API refuses
  to start while a tombstoned institute still has rows (a start-up check, as for TEMP in P1-J8).

## Retention limits for the SMS and audit logs (X-J, X-K)

- **SMS log:** the text of an SMS is replaced by a marker after 90 days (it holds names, marks,
  dues); the row (number, purpose, status, segments, cost, day) is kept 13 months for billing
  disputes and the monthly usage, then deleted. A daily job per institute, batches, owner login
  as the purge.
- **Audit log:** kept 7 years for money and marks entities (fees, payments, results), 2 years
  for everything else, then deleted by the same daily job. Old and new values of deleted rows
  hold personal data, so the period is a legal question (to confirm with the lawyer, #30).
- The privacy policy's retention table is updated in the same PR.

## Tests (each task test-first)

- **Every tenant table is classified** (schema test); a new table fails it until classified.
- **Export completeness:** a fixture institute with at least one row in every tenant table
  (built from the existing test helpers), exported: every class-"institute data" table has a
  CSV with the right row count, the manifest's hashes match, no excluded column appears
  anywhere (password hashes, ciphertexts), another institute's rows never appear.
- **Purge:** the fixture purged: zero rows in every institute table for it; the other institute
  untouched (row counts per table before and after); a person shared with the other institute
  keeps their account and the other institute's links; a person only of the purged institute is
  gone with sessions and tokens; Jantrik's invoices kept; resumable after a crash mid-table;
  refused before `delete_after`, without the double slug, while jobs are queued.
- **Restore guard:** a dump taken before the purge, restored into a scratch database: the start-up
  check refuses; the re-purge makes it pass.
- **Retention jobs:** with the faketime test database (as used for the test-year PR), rows of
  each age are kept or removed exactly at the limits.

## Tasks and PR split

- **X1, export** (PR 1): X1.1 the table classification and its test; X1.2 `institute_exports`
  and the export volume (deploy: a volume, `EXPORT_FILES_KEY`); X1.3 the job and the ZIP writer;
  X1.4 the settings page and the download route; X1.5 a large-institute measurement; docs
  (`docs/exit.md`), review (database, security).
- **X2, exit and purge** (PR 2): X2.1 `tenant_exits`, `DELETED`, the lifecycle and the banner;
  X2.2 read-only `ARCHIVED` (sign-out, guards, workers skip); X2.3 the purge job and command;
  X2.4 shared persons; X2.5 Redis and files; X2.6 the certificate; X2.7 the restore guard and the
  runbook; review (database, security, two rounds).
- **X3, retention** (PR 3): the daily job for SMS text, SMS rows and audit rows, the settings and
  the privacy policy table; review (database).

Size: **L** in total (X1 M, X2 L, X3 S). X1 and X3 are independent of each other; X2 needs X1
(the export must exist before anything is deleted).

## New for the owner

- **Environment:** `EXPORT_FILES_KEY` (≥ 32 characters, production only; development and tests
  derive one from `OTP_PEPPER` like `PLATFORM_TOTP_KEY`). Generate with
  `openssl rand -base64 48`.
- **Deploy:** an export volume in `deploy/docker-compose.prod.yml` (API and worker), left out of
  the backups: exports are copies and expire (X-E).
- **No new database role** (the purge uses the existing owner login, X-F).

## Decisions for the owner

| #   | Decision                              | Recommended default                                                                                                                                    | Alternative                                                       |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| X-A | Where the exit lives                  | A platform table `tenant_exits` and a new status `DELETED`; `ARCHIVED` becomes "read-only, export only"                                                | Statuses only, dates on `tenants`                                 |
| X-B | Access during the export window       | The OWNER only, read-only, export allowed; staff and guardians signed out                                                                              | Everyone read-only                                                |
| X-C | Who may export and how often          | The OWNER (password re-entered) any time, once a day; a platform admin on written request                                                              | Only at exit; or ADMIN too                                        |
| X-D | Format                                | One ZIP: CSV per table (UTF-8 BOM, ids kept) + friendly people CSVs + files + manifest with hashes + README in bn and en                               | JSON per table; or a SQL dump (not usable by a school)            |
| X-E | Delivery and storage                  | A 7-day OWNER-only link, the file encrypted at rest with `EXPORT_FILES_KEY`, on a volume not in backups                                                | Email a link (no email infrastructure yet); store in the database |
| X-F | Who deletes and how                   | A platform admin's explicit command after `delete_after`, slug typed twice; the owner login with a signed tenant context, FK order, batches, resumable | An automatic purge on the date; a new purge role                  |
| X-G | A person shared with other institutes | Keep the account, remove every link to this institute; delete the account only when nothing links it elsewhere                                         | Always keep accounts                                              |
| X-H | What Jantrik keeps                    | Its invoices and payments for the institute and the tombstone, for the legal period [to verify: tax and company record periods], then purged           | Keep forever                                                      |
| X-I | Backups                               | Not edited; expire on their own; a mandatory re-purge after any restore and a start-up check that refuses tombstoned data                              | Delete backups early (loses everyone's recovery)                  |
| X-J | SMS log retention                     | Text replaced after 90 days; rows deleted after 13 months                                                                                              | Keep everything; or delete after 90 days                          |
| X-K | Audit log retention                   | 7 years for money and marks, 2 years for the rest [to verify with the lawyer]                                                                          | Keep everything                                                   |
| X-L | The export window and deletion period | Export 30 days after access ends; deletion within 30 days after that (the drafts' numbers)                                                             | Other numbers in the contract                                     |
| X-M | Cancelling an exit                    | Allowed until the purge starts                                                                                                                         | Not allowed after read-only                                       |
| X-N | Jobs during read-only                 | None run (no SMS, no reminders, no device processing); queued ones are dropped at the start of read-only                                               | Let queued SMS finish                                             |
| X-O | Device data at exit                   | Exported and deleted like everything else; devices are unlinked at read-only so punches stop                                                           | —                                                                 |
| X-P | Payment gateway accounts (P7a)        | Switched off at read-only; credentials deleted in the purge; SSLCommerz's own records listed as outside Jantrik                                        | —                                                                 |
| X-Q | The certificate                       | Counts per table, kept classes, backup expiry date, outside parties; printable from the platform                                                       | A signed PDF (no PDF library yet, P8-D)                           |
| X-R | One person's erasure (agreement 8.4)  | A follow-up plan after X2, reusing the export and purge code per person, with the school-record exemptions the lawyer names                            | Build it in X2                                                    |

## Risks

- **Deleting the wrong institute:** RLS limits every statement to the signed institute; the slug
  is typed twice; the command shows the counts and the tombstone check before it starts; the
  test checks another institute's counts are unchanged.
- **A restore brings data back:** the start-up check and the runbook step (X-I).
- **Shared persons:** the only cross-institute rows (`users`, sessions, refresh tokens) are
  handled by one function with its own tests (X-G).
- **Export leaks:** OWNER only, re-authenticated, short-lived link, encrypted at rest, audited
  downloads, excluded secret columns tested.
- **Legal periods unknown:** X-H, X-J and X-K are flagged for the lawyer; the defaults are the
  conservative ones that keep money and marks history longest.

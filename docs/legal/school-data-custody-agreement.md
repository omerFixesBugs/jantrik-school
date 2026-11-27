# Jantrik School: School Data Custody Agreement (DRAFT)

> **DRAFT FOR LAWYER REVIEW — NOT LEGAL ADVICE. Not for publication or signature until reviewed
> by a lawyer qualified in Bangladesh.**
>
> Written on 2026-11-18 from the product's code and docs, by an assistant, while the owner was
> away. The annexes describe **only what the software does today**, and mark what is planned or
> waiting in an open pull request (PR). Square brackets mark undecided facts and unchecked law
> (`[to verify]`). Open questions: [README.md](README.md). A Bangla version is needed before use.

This agreement is part of the Jantrik School Terms of Service ([terms-of-service.md](terms-of-service.md))
between **[Company legal name]** ("**Jantrik**") and the institute named in the Order Form
("**the Institute**"). It says how Jantrik looks after the information the Institute puts into
Jantrik School. It is written in plain language on purpose: the Institute's head should be able
to read it and know what Jantrik will and will not do.

---

## 1. The idea in one paragraph

The Institute decides what information about its students, guardians and staff goes into Jantrik
School and why. Jantrik keeps that information safe and uses it **only** to run the service for
the Institute, in the way the Institute sets it up. Jantrik does not own it, sell it, advertise
with it, or use it for anything else. When the Institute leaves, it gets its information back
and Jantrik deletes it.

## 2. Words used

- **Institute Data:** all personal information the Institute, its staff or its guardians put into
  the service, or that the service creates from it. Annex D lists the kinds.
- **Data fiduciary** and **data processor:** the roles under Bangladesh's personal data
  protection law: the one who decides the purpose, and the one who handles data on its behalf.
  [to verify: the exact terms and definitions in the Personal Data Protection Act, 2026, and
  whether "data custodian" has its own meaning there.]
- **Sub-processor:** a company Jantrik uses that handles Institute Data for the service (Annex B).
- **Breach:** any event where Institute Data is lost, changed, seen or taken by someone who
  should not have it.

## 3. Roles

3.1 The Institute is the **data fiduciary** for Institute Data. Jantrik is its **data
processor**. [to verify]

3.2 The Institute is responsible for:

- having a lawful basis for the data, including **a parent's or guardian's consent for a child's
  data** where the law requires it [to verify: when consent is needed and in what form];
- telling students, guardians and staff about the processing (Jantrik's Privacy Policy can help);
- the accuracy of what it enters, especially guardians' mobile numbers;
- who in the Institute has access, and with which roles;
- answering requests from students, guardians and staff about their data (section 8).

## 4. Jantrik follows the Institute's instructions

4.1 Jantrik processes Institute Data only:

- to provide, secure, support and fix the service under the Terms of Service;
- as the Institute sets it up in the service. **The Institute's settings and actions in the
  service are its instructions**: for example switching absent SMS on, publishing results,
  sending reminders, inviting a teacher;
- where Bangladeshi law requires it (section 10).

4.2 If Jantrik believes an instruction breaks the law, it will tell the Institute.

4.3 Jantrik does **not**:

- sell, rent or trade Institute Data;
- use it for advertising, or show advertising in the service;
- build profiles of children, or track them for any purpose other than the Institute's own
  records;
- contact students or guardians for Jantrik's own purposes, except service messages the
  Institute has switched on and sign-in codes;
- combine one Institute's data with another's.

4.4 Jantrik may use **counts** (for example the number of active students, SMS sent, imports)
to bill the Institute and run the service. Jantrik's own staff screens show only such counts;
the database does not give them students' or guardians' details.

## 5. Children's data

Most Institute Data is about children. Jantrik treats all of it as needing special care:

- access inside the Institute follows its roles (teachers see full details only of the students
  in their own sections; accountants see guardian numbers partly hidden; guardians see only their
  own children);
- images are re-made by the server and hidden details (such as a photo's location) are removed;
- attendance devices never send fingerprints, faces or photos to Jantrik;
- Jantrik will not use children's data to train or improve anything other than the service
  itself, and will not use it in any automated decision about a child. [to verify: whether this
  promise, and the ban on profiling minors reported for the 2025 ordinance, need more.]

## 6. Jantrik's people

6.1 Everyone at Jantrik who can reach Institute Data is bound by confidentiality.

6.2 Only the people who run the servers can reach the database directly, and only to keep the
service working, fix faults, restore backups or follow the law. [to decide: a written access
policy: who, when, logged how, and whether the Institute is told. Today there is no separate log
of a server operator's direct database access.]

6.3 Jantrik's platform staff (who onboard institutes and send invoices) use a separate login
with a password and an authenticator app, and see counts only (section 4.4).

## 7. Security

Jantrik keeps the measures in **Annex A** in place and improves them over time. It will not
reduce the overall level of protection during this agreement.

## 8. Requests from students, guardians and staff

8.1 Most requests the Institute can handle itself in the service: correcting a record, changing
a guardian's number, removing a photo, deactivating a student or staff member, or producing a
student's attendance, fee ledger or report card.

8.2 Jantrik will help with anything the Institute cannot do itself, within [number] working
days of being asked, for example a full copy of one person's records. [to decide: fees for
unusual requests.]

8.3 If a student, guardian or staff member contacts Jantrik directly, Jantrik will pass the
request to the Institute and not answer it itself, unless the law requires Jantrik to answer.
[to verify]

8.4 **Not built yet:** a one-click "everything about this person" export, and a way to
permanently delete one person's records. Records today are deactivated, not deleted (Annex C).
[to verify: whether the right to erasure under the Personal Data Protection Act, 2026 requires
Jantrik to build permanent deletion before go-live, and which school records are exempt.]

## 9. Sub-processors

9.1 Jantrik may use the sub-processors in **Annex B**. Each is bound by a written agreement to
protect the data at least as well as this agreement requires. Jantrik is responsible for them.

9.2 Jantrik will tell the Institute at least [30] days before adding or replacing a
sub-processor. If the Institute has a reasonable objection, the sides will discuss it; if it
cannot be solved, the Institute may end the agreement without penalty.

## 10. Where the data is kept, and requests from authorities

10.1 Institute Data is stored at [hosting provider, country/region: to decide].

10.2 [to verify: whether the Personal Data Protection Act, 2026 requires some or all of this
data, or a synchronised copy of it, to be kept inside Bangladesh, and what is needed for
storage or backups outside Bangladesh. The February 2026 amendment of the earlier ordinance
required a copy in Bangladesh for some data; reports differ on which.]

10.3 If an authority asks Jantrik for Institute Data, Jantrik will check that the request is
lawful, give only what the law requires, and tell the Institute first unless the law forbids it.
[to verify: the powers under the cyber security law, the data protection law and the
telecommunication law, and whether "tipping off" restrictions apply.]

## 11. Breaches

11.1 Jantrik will tell the Institute's owner **without undue delay, and within [48] hours** of
becoming aware of a breach affecting the Institute's data, even if not all facts are known yet.
[to verify: the period the law requires, and whether 48 hours is achievable.]

11.2 The notice will say, as far as known: what happened and when; what data and how many
people are affected; the likely effects; what Jantrik has done and will do; and a contact
person. Jantrik will update it as it learns more.

11.3 Jantrik will help the Institute tell the data protection authority and the people affected
where the law requires. [to verify: who must notify (the Institute as fiduciary, Jantrik, or
both), to whom, and in what time. Reports on the final Act differ on whether it requires breach
notification at all.]

11.4 Jantrik keeps a record of every breach, including small ones, and what was done.

11.5 **Today:** there is no automated breach detection beyond server logs, health checks and the
backup alerts the deployment guide describes. [to decide]

## 12. Backups

12.1 Jantrik backs up the whole database (including photos and images) every night, checks each
backup, and keeps it for **14 days** on the server by default. A restore is tested regularly
(the deployment guide says once a month).

12.2 [to decide: off-site backup storage, its location and how long it keeps copies. The
deployment guide treats an off-site copy as required but has not chosen one.]

12.3 Deleted data stays in backups until those backups expire.

## 13. When the agreement ends

13.1 **Export.** For [30] days after the agreement ends, the Institute can sign in (read only
[to decide]) and export its data. Jantrik will also provide, on request within that time, a
complete export in a common format (for example CSV files and the images). **Today the service
has per-screen exports only** (attendance registers, fee reports, tabulation sheets, import
reports, as CSV or print); a full export must be built before the first Institute leaves.

13.2 **Deletion.** After the export period Jantrik deletes Institute Data from the live service
within [30] days, and it disappears from backups as they expire (14 days by default, plus
[off-site period]). Jantrik will confirm the deletion in writing. **Today there is no deletion
tool**; it must be built and tested before the first Institute leaves.

13.3 Jantrik may keep, for as long as the law requires, its own records: invoices, payments to
Jantrik and the Institute's account details. [to verify: tax and company record periods.]

13.4 If the law requires the Institute to keep school records for a period, the Institute must
export them before deletion. Jantrik is not a records archive after the agreement ends unless
agreed separately. [to verify: record-keeping duties of institutes.]

## 14. Information and audits

14.1 Jantrik will answer the Institute's reasonable questions about how it protects the data,
including security questionnaires, within [number] working days.

14.2 Once a year, or after a breach, the Institute may ask for a review of these measures,
with [30] days' notice, at its own cost, by a reviewer bound by confidentiality, without access
to other institutes' data. [to decide]

## 15. Liability and term

15.1 The liability terms of the Terms of Service apply. [to verify: whether a higher cap should
apply to data breaches.]

15.2 This agreement lasts as long as Jantrik holds Institute Data.

---

## Annex A: Security measures

Status: **Built** = in the released code (`main`). **Merging** = built and reviewed, in an open
pull request that is about to merge. **Planned** = decided or proposed, not built. **Limit** =
a known weakness, stated openly.

### A1. Keeping institutes apart

| Measure                                                                                                                                                                                                                | Status                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Every institute's records carry the institute's ID, and every query is limited to the signed-in person's institute.                                                                                                    | Built                   |
| The database itself also enforces this (PostgreSQL row-level security, forced on every institute table), so a mistake in the application cannot show another institute's rows.                                         | Built                   |
| The application logs in to the database as an ordinary user that cannot switch this protection off; at start-up it refuses a login that could (superuser, bypass of row-level security, replication or role creation). | Built                   |
| Separate database logins, each with only the rights it needs: the main app, Jantrik's platform tools, the password check, and the attendance-device receiver.                                                          | Built                   |
| The ordinary application login cannot read password hashes; only the sign-in check can.                                                                                                                                | Merging (PR #16)        |
| A signed request context, so that even an SQL injection could not pose as another person or institute.                                                                                                                 | Planned (PR #20)        |
| Today, an SQL injection (if one existed) could still change who the request acts as and so take over an account. No such injection is known.                                                                           | Limit (fixed by PR #20) |

### A2. Who can see what

| Measure                                                                                                                                                                                                  | Status |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Every page and request checks the person's role and whether the institute has that module.                                                                                                               | Built  |
| Teachers see full student details only for their own sections; accountants see guardian phone numbers partly hidden; guardians see only their own children (any other child's link answers "not found"). | Built  |
| Jantrik's platform staff tools return counts only; the database grants them no access to students', guardians' or messages' details.                                                                     | Built  |
| Jantrik's platform staff sign in with a password and an authenticator app (with one-time backup codes), never SMS, and their actions are logged.                                                         | Built  |

### A3. Sign-in

| Measure                                                                                                                                                                                                  | Status  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| No public sign-up: only people an institute (or Jantrik, for a first owner) added can sign in.                                                                                                           | Built   |
| Sign-in codes: 6 digits, valid 5 minutes, 5 tries, single use, stored only as a keyed hash; limits per phone (10 a day) and per address.                                                                 | Built   |
| Staff passwords: at least 10 characters, not the phone number or the institute's name, not a common password; stored with argon2id; 5 wrong tries per 15 minutes.                                        | Built   |
| The app never says whether a number or account exists.                                                                                                                                                   | Built   |
| Sessions: short-lived access tokens kept only in memory; the long-lived token in a secure, script-proof cookie, stored only as a hash and replaced on every use; reuse of an old token ends the session. | Built   |
| Sign-out ends the session at once; setting a password signs out every other device.                                                                                                                      | Built   |
| A screen showing a person's signed-in devices; password reset by an admin.                                                                                                                               | Planned |

### A4. Network and servers

| Measure                                                                                                                                                                                                                                                                                                                                   | Status                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| The web app, the API and Jantrik's platform area are served only over HTTPS (automatic certificates, HSTS).                                                                                                                                                                                                                               | Built (deployment guide)                    |
| The server's firewall opens only SSH, web (80, 443) and the device port (4080); the database and Redis are not reachable from the internet.                                                                                                                                                                                               | Built (deployment guide; confirm on server) |
| Secrets (database passwords, signing keys) live only in the server's settings file, never in the code. Authenticator secrets for Jantrik's staff are encrypted (AES-256-GCM).                                                                                                                                                             | Built                                       |
| Attendance devices connect over plain HTTP, because ZKTeco devices support nothing else. Only a device ID number, a time, in/out and how the person verified are accepted; everything else the device sends is thrown away unread. Devices are identified by serial number, and commands go only to an address the Institute has trusted. | Limit                                       |
| The device receiver runs as its own program with its own database login that can read no table.                                                                                                                                                                                                                                           | Built                                       |
| Encryption of the database and backups at rest (beyond what the hosting provider's disks offer).                                                                                                                                                                                                                                          | Planned [to decide]                         |
| An uptime monitor with alerts.                                                                                                                                                                                                                                                                                                            | Planned (owner to choose)                   |

### A5. Records and history

| Measure                                                                                                                                                                | Status              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| An audit log of creating, changing and deleting important records (marks, fees, payments, attendance, staff roles, setup), with who, when, and the old and new values. | Built               |
| Payments, receipts and marks are never edited or deleted; mistakes are voided or corrected with a reason, which is kept.                                               | Built               |
| Uploaded images are checked (JPEG, PNG or WebP only), re-made by the server, shrunk, and stripped of hidden details such as location.                                  | Merging (PR #18)    |
| An institute-facing screen to read the full audit log.                                                                                                                 | Planned [to decide] |

### A6. Backups

| Measure                                                                                                                | Status                         |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Nightly backup of the whole database (images included), with a checksum, private files, kept 14 days by default.       | Built (deployment guide)       |
| A restore tool that refuses unsafe restores, and a restore check that compares a restored copy with the live database. | Built                          |
| The restore check runs on every code change in CI; on the server the guide says monthly.                               | Built                          |
| An off-site copy of every backup.                                                                                      | Planned (owner to choose)      |
| An alert when the last good backup is older than a day.                                                                | Built (deployment guide, cron) |

## Annex B: Sub-processors

| Sub-processor                                  | What it does                                     | Data it handles                                                     | Where                  | Status                             |
| ---------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------- | ---------------------- | ---------------------------------- |
| [Hosting provider]                             | Runs the servers, disks and network              | All Institute Data (stored on its machines)                         | [country/region]       | To decide                          |
| [SMS provider, a BTRC-licensed A2P aggregator] | Delivers SMS to mobile networks                  | Mobile numbers and message texts                                    | Bangladesh [to verify] | To decide; required before go-live |
| [Off-site backup storage]                      | Keeps copies of backups                          | All Institute Data (inside backup files)                            | [country/region]       | To decide                          |
| Cloudflare (Turnstile)                         | "Not a robot" check on the public admission form | The visitor's browser signals and internet address; no form content | [to verify]            | After PR #24 is merged             |
| SSLCommerz                                     | Online fee payments                              | Payment details; the payer's name and contact [to verify]           | Bangladesh             | Planned (not live)                 |
| Let's Encrypt                                  | Issues HTTPS certificates                        | Only the service's domain names; no personal data                   | —                      | Not a sub-processor [to verify]    |

Jantrik does not use any analytics, advertising, email-marketing or error-tracking service
today.

## Annex C: How long data is kept (what the software does today)

| Data                                                    | Kept                                                                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Students, guardians, staff                              | During the agreement. "Deactivate" hides a record; nothing is deleted.                                                                      |
| Attendance registers and records, staff attendance days | Not deleted.                                                                                                                                |
| Raw device punches                                      | The Institute's setting, 730 days by default (30 to 3650); the database never lets the app delete the last 30 days.                         |
| Device commands (names and ID numbers sent to devices)  | Failed, cancelled or replaced ones: deleted 90 days after their last activity. The latest per person and device: kept.                      |
| Fee dues, payments, receipts, voids                     | Not deleted.                                                                                                                                |
| Exam marks, results, remarks and their history          | Not deleted.                                                                                                                                |
| Student import files                                    | Uploaded rows cleared when the import ends, or after 7 days unfinished (a daily job). Per-row results (row number, name, the problem) kept. |
| SMS log (number, text, status, cost)                    | Not deleted.                                                                                                                                |
| Audit log                                               | Not deleted.                                                                                                                                |
| Sign-in codes                                           | Hashed, 5 minutes, deleted on use.                                                                                                          |
| Sessions (browser description, IP address, times)       | Expire after 30 days unused. [to verify: deletion of old rows]                                                                              |
| Photos, logo, signature, seal                           | Until replaced or removed (then deleted in the same step).                                                                                  |
| Admission applications (after PRs #23 and #24)          | Not deleted. **Planned:** rejected applications' personal data cleared 12 months after the cycle closes (decision S30; not built).          |
| Notices and SMS broadcasts (after PRs #25 and #26)      | Not deleted; withdrawn notices kept for the record.                                                                                         |
| Backups                                                 | 14 days on the server by default; off-site [to decide].                                                                                     |

[to verify with the lawyer: which of these "not deleted" periods must get an end date under the
data protection law, and which records institutes must keep by law.]

## Annex D: Description of the processing

- **People:** students (mostly children), applicants for admission, guardians, the Institute's
  staff.
- **Data:** as listed in the Privacy Policy, section 3. Includes birth registration numbers,
  religion and blood group (possibly "sensitive" data [to verify]), photos, attendance, fees and
  exam results. No biometric data.
- **Purpose:** running the Institute's administration through the service, as set out in the
  Terms of Service.
- **What is done with it:** storing, organising, showing to authorised users, printing, sending
  SMS, backing up, and deleting at the end.
- **Duration:** the agreement, then the export and deletion periods in section 13.

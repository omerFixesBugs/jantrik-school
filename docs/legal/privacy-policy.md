# Jantrik School: Privacy Policy (DRAFT)

> **DRAFT FOR LAWYER REVIEW — NOT LEGAL ADVICE. Not for publication or signature until reviewed
> by a lawyer qualified in Bangladesh.**
>
> Written on 2026-11-18 from the product's code and docs, by an assistant, while the owner was
> away. It describes only what the software does today, and says so where something is planned
> or depends on an open pull request (PR). Square brackets mark undecided facts and unchecked
> law (`[to verify]`). Open questions: [README.md](README.md). A Bangla version is needed before
> use; most readers will be guardians.

**Version:** [version] · **Effective from:** [date]

---

## 1. In short

- Jantrik School is software that schools, madrasas and coaching centres ("**institutes**") use
  to run their office: students, guardians, attendance, fees, exams and messages.
- **Your institute decides** what information about students, guardians and staff goes into
  Jantrik School and what it is used for. **[Company legal name]** ("**Jantrik**", "**we**")
  runs the software and handles that information **on the institute's behalf**, under a written
  agreement with it.
- Most of this information is about **children**. We do not sell it, do not show advertising,
  do not build profiles of children, and do not send them or their guardians marketing.
- For questions about a child's record, or to correct it, **contact the institute first**. We
  help the institute answer.

## 2. Who is responsible for what

| Information                                                                                              | Who decides how it is used ("data fiduciary") | Jantrik's role                                    |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------- |
| Students, guardians and staff, and everything the institute records about them ("Institute Data")      | The institute                                 | Processes it on the institute's instructions      |
| The institute's account: its name, owner contacts, plan, invoices and payments to Jantrik               | Jantrik                                       | Decides                                           |
| Sign-in security records (codes sent, sessions, failed attempts) and Jantrik's own staff accounts      | Jantrik                                       | Decides                                           |

The words "data fiduciary" and "data processor" come from Bangladesh's personal data protection
law. [to verify: the final terms used in the Personal Data Protection Act, 2026, and that this
split of roles matches it.]

## 3. What information the software holds

Only what the institute enters, or what the software creates from it. Not every institute uses
every part.

**About students:**

- name (Bangla and English), date of birth, gender, religion, blood group, birth registration
  number, father's and mother's names, present and permanent address, a photo;
- student ID, academic year, class, section, group, roll, subjects and elective choices,
  status (for example active or deactivated);
- attendance: each day's present, absent, late or leave, and who marked it;
- if the institute uses attendance devices: the person's device ID number and the time and
  direction (in or out) of each punch. **Fingerprints, face data and photos from the device are
  never received or stored by Jantrik**; they stay on the device;
- fees: dues, concessions and scholarships (with reasons), payments, receipts, bKash/Nagad
  transaction IDs and the sender's number;
- exams: marks, results, positions, remarks, seat plans;
- after PRs #23, #24 and #27 are released: **admission applications** (the child's and
  guardian's details typed into the online form, a photo if the institute asks for one, and
  admission test rolls and scores).

**About guardians:** name, mobile number, relation to the student, occupation, and which
children they are linked to.

**About staff:** name, mobile number, email (optional), roles, sections and subjects they teach,
staff attendance (from devices or entered by the office), and who collected which payment.

**About anyone who signs in:**

- mobile number (and for staff, a password, stored only as a one-way hash);
- sign-in sessions: the type of client, the browser's description (user agent), the internet
  (IP) address, and when the session was created and last used;
- a record that a sign-in code was sent to a number (never the code);
- display preferences (language; light or dark).

**About the institute itself:** its names, address, contacts, EIIN, head's name and title, logo,
the head's signature image and the seal image.

**Messages:** a log of every SMS the institute sends: the mobile number, the full text, the
purpose (for example "absent"), when it was sent, its status and its cost.

**History:** an audit log records who created, changed or deleted important records (for
example marks, fees, payments, attendance, staff roles), with the old and new values.

We do not collect any information from children directly. Children do not have accounts today.

## 4. What it is used for

Institute Data is used only to provide the service to the institute, for example to:

- show staff the records their role allows (a teacher sees full details only of the students in
  their own sections; an accountant sees guardian numbers partly hidden);
- show guardians their own children's attendance, fees and published results;
- send the SMS the institute has switched on or chosen to send: absent alerts, fee receipts and
  reminders, exam results, and later admission and broadcast messages;
- print registers, receipts, report cards and other documents;
- keep the service secure and find faults.

Jantrik uses its own information (section 2) to run accounts, bill institutes, count SMS costs,
keep sign-in secure and give support.

Jantrik's own staff tools show institutes' **counts** (for example the number of active students
and SMS sent), never students' or guardians' names, numbers or records. This is enforced by the
database's permissions, not only by the screens.

There is **no advertising and no analytics or tracking service** in the software today. [to
verify before any is added: this section must change first.]

## 5. The legal basis

[to verify with the lawyer under the Personal Data Protection Act, 2026:]

- For Institute Data: the institute's basis (for example its education duties, the contract with
  parents, and the consent of a parent or guardian for a child's data). The institute is
  responsible for obtaining any consent the law requires.
- For Jantrik's own information: the contract with the institute, keeping the service secure,
  and legal duties (for example tax records).

## 6. Who can see it

- **The institute's staff**, according to their roles (owner, admin, teacher, accountant).
- **Guardians**, for their own children only. Anyone using the same mobile number shares one
  sign-in and sees every child linked to that number.
- **Service providers** that Jantrik uses to run the service ("sub-processors"), only as needed
  for their job. The current list is in the School Data Custody Agreement, Annex B. In short:
  the hosting provider [to decide], the SMS provider [to decide] and the off-site backup storage
  [to decide]; later Cloudflare (for the "not a robot" check on the public admission form, after
  PR #24) and SSLCommerz (for online payments, not live yet).
- **Authorities**, only when Bangladeshi law requires it, for example a lawful order under the
  cyber security or data protection laws [to verify which laws give which authorities the power
  to demand data, and how Jantrik should respond and inform the institute].
- **Nobody else.** Jantrik does not sell or rent personal data.

Each institute's data is kept separate from every other institute's (section 9).

## 7. Where it is stored

The service runs on servers at [hosting provider, country/region: to decide]. Photos, logos,
signature and seal images are stored in the same database.

[to verify: whether the Personal Data Protection Act, 2026 (and the February 2026 amendment of
the earlier ordinance) requires a copy of some of this data to be kept inside Bangladesh, which
data counts as "restricted" or "sensitive" (children's data, birth registration numbers), and
what is needed for storage outside Bangladesh. The deployment guide currently suggests a region
near Bangladesh such as Singapore or Mumbai.]

## 8. How long it is kept

What the software does **today**:

| Information                                                                  | How long                                                                                                                                                             |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Student, guardian and staff records                                          | While the institute uses the service. A student or staff member who is "deactivated" is hidden from lists but **not deleted**.                                        |
| Attendance, staff attendance, fee payments and receipts, exam marks         | Not deleted automatically.                                                                                                                                           |
| Raw attendance-device punches                                               | The institute's setting: 730 days by default (between 30 and 3650). Attendance made from them is kept.                                                               |
| Commands sent to attendance devices (they carry names and ID numbers)       | Failed, cancelled and replaced commands are deleted 90 days after their last activity; the latest one per person and device is kept.                                |
| Student import files (with phone and birth registration numbers)           | The uploaded rows are cleared when the import finishes or fails, or after 7 days if unfinished. A per-row result (row number, name, the problem) is kept.            |
| SMS log (number, text, status, cost)                                         | Not deleted automatically.                                                                                                                                           |
| Audit log (who changed what, old and new values)                            | Not deleted automatically.                                                                                                                                           |
| Sign-in codes                                                                | Stored only in scrambled (hashed) form, for 5 minutes; deleted once used.                                                                                            |
| Sign-in sessions                                                             | A session expires after 30 days without use. [to verify: when old session records are deleted.]                                                                     |
| Attendance and marks drafts on a teacher's phone                             | Kept in that phone's browser until sent (attendance drafts: at most 7 days). They hold names, rolls and IDs, never phone numbers or photos.                           |
| Photos, logo, signature, seal                                               | Until replaced or removed; then deleted from the database (copies remain in backups until those expire).                                                             |
| Admission applications (after PRs #23 and #24)                              | Not deleted. **Planned:** the personal data of rejected applications cleared 12 months after the admission cycle closes (decided, not built yet).                    |
| Backups                                                                      | Nightly, kept 14 days on the server by default; off-site copies [to decide].                                                                                         |
| When an institute leaves                                                     | [Export window, then deletion: see the Custody Agreement. Not built yet.]                                                                                            |

[to verify: whether keeping SMS logs, audit logs and attendance with no end date is allowed under
the Personal Data Protection Act, 2026's rule that data is not kept longer than needed; and what
records schools must keep by law. Jantrik may need to add deletion periods.]

## 9. How it is protected

Measures the software has today (the full list, with what is planned: Custody Agreement,
Annex A):

- every institute's records are tagged with the institute and the database itself refuses to
  show one institute's rows to another (row-level security), as a second lock behind the
  application's own checks;
- every screen and request checks the person's role and the institute's modules;
- passwords are stored only as strong one-way hashes (argon2id); sign-in codes are hashed,
  expire in 5 minutes and work once; repeated attempts are limited;
- the web app and API are reached only over encrypted connections (HTTPS);
- an audit log of important changes;
- uploaded images are re-made by the server, which removes hidden details such as the location
  a photo was taken;
- nightly backups, with a regular test that they can be restored.

No system is perfectly secure. Attendance devices talk to the service over plain, unencrypted
internet connections because that is all the devices support; only an ID number and a time are
sent.

## 10. Your rights

Under Bangladesh's personal data protection law you may have rights to know what data is held
about you or your child, to get a copy, to have it corrected, to withdraw consent, and to have it
deleted in some cases. [to verify: the exact list, how requests must be made, time limits, and
exceptions, under the Personal Data Protection Act, 2026 and any rules made under it.]

**How to use them:** ask the institute. If you contact Jantrik, we will pass your request to the
institute and help it answer, unless the law says we must answer directly. For information
Jantrik decides about (section 2), contact us directly.

Contact: [name or role, email, phone, postal address].

## 11. Cookies and browser storage

The web app uses only what it needs to work:

- a secure sign-in cookie that keeps you signed in (it cannot be read by the page's scripts);
- a small cookie that tells the app you are signed in (it holds no personal data);
- for Jantrik's own staff, a separate session cookie;
- the browser's local storage, for unsent attendance and marks drafts and display preferences.

No advertising or tracking cookies are used.

## 12. If something goes wrong

If a security breach puts Institute Data at risk, Jantrik will tell the affected institute
without undue delay and help it inform the authority and the people affected, as the law and
the Custody Agreement require. [to verify: whether the Personal Data Protection Act, 2026
requires notification to the authority or to individuals, and the time limits.]

## 13. Changes

We will post any change here with its date, and tell institute owners in the app at least [30]
days before an important change.

## 14. Contact and complaints

[Company legal name], [address], [email], [phone]. [Data protection contact or Chief Data
Officer, if the law requires one: to verify.]

You may also complain to the data protection authority [name of the authority under the Personal
Data Protection Act, 2026: to verify].

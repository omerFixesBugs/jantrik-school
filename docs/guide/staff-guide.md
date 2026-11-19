# Jantrik School: staff guide (DRAFT)

> **DRAFT for the owner's review. Not for institutes yet.**
>
> - Written in plain English from the code and the project docs on 2026-11-18, while the owner
>   was away. Nobody has yet walked through these steps on the running app to check them.
> - Institutes read Bangla first. **An owner-approved Bangla translation is needed** before this
>   guide goes to any institute.
> - It describes the app on the branch `integration/sprint-1`: `main` plus PRs #16 (password
>   login hardening), #17 (small follow-ups) and #18 (institute profile, photos). Section 15
>   describes features that are built in **open PRs, not merged yet**. Each says which PR.
> - Places where the writer was not sure are marked **To check**. They are collected in
>   section 16.

**Before the first institute goes live (owner).** The app sends every SMS through an SMS
gateway, and no gateway is connected yet (`docs/deploy.md` → What needs the owner). Until one
is, no SMS reaches anyone: not the sign-in codes, not the absent alerts, not the fee receipts.
Everything in this guide that mentions an SMS assumes the gateway is working.

---

## Contents

1. How to read this guide
2. Who can do what
3. Signing in
4. The dashboard
5. Institute setup
6. The institute profile: logo, signature and seal
7. Appearance
8. Staff and invitations
9. Students
10. Guardians
11. Attendance
12. Fees
13. Exams and results
14. SMS: the daily limit
15. Coming soon: features in open PRs
16. To check

---

## 1. How to read this guide

- **Bangla screen names** are in square brackets, as the app shows them, for example Dashboard
  [ড্যাশবোর্ড]. Buttons are in **bold**.
- **Your institute's own words.** Some words change with the institute type and can be changed
  by the owner or an admin (section 5.6). A school sees "Class" [শ্রেণি] and "Section" [শাখা];
  a coaching centre may see "Course" and "Batch". This guide uses the school words: class,
  section, academic year [শিক্ষাবর্ষ], student [শিক্ষার্থী], roll [রোল].
- **Modules.** Attendance, Fees and Exams are separate modules. Jantrik switches them on or off
  for each institute (it is part of the plan). If your institute does not have a module, its
  menu item is not shown. If you open such a page anyway you see "Not available" [দেখা যাচ্ছে
  না]: "This section is not enabled for your institute, or you don't have permission."
- **Digits.** You can type Bangla or English digits anywhere you type a number. Phone numbers,
  student IDs, rolls and receipt numbers are always shown in English digits so they can be
  copied into a phone.
- **Phone or computer.** Every screen works on a phone. Teachers mostly use a phone; the office
  mostly uses a computer.

## 2. Who can do what

Each person has one or more **roles** in an institute. One person can hold several roles, for
example a teacher who also collects fees.

| Role (Bangla)             | In short                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| Owner [প্রতিষ্ঠান প্রধান] | Everything an admin can do, plus: owners' roles, the institute's look, the bKash/Nagad numbers. |
| Admin [প্রশাসক]           | Runs the office: setup, students, staff, attendance settings, fee setup, exams.                 |
| Accountant [হিসাবরক্ষক]   | The fee counter: collect, receipts, bKash/Nagad checks, own daily closing, fee reports.         |
| Teacher [শিক্ষক]          | Attendance and marks for the sections and subjects they are given.                              |
| Staff [কর্মী]             | Today: the dashboard and their own password only. **To check** what this role is for.           |
| Guardian [অভিভাবক]        | Not staff. Sees their own children only (section 10.4).                                         |

| Area                                 | Owner | Admin                             | Accountant | Teacher                                  |
| ------------------------------------ | ----- | --------------------------------- | ---------- | ---------------------------------------- |
| Dashboard                            | yes   | yes                               | yes        | yes                                      |
| Institute setup, profile             | yes   | yes                               | no         | no                                       |
| Appearance (the institute's look)    | yes   | no                                | no         | no                                       |
| Staff list and invitations           | yes   | yes (not owners)                  | no         | no                                       |
| Student list                         | yes   | yes                               | no         | yes (full details only for own sections) |
| Admit, import, edit students, photos | yes   | yes                               | no         | no                                       |
| Take attendance                      | yes   | yes                               | no         | own sections, within the edit window     |
| Attendance settings, devices         | yes   | yes                               | no         | no                                       |
| Fee setup                            | yes   | yes (not the bKash/Nagad numbers) | no         | no                                       |
| Collect fees, receipts               | yes   | yes                               | yes        | only if also given "fee collection"      |
| Void a receipt, waive a fine         | yes   | yes                               | no         | no                                       |
| Fee reminders (SMS)                  | yes   | yes                               | no         | no                                       |
| Exam setup, lock, publish, print     | yes   | yes                               | no         | no                                       |
| Enter marks                          | yes   | yes                               | no         | own subject and section                  |

If a button or page you need is missing, your role does not include it. **Ask your
institute's admin.** Admins: if something is missing for you, ask your institute's owner, or
Jantrik if a whole module is missing.

## 3. Signing in

There is no sign-up page. You can sign in only after your institute (or Jantrik, for the first
owner) has added your mobile number.

### 3.1 The first time: with a code

1. Open the app's address in a browser (phone or computer).
2. Choose **OTP code** [ওটিপি কোড].
3. Type your mobile number [মোবাইল নম্বর], for example 01712345678, and tap **Send code**
   [কোড পাঠান].
4. An SMS brings a 6-digit code. Type it in **Verification code** [যাচাই কোড] and tap **Sign
   in** [লগইন]. The code works for 5 minutes and only once.
5. If your institute has invited you, you now see the invitation: "<Institute> added you as
   <role>" with **Accept** [গ্রহণ করুন] and **Decline** [প্রত্যাখ্যান]. You get access only
   after you accept. An invitation can be accepted for 14 days.

### 3.2 Set a password (staff)

A password lets you sign in without waiting for an SMS each time. Only staff can have one;
guardians always sign in with a code.

1. Sign in with a code (3.1).
2. Open your menu (your name, top corner) and choose **Password** [পাসওয়ার্ড].
3. Tap **Send code** [কোড পাঠান]. A code comes to your own phone. It works for 5 minutes.
4. Type the code, your new password, and the password again. Tap **Set password**
   [পাসওয়ার্ড সেট করুন].

Password rules [পাসওয়ার্ডের নিয়ম]:

- 10 to 128 characters. Bangla, English, digits and symbols all count.
- Not your mobile number, in any form.
- Not the institute's name or a distinctive word from it. General words like "school",
  "বিদ্যালয়" or "coaching" are fine.
- Not a very common password.

Setting a password **signs you out on every other device**. This browser stays signed in.

### 3.3 Sign in with a password

1. Choose **Password** [পাসওয়ার্ড].
2. Type your mobile number or email, and your password. Tap **Sign in** [লগইন].

### 3.4 Forgot your password

There is no "reset by the admin" yet. Do this yourself:

1. Sign in with a code (3.1).
2. Set a new password (3.2).

If you no longer have the phone with your number, **ask your institute's admin**. **To check:**
what an admin can do then (they cannot change your number or password today).

### 3.5 More than one institute

- If you work in more than one institute (or are also a guardian somewhere), you see **Choose
  an institute** [প্রতিষ্ঠান নির্বাচন করুন] after signing in. Tap the one you want.
- To move to another one later: your menu → **Switch institute** [প্রতিষ্ঠান পরিবর্তন].
- If you switch in one browser tab, your other tabs show "Institute changed" and reload. This
  is on purpose: a page never mixes two institutes' data.

### 3.6 Signing out

Your menu → **Log out** [লগআউট]. Every tab of that browser signs out. Sign out on shared
office computers.

### 3.7 Messages you may see

| Message                                                                                       | What it means and what to do                                                                                                                 |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| "The phone number, code or password is not correct." [ফোন নম্বর, কোড বা পাসওয়ার্ড সঠিক নয়।] | Wrong code or password, an expired code, or a number the institute has not added. For safety the app never says which. Check and try again.  |
| "Too many attempts. Try again in N seconds."                                                  | You (or someone) tried too often. Wait. A phone gets at most one code a minute and 10 codes a day; 5 wrong passwords lock it for 15 minutes. |
| "No password yet? Sign in with a code, then set one from your menu."                          | You have no password. Use a code (3.1), then 3.2.                                                                                            |
| "You don't have access to any active institute."                                              | Your invitation is not accepted, has expired, or your access was turned off. Ask your institute's admin.                                     |
| "Temporarily unavailable" [সাময়িকভাবে বন্ধ] next to an institute                             | Jantrik has paused that institute's account. The owner should contact Jantrik.                                                               |
| "Can't reach the server" [সার্ভারের সাথে সংযোগ হচ্ছে না]                                      | Weak internet. You are not signed out. The app keeps trying by itself; attendance and marks kept on the phone are sent later.                |
| "The code is wrong or has expired." (password page)                                           | Send a new code. A refused password does not use the code up, so fix the password first.                                                     |

## 4. The dashboard

Dashboard [ড্যাশবোর্ড] is the first page after signing in. What it shows depends on your roles
and your institute's modules. Some cards:

- **Today's figures** [আজকের হিসাব]: total students, present today, registers taken, SMS sent
  today against the daily limit.
- **Needs attention** [নজর দিন]: students absent several days running (call their guardians),
  registers not taken yet, SMS held back by the daily limit.
- **Absent today** [আজ অনুপস্থিত], with a call button per guardian.
- **Fees** [ফি আদায়]: collected this month against the same days last month, overdue amounts,
  bKash/Nagad payments waiting to be checked.
- **Exams**: mark sheets submitted and locked; for a teacher, "N of yours to finish".
- **Quick actions** [দ্রুত কাজ]: admit a student, take attendance, collect a fee.
- **Getting started** [শুরু করার ধাপ] (owner, admin): the setup steps still open, with
  **Continue setup** [সেটআপ চালিয়ে যান] for an institute Jantrik created with the setup
  wizard.
- **"N attendance lists not sent yet"**: registers kept on this phone. Open them; they send by
  themselves when the internet is back (11.2).
- **"N SMS held back today"** (owner, admin): see 14.
- **Jantrik's invoice** (owner only): an unpaid Jantrik invoice past its due date. Contact
  Jantrik to pay. It disappears once Jantrik records the payment.

## 5. Institute setup

Who: owner and admin. Menu: **Institute setup** [প্রতিষ্ঠান সেটআপ]. The tabs are: academic
year, classes and sections, shifts, subjects, groups, names and words, student ID, institute
profile, and (owner only) appearance.

Things that are in use cannot be deleted, only **deactivated** [নিষ্ক্রিয় করুন]. "In use, so
it can't be deleted; deactivate it" means exactly that.

### 5.1 The setup wizard (new institutes)

When Jantrik creates your institute, the owner is invited. After the owner accepts, a short
wizard opens: academic year, classes and sections, shifts, inviting teachers, importing
students, attendance. Each step can be skipped [এই ধাপ বাদ দিন] and done later; **Continue
later** [পরে করব] goes to the dashboard, which keeps a **Continue setup** button until the
wizard is finished.

### 5.2 Academic year [শিক্ষাবর্ষ]

One academic year is always **current** [চলতি]. Attendance, admissions and lists use the
current one.

1. Check the year Jantrik made for you: name, start and end date. **Edit** [সম্পাদনা] if needed.
2. For the next year: **Open the next year** [পরের শিক্ষাবর্ষ খুলুন]. You can copy every
   section of the current year into it. Only the structure is copied, not the students.
3. **Make current** [চলতি করুন] switches the whole institute to that year. Do this only when
   the new year really starts. (After PR #22 there is a guided way to do this: 15.4.)

### 5.3 Classes and sections [শ্রেণি ও শাখা]

- The list of classes comes from your institute type. You can add, rename, reorder (**Order**
  [ক্রম]: smaller numbers come first) or deactivate classes.
- Each section belongs to one class **and one academic year**. Add a section with **New
  section in <class>** [<class>-এ নতুন শাখা]: a name (for example ক, খ, A or "Morning
  batch"), optionally a shift and a number of seats [আসন সংখ্যা] (empty means no limit).
- "More students than that are already enrolled" means you set fewer seats than the students
  already in that section.

### 5.4 Shifts [শিফট]

Optional. Add morning and day shifts with their start and end times if you have them, and give
each section one. Device attendance (11.8) uses the shift's start time.

### 5.5 Subjects [বিষয়] and groups [বিভাগ]

- Subjects belong to a class. Each has a name in Bangla and English and a short code (English
  letters, for example MATH).
- Tick **Optional subject (4th subject)** [ঐচ্ছিক বিষয় (৪র্থ বিষয়)] for subjects students
  may choose.
- Groups are Science, Business Studies, Humanities and so on. A subject can belong to one group
  or to all.

### 5.6 Names and words [নাম ও শব্দ]

The words your institute uses (for example Batch instead of Section), in Bangla and English.
Write both. **Preview** [যেমন দেখাবে] shows them before you save; the app then uses them
everywhere.

### 5.7 Student ID [শিক্ষার্থী আইডি]

How IDs are made for **new** admissions. Existing IDs never change.

- **Prefix** [শুরুর অংশ]: 1 to 10 English letters or digits, for example SHS.
- **Pattern** [গঠন]: keep exactly one `{NNNN}` (the running number); you may add `{PREFIX}`,
  `{YEAR}` or `{YY}`, letters, digits, `-`, `/` and `_`. The page shows the next ID.

### 5.8 Messages

| Message                                                                         | What to do                                        |
| ------------------------------------------------------------------------------- | ------------------------------------------------- |
| "This name or code already exists."                                             | Use another name or code.                         |
| "It is deactivated; activate it first."                                         | **Activate again** [আবার চালু করুন], then use it. |
| "It is linked to something else, or what you picked no longer exists."          | Someone changed it meanwhile. Reload the page.    |
| "There is no current academic year. Make one current in institute setup first." | 5.2.                                              |

## 6. The institute profile: logo, signature and seal

Who: owner and admin. Setup → **Institute profile** [প্রতিষ্ঠানের প্রোফাইল].

1. **Names** [নাম]: the name in Bangla and English, a short name, the EIIN (6 digits, if you
   have one), the year established.
2. **Address and contact** [ঠিকানা ও যোগাযোগ]: address in Bangla and English, phone, email,
   website.
3. **Head of institute** [প্রতিষ্ঠান প্রধান]: title (for example প্রধান শিক্ষক) and name in
   both languages.
4. **Save** [সংরক্ষণ করুন].
5. **Logo, signature and seal** [লোগো, স্বাক্ষর ও সিল]: **Upload** [আপলোড], **Replace**
   [বদলান] or **Remove** [সরান] each image.
   - Logo: a PNG with a transparent background looks best.
   - Head's signature: sign in black ink on white paper and take a photo.
   - Seal: stamp it on white paper and take a photo.

Images: JPEG, PNG or WebP, at most 5 MB each. The app shrinks them and removes hidden details
(such as the place a photo was taken). The page shows how much image space the institute has
used. Everyone in the institute (guardians too) can see the logo; only the owner and admins
can see the signature and seal.

The profile is meant for admission forms, ID cards and certificates. **To check:** which
printouts already use the logo, signature and seal today (the admission test admit cards in
PR #27 use the logo).

Image messages:

| Message                                                            | What to do                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------- |
| "This file is not a JPEG, PNG or WebP image, or it is damaged."    | Use another image (other formats, such as HEIC, are refused). |
| "The file is larger than 5 MB."                                    | Choose a smaller one.                                         |
| "The image has too many pixels (at most 50 megapixels)."           | Choose a smaller one.                                         |
| "This image could not be made small enough."                       | Choose another image.                                         |
| "Many images are being prepared right now. Try again in a moment." | Wait a moment and try again.                                  |
| "The institute's storage for images is full."                      | Remove old images, or contact Jantrik.                        |

## 7. Appearance

**The institute's look** (owner only): Setup → **Appearance** [চেহারা].

1. Pick one of four looks: School [স্কুল], Madrasa [মাদ্রাসা], Coaching [কোচিং], English
   medium [ইংলিশ মিডিয়াম]. Your type's default is marked.
2. Optionally pick an **Accent colour** [মূল রং] for buttons, links and charts. If text would
   be hard to read, the app adjusts the colour or refuses it and says so.
3. **Save** [সংরক্ষণ করুন]. **Back to the default for your type** undoes it.

**Your own view** (everyone): your menu →

- **Appearance** [রং]: Light [আলো], Dark [অন্ধকার] or Same as the device [ডিভাইসের মতো]. It is
  kept on your account.
- **Layout** [বিন্যাস]: Compact (desktop) [ঘন] or Comfortable (larger) [আরামদায়ক].

## 8. Staff and invitations

Who: owner and admin. Menu: **Staff** [কর্মী ও শিক্ষক].

### 8.1 Add a person

1. **Add staff** [নতুন কর্মী যোগ করুন].
2. Type their mobile number, their name in English (and in Bangla if you like), and tick one or
   more roles.
3. **Add** [যোগ করুন].

**No SMS is sent.** Tell the person yourself: "Sign in with an OTP code on this number and
accept the invitation within 14 days." Until they accept, the list shows "Invited, waiting for
an answer" [আমন্ত্রিত, উত্তরের অপেক্ষায়].

- **Cancel invitation** [আমন্ত্রণ বাতিল করুন]: for example if you typed a wrong number.
- **Invite again** [আবার আমন্ত্রণ পাঠান]: after it expired or was declined.

### 8.2 Change what a person does

From the menu beside their name:

- **Change roles** [দায়িত্ব বদলান].
- **Assign sections** [শাখা দিন]: the current year's sections they teach and take attendance
  for. (Also possible from Attendance → Settings → Teachers per section, 11.7.)
- **Give fee collection** [ফি আদায়ের দায়িত্ব দিন] / **Remove fee collection**: lets a teacher
  collect fees too, without other office rights. Receipts they gave stay as they are.
- **Deactivate** [নিষ্ক্রিয় করুন]: they lose access to this institute at once. Nothing is
  deleted; **Activate again** brings back their old roles.

### 8.3 Rules about owners

- Only an owner can add an owner, or change an owner's roles or status.
- The institute must always keep at least one active owner.
- Nobody can change their own roles or status.

### 8.4 Messages

| Message                                                             | What to do                                            |
| ------------------------------------------------------------------- | ----------------------------------------------------- |
| "The person with this number is already on the staff list."         | Find them in the list and change their roles instead. |
| "Only an owner can make changes involving owners."                  | Ask the owner.                                        |
| "The institute must keep at least one active owner."                | Make someone else owner first.                        |
| "You cannot change your own roles or status."                       | Ask another admin or the owner.                       |
| "Only active teachers or admins can be given sections."             | Give them the teacher role first.                     |
| "Many staff were added in the last hour. Try again a little later." | A safety limit (30 an hour). Wait and continue.       |

## 9. Students

Menu: **Student list** [শিক্ষার্থী তালিকা]. Owner, admin and teachers see the list; only the
owner and admins can add or change students.

### 9.1 Find a student

Search by name, ID or phone number [নাম, আইডি বা ফোন নম্বর দিয়ে খুঁজুন], and filter by class,
section and status. Open a student to see their page.

**What a teacher sees:** every student's name, ID, class, section, roll and status. The full
record (date of birth, birth registration number, addresses, parents and guardians with their
phones, the photo) only for students of the sections they are assigned to this year.

### 9.2 Admit one student

1. **Admit a student** [নতুন শিক্ষার্থী ভর্তি].
2. **Student details** [শিক্ষার্থীর তথ্য]: at least one name (Bangla or English); date of
   birth, gender, religion, blood group, birth registration number (17 digits), parents' names
   and addresses as you have them.
3. **Class** [ভর্তির শ্রেণি]: the academic year, class, section and group. **Roll** may be left
   empty and given later.
4. **Student ID**: leave empty to make one from the pattern (5.7).
5. **Guardians** [অভিভাবক]: name, mobile number and relation. Add more with **Another
   guardian** [আরেকজন অভিভাবক]. Mark one as **Primary guardian** [প্রধান অভিভাবক]: they get the
   attendance SMS.
6. **Board registration** [বোর্ড নিবন্ধনের তথ্য] can be filled in later.
7. **Admit** [ভর্তি করুন]. The app shows the new ID.

If a guardian's number is already in the institute (a brother or sister studies here), the app
asks **who this is**: pick the existing guardian, or **Add as a new guardian**. Everyone on one
number shares one login: whoever holds that phone sees all those children in the app.

No SMS is sent on admission.

### 9.3 Import many students from Excel or CSV

Who: owner and admin. Student list → **Import from Excel** [এক্সেল থেকে আনুন].

1. **Download a template** [টেমপ্লেট নামান] (Excel or CSV), or use your own sheet.
   - One student per row. Name, class and guardian phone are required.
   - At most 5 MB and 5000 rows per file.
   - Students are enrolled in the **current** academic year.
2. **Upload and check** [আপলোড ও যাচাই]. Nothing is saved yet.
3. **Match the columns** [কলাম মেলান]: the app matches them by itself; fix any wrong ones and
   **Check again** [আবার যাচাই করুন].
4. Look at the rows: OK, Errors, Already here, Possible duplicates. Each error says what is
   wrong in that row. Fix them in your file and upload again, or leave them out.
   - **Possible duplicate**: same name, class and guardian phone as a student already here or
     another row. Such rows are skipped unless you switch on **Import anyway** for that row.
5. **Add N students** [N জন শিক্ষার্থী যোগ করুন], then confirm. Rows with errors and
   students already here are skipped.
6. Download the **Report** [রিপোর্ট] (Bangla or English) to see each row's result.

Uploading the same file again adds nobody twice (it matches on student ID or birth
registration number). An unfinished import older than a week loses its file data; upload it
again. Common row errors: "no such class (or deactivated)", "already taken in the section"
(roll), "not a valid mobile number", "must be 17 digits" (birth registration), "unreadable
date (e.g. 17/05/2014)", "no seats left in the section".

### 9.4 The student's page

Owner and admin can:

- **Edit** [সম্পাদনা]: change the details.
- **Photo** [ছবি]: **Add photo** / **Change photo** / **Remove photo**. JPEG, PNG or WebP up to
  5 MB. It is kept at passport size; the location and other hidden details are removed. The
  photo appears on the student's page and the report card. Lists show initials, not photos.
- **Change section** [শাখা বদল]: moves the student to another section of the **same class and
  year**. The roll must be free there. (This is what the app calls a transfer; a student who
  leaves the institute is a different thing, see below.)
- **Guardians**: section 10.
- **Deactivate** [নিষ্ক্রিয় করুন]: the student leaves the lists and attendance registers, and
  their roll can be given to someone else. Nothing is deleted; the page becomes read only.
  **To check:** there is no "activate again" for a student today.

A student who leaves the institute (transferred to another school, dropped out, graduated):
today the only way is **Deactivate**. After PR #21 there is a proper **Leaves the institute**
action that keeps their dues and history (15.4).

**Attendance report** [হাজিরার হিসাব] on the page opens the student's day-by-day attendance.

### 9.5 Messages

| Message                                                                     | What to do                                        |
| --------------------------------------------------------------------------- | ------------------------------------------------- |
| "This roll is already taken in the section"                                 | Give another roll, or leave it empty.             |
| "This section has no seats left"                                            | Choose another section, or raise the seats (5.3). |
| "Another student has this birth registration number"                        | Probably the same child. Search for them first.   |
| "This ID already exists"                                                    | Leave the ID empty to make a new one.             |
| "The institute has reached the student limit of its plan. Contact Jantrik." | The owner should contact Jantrik.                 |
| "Only an owner or admin can admit students."                                | Ask your institute's admin.                       |
| "Make someone else the primary guardian first."                             | 10.2.                                             |
| "A student needs at least one guardian."                                    | Add another guardian before removing this one.    |
| "This student is deactivated."                                              | Nothing can be changed on a deactivated student.  |

## 10. Guardians

Guardians are managed on each student's page (owner and admin). There is no separate guardian
list.

### 10.1 Add a guardian

Student page → **Add guardian** [অভিভাবক যোগ করুন]: name, mobile number, relation. If the
number is already known, pick the existing guardian or add a new one (9.2).

### 10.2 Primary guardian

The **primary** guardian [প্রধান] gets the attendance SMS, fee receipt SMS, reminders and
result SMS. To change it: **Make primary** [প্রধান করুন] on another guardian. You cannot
remove the primary guardian until someone else is primary.

### 10.3 Remove a guardian

**Remove** [বাদ দিন] unlinks them from this student. A student must keep at least one guardian.

### 10.4 What guardians see

Guardians sign in with an SMS code on the number the institute has on file. They never get a
password. They see only their own children:

- each child's card with their class, roll and ID (the photo is on the report card);
- the attendance calendar for the month;
- fees: dues, receipts, and **I paid by bKash/Nagad** to report a transfer (12.6);
- exam results, only after they are published (13.6).

If a guardian says "No students are linked to your mobile number", their number is not on any
child's record, or is typed differently. Check the student's page.

## 11. Attendance

Menu: **Attendance** [হাজিরা]. Tabs: Take attendance [হাজিরা নিন], Today [আজকের হিসাব],
Monthly register [মাসিক রেজিস্টার], Settings [সেটিংস], and for the owner and admins Devices
[ডিভাইস] and Staff [কর্মীদের হাজিরা].

### 11.1 Take attendance (teachers)

1. Attendance → **Take attendance**. You see the sections you were given. If you see "You
   haven't been given any section", **ask your institute's admin** to assign you (8.2).
2. Tap a section.
3. Everyone starts as **Present** [উপস্থিত]. Tap a name to change it: Present → Absent
   [অনুপস্থিত] → Late [দেরি] → Leave [ছুটি] → Present. **All present** [সবাই উপস্থিত] resets
   everyone.
4. **Submit attendance** [হাজিরা জমা দিন]. If more than half are absent, the app asks you to
   confirm.
5. The screen says "Submitted at 10:42" [জমা হয়েছে]. To correct it later the same day,
   change the names and **Submit changes** [পরিবর্তন জমা দিন].

If attendance is taken every period (a setting), choose the **Period** [পিরিয়ড] first.

### 11.2 No internet? Your work is kept on the phone

- Every tap is saved on the phone at once. The screen always says where your work is: "Kept on
  this phone, not sent yet", "Sending…", "Couldn't send. Trying again in N s", or "Submitted
  at …".
- When the internet comes back the app sends it by itself. **Send now** [এখনই পাঠান] tries at
  once.
- Do not clear the browser's data or use a private window for attendance: that would lose the
  kept copy. Unsent copies older than 7 days are removed.
- The dashboard and the take screen list registers still on this phone.

### 11.3 "Someone changed this attendance"

If another person (or the attendance device) changed the same register while you were working,
you see "X changed this attendance at 10:30" with only the students that differ, and two
buttons: **Keep mine** [আমারটা রাখুন] or **Keep theirs** [ওনারটা রাখুন]. Talk to the other
person if you are not sure.

If the student list changed (a new admission, a section change), the app says so: new students
are marked present. Check and submit again.

### 11.4 Which days can be changed

- Never a future day.
- Teachers: today and the number of days back the institute allows (the edit window; 0 means
  today only). Older days: "It's too late to change this day. Ask the institute admin if it
  needs a fix." [এই দিনের হাজিরা বদলানোর সময় শেষ।]
- Owner and admin: any past day.
- Weekly days off and holidays: "No attendance today." An owner or admin can still **Take
  attendance anyway** [তবুও হাজিরা নিন].

### 11.5 Reports

- **Today** [আজকের হিসাব]: every section, taken or not, counts, and the absent students with
  how many days running and a call button.
- **Monthly register** [মাসিক রেজিস্টার]: students × days for a section and month, with
  totals. **Print** [প্রিন্ট] (A4 landscape) or **Download CSV** [CSV ডাউনলোড] (opens in
  Excel, Bangla included).
- **One student**: this month, the last 30 days or this year, day by day, with who marked each
  day (by hand or the device).

Present % = (present + late) ÷ (all days − leave days). If the institute counts leave as
absent, leave days stay in.

### 11.6 Absent SMS

Off by default, because SMS cost the institute money. When on:

- one SMS per absent student per day, to the **primary** guardian, only for today's register,
  and only for active students;
- it waits a few minutes first (the correction delay, 10 minutes by default). If the teacher
  corrects the mistake within that time, no SMS goes;
- it counts towards the daily SMS limit (14).

### 11.7 Attendance settings (owner, admin)

Attendance → **Settings** [হাজিরার সেটিংস]:

- **How often** [হাজিরা কতবার]: once a day, or every period.
- **Weekly days off** [সাপ্তাহিক ছুটি].
- **How many days back teachers can change attendance**.
- **Count leave as absent** [ছুটিকে অনুপস্থিত ধরুন].
- **Absent SMS** [অনুপস্থিতির SMS]: on or off; the text (with `{student}`, `{date}`,
  `{institute}` filled in for you, a preview, and how many SMS it costs: Bangla fits 70
  characters in one SMS); the wait before sending; **Most SMS per day** (automatic = twice the
  number of students, or your own number).
- **Holidays** [ছুটির দিন]: add each holiday with its dates.
- **Teachers per section** [শাখার শিক্ষক]: who takes attendance for each section; mark one as
  **Class teacher** [শ্রেণি শিক্ষক].
- Device, punch check, entry/exit SMS and staff office hours cards: 11.8.

### 11.8 Attendance devices (ZKTeco) and staff attendance

Built, but **not yet tried with a real device**: everything was tested with a simulated one.
Try it with your own device before relying on it.

Who: owner and admin. Attendance → **Devices** [ডিভাইস].

1. **Add device** [ডিভাইস যোগ করুন] with its serial number (the device's System Info →
   Device Info). The setup guide then shows, in Bangla, what to set on the device: the server
   address and port, HTTPS off, the time zone GMT+6.
2. When the device connects, the guide shows the internet address it called from. **Trust**
   only the address that is your institute's own internet connection. No changes are sent to
   the device until one address is trusted.
3. **People and device IDs** [মানুষ ও ডিভাইস আইডি]: everyone gets a number. **Assign default
   IDs** [ডিফল্ট আইডি দিন] gives students their ID's digits and staff a number from 9001 up.
   New IDs are sent to every active device by themselves.
4. On the device itself, enrol each person's finger, card or face under their ID. Jantrik
   never receives or stores fingerprints, faces or photos from the device: only the ID, the
   time and in/out.

What the device does for attendance:

- The take screen shows each student's punch-in time.
- With **Take attendance from the devices at the cutoff** on (once-a-day attendance only), the
  day's register is written at the cutoff (the shift's start + the cutoff minutes, 60 by
  default): punched in = present or late, no punch = absent. A teacher's own register before
  the cutoff always wins.
- The app holds it back, and says why on the Today page, when no device was connected in the
  last 15 minutes, when students are not on any device yet, or when more than half have no
  punch. Then take it by hand, or an owner/admin uses **Take from the device** [ডিভাইস থেকে
  নিন].
- **Entry and exit SMS** [প্রবেশ ও বের হওয়ার SMS]: optional; at most one of each per student per
  day; they stop at 90 % of the daily SMS limit so absent alerts still go.
- **Device alerts** [ডিভাইসের সতর্কতা]: offline, a new internet address, too many punches in a
  minute (held until you accept them), a clock that is fast or slow.
- Raw punches are kept for 730 days by default (a setting: 30 to 3650). Attendance made from
  them is kept.

**Staff attendance** [কর্মীদের হাজিরা] (owner, admin): each tracked staff member's in and out
from the device, late and early-leave minutes against the office hours (a setting, 08:00 to
16:00 by default), a month view to print or download, and manual entries (present, absent or
leave) with a reason.

**Before switching a device off and on again** after giving someone's ID to another person,
read `docs/devices.md` → Device IDs ("Known limit"): the old person's fingerprint could punch
as the new one. **To check** with the owner how to explain this to institutes.

### 11.9 Messages

| Message                                                        | What it means                                                        |
| -------------------------------------------------------------- | -------------------------------------------------------------------- |
| "Couldn't submit (CODE). The list is kept on this phone."      | It was not saved yet. It stays on the phone and is sent again later. |
| "The student list changed: N new (marked present), M removed." | Check the names and submit again.                                    |
| "Attendance can't be taken for a future day."                  | Choose today or a past day.                                          |
| "The system is busy right now. Try again in a moment."         | Wait a few seconds and try again. Nothing was changed.               |
| "This text is longer than 3 SMS. Make it shorter." (settings)  | Shorten the absent SMS text.                                         |
| "This serial number can't be added." (devices)                 | Check the number. If it is right, contact Jantrik.                   |

## 12. Fees

Menu: **Fees** [ফি] (owner, admin, accountant; a teacher only if given fee collection). Tabs:
Collect [আদায়], bKash/Nagad [বিকাশ/নগদ যাচাই], Daily closing [দিনের হিসাব], Reports
[রিপোর্ট], Reminders [রিমাইন্ডার], Setup [সেটআপ].

All amounts are in taka; the app never rounds a payment.

### 12.1 Fee setup (owner, admin)

Fees → **Setup**. Do these once, in this order:

1. **Start and general** [শুরু ও সাধারণ]:
   - **First month of dues** [বকেয়া শুরুর মাস]. No dues are made before it, so switching fees
     on in the middle of the year never charges past months. **No dues are created at all
     until this is set.**
   - Receipt SMS (on by default), a note printed on every receipt (for example office hours or
     "Fees paid are not refundable"), the sibling discount rule.
2. **Fee heads** [খাত]: tuition, admission, exam, session and so on, each monthly, per term,
   yearly or one-time, with its due day and an optional late fine (a fixed amount once, or an
   amount per day up to a limit). Heads are deactivated, never deleted.
3. **Amounts** [পরিমাণ]: how much each class pays for each head this year. A group's amount
   overrides the class amount. **Copy from another year** fills only what is missing.
4. **Terms** [সাময়িক]: for per-term heads, each term's opening and due dates.
5. **Concessions** [ছাড়]: per student and head: a fixed amount or a percentage, full or half
   free studentship, or a scholarship (needs a reason), from a date. End a concession with a
   reason; it is never deleted.
6. **Siblings** [ভাইবোন]: the app only **suggests** brothers and sisters (students sharing a
   guardian phone). The sibling discount applies only to families an owner or admin confirms.
   The student in the highest class pays in full. A student gets either the concession or the
   sibling discount, whichever is larger, never both.
7. **bKash/Nagad numbers** [বিকাশ/নগদ নম্বর]: the institute's own numbers that guardians send
   money to. **Only the owner** can change them.
8. **Fee collectors** [ফি আদায়কারী]: who can take money. Roles are changed on the Staff page
   (8.2).

Changes apply to new dues. A due already made keeps its amount. **Recalculate unpaid dues**
(owner, admin) rewrites dues nothing has been paid on.

### 12.2 Dues

A **due** is what one student owes for one head and one period (a month, a term, the year).
The app makes dues by itself when their period starts; opening a student at the counter always
brings their dues up to date. A student admitted in the middle of a period gets at least 7
days to pay.

### 12.3 Collect at the counter

Who: accountant, owner, admin, or a teacher given fee collection.

1. Fees → **Collect** [আদায়]. "Whose fees are you taking?" [কার ফি নেবেন?] Search by name, ID
   or the guardian's **whole** phone number.
2. Open the student. Their ledger shows what is owed, with fines up to today. Overdue fees are
   already ticked. Tick or untick what to collect. To take coming months in advance, choose
   them too.
3. **Collect** [আদায় করুন].
4. Type the **Amount** [টাকার অঙ্ক]. Less than the total is fine: the oldest fees are paid
   first, then the fines. You cannot take more than is owed.
5. Choose the **Method** [মাধ্যম]: Cash [নগদ], bKash [বিকাশ] or Nagad.
6. Check "Where the money goes" and **Confirm** [আদায় নিশ্চিত করুন].
7. The receipt opens. **Print receipt** [রসিদ প্রিন্ট] on A5 or an 80 mm thermal printer.

If the internet dropped while confirming, pressing **Confirm** again sends the **same**
payment: the money is never recorded twice.

The accountant sees guardian phones masked (`018•••••101`). The owner and admins see them in
full.

### 12.4 Receipts

- Numbered per institute and calendar year, with no gaps: `2026-000123`.
- Bangla, with the amount in words, the receipt number, ID and TrxID in English digits.
- After a payment the primary guardian gets a receipt SMS (if receipt SMS is on). This also
  catches money taken without giving a receipt.

### 12.5 Mistakes: void a receipt, cancel a due, waive a fine (owner, admin)

Payments are never edited or deleted.

- **Void a receipt** [রসিদ বাতিল করুন]: open the receipt → **Void** [বাতিল করুন], with a
  reason. The fees it paid are owed again and their fines run again. The receipt is marked
  VOID with the reason. Voiding does not give money back: **any refund happens outside the
  app**. A receipt can be voided once.
- **Cancel a due**: only a due with nothing paid on it, with a reason. It stays in the list,
  struck through, and is never charged again. If money was paid on it: "Void that receipt
  first."
- **Waive a fine** [জরিমানা মওকুফ]: the whole fine (no more fine is added to that fee) or part
  of it.

An accountant who made a mistake: **ask your institute's admin** to void the receipt, then
collect again.

### 12.6 bKash/Nagad payments to check

Guardians (from their app: **I paid by bKash/Nagad**) or staff report a transfer with the
amount, the TrxID and the sender's number.

1. Fees → **bKash/Nagad** [বিকাশ/নগদ যাচাই].
2. For each one, find the TrxID in **the institute's own bKash/Nagad app or statement**.
3. **Verify** it if the money really arrived: a receipt is made, dated the day the guardian
   reported it (so the fine stops there). Or **reject** it with a reason.

A TrxID can be used only once. Jantrik does not check with bKash or Nagad: **the person
verifying is responsible for matching the TrxID**. (Online payment through a gateway is not
built yet.)

### 12.7 Daily closing

Fees → **Daily closing** [দিনের হিসাব]: for a date, per collector and method: collected,
voided, net, and "Cash that should be in hand" [হাতে নগদ থাকার কথা]. A void is counted on
the day it was made, so a closed day never changes later. An accountant sees only their own.
**Print** it at the end of the day.

### 12.8 Reports

Fees → **Reports**: **Dues** [বকেয়া তালিকা] by class and section, **Defaulters** [খেলাপি]
(overdue for at least N days and a minimum amount), **Collections** [আদায়] by day, month, head,
method or collector. Each prints and downloads as CSV. The lists cover students still here; a
student who left keeps their old dues on their own ledger.

### 12.9 Reminders (owner, admin)

Fees → **Reminders** [বকেয়ার রিমাইন্ডার SMS]:

1. **See who would get one** [কতজন পাবেন দেখুন]: the students, those without a phone, those
   already reminded, the number of SMS, the cost and what today's SMS limit leaves.
2. **Send SMS to N guardians**. If the numbers changed since you looked, the app asks you to
   look again.

One reminder per student per overdue period. If they pay before it goes out, it is cancelled.

### 12.10 Messages

| Message                                                                               | What to do                                                                   |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| "These fees changed meanwhile (now X owed). Check the new figures and confirm again." | Someone else collected or changed something. Read the new total and confirm. |
| "The earlier attempt may already have been recorded. Check the payments."             | Look at the student's receipts before collecting again.                      |
| "Could not reach the server. Pressing again sends the same collection."               | Press again when the internet is back. It will not be recorded twice.        |
| "Money was paid on this fee, so it cannot be cancelled. Void that receipt first."     | 12.5.                                                                        |
| "Fee setup is for the owner and admins."                                              | Ask your institute's admin to change heads, amounts or concessions.          |
| "This student already has a concession on this fee for that time."                    | End the old concession first, then add the new one.                          |

## 13. Exams and results

Menu: **Exams & results** [পরীক্ষা ও ফলাফল]. In this release the office screens (setup,
locking, publishing, printing) are for the owner and admins; teachers enter marks.

### 13.1 Exam setup (owner, admin, once)

Exams → **Setup** [সেটআপ]:

- **Subject marks** [বিষয়ের নম্বর]: each subject's parts (for example CQ, MCQ, practical) with
  full and pass marks, and the pass rule (each part on its own, or parts of the same kind added
  together across papers). **Fill in NCTB defaults** [এনসিটিবি অনুযায়ী ভরুন] fills subjects
  that have no parts yet.
- **Subject teachers** [বিষয় শিক্ষক]: who enters marks for each subject in each section (up to
  five people). Being the class teacher is not enough to enter marks: the person must be given
  the subject. You can give every subject of a section to its class teacher in one step.
- **4th subject** [৪র্থ বিষয়]: which elective each student takes and which one is their 4th
  subject.
- **Rooms** [কক্ষ]: exam rooms (rows × columns) for the seat plan.
- **Grading** [গ্রেডিং]: the grading scheme (read only in this release).

### 13.2 Create and open an exam

1. Exams → **New exam** [নতুন পরীক্ষা]: type (half-yearly, annual, pre-test, test, class test,
   model test…), names, dates, and results by **GPA** (school exams) or **marks and
   percentage** (coaching model tests).
2. Add the classes, their subjects and the routine. Everything can change until the exam is
   opened.
3. **Open the exam** [চালু করুন]: each class's student list is taken now and teachers can
   start entering marks. Once marks exist, a subject's parts cannot change.
4. After new admissions or section changes: Students → **Sync with enrolments** [ভর্তির সাথে
   মেলান]. Students who left are withdrawn; their marks are kept but left out of results.

### 13.3 Enter marks (teachers)

1. Exams → **My mark sheets** [আমার নম্বরপত্র]: the subjects and sections you were given.
2. Open one. Type each student's marks. Enter moves down. Bangla digits are fine; at most two
   decimals. Type **a**, **ab** or **অ** for absent. Empty means not entered yet.
3. The app saves by itself a few seconds after you stop typing. Like attendance, marks are
   kept on the phone if the internet drops ("Kept on this phone"), and sent later.
4. When every student has marks or "absent", **Submit** [জমা দিন]. A sheet with empty cells
   cannot be submitted.
5. Until the office locks it you can fix marks and **Submit again**. If the office returns it
   [ফেরত পাঠান], you see their note under My mark sheets.

Absent in any part fails the subject.

### 13.4 Check and lock (owner, admin)

For each sheet: **Return** [ফেরত পাঠান] with a note (back to the teacher), **Lock** [লক করুন],
or **Lock N submitted** [জমা দেওয়া Nটি লক করুন] for a whole class. After locking only the
owner or an admin can change a mark, with **Correct** [সংশোধন] and a reason. **Unlock** needs
a reason and is refused while results are published. Every change is kept in the sheet's
history.

### 13.5 Remarks

The class teacher (or owner/admin) writes remarks for the report cards. **To check:** the
remarks page and printouts are shown to the owner and admins in this release; whether class
teachers can reach them from the web.

### 13.6 Publish

1. Exam → **Results** [ফলাফল]. The page lists what blocks publishing (sheets not locked,
   missing marks) and warnings (student list out of date, missing 4th-subject choices).
2. Before publishing, results shown are a "preview".
3. **Publish** [প্রকাশ করুন]. Guardians now see the results and report card in their app.
4. If marks or remarks change after publishing, the page says "changed since publish".
   Guardians see the old version until you **Publish again** [আবার প্রকাশ করুন].
5. **Unpublish** [প্রকাশ বাতিল] needs a reason; guardians stop seeing the results.
6. **Archive** [সংরক্ষণে রাখুন] freezes the exam. Published results stay visible. It can be
   reopened.

### 13.7 Printouts

Browser print or "Save as PDF":

- **Tabulation sheet** [টেবুলেশন শিট]: A4 landscape, also as CSV.
- **Report cards** [রিপোর্ট কার্ড]: one A4 page each, Bangla first, with the photo,
  attendance over the exam period and the grading key.
- **Admit cards** [প্রবেশপত্র]: two per A4 page.
- **Seat plan**: per room.

### 13.8 Result SMS (owner, admin)

Never automatic. After publishing: Results → send results by SMS:

1. The preview shows students, those without a phone, those already sent for this version,
   the SMS count, the cost and today's limit.
2. **Send N** [Nটি পাঠান]. Over today's limit, the rest are **skipped, not held**. Send them
   another day.

The text is fixed: GPA and letter (or marks and %) and the class place.

### 13.9 Messages

| Message                                                                    | What to do                                               |
| -------------------------------------------------------------------------- | -------------------------------------------------------- |
| "Some cells are empty. Enter marks or mark absent for everyone."           | Fill every cell, then submit.                            |
| "Someone else changed this mark sheet in the meantime."                    | Check the latest marks; choose keep mine or keep theirs. |
| "The results are published. Unpublish them first."                         | Correct with a reason instead, then publish again.       |
| "The results changed in the meantime. Check the latest and publish again." | Another person published or changed something.           |
| "This cannot be done while the mark sheet is in its current state."        | For example a locked sheet: use Correct.                 |

## 14. SMS: the daily limit

All of an institute's SMS share **one daily limit**: absent SMS, receipts, reminders, result
SMS (and, after the PRs in section 15, admission and broadcast SMS). Sign-in and password codes
are paid by Jantrik and do not count.

- The limit is set in Attendance → Settings → **Most SMS per day**: automatic (twice the
  number of active students) or your own number. Jantrik may set a lower ceiling for your plan;
  the settings page says so.
- **Absent SMS over the limit are held** [আটকে আছে]. The dashboard shows "N SMS held back
  today" with **Send held SMS** [আটকে থাকা SMS পাঠান]. Each is checked again first (a student
  who is now present gets none). Held SMS not sent by midnight are never sent.
- **Result SMS and entry/exit SMS over the limit are skipped.**
- A Bangla SMS holds 70 characters; a longer one costs one SMS per 67 characters.

## 15. Coming soon: features in open PRs

These are built in pull requests that are **not merged yet**. Screens and words may still
change. Each part applies **after its PR is merged**.

### 15.1 Online admission, staff side (after PR #23 is merged)

Owner and admin. New menu item **Admission** [ভর্তি].

1. **New admission cycle** [নতুন ভর্তি কার্যক্রম]: the academic year (usually next year), the
   names, when the form opens and closes (Bangladesh time), whether there is an admission
   test, whether to ask for the child's photo, which form fields are asked (not asked,
   optional, required), and the classes with seats.
2. **Open the form** [ফর্ম চালু করুন] (needs at least one class). **Close the form** stops
   it.
3. **Applications** [আবেদনসমূহ]: search, filter, CSV. Walk-in applications are typed by
   staff.
4. Change an application's status: Submitted [জমা হয়েছে], Shortlisted [প্রাথমিক তালিকায়],
   Selected [নির্বাচিত], Rejected [বাতিল] (reason required), Withdrawn [প্রত্যাহার] (reason
   required).
5. **Approve as a student** [শিক্ষার্থী হিসেবে ভর্তি]: the child becomes a student of the
   cycle's year with the applicant's guardian as primary guardian. If the guardian's number is
   already known, pick the existing guardian or a new one. **Approve a class** [একটি শ্রেণি
   ভর্তি করুন] admits every **Selected** application of a class into one section, in the
   background.

The same child cannot apply twice in one cycle (same birth registration number, or same phone,
name and date of birth); one phone can have at most three live applications per cycle.
Applications are never deleted. A child admitted in December for January owes fees from
January.

### 15.2 The public admission form (after PR #24 is merged)

Guardians apply from their phone without an account, at `/apply/<your institute's link>`. The
cycle page shows the address to share.

- Steps: class → phone → a code by SMS → the form → check → submitted, with an application
  number to print or save.
- The status page asks for the application number and sends a code to the phone that applied.
- A "not a robot" check (Cloudflare Turnstile) protects the form.
- "Application received" SMS goes through the institute's daily limit; the code SMS does not.

**To check:** how the institute should share the link (notice board, Facebook page, SMS).

### 15.3 Admission test and merit list (after PR #27 is merged)

For a cycle with an admission test. Owner and admin. Cycle page → a class → **Admission test**
[ভর্তি পরীক্ষা]. Tabs:

1. **Setup and rolls** [বিবরণ ও রোল]: date, time, venue, full marks, pass marks (empty: nobody
   fails), seats and waiting-list size; then **Issue rolls** [রোল দিন]. An issued roll never
   changes.
2. **Admit cards** [প্রবেশপত্র]: two per A4, with the logo, photo and roll.
3. **Scores** [নম্বর]: one total score per applicant, or absent.
4. **Merit list** [মেধাতালিকা]: build it, check it, publish it. Statuses become Selected,
   Waiting list [অপেক্ষমাণ] or Rejected. Only published Selected applicants can be approved.
5. **Result SMS** [ফলাফলের এসএমএস]: preview, then send. The SMS never shows the score.

When a seat frees up, **move up** the waiting list. Applicants see their result on the status
page.

### 15.4 Leaving, promotion and the new session (after PRs #21 and #22 are merged)

**Leaving** (PR #21). Student page → **Leaves the institute** [প্রতিষ্ঠান ছাড়ছে]: graduated,
transferred or dropped out, the date, and an optional note. Nothing is deleted: old dues and
history stay. They leave attendance, the device and the due list from the next day, and free
their seat. **Came back** [ফিরে এসেছে] makes them active again. Fees → Reports gains "Leavers
with dues".

**The new academic year** (PR #22). Setup → academic year → **New academic year** [নতুন
শিক্ষাবর্ষ]. Nothing switches by itself and no dues move.

1. **The new year**: create it from the current one (sections copied), or pick one made.
2. **Fees**: copy amounts, terms and (optionally) running concessions.
3. **Teachers**: copy class, section and subject teachers by name.
4. **Promote, class by class** [শ্রেণি ধরে উত্তীর্ণ করুন]: for each class a list of who is
   promoted, who repeats and who leaves, with defaults from the published annual results
   (passed → promoted, failed → repeat, the top class → graduated). Change any row, then
   **apply**. It runs in the background and can be resumed if it stops.
5. **Number the rolls** [রোল নম্বর দিন]: promoted students first (by merit, name or old roll),
   then repeaters, then new admissions. Rolls already given are kept.
6. **Make it the current year** [চলতি বছর করুন]: a checklist of what is not finished, then the
   switch. Students not enrolled in the new year leave the due list and attendance after the
   switch.

There is no "undo" for an applied list; single students are fixed afterwards on their page.

### 15.5 Notices (after PR #25 is merged)

- Everyone sees the **Notices** [নোটিশ] board, with "New" on unread ones and a count in the
  menu.
- Owner and admin: **Manage notices** [নোটিশ পরিচালনা] → **New notice**: title, details,
  **Who sees it** (everyone, staff, guardians), optionally only some classes or sections (for
  guardians), a last day, and a pin. **Publish** now or at a later time (up to 30 days ahead).
- Edit a published notice (it shows "Edited"). **Withdraw** [প্রত্যাহার] with a reason takes
  it off every board; it is kept on record. Notices are never deleted.
- Links in a notice are shown as text and cannot be clicked.
- The manage list shows how many have read each notice.

### 15.6 SMS broadcasts (after PR #26 is merged)

Owner and admin. Menu: **SMS broadcasts** [এসএমএস বার্তা].

1. **New broadcast** [নতুন বার্তা]: the message (sent exactly as typed, at most 3 SMS), **Send
   to** [কাকে পাঠাবেন] primary guardians, all guardians or staff, and optionally some classes
   or sections.
2. **Preview** [হিসাব দেখুন]: recipients, those without a phone, shared phones (sent once),
   SMS per message, the estimated cost, and what today's limit leaves.
3. **Send now** or schedule it (5 minutes to 30 days ahead).

Rules:

- **All or nothing**: if it does not fit today's limit, nothing is sent.
- **Quiet hours**: nothing goes between 21:00 and 08:00.
- It is not sent if it would cost much more than you confirmed, or if it is found more than 3
  hours late; the dashboard says so, and **Edit and send again** starts over.
- A sent broadcast cannot be stopped.

## 16. To check

For the owner, before this guide goes to institutes:

1. Walk through every numbered step on the running app (bn, phone and desktop) and fix the
   wording to match the screens.
2. The SMS gateway: until it is connected nobody can receive a sign-in code (see the top).
3. What the Staff [কর্মী] role is meant to do: today it sees only the dashboard.
4. How a staff member who lost their phone or number gets back in (no admin reset today).
5. There is no "activate again" for a deactivated student, and no web screen to enrol an
   existing student into another year (the API has one).
6. Which printouts use the institute's logo, signature and seal today.
7. Whether class teachers can reach remarks and report cards from the web in this release.
8. Devices: confirm the setup steps on a real ZKTeco device, and how to explain the "device
   switched off and on again" limit to institutes.
9. How institutes should share the public admission link (after PR #24).
10. Names: the screens use the institute's own words; check the guide reads well for a coaching
    centre ("Course", "Batch") and a madrasa.
11. A short printed "first day" sheet per role (teacher: 3.1, 3.2, 11.1; accountant: 3.1, 3.2,
    12.3, 12.7) may help more than this full guide.

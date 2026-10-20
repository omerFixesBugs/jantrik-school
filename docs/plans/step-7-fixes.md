# Step 7 fixes plan (before merging `feature/step-7-setup-students`)

Status: **proposed, waiting for approval.** Nothing below is implemented yet.

## 1. CI end-to-end

**What the CI logs show** (`gh run view --log-failed`, playwright-report of run 39172356580):

- Every failing run fails the same test: `layout.spec.ts › login: both tabs and the code step`,
  twice (first try and retry):
  `strict mode violation: getByLabel('মোবাইল নম্বর') resolved to 2 elements` — the OTP input
  and the password tab's "মোবাইল নম্বর বা ইমেইল" input.
- Cause: after `tap()` on the OTP tab, the password panel is still mounted for a moment while
  Base UI swaps panels. On a slow CI runner the `fill` lands in that window; locally it never
  does. The artifact's page snapshot (taken after the failure) shows only the OTP panel. The
  test is wrong, not the app.
- Second problem: the phase D run was **cancelled at the 10-minute job limit**. The suite now
  spends ~2 minutes waiting out the OTP resend cooldown, because three specs log in the same demo
  guardian (`01811000101`). One of those waits also failed once (`dashboard.spec.ts:54`, passed
  on retry).

**Fix:**

- Target inputs by exact accessible name inside the active tab panel
  (`getByRole('tabpanel', …).getByLabel('মোবাইল নম্বর', { exact: true })`) in `layout.spec.ts`
  and `helpers.ts`, and wait for the OTP panel before typing.
- Give each guardian-login spec its own seeded guardian (Tasnim's mother `01811000102` for
  `layout.spec.ts`, a new demo guardian for `reports.spec.ts` if needed), so no test waits for a
  cooldown. Keep the cooldown wait in the helper as a fallback.
- Raise the CI job `timeout-minutes` from 10 to 20 (normal run ~6–7 min).
- Done when: two consecutive green CI runs on the branch (`gh run watch`).

## 2. Staff by phone: privacy and invitations

**Schema** (one migration; new table via the add-tenant-table skill):

- `membership_status` gets `INVITED` and `DECLINED`.
- New tenant table `staff_profiles` (`tenant_id`, `user_id`, `name`, `name_bn`, `phone`,
  unique per tenant + user): the name and phone **as this institute typed them**. RLS enabled +
  forced, `tenant_isolation`, SELECT/INSERT/UPDATE. Plain FK to `users` (checked by the service).
- `users_visible` policy: a user is visible to a tenant only through a membership that is not
  `INVITED`/`DECLINED`. So an invited person's global row (real name) is invisible to the
  inviting institute **at the database level**, not just in the API.

**API:**

- `POST /staff`: find-or-create the user, create the memberships as **INVITED**, create the
  staff profile from the typed values. The response is built only from what the admin typed
  (name, name_bn, phone, roles, status `INVITED`), so it is **identical whether or not the phone
  already exists** (user ids are random v4 UUIDs, no timestamp). Already invited/staff here →
  409 as today; a `DECLINED` person can be invited again.
- Staff list and staff pickers (staff page, attendance staff list, section teachers, "last
  changed by") show the **staff profile name**, never `users.name`. Rows created before this
  (seeded staff) fall back to `users.name`; the seed gets profiles too.
- **Rate limit:** staff additions per tenant (default 30 per hour, env
  `STAFF_ADD_PER_TENANT_PER_HOUR`) → 429 with Retry-After.
- **Invitations** (user-scoped routes, work without a selected institute):
  - `GET /me/invitations`: institute name + roles, from the existing
    `auth_list_my_memberships()` definer function (it already returns `INVITED` rows). **No new
    definer function.**
  - `POST /me/invitations/:tenantId/accept|decline`, in `TenantAccessService` (the tenancy layer,
    like other membership writes). It opens a transaction with that tenant + the caller's user
    context only after checking the caller has an INVITED membership there, sets **only the
    caller's own INVITED rows** to ACTIVE/DECLINED, audits it, and drops the roles cache.
  - Access starts only on accept: invited rows are not ACTIVE, so tenant selection, the
    per-request membership check and `RolesGuard` all already refuse them.
- Owner rules stay: inviting an OWNER needs an owner; the last-owner check counts ACTIVE owners
  only; an invitation can be cancelled (status DISABLED).

**Web:**

- After login, a pending invitation shows "<institute> added you as <role>: accept / decline" on
  the institute-selection screen, and as a banner on the dashboard for someone already signed in.
  With only invitations (no active institute), login lands on that screen instead of an error.
- Staff page: an "Invitation pending" / "Declined" badge, cancel invitation, invite again.

**Tests:** db (users hidden while INVITED/DECLINED, staff_profiles RLS); API: identical POST
response for a new vs. existing phone (incl. one who is a guardian elsewhere), the list never
shows the global name, invited person gets 403 in that tenant until accept, accept → access,
decline → no access and re-invite possible, cannot accept someone else's / another tenant's
invitation, rate limit 429, owner rules still hold; e2e: invite → log in as that person → accept
→ dashboard.

## 3. Least privilege for teachers

Rule: OWNER/ADMIN see everything. A TEACHER sees full details only for students enrolled (current
year) in a section they are assigned to (`section_teachers`); for others, only the basics.

**API (enforced in the service, per student):**

- `GET /students` (list): name, code, class/section, roll, status for everyone; the primary
  guardian (name + phone) **only** for admins and for rows in the teacher's own sections.
- Phone search (`?q=` with a phone number) only for OWNER/ADMIN, so a teacher can't check "is
  this phone a guardian of X". Name/code search unchanged.
- `GET /students/:id`: for a non-assigned teacher the response has `access: 'basic'` with date
  of birth, birth registration number, addresses, parents' names and guardians **removed**
  (null/empty), enrolments kept. Assigned teachers and admins get `access: 'full'`, including
  guardian phones (absence calls).
- Writes stay OWNER/ADMIN.

**Web:** the profile shows the basic view (with a short "visible to admins and this section's
teachers" note); the list shows guardian lines only when present.

**Tests (API):** teacher of section A vs. not assigned vs. admin: list shows/omits guardian;
profile full vs. basic (each sensitive field checked absent from the JSON, not just empty in the
UI); phone search refused for teachers; another tenant still 404. e2e: a teacher opens an
assigned and an unassigned student.

## Order and gates

1 → 3 → 2 (CI green first, so later pushes are checked). Each part: lint, typecheck,
format:check, all tests, full Playwright, review subagent, commit, push, wait for green CI.
Docs: database.md (statuses, staff_profiles, users policy), auth.md (invitations), decisions
file updated (#15, #18, #19 resolved).

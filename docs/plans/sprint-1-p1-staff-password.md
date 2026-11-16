# Sprint 1, P1: staff set their own password (implementation plan)

**Status: approved by the owner on 2026-11-15, with P1-A to P1-E,** and one addition to P1-D: a
password that contains the person's own phone number or an institute's name is refused too. It
is built on its own branch once the refresh-race fix PR is green; then the review subagent, CI
green, not merged by Claude. The sprint plan is [sprint-1.md](sprint-1.md) → P1, with decisions
S26 and S28.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (one implementer,
> one review subagent at the end of the phase). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a staff member, signed in with a phone code, can set (or change) a password and then
sign in with it. Guardians cannot. Every other device of theirs is signed out when the password
changes.

**Architecture:**

- Three routes under `/me/password` run in the current institute's request transaction, for staff
  roles only:
  - `GET /me/password`: the status;
  - `POST /me/password/code`: sends a code to the person's own phone;
  - `PUT /me/password`: sets the password, given that code.
- The code is an OTP with its own purpose (`password`). It shares the phone's SMS limits with the
  login code, but a login code never sets a password and a password code never signs in.
- The password rules live in `@jantrik/shared`, so the form shows the same rules. The server adds
  a common-password check.
- Password login also requires an active staff membership.

**Tech stack:** NestJS, Prisma/PostgreSQL 16, Redis, argon2id (`@node-rs/argon2`, as today), Next.js
(v3 kit), next-intl, Vitest and Playwright.

**Spec:** [sprint-1.md](sprint-1.md) → "P1: Staff set their own password", S26 (10–128 characters,
not the phone, not common; a fresh code to set or change it; other sessions revoked), S28 (a
person who is staff and guardian reaches all their memberships with the password).

**Branch:** `feature/sprint-1-p1-staff-password`, from `main` after the refresh-race fix
([fix-refresh-race.md](fix-refresh-race.md)) is merged, if the owner approves that fix first.

## Global constraints

- **Staff roles:** `OWNER`, `ADMIN`, `TEACHER`, `ACCOUNTANT`, `STAFF`. Not `GUARDIAN` or `STUDENT`.
- **Routes:** `@RequireModule('CORE')` and `@Roles('OWNER','ADMIN','TEACHER','ACCOUNTANT','STAFF')`,
  in the institute's request transaction (not `@UserScoped`), so each change is audited in that
  institute (P1-A).
- **Password rules (S26):**
  - normalised with `String.prototype.normalize('NFC')` before anything else (P1-C);
  - 10 to 128 Unicode code points (`[...pw].length`);
  - not containing the person's phone number in any form (P1-D). Spaces, dashes, dots and plus
    signs are dropped and Bangla digits made ASCII; then the 10-digit national number
    (`17XXXXXXXX`) must not appear. That covers `01…`, `+8801…` and `8801…`.
  - not containing the name of an institute the person belongs to (P1-D). Names and password
    are compared NFC-normalised, lower-cased and without spaces. Names under 4 letters are
    skipped, because such a short name would refuse most passwords.
  - not in the bundled common-password list (lower-cased), checked on the server;
  - no other composition rules.
- **The code:**
  - 6 digits, 5 minutes, 5 attempts, single use, as the login code;
  - Redis key `otp:password:<phone>` (the login code keeps `otp:<phone>`);
  - the phone's SMS limits (`otp-phone-cooldown`, `otp-phone-15m`, `otp-phone-day`) are shared
    with the login code;
  - fixed texts:
    - bn: `আপনার জান্ত্রিক পাসওয়ার্ড সেট করার কোড: {code}। ৫ মিনিটের মধ্যে ব্যবহার করুন। কাউকে জানাবেন না।`
    - en: `Your Jantrik code to set your password is {code}. It expires in 5 minutes. Do not share it.`
- **Limits:** `PUT /me/password` allows 5 attempts per user per 15 minutes (`pwd-set:<userId>`).
  `POST /me/password/code` falls under the phone's OTP limits.
- **Errors:**
  - 422 `PASSWORD_CODE_INVALID` (wrong, expired or used code);
  - 422 `PASSWORD_REJECTED` with
    `problems: ('TOO_SHORT'|'TOO_LONG'|'HAS_PHONE'|'HAS_INSTITUTE_NAME'|'TOO_COMMON')[]`;
  - 403 for guardians and students (the roles guard);
  - 429 with `Retry-After`.
- **On success, in one transaction:**
  - set `users.password_hash` and `users.password_changed_at`;
  - revoke every other live session of the user (`revoke_reason = 'PASSWORD_CHANGED'`);
  - write an audit row in the current institute (entity `user_password`, action `UPDATE`, no
    values).

  After commit: the revoked sessions' Redis revocation keys. Answer 204. The current session, and
  every tab of this browser, stays signed in.

- **Logs and storage:** the password and the code never appear in logs, responses, audit rows,
  Redis (except the code's HMAC, as today) or job payloads.
- **Strings:** all of them in bn and en, in a route namespace `account`. Bangla digits are
  accepted in the code field (`toAsciiDigits`). The v3 kit is used, light-first.
- **Gates:** affected tests during the phase; at its end, `pnpm lint`, `pnpm typecheck`,
  `pnpm format:check`, `pnpm test`, `pnpm build` and `pnpm e2e` (locally on a scratch database,
  per the memory note on Prisma's reset guard). Then one review subagent and the PR.

## Review focus

1. **A person who is staff in institute A and guardian in institute B,** working in B.
   - Expected: no password item and 403 on the routes in B. In A it works.
   - After setting the password, a password login offers both A and B (S28).
   - Test: Task 3.
2. **Bangla and other non-ASCII passwords** typed on different keyboards (composed vs decomposed
   forms). Expected: the same password signs in whichever form was typed. Test: Tasks 2 and 4.
3. **Another tab of the same browser** is open when the password changes. Expected: it stays
   signed in, because tabs of one browser share one session. Only other devices (other sessions)
   are signed out. Test: Task 3 (API: the current session's access token and refresh still work)
   and Task 6 (two tabs).
4. **A staff member whose only staff membership was disabled** tries their password. Expected:
   the same 401 as a wrong password; signing in with a code still works for any other membership
   (e.g. as a guardian). Test: Task 4.
5. **Code abuse.** Asking for password codes cannot push a phone past its daily SMS cap, and a
   login code cannot set a password (nor a password code sign in). Test: Task 3.

## Added in this plan (the owner approves these with the plan)

- **P1-A. The routes need the current institute and a staff role there.**
  - The sprint plan said "staff in any institute". Working inside an institute makes the change
    auditable there, and keeps guardians' screens free of it.
  - A person who is staff elsewhere switches to that institute first.
- **P1-B. The app login may update only some columns of `users`.**
  - Today `jantrik_app` may update every column of the person's own row, including `phone` (the
    login identifier) and `email`.
  - This plan grants UPDATE only on `locale`, `color_scheme`, `name_bn`, `password_hash`,
    `password_changed_at` and `updated_at`, the columns the API, the seed and the tests write.
  - So no app code (or injection) can change a login's phone or email.
- **P1-C. Passwords are NFC-normalised** before hashing and before verifying, so a Bangla password
  typed on another keyboard still matches. Existing hashes are unaffected (the demo password is
  ASCII).
- **P1-D. The common-password list:**
  - the 10,000 most common passwords from SecLists (`10k-most-common.txt`, MIT licence), stored as
    `apps/api/src/auth/common-passwords.txt` with its source and licence in the file's first
    lines;
  - plus `jantrik`, `bangladesh` and `password` variants with the year;
  - server side only (never in the web bundle);
  - **the owner's addition:** a password containing the person's own phone number, or the name of
    an institute they belong to, is refused as well (see the password rules above).
- **P1-E. Password codes cost Jantrik, as login codes do** (recorded in `platform_sms_logs` with
  purpose `OTP`), not the institute's SMS budget.

## Files

| File                                                                                                       | Change                                                                               |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `packages/db/prisma/schema.prisma` + 2 migrations                                                          | `users.password_changed_at`; `session_revoke_reason` `PASSWORD_CHANGED`; P1-B grants |
| `packages/db/test/users-rls.test.ts`                                                                       | the column grants                                                                    |
| `packages/shared/src/password.ts` (+ `.test.ts`), `index.ts`                                               | `normalizePassword`, `passwordProblems`, `setPasswordSchema`, `PASSWORD_RULES`       |
| `apps/api/src/auth/common-passwords.txt`, `common-passwords.ts`                                            | the list and `isCommonPassword`                                                      |
| `apps/api/src/auth/otp.service.ts`                                                                         | `purpose: 'login' \| 'password'`                                                     |
| `apps/api/src/auth/password-settings.service.ts`, `password.controller.ts`                                 | the three routes                                                                     |
| `apps/api/src/auth/password.service.ts`, `auth.service.ts`                                                 | NFC; password login only with a staff membership                                     |
| `apps/api/src/auth/password-writes.spec.ts`                                                                | code scan: who writes `passwordHash`                                                 |
| `apps/api/test/password-set.e2e-spec.ts`, `password.e2e-spec.ts`                                           | the API tests                                                                        |
| `apps/web/src/app/(app)/account/password/page.tsx` (+ layout)                                              | the page                                                                             |
| `apps/web/src/components/app-shell.tsx`                                                                    | the "Password" menu item, for staff only                                             |
| `apps/web/src/app/(public)/login/page.tsx`                                                                 | the hint under the password tab                                                      |
| `apps/web/messages/account/*.json`, `messages/{bn,en}.json`, `i18n/route-messages.ts`, `load-messages.ts`  | strings                                                                              |
| `apps/web/e2e/password.spec.ts`                                                                            | Playwright                                                                           |
| `docs/auth.md`, `docs/database.md`, `docs/deploy.md`, `docs/demo-accounts.md`, `docs/decisions-pending.md` | Task 7                                                                               |

---

### Task 1: The database (column, enum value, column grants)

**Files:** `packages/db/prisma/schema.prisma`; migrations `…_session_revoke_password_changed` (the
enum value alone: a new value cannot be used in the transaction that adds it) and
`…_users_password_changed_at` (the column plus P1-B's grants); `packages/db/test/users-rls.test.ts`.

**Interfaces:**

- Produces:
  - `User.passwordChangedAt: Date | null` (`password_changed_at timestamptz(3)`);
  - `SessionRevokeReason.PASSWORD_CHANGED`;
  - grants: `REVOKE UPDATE ON users FROM jantrik_app;` then
    `GRANT UPDATE (locale, color_scheme, name_bn, password_hash, password_changed_at, updated_at) ON users TO jantrik_app;`

- [ ] **Step 1: Write the failing tests** in `users-rls.test.ts`:

```ts
it('the app may update its own preferences, Bangla name and password columns', async () => {
  await withContext(app, { userId: u.id }, (tx) =>
    tx.user.update({
      where: { id: u.id },
      data: { locale: 'en', nameBn: 'নাম', passwordHash: 'x', passwordChangedAt: new Date() },
    }),
  ); // resolves
});
it.each([
  ['phone', '+8801799999999'],
  ['email', 'x@example.com'],
  ['name', 'Someone else'],
])(
  'the app may not change its own %s (the login identifiers and the global name)',
  async (column, value) => {
    await expect(
      withContext(app, { userId: u.id }, (tx) =>
        tx.$executeRawUnsafe(`UPDATE users SET ${column} = $1 WHERE id = $2::uuid`, value, u.id),
      ),
    ).rejects.toThrow(/permission denied/);
  },
);
```

- [ ] **Step 2: Run them and see them fail.** Run `pnpm --filter @jantrik/db exec vitest run
test/users-rls.test.ts`. Expected: FAIL (the column is missing; the phone update succeeds).
- [ ] **Step 3: Write the schema change and the two migrations.**
  - Create each with `pnpm db:migrate --create-only --name <name>` (run once, then find the folder
    with `ls -t`), and append the grants SQL to the second.
  - Apply with `pnpm db:migrate`.
  - Check for drift: `prisma migrate diff … --script` must print an empty migration.
- [ ] **Step 4: Run the tests and see them pass**, the same command. Then run the whole db suite
      (`pnpm --filter @jantrik/db test`), plus a demo seed into a scratch database. The seed writes
      `nameBn` and `passwordHash` as each user, which the narrower grant must still allow.
- [ ] **Step 5: Commit**: "users.password_changed_at, the PASSWORD_CHANGED revoke reason, and the
      app login may update only preferences, Bangla name and password columns of its own row (P1-B)".

### Task 2: The password rules (`@jantrik/shared`)

**Files:** `packages/shared/src/password.ts`, `packages/shared/src/password.test.ts`,
`packages/shared/src/index.ts`.

**Interfaces:**

- Produces:
  - `PASSWORD_RULES = { min: 10, max: 128 }`;
  - `normalizePassword(pw: string): string` (NFC);
  - `type PasswordProblem = 'TOO_SHORT' | 'TOO_LONG' | 'HAS_PHONE' | 'HAS_INSTITUTE_NAME'`;
  - `passwordProblems(pw: string, about: { phone: string; instituteNames: readonly string[] }): PasswordProblem[]`
    (normalises first; the server adds `TOO_COMMON`, and passes the names of every institute the
    person has an active membership in; the web passes the current one);
  - `setPasswordSchema = z.object({ code: z.string(), password: z.string().max(512) })`. The code
    is ASCII-normalised with `toAsciiDigits` in the transform and must then be 6 digits.

- [ ] **Step 1: Write the failing tests:**

```ts
it('counts code points after NFC: a Bangla password typed decomposed equals the composed one', () => {
  const composed = 'আমারপাসওয়ার্ড১২'; // য় as one code point
  const decomposed = composed.normalize('NFD');
  expect(normalizePassword(decomposed)).toBe(normalizePassword(composed));
});
const about = {
  phone: '+8801711000002',
  instituteNames: ['শাপলা উচ্চ বিদ্যালয়', 'Alo Coaching', 'ABC'],
};
it.each([
  ['short', 'abcdefghi', ['TOO_SHORT']],
  ['long', 'a'.repeat(129), ['TOO_LONG']],
  ['ok', 'a'.repeat(10), []],
])('%s', (_c, pw, problems) => expect(passwordProblems(pw, about)).toEqual(problems));
it.each([
  '01711000002',
  '+8801711000002',
  '8801711000002',
  '০১৭১১০০০০০২',
  'my-01711-000002!',
  'x+880 1711 000002y',
])('refuses a password containing the phone number: %s', (pw) =>
  expect(passwordProblems(pw, about)).toContain('HAS_PHONE'),
);
it.each(['শাপলাউচ্চবিদ্যালয়2026', 'শাপলা উচ্চ বিদ্যালয়!', 'myALOcoaching!!', 'alo coaching 123'])(
  'refuses a password containing an institute name (case and spaces ignored): %s',
  (pw) => expect(passwordProblems(pw, about)).toContain('HAS_INSTITUTE_NAME'),
);
it('skips institute names under 4 letters (they would refuse most passwords)', () => {
  expect(passwordProblems('abcdefghijk', about)).toEqual([]);
});
it('accepts Bangla digits in the code and refuses anything but 6 digits', () => {
  expect(setPasswordSchema.parse({ code: '১২৩৪৫৬', password: 'x' }).code).toBe('123456');
  expect(() => setPasswordSchema.parse({ code: '12345', password: 'x' })).toThrow();
});
```

- [ ] **Step 2: Run them.** Run `pnpm --filter @jantrik/shared exec vitest run src/password.test.ts`.
      Expected: FAIL (no module).
- [ ] **Step 3: Implement** the functions as specified.
  - The phone: drop spaces, dashes, dots and `+` from a copy of the password, convert its digits
    to ASCII (`toAsciiDigits`), and look for the phone's 10-digit national number (the E.164 phone
    without `+880`).
  - The institute names: NFC, lower-case, drop whitespace on both sides, skip names under 4
    letters, then look for each name in the password.
- [ ] **Step 4: Run them and see them pass.** Check that the web bundle budget is unchanged: the
      module is tiny, and the list stays on the server.
- [ ] **Step 5: Commit**: "Password rules shared by the API and the web: NFC, 10-128 code points,
      never the phone number (S26, P1-C)".

### Task 3: Setting a password (API)

**Files:** `apps/api/src/auth/common-passwords.txt` (P1-D), `common-passwords.ts`,
`otp.service.ts`, `password-settings.service.ts`, `password.controller.ts`, `auth.module.ts`,
`apps/api/test/password-set.e2e-spec.ts`, `apps/api/src/auth/password-writes.spec.ts`.

**Interfaces:**

- Consumes: Task 1's column and enum value; Task 2's `normalizePassword`, `passwordProblems` and
  `setPasswordSchema`.
- Produces:
  - `OtpService.request(phone, ip, purpose = 'login')` and
    `OtpService.verify(phone, code, ip, purpose = 'login')`;
  - `isCommonPassword(pw: string): boolean`;
  - `PasswordSettingsService.status(principal): Promise<{ hasPassword: boolean; changedAt: string | null }>`;
  - `PasswordSettingsService.sendCode(principal, ip): Promise<{ expiresIn: number; phoneHint: string }>`,
    where `phoneHint` is like `017•••••002`;
  - `PasswordSettingsService.set(principal, ip, input: { code: string; password: string }): Promise<void>`;
  - routes: `GET /me/password`, `POST /me/password/code` (202), `PUT /me/password` (204).

- [ ] **Step 1: Write the failing tests** (`password-set.e2e-spec.ts`; the harness's
      `MemorySmsProvider` gives the code):
  - **A teacher with no password:**
    - `GET` → `{hasPassword:false, changedAt:null}`;
    - `POST` code → an SMS to their phone with the password text;
    - `PUT` → 204, then `POST /auth/login` with the password → 200;
    - `GET` → `{hasPassword:true}` with `changedAt`;
    - an audit row `user_password`/`UPDATE` in that institute with null values.
  - **Review focus 1:** a person who is GUARDIAN in B and TEACHER in A. In B, both routes → 403.
    In A → 204. Afterwards a password login lists both A and B.
  - A guardian-only user → 403 on all three routes; nothing is sent.
  - **The code:**
    - wrong code → 422 `PASSWORD_CODE_INVALID`;
    - the same code twice → the second answers 422;
    - an expired code (the test sets the code key's TTL to 1 s in the test Redis and waits)
      → 422;
    - Bangla digits in the code → accepted.
  - **Review focus 5:**
    - a login code (`/auth/otp/request` then the code) given to `PUT /me/password` → 422;
    - a password code given to `/auth/otp/verify` → 401;
    - password codes and login codes together never exceed `OTP_PER_PHONE_PER_DAY` (the 11th
      request in a day → 429).
  - **The rules:**
    - 9 characters → 422 `PASSWORD_REJECTED` `['TOO_SHORT']`;
    - a password containing the phone number (`01…`, `+880…`, Bangla digits) → `HAS_PHONE`;
    - a password containing the current institute's name, or another institute's where the
      person is a member (as a guardian too) → `HAS_INSTITUTE_NAME`;
    - `password123` and `1234567890` → `TOO_COMMON`;
    - 129 characters → `TOO_LONG`.
  - **Review focus 3:** a second login of the same user (another "device") stops working once the
    password is set:
    - its access token → 401;
    - its refresh → 401;
    - its `revoke_reason` is `PASSWORD_CHANGED`;
    - the current session's access token and refresh still work.
  - The 6th `PUT` within 15 minutes → 429 `Retry-After`.
  - Changing an existing password needs a fresh code too (no code → 422).
  - The password and the code never appear in the captured logs (the pattern of
    `password.e2e-spec.ts` → "never writes the password or code to the logs").
  - Code scan (`password-writes.spec.ts`): in `apps/api/src`, only `password-settings.service.ts`
    writes `passwordHash`.
- [ ] **Step 2: Run them.** Run
      `pnpm --filter @jantrik/api exec vitest run test/password-set.e2e-spec.ts src/auth/password-writes.spec.ts`.
      Expected: FAIL (404 on the routes).
- [ ] **Step 3: Implement.**
  - `OtpService` gets the purpose: key, text, and the verify limiter key `login-ip` (shared).
  - `PasswordSettingsService.set` runs in this order:
    1. the `pwd-set:<userId>` limiter;
    2. `otp.verify(phone, code, ip, 'password')`, where `phone` is the user's own row read through
       `Db.tx` (RLS: self);
    3. normalise; `passwordProblems` plus `isCommonPassword`;
    4. `passwords.hash`;
    5. `Db.tx`: update the user's `passwordHash` and `passwordChangedAt`;
       `session.findMany({ where: { userId, revokedAt: null, NOT: { id: principal.sessionId } } })`,
       then `updateMany` revoked with `PASSWORD_CHANGED`; an audit row;
    6. `afterCommit`: `SET revoked:sid:<id> 1 EX 900` for each revoked session.
- [ ] **Step 4: Run them and see them pass**, the same command. Then run the auth-related suites:
      `test/password.e2e-spec.ts test/otp.e2e-spec.ts test/refresh.e2e-spec.ts`.
- [ ] **Step 5: Commit**: "Staff set or change their own password after a code sent to their phone;
      their other devices are signed out (S26, P1-A, P1-D, P1-E)".

### Task 4: Password login only for staff, and NFC

**Files:** `apps/api/src/auth/auth.service.ts`, `password.service.ts`,
`apps/api/test/password.e2e-spec.ts`.

**Interfaces:**

- Consumes: `normalizePassword` (Task 2).
- Produces: `loginWithPassword` refuses a user without a selectable staff membership with the same
  401; `PasswordService.verify` and `hash` normalise first.

- [ ] **Step 1: Write the failing tests** (`password.e2e-spec.ts`):
  - **Review focus 4:** a teacher with a password, whose membership is then disabled, gets the
    identical 401 body and status as a wrong password. Their OTP login still answers 200 (they
    have a guardian membership elsewhere in the fixture).
  - A user who has a password hash but only a GUARDIAN membership (set directly as the user, as the
    test helper does) → the same 401.
  - **Review focus 2:** the password set in its decomposed form (through `PUT /me/password`) signs
    in with the composed form, and the other way round.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - After a correct password, `listMembershipsFor(prisma, user.id)` must contain one with
    `selectable && roles.some(isStaffRole)`; otherwise `invalidCredentials()`.
  - `isStaffRole` lives in `@jantrik/shared`, next to the roles list.
- [ ] **Step 4: Run them and see them pass**, plus `test/password-set.e2e-spec.ts`.
- [ ] **Step 5: Commit**: "Password login needs an active staff membership (guardians stay OTP
      only); passwords are compared NFC-normalised (P1-C)".

### Task 5: The web page, the menu item, the login hint

**Files:** `apps/web/src/app/(app)/account/password/page.tsx` and `layout.tsx`
(`<RouteMessages area="account">`), `apps/web/src/components/app-shell.tsx`,
`apps/web/src/app/(public)/login/page.tsx`, `apps/web/messages/account/password.{bn,en}.json`,
`apps/web/src/i18n/load-messages.ts`, `route-messages.ts`, `apps/web/messages/{bn,en}.json` (the
menu item and the login hint), `apps/web/e2e/password.spec.ts`.

**Interfaces:** consumes the three routes (Task 3) and `passwordProblems` and `PASSWORD_RULES`
(Task 2).

- [ ] **Step 1: Write the failing Playwright spec** `password.spec.ts`:
  - **bn at 390 px:**
    1. a demo teacher signs in with a code;
    2. menu → "পাসওয়ার্ড" → "কোড পাঠান" (the phone shown masked);
    3. the code from the outbox, typed in Bangla digits;
    4. the new password twice → a success message.
  - Then: sign out, sign in on the password tab with it → the dashboard.
  - A second tab open meanwhile stays signed in (review focus 3).
  - A guardian has no menu item, and `/account/password` shows the "not for your role" state (the
    app's existing 403 handling).
  - The form shows the rules live: too short, the phone number.
- [ ] **Step 2: Run it.** Run `pnpm e2e` on a scratch database (`password.spec.ts`). Expected:
      FAIL.
- [ ] **Step 3: Implement** with the v3 kit:
  - a two-step form (send code → code + password + confirm);
  - rule hints from `passwordProblems`;
  - errors mapped from `PASSWORD_CODE_INVALID`, `PASSWORD_REJECTED` and 429 (with the countdown,
    as the login page shows it).

  Plus the menu item (only when the current roles include a staff role) and one hint line under
  the password tab: "পাসওয়ার্ড নেই? কোড দিয়ে ঢুকে মেনু থেকে পাসওয়ার্ড সেট করুন।" / "No password yet?
  Sign in with a code, then set one from your menu."

- [ ] **Step 4: Run it and see it pass.** Run the unit tests (`route-messages.test.ts` checks the
      namespace), and take screenshots in bn at 1366 and 390 px.
- [ ] **Step 5: Commit**: "The password page for staff, its menu item, and a hint on the login page".

### Task 6: Docs

Update:

- `docs/auth.md`:
  - Login methods: staff set their own password after a code; password login only with a staff
    membership; NFC;
  - remove "Password set/reset endpoints" from "Not built yet";
  - the revoke reason `PASSWORD_CHANGED`.
- `docs/database.md`: the users column grants (P1-B); `password_changed_at`.
- `docs/deploy.md` → What needs the owner: staff still need one SMS code (the gateway stays a
  go-live blocker), but after that the password works without SMS.
- `docs/demo-accounts.md`: how to try it.
- `docs/decisions-pending.md`: P1-A to P1-E.

- [ ] Run `pnpm format:check`. Commit: "Docs for staff passwords (sprint 1 P1)".

### Task 7: Gates, review, PR

- [ ] Run the full gates as in the global constraints (Playwright on a scratch database).
- [ ] Run the review subagent on the branch (auth and database focus), giving it this plan's review
      focus. Fix what it finds, each fix with a test that fails first.
- [ ] Push with the gh credential helper and open the PR. Watch CI until it is green; do not merge.

## Self-review

- **Spec coverage:**
  - S26:
    - the length and phone rules: Task 2;
    - the common-password list: Task 3;
    - a fresh code to set or change: Task 3;
    - other sessions revoked: Task 3.
  - S28 (all memberships with the password): Task 3, review focus 1.
  - Guardians stay OTP only: Tasks 3 and 4.
  - Login refused without a staff membership: Task 4.
  - The menu item and the login hint: Task 5.
  - The code scan: Task 3.
  - Docs: Task 6.
- **Types:** these have the same names in every task: `normalizePassword`, `passwordProblems`,
  `PASSWORD_RULES`, `setPasswordSchema`, `isCommonPassword`, `PasswordSettingsService.status`,
  `sendCode` and `set`, `OtpService.request` and `verify` with `purpose`, `PASSWORD_CHANGED`,
  `isStaffRole`.
- **Review focus:**
  - 1 is tested in Task 3;
  - 2 in Tasks 2 and 4;
  - 3 in Tasks 3 and 5;
  - 4 in Task 4;
  - 5 in Task 3.

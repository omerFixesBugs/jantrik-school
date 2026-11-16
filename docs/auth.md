# Authentication and request context

How people log in to the Jantrik API, how sessions work, and how every request gets its tenant.
Code lives in [`apps/api/src/auth`](../apps/api/src/auth) and
[`apps/api/src/tenancy`](../apps/api/src/tenancy). Database side: [database.md](database.md).

## Login methods

| Method                    | Endpoint                                              | For      | Notes                                 |
| ------------------------- | ----------------------------------------------------- | -------- | ------------------------------------- |
| Phone + OTP               | `POST /auth/otp/request` then `POST /auth/otp/verify` | everyone | 6 digits, 5-minute expiry, 5 attempts |
| Phone or email + password | `POST /auth/login`                                    | staff    | argon2id (19 MiB, t=2)                |

**No self-signup.** Only people who already exist (created by staff or the seed) can log in.

**Passwords are for staff** (sprint 1 P1):

- A password login needs an active membership with a staff role (`OWNER`, `ADMIN`, `TEACHER`,
  `ACCOUNTANT`, `STAFF`) in an open institute. Guardians and students sign in with a code only. A
  correct password without such a membership gets the same `401` as a wrong one, and counts as a
  failed attempt.
- Passwords are compared NFC-normalised (`normalizePassword` in `@jantrik/shared`): a Bangla
  password typed on another keyboard (e.g. য় as one code point or two) still matches. The
  platform-admin CLI hashes the NFC form too.
- Staff set their own password; see [Setting a password](#setting-a-password).

**No account enumeration:**

- `otp/request` always answers `202 {"expiresIn":300}`, and its rate limits are applied before
  the user lookup. An SMS is sent only if the phone belongs to a user.
- Every failure of `otp/verify` and `login` (unknown user, wrong code or password, expired or
  burned code, OTP-only account) returns the same `401 Invalid credentials`.
- Password checks always run argon2, against a dummy hash if needed, so timing doesn't leak
  either.

**OTP storage.** Codes are never stored in plain text. Redis holds
`HMAC-SHA256(OTP_PEPPER, phone:code)` with a 5-minute TTL, plus an attempt counter. The 5th wrong
attempt deletes the code. A successful verify deletes it too (single use): only the request
that deletes it gets through, so two requests racing with the same code cannot both succeed.

A code has a purpose. A login code is under `otp:<phone>`; a password code (below) is under
`otp:password:<phone>`, with `password:` in the MAC input and its own SMS text. Neither can be
used for the other.

**SMS** goes through `SmsService` → BullMQ queue `sms` → `SmsProvider`:

- `ConsoleSmsProvider` (development) prints the message, including the code, to the API log.
  This is the only place an OTP may appear, and it refuses to start in production.
- Tests use `MemorySmsProvider`.
- The real Bangladeshi gateway will be another `SmsProvider`.
- Every OTP send is recorded in `platform_sms_logs` (phone, segments, SENT/FAILED, never the
  text) for cost tracking. The app role can only insert there.

Tenant SMS (e.g. absent alerts) go through **`TenantSmsService.queue()`** instead, inside the
request transaction (or a job's, which may act for no person, e.g. device punches):

1. It takes a per-tenant advisory lock, so the dedupe check and the daily count can't race.
2. A `dedupeKey` that already exists → `DUPLICATE`, nothing queued.
3. Over the tenant's daily cap → an `sms_logs` row with status `HELD_OVER_LIMIT`, nothing queued.
4. Otherwise an `sms_logs` row (`QUEUED`, with segments) and, after commit, a delayed job
   `{ tenantId, smsLogId }`. No phone number or text goes into Redis.
5. The worker loads the row in that tenant's context (see `TenantJobRunner` below), asks the
   purpose's registered relevance check whether it is still wanted (an absence corrected in the
   meantime → `CANCELLED`), sends it outside any transaction, then marks it `SENT` or, after the
   last retry, `FAILED`.

`queue()` takes `overCap: 'HOLD' | 'SKIP'` (default `HOLD`, step 3's behaviour). With `SKIP` an
SMS over the daily cap writes no row and returns `OVER_CAP`: result SMS use it, because a held
message's dedupe key could never be sent again ([exams.md](exams.md)), and so do the device entry
and exit SMS (with 90 % of the cap, leaving the rest for absent alerts).

## Rate limits (Redis, all configurable via env)

Per-IP limits are deliberately generous because many users share one IP (carrier CGNAT, school
Wi-Fi). The per-phone and per-account limits are the real protection.

| Limit                                   | Default                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| OTP per phone                           | 1 per 60 s per purpose (login, password); 5 per 15 min and **10 per day** for both together (SMS costs money)                   |
| OTP requests per IP                     | 200 / hour                                                                                                                      |
| Login / OTP-verify per IP               | 300 / 15 min                                                                                                                    |
| Failed password attempts per account    | 5 / 15 min; a successful login resets it (counted before the check, cleared on success, so parallel guesses can't slip through) |
| Setting a password (`PUT /me/password`) | 5 / 15 min per person                                                                                                           |
| Authenticated requests                  | 300 / min **per user**                                                                                                          |
| Unauthenticated requests                | 600 / min per IP                                                                                                                |
| Device receiver, per address            | 1200 / min (an IPv6 address counts by its /64)                                                                                  |
| Device receiver, refused serials        | 30 / 10 min per address, then 429 without a database call                                                                       |
| Device receiver, one serial number      | 300 / min from each address; 1200 / min from all the addresses it does not trust, together                                      |

Exceeding a limit returns `429` with `Retry-After`. The device receiver's limits and why they are
shaped this way: [devices.md](devices.md) → Limits.

## Tokens and sessions

**Access token:** JWT, HS256, 15 minutes, `Authorization: Bearer …`.

```jsonc
{
  "sub": "<userId>",
  "sid": "<sessionId>", // checked against the Redis revocation list on every request
  "tid": "<tenantId>", // only once a tenant is selected
  "roles": ["ADMIN"], // UI hint only; guards read current roles from Redis/DB
  "typ": "access",
  "iss": "jantrik-api",
  "aud": "jantrik",
  "iat": 0,
  "exp": 0,
}
```

**Session:** one row in `sessions` per login on one device. It stores the client type, user
agent, IP, `created_at`, `last_used_at`, a sliding 30-day expiry, and the active tenant. This is
the data a future "logged-in devices" screen will show.

**Refresh token:** opaque, 256 bits. Only its SHA-256 is stored, in `refresh_tokens`. Every use
rotates it:

| Presented token                                             | Result                                                                                         |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| current, unused                                             | new pair; old token marked rotated                                                             |
| rotated **≤ 30 s ago** and its replacement **not yet used** | the **same** new pair again (idempotent; covers mobile networks that retry timed-out requests) |
| any other rotated token                                     | **reuse detected**: the whole session is revoked; its refresh and access tokens stop working   |
| unknown, expired, or revoked session                        | `401`                                                                                          |

The retry window works by caching the issued response in Redis:

- for at most 30 s;
- under the old token's SHA-256 (`rt:grace:<hash>`);
- AES-256-GCM encrypted with a key derived from the _old_ token, so only someone holding that
  token can read it;
- naming its session, which is checked when it is read back.

**Refreshes of one token never overlap** (`docs/plans/fix-refresh-race.md`). A page that lost a
refresh's answer (navigated away mid-request) makes the next page present the old token again
while the first refresh may still be running. So each refresh takes a lock on its token in Redis
(`rt:lock:<hash>`) and, inside it, works in this order:

1. what the token is: fresh, a retry within 30 s (the same answer again), or reuse (revoke);
2. build the whole answer;
3. store it for retries;
4. only then commit the rotation.

A second refresh of the same token waits for the lock (up to 10 s, then **503 `REFRESH_BUSY`**)
and then finds the first one's stored answer: a retry, never reuse.

- **A failure before step 4** leaves the token unrotated, so the client's retry rotates it
  normally.
- **The lock lives 15 s, and a refresh never outlives it.** Before step 3 it checks that storing
  and committing can still finish inside its lock (Redis 2 s each call, the commit's transaction
  at most 3 s waiting and 3 s running). If not, it stops with 503 `REFRESH_BUSY` before changing
  anything. A commit that still finds the token rotated, which only a lost lock allows, is also
  503, never 401.
- **A session revoked while the answer is built** (a logout) rolls the commit back: 401, and no
  new pair.
- **An institute that can no longer be selected** is cleared only if the session still has it,
  so an institute switch made meanwhile stays.
- **Redis unavailable:** if Redis fails or does not answer within 2 s, the refresh answers
  **503 `REFRESH_UNAVAILABLE`** and changes nothing. So does a lock request that timed out: its
  release is queued behind it.
- **Every route, not just refresh:** the global rate-limit check answers **503
  `SERVICE_UNAVAILABLE`** when Redis fails or is silent past 2 s, instead of hanging or failing
  with a 500.

A 503 is never a sign-out: the web client shows "unreachable" and retries. Two tabs refreshing at
once get the same pair; the web client still serialises refreshes (Web Locks) to save requests.

**Where the refresh token lives:**

- **Web** (`client: "web"`): only in the cookie
  `jantrik_rt; HttpOnly; Secure; SameSite=Strict; Path=/auth`. The body never contains it.
  `POST /auth/refresh` reads the cookie only when the request also sends
  `X-Jantrik-Client: web`, as extra CSRF protection.
- **Mobile** (`client: "mobile"`): `refreshToken` in the body. Send it back in the body of
  `/auth/refresh`.

**Logout** (`POST /auth/logout`) revokes the session and puts its id on a Redis revocation list,
so the access token dies immediately rather than after up to 15 minutes.

Revoke reasons (`sessions.revoke_reason`): `LOGOUT`, `REUSE_DETECTED` (refresh token reuse),
`ADMIN`, and `PASSWORD_CHANGED` (the person set a password: every other session of theirs).

## Setting a password

Staff set (or change) their own password from the user menu (`/account/password`). The three
routes run in the current institute's request transaction, for staff roles there
(`@RequireModule('CORE')`, `@Roles(OWNER, ADMIN, TEACHER, ACCOUNTANT, STAFF)`), so each change is
audited in that institute. Someone who is staff elsewhere switches to that institute first.

| Route                    | Answer | What it does                                                             |
| ------------------------ | ------ | ------------------------------------------------------------------------ |
| `GET /me/password`       | 200    | `{ hasPassword, changedAt, phone }` (the phone: their own, for the form) |
| `POST /me/password/code` | 202    | a password code to their own phone; `{ expiresIn, phoneHint }`           |
| `PUT /me/password`       | 204    | `{ code, password }`: sets it                                            |

`PUT` checks, in this order:

1. 5 tries per person per 15 minutes (`pwd-set:<userId>`), else `429` with `Retry-After`;
2. the rules, else `422 PASSWORD_REJECTED` with `problems`:
   - `TOO_SHORT` / `TOO_LONG`: 10 to 128 Unicode code points after NFC;
   - `HAS_PHONE`: the person's 10-digit national number, in any form (`01…`, `+880…`, Bangla
     digits, split by spaces, punctuation or symbols);
   - `HAS_INSTITUTE_NAME`: the whole name of any institute they are an active member of (as a
     guardian too), ignoring case and spaces; names under 4 characters (code points) are skipped;
   - `TOO_COMMON`: on the list in `apps/api/src/auth/common-passwords.txt` (SecLists' 10,000 most
     common, MIT; plus jantrik, bangladesh and password with digits and years). Server only;
3. the code, else `422 PASSWORD_CODE_INVALID` (wrong, expired or used). Checking the rules first
   means a refused password does not use the code up.

On success, in one transaction: `users.password_hash` and `password_changed_at`, every other
session not yet revoked (expired ones too: a refresh that passed its check just before its session
expired may still commit, and only a revoked session makes it roll back) revoked with
`PASSWORD_CHANGED` in one `UPDATE … RETURNING`, and an audit row (`user_password`, `UPDATE`, no
values).
After commit, those sessions' ids go on the Redis revocation list, so their access tokens stop at
once (a Redis failure there is logged; their refresh fails anyway). The current session, and so
every tab of this browser, stays signed in. The password and the code never reach logs, answers,
audit rows or Redis (the code only as its HMAC).

Password codes cost Jantrik, as login codes do (`platform_sms_logs`), not the institute's SMS
budget. The common-password list is read at start-up: without it the API does not start.
Password login accepts up to 512 code points, as many as a settable password can have when typed
decomposed. `PasswordSettingsService` is the only code that writes `users.password_hash`
(`password-writes.spec.ts` checks it).

## Tenants

- `GET /auth/memberships` lists the user's tenants with their roles. `selectable` means the
  membership is active and the tenant is ACTIVE or TRIAL.
- `POST /auth/switch-tenant {tenantId}` returns an access token with `tid`. It is allowed only
  for a selectable membership, and it also stores the choice on the session, so refreshes keep it.
- A user with exactly one selectable tenant is switched into it automatically at login,
  unless they have a pending invitation.

### Staff invitations

- `POST /staff` creates an `INVITED` membership; no SMS is sent. The response is built from the
  typed input only, so it is the same whether the phone already belongs to someone or not.
  Additions are rate-limited per tenant (`STAFF_INVITES_PER_TENANT_PER_HOUR`, default 30).
- After OTP login, `GET /auth/memberships` shows the institute with `invitation: {roles,
expiresAt}` and `selectable: false`. `/select-institute` and the dashboard show
  "<institute> added you as <role>" with accept / decline.
- `POST /me/invitations/:tenantId/accept|decline` (user-scoped, own rows only): 404 when there is
  no pending invitation, 410 `INVITATION_EXPIRED` after 14 days. Audited. Accept sends
  `{roles}`, the roles the person was shown; the rows are locked and a mismatch (the institute
  changed the roles meanwhile) is 409 `INVITATION_CHANGED`, so nobody accepts roles they did not
  see.
- Admins can `POST /staff/:userId/cancel-invitation` (pending) and `POST /staff/:userId/reinvite`
  (declined or expired). Both are audited; owner invitations are managed by owners only.
- A cancelled invitation keeps the typed name and phone in `staff_profiles` and the audit log
  (no DELETE grant, as for other history). The typed name is a guarantee of the code, not of RLS:
  once someone is an active member, `users_visible` lets that institute read their global row,
  so only the self endpoints may read `users` names or email (see `database.md`, "Global names
  stay private").

## The request pipeline

```
nestjs-cls middleware     AsyncLocalStorage for the request
JwtAuthGuard              @Public() skips; verify JWT + session not revoked → principal
RateLimitGuard            per user (authenticated) or per IP
RolesGuard                @Roles(...)        → current roles from Redis (tenant:{tid}:user:{uid}:roles:v{n})
ModuleGuard               @RequireModule(…)  → enabled modules from Redis (tenant:{tid}:modules)
TenantContextInterceptor  withContext({ tenantId: tid, userId: sub }) around the handler
                          (RequestTransaction.run; @OwnTransaction routes call it themselves):
                            - re-checks tenant ACTIVE/TRIAL + active membership (immediate suspension)
                            - handler runs inside the transaction (services use Db.tx)
                            - error → rollback;  success → commit → afterCommit callbacks
```

- **Role and module changes apply on the next request.** Change them through
  `TenantAccessService` (`setMemberRoles`, `setModuleEnabled`), or call
  `invalidateRolesAfterCommit` after writing memberships directly. The 5-minute TTL is only a
  safety net.
  - **Roles are cached per version.** Each member has a counter `tenant:{tid}:user:{uid}:roles:ver`
    (no expiry: a counter that expired could restart at a number whose stale entry is still
    cached), bumped _after commit_ by every role or status change (staff roles, activate /
    deactivate, invitations sent, answered, re-sent or cancelled, guardian links). `getRoles` reads
    the counter _before_ loading and caches under `…:roles:v{n}`. A request that loaded the old
    roles just before a change committed can only write them under the old version, which is
    never read again, so a demoted person (also one who is still an active guardian) loses the
    role on their next request. A failed bump is logged; the old roles then last at most the TTL.
  - Modules are changed only by the platform; their key is deleted after commit.
  - **Production Redis must use `maxmemory-policy noeviction`.** Evicting these counters, revoked
    sessions or rate-limit keys would silently weaken the checks above.
- **`@UserScoped()`** runs a route with the user context only. Used by `/auth/*`, so account
  routes such as logout work even when the selected tenant is suspended.
- **`@Public()`** routes get no request transaction.
- **`@OwnTransaction()`** routes (sprint 1 P2: the image uploads `PUT /students/:id/photo` and
  `PUT /institute/profile/:slot`) get no transaction from `TenantContextInterceptor`, which runs
  before a route's own interceptors. Otherwise the transaction, and one of the pool's 10
  connections, would be held while multer reads a slow upload and sharp decodes it: on slow 4G a
  5 MB photo outlives the 15 s transaction (a 500 every time), and ten of them would hold every
  connection and fail all other institutes' requests after the 5 s `maxWait`.
  - The guards above still run first (token, rate limits, roles, module).
  - The handler reads the body, applies the upload limit and decodes the image without the
    database, then calls `RequestTransaction.run(fn)`: the same transaction the interceptor opens
    (`withContext` with the same tenant and user, the tenant and membership re-check, `Db.tx`,
    rollback on error, afterCommit after commit), just later and short.
  - Everything that touches the database goes inside `run`. Nothing outside it may use `Db.tx`
    (it throws: no request transaction), and `run` refuses to start inside one.
  - The guards' checks can be a minute old by then (a slow body, the image queue), so the upload
    routes pass `roles` to `run`: in its transaction it re-checks the session (not revoked) and
    that the person still holds one of the route's roles, besides the institute's status and the
    membership. A short `run` before decoding refuses a lost role or a wrong target early.
  - `UploadGuard` bounds the bodies in memory: 16 uploads in flight per process, 2 per person
    (503 `IMAGE_BUSY`), a body not received within 60 s dropped.
  - The CSV imports (student import, device people) still read their uploads inside the request
    transaction; they are small (≤ 1–5 MB) and in the backlog to move the same way.

### Writing a service

```ts
@Injectable()
export class StudentsService {
  constructor(
    private readonly db: Db,
    private readonly sms: SmsService,
  ) {}

  async admit(input: AdmitInput) {
    const student = await this.db.tx.student.create({ data: {/* … */} }); // RLS-scoped
    await this.sms.send(input.guardianPhone, '…'); // queued only after commit
    return student;
  }
}
```

**Rules:**

- Never set the tenant yourself, and never import `withContext` / `withTenant` / `tenantClient`.
  ESLint enforces this.
- Anything with an outside effect (queue jobs, SMS, cache invalidation) goes through
  `RequestContext.afterCommit(fn)`. `SmsService` already does this. Such callbacks are dropped if
  the request fails.
- Write `audit_logs` with **`AuditService.record({ entity, entityId, action, oldValues,
newValues })`**. It uses the request transaction (the audit row commits or rolls back with the
  change) and fills in the tenant and actor.

### Background jobs that touch tenant data

A queue worker has no request. Wrap its work in **`TenantJobRunner.run(tenantId, fn)`**
(`apps/api/src/tenancy`). It opens one RLS transaction for that tenant (with no user), so `Db.tx`
and `afterCommit` work exactly as in a request. The tenant id must come from a job we enqueued
ourselves, never from user input.

- Inside a job, `RequestContext.requireTenantId()` returns the job's tenant. Without an actor
  (the nightly fee dues run), `AuditService.record` writes `actor_user_id = NULL`; outside any
  request or job it still refuses.
- With `{ actorUserId }` the job acts as that person (audit names them); re-check that they still
  hold the role (fee jobs: OWNER/ADMIN for "generate now", recalculation and reminders).

## Access inside a role

`@Roles` decides who may call a route; services narrow it to the rows that person may touch, in
the same request transaction:

- **Teachers, attendance:** only the sections in `section_teachers`.
- **Teachers, marks** (step 10): only the subject and section pairs in `section_subject_teachers`
  (403 `NOT_ASSIGNED`; being the class teacher is not enough). A section's teachers may print its
  tabulation and report cards; only its class teacher writes remarks. OWNER/ADMIN: any.
- **Guardians:** `/me/children/:id/…` (fees, results) answer only for the caller's own children,
  and results only once published; anything else is 404, never 403, so an id reveals nothing.
- **Devices and staff attendance** (step 11, module ATTENDANCE): `/attendance/devices/…`,
  `/attendance/device-people/…`, `POST /attendance/sections/:id/close-from-device` and
  `/staff-attendance/…` are OWNER/ADMIN only (teachers, accountants and guardians get 403).
  Teachers see device arrival times only through the take screen and the today report of their
  own sections. Every change there is audited.

## Tenant-switch safety: `X-Jantrik-Tenant`

A browser tab is bound to the institute it was loaded for. It sends that institute's id as
`X-Jantrik-Tenant` on every API request. `TenantHeaderGuard` answers **409
`TENANT_MISMATCH`** when the header differs from the access token's `tid`, for example when the
session was switched to another institute in another tab and this tab's token has since refreshed.

- **Requests without the header** (mobile apps) are not checked.
- **`@UserScoped` account routes** (`/auth/*`, `/me/preferences`) are not checked either, so
  logout always works.

## The device receiver (no login)

ZKTeco attendance devices cannot log in: the protocol sends only a serial number, over plain
HTTP. So they talk to a separate server, not the API ([devices.md](devices.md)):

- **Its own Nest application** ([`apps/api/src/ingest`](../apps/api/src/ingest)), port
  `INGEST_PORT` (4080). Its own process in production (`node apps/api/dist/ingest-main.js`);
  inside the API process in development (`INGEST_IN_PROCESS`, on by default outside production).
- **No JWT, guards, CORS, cookies or sessions**, and no tenant context. Only `GET` and `POST`
  under `/iclock` reach a route; everything else is 404. Bodies are read by the controller within
  fixed limits (no body parser), and nothing is ever logged from a body or a query string.
- **Its own database login** (`DATABASE_INGEST_URL`, role `jantrik_ingest_app`): no table grants,
  only the four `ingest_*` definer functions, which find the device and its institute from the
  serial number themselves. It never uses the API's `PrismaService` or `Db`
  (`ingest-isolation.spec.ts`), and refuses to start if its login can read `students` or
  `device_punches` or cannot run `ingest_resolve`.
- **The institute in a queued job** comes from the database's answer, never from the request.
- **Its own limits** (table above), keyed by address and by serial number, and server timeouts.
  `INGEST_TRUST_PROXY` works like `TRUST_PROXY` but must never be `true` behind a proxy that
  passes on a client's `X-Forwarded-For` ([decisions-pending.md](decisions-pending.md) →
  Deployment requirements).

## Web client (apps/web)

Code: [`apps/web/src/lib/auth/auth-client.ts`](../apps/web/src/lib/auth/auth-client.ts).

- **Access token in memory only.** Never in localStorage, sessionStorage or a readable cookie. A
  reload restores the session through the refresh cookie (`POST /auth/refresh` with
  `X-Jantrik-Client: web`).
- **Refreshes are serialised across tabs** with the Web Locks API (`jantrik-refresh`):
  - The winner broadcasts the new session on the BroadcastChannel `jantrik-auth`.
  - A tab that waited for the lock reuses a token received meanwhile instead of presenting the
    (already rotated) cookie again.
  - The client refreshes about 60 s before expiry (with jitter), and when a hidden tab becomes
    visible.
- **The boot refresh** ([`boot-refresh.ts`](../apps/web/src/lib/auth/boot-refresh.ts)): on a
  full page load of an institute app page (the `(app)` layout only: never `/login`, `/platform`
  or `/select-institute`), an inline script in the HTML starts `POST /auth/refresh`, then
  `GET /me/context`, while the JavaScript downloads. `AuthClient` takes the result over on its
  first restore (`refresh()`), and `useMeContext` takes the early `/me/context` only when it was
  fetched with that very access token and for the page's institute. The script follows the rules
  above:
  - It runs only when the `jantrik_signed_in` hint is set and Web Locks and BroadcastChannel
    exist. Otherwise it does nothing and `AuthClient` restores as before.
  - It holds `jantrik-refresh`, reuses a session another tab broadcast while it waited, and
    broadcasts the session it got.
  - It keeps listening until the hand-over. Anything it hears after sending its refresh is newer
    than that refresh and wins: a logout (which probably revoked the session it got), or another
    tab's login or institute switch (refreshes take the lock, so a session heard then is one of
    those). Its own result is then neither used nor broadcast.
  - Only `AuthClient`'s first restore (`bootstrap()`) takes the result: timer, visibility and
    401-retry refreshes always go to the API. A session or sign-out that reaches `AuthClient`
    another way first (a broadcast, a login) drops the hand-over, and anything its own channel
    heard before the result arrived wins over it.
  - Its 401 is handled exactly like `AuthClient`'s own (sign out everywhere). Another status
    (429, 5xx) is reported like `AuthClient`'s own too: the "unreachable" screen and retries with
    backoff, not a second request at once. After a network error (seconds earlier, early in the
    load) or a failure of the script itself, `AuthClient` refreshes at once.
  - **Switch:** `JANTRIK_BOOT_REFRESH=off` (also `false`, `0`, `no`) on the web server leaves
    the script out from the next request on, with no rebuild. Off is the previous behaviour: no
    script, and `AuthClient` and `useMeContext` take their usual path.
- **On a 401** the client refreshes once and retries once. If that fails, it signs out.
- **The API can't be reached at startup** (network error or 5xx while restoring the session):
  nobody is signed out. `AuthProvider` reports `unreachable`, the app shows "সার্ভারের সাথে
  সংযোগ হচ্ছে না" with the number of unsent attendance drafts on the phone (a count only, no
  names), and retries with backoff (2–30 s), on the browser's `online` event and when the tab
  becomes visible. Only a real 401 from `/auth/refresh` means signed out.
- **Logout** (or a refresh that returns 401) broadcasts `logout`, and every tab clears its state
  and goes to `/login`.
- **Institute changes are never adopted silently.** When the session's institute stops matching the
  tab's page institute, the tab:
  1. refuses all further API calls (`TenantChangedError`)
  2. clears the React Query cache
  3. shows a blocking dialog ("Institute changed to X")
  4. reloads to `/dashboard`

  The change can arrive as a broadcast from another tab, a refreshed token, or a 409 from the API.

- **Page protection is UX only.** The real boundary is the API (token, guards, RLS).
  - `proxy.ts` redirects to `/login` when the readable, non-secret `jantrik_signed_in` hint
    cookie is missing.
  - `(app)/app-frame.tsx` (inside the `(app)` layout) bootstraps the session, sends users without
    an institute to `/select-institute`, and loads `GET /me/context` once (labels, modules, roles,
    academic year).
  - Sidebar items and page gates use the same `NAV_ITEMS` table (module + roles) as the API's
    guards.

## Configuration

| Variable             | Purpose                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_ACCESS_SECRET`  | at least 32 characters                                                                                                                                        |
| `OTP_PEPPER`         | at least 32 characters                                                                                                                                        |
| `CORS_ORIGINS`       | comma-separated allowlist; browsers may cache a preflight's answer for 2 h (`maxAge` in `app.setup.ts`), so a narrower list reaches open tabs up to 2 h later |
| `PLATFORM_ORIGINS`   | the platform web app's origins: the only ones `/platform/*` answers (each also in `CORS_ORIGINS`); default `http://localhost:3000`, required in production    |
| `COOKIE_SECURE`      | Secure flag on the refresh cookie                                                                                                                             |
| `TRUST_PROXY`        | Express `trust proxy`; set it behind a load balancer so client IPs are right                                                                                  |
| `INGEST_*`           | the device receiver: port, public host and port for the setup guide, `INGEST_TRUST_PROXY`, limits ([devices.md](devices.md))                                  |
| `SMS_PROVIDER`       | `console` in development, `memory` in API tests, `outbox` (Redis list `sms:outbox:<phone>`) for Playwright; all refused in production                         |
| rate-limit variables | see `.env.example`                                                                                                                                            |

In production `SMS_PROVIDER=none` stands in until a gateway is built: every SMS fails and is
recorded as failed. What else production refuses: [deploy.md](deploy.md) → Environment checks.

Demo staff accounts from `pnpm db:seed` use the password `Jantrik@2026` (development only; the
seed refuses to run when `NODE_ENV=production`). Staff change it from the user menu. Demo
guardians log in with OTP, e.g. `01811000101`.

## Platform admins (Jantrik staff)

The `/platform` area has its own login: a password, then an authenticator app (TOTP, with
one-time backup codes), never SMS. Its own session is an httpOnly cookie `jantrik_ps` on
`/platform`: 30 minutes idle, 8 hours at most. It has its own guard and audit log.

- Institute tokens never work there, and the platform cookie never works on institute routes.
- Only the platform's own web origin may call it (`PLATFORM_ORIGINS`): the institute app is in
  `CORS_ORIGINS` too and shares the cookie's site, so CORS alone would let an XSS there use a
  platform session.
- Platform admins are not `users`.

See [platform.md](platform.md).

## Not built yet

- Password reset by an institute admin (staff set their own after a code; a forgotten password
  is replaced the same way)
- Real SMS gateway
- "Logged-in devices" endpoints (the data is stored)

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

**No account enumeration:**

- `otp/request` always answers `202 {"expiresIn":300}`, and its rate limits are applied before
  the user lookup. An SMS is sent only if the phone belongs to a user.
- Every failure of `otp/verify` and `login` (unknown user, wrong code or password, expired or
  burned code, OTP-only account) returns the same `401 Invalid credentials`.
- Password checks always run argon2, against a dummy hash if needed, so timing doesn't leak
  either.

**OTP storage.** Codes are never stored in plain text. Redis holds
`HMAC-SHA256(OTP_PEPPER, phone:code)` with a 5-minute TTL, plus an attempt counter. The 5th wrong
attempt deletes the code. A successful verify deletes it too (single use).

**SMS** goes through `SmsService` → BullMQ queue `sms` → `SmsProvider`:

- `ConsoleSmsProvider` (development) prints the message, including the code, to the API log.
  This is the only place an OTP may appear, and it refuses to start in production.
- Tests use `MemorySmsProvider`.
- The real Bangladeshi gateway will be another `SmsProvider`.

## Rate limits (Redis, all configurable via env)

Per-IP limits are deliberately generous because many users share one IP (carrier CGNAT, school
Wi-Fi). The per-phone and per-account limits are the real protection.

| Limit                            | Default                                                    |
| -------------------------------- | ---------------------------------------------------------- |
| OTP per phone                    | 1 per 60 s, 5 per 15 min, **10 per day** (SMS costs money) |
| OTP requests per IP              | 200 / hour                                                 |
| Login / OTP-verify per IP        | 300 / 15 min                                               |
| Password attempts per identifier | 5 / 15 min                                                 |
| Authenticated requests           | 300 / min **per user**                                     |
| Unauthenticated requests         | 600 / min per IP                                           |

Exceeding a limit returns `429` with `Retry-After`.

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

The retry window works by caching the issued response in Redis for 30 s. It is AES-256-GCM
encrypted with a key derived from the _old_ token, so only someone holding that token can read
it.

Two simultaneous refreshes from two browser tabs still look like a retry and get the same pair,
but only within 30 s. The web client should still serialise refreshes.

**Where the refresh token lives:**

- **Web** (`client: "web"`): only in the cookie
  `jantrik_rt; HttpOnly; Secure; SameSite=Strict; Path=/auth`. The body never contains it.
  `POST /auth/refresh` reads the cookie only when the request also sends
  `X-Jantrik-Client: web`, as extra CSRF protection.
- **Mobile** (`client: "mobile"`): `refreshToken` in the body. Send it back in the body of
  `/auth/refresh`.

**Logout** (`POST /auth/logout`) revokes the session and puts its id on a Redis revocation list,
so the access token dies immediately rather than after up to 15 minutes.

## Tenants

- `GET /auth/memberships` lists the user's tenants with their roles. `selectable` means the
  membership is active and the tenant is ACTIVE or TRIAL.
- `POST /auth/switch-tenant {tenantId}` returns an access token with `tid`. It is allowed only
  for a selectable membership, and it also stores the choice on the session, so refreshes keep it.
- A user with exactly one selectable tenant is switched into it automatically at login.

## The request pipeline

```
nestjs-cls middleware     AsyncLocalStorage for the request
JwtAuthGuard              @Public() skips; verify JWT + session not revoked → principal
RateLimitGuard            per user (authenticated) or per IP
RolesGuard                @Roles(...)        → current roles from Redis (tenant:{tid}:user:{uid}:roles)
ModuleGuard               @RequireModule(…)  → enabled modules from Redis (tenant:{tid}:modules)
TenantContextInterceptor  withContext({ tenantId: tid, userId: sub }) around the handler:
                            - re-checks tenant ACTIVE/TRIAL + active membership (immediate suspension)
                            - handler runs inside the transaction (services use Db.tx)
                            - error → rollback;  success → commit → afterCommit callbacks
```

- **Role and module changes apply on the next request.** Change them through
  `TenantAccessService` (`setMemberRoles`, `setModuleEnabled`). It writes the row and invalidates
  the cache _after commit_. The 5-minute TTL is only a safety net.
- **`@UserScoped()`** runs a route with the user context only. Used by `/auth/*`, so account
  routes such as logout work even when the selected tenant is suspended.
- **`@Public()`** routes get no request transaction.

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

## Tenant-switch safety: `X-Jantrik-Tenant`

A browser tab is bound to the institute it was loaded for. It sends that institute's id as
`X-Jantrik-Tenant` on every API request. `TenantHeaderGuard` answers **409
`TENANT_MISMATCH`** when the header differs from the access token's `tid`, for example when the
session was switched to another institute in another tab and this tab's token has since refreshed.

- **Requests without the header** (mobile apps) are not checked.
- **`@UserScoped` account routes** (`/auth/*`, `/me/preferences`) are not checked either, so
  logout always works.

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
- **On a 401** the client refreshes once and retries once. If that fails, it signs out.
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
  - `(app)/layout.tsx` bootstraps the session, sends users without an institute to
    `/select-institute`, and loads `GET /me/context` once (labels, modules, roles, academic year).
  - Sidebar items and page gates use the same `NAV_ITEMS` table (module + roles) as the API's
    guards.

## Configuration

| Variable             | Purpose                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_ACCESS_SECRET`  | at least 32 characters                                                                                                                |
| `OTP_PEPPER`         | at least 32 characters                                                                                                                |
| `CORS_ORIGINS`       | comma-separated allowlist                                                                                                             |
| `COOKIE_SECURE`      | Secure flag on the refresh cookie                                                                                                     |
| `TRUST_PROXY`        | Express `trust proxy`; set it behind a load balancer so client IPs are right                                                          |
| `SMS_PROVIDER`       | `console` in development, `memory` in API tests, `outbox` (Redis list `sms:outbox:<phone>`) for Playwright; all refused in production |
| rate-limit variables | see `.env.example`                                                                                                                    |

Demo staff accounts from `pnpm db:seed` use the password `Jantrik@2026` (development only; the
seed refuses to run when `NODE_ENV=production`, and no API endpoint sets passwords). Demo
guardians log in with OTP, e.g. `01811000101`.

## Not built yet

- Password set/reset endpoints
- Real SMS gateway
- "Logged-in devices" endpoints (the data is stored)

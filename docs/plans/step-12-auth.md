# Step 12: start the session sooner (a plan for the owner's review)

**Status: plan only, not implemented.** The owner asked on 2026-11-13 for the "start the session
refresh earlier" idea to be written up for review, not built. Everything here touches auth
(`apps/web/src/lib/auth/auth-client.ts`, the refresh cookie, CORS), so it needs approval first
(CLAUDE.md). The rest of step 12 (smaller JavaScript, translations per route, the size budget)
is in PR #9 and changes no auth code.

## Why

A signed-in page opened cold on a phone does this today, one step after another:

1. download the HTML, then the JavaScript (after step 12: 276-298 KB gzip), parse and hydrate;
2. only then `AuthProvider` restores the session: `POST /auth/refresh` (the refresh cookie);
3. then `GET /me/context` (labels, modules, roles, the academic year), because the app shell
   waits for it before rendering a page;
4. then the page's own requests.

Every API call goes to another origin (`api.<domain>`) with `Authorization` or
`X-Jantrik-Client`, so the browser first sends a CORS preflight (`OPTIONS`), and the API sets no
`Access-Control-Max-Age`, so Chrome keeps each preflight for 5 s only. On slow 4G (150 ms per
round trip) each step above costs at least two round trips before the server even starts.

Measured in the step 12 A/B (PR #9, owner dashboard, medians on the throttled phone profile):
see "Numbers" at the end.

## The proposal

### A. Start the refresh while the JavaScript downloads

An inline script in `<head>` (like the theme and density scripts, so it runs before any bundle)
starts the refresh at once when the readable `jantrik_signed_in` hint is present:

- It takes the same Web Lock (`jantrik-refresh`) and follows the same rules as `AuthClient`
  (`auth-client.ts`): another tab's fresh session on the BroadcastChannel `jantrik-auth` is
  reused instead of presenting the already-rotated cookie, and its own result is broadcast.
  This matters: the refresh token rotates on every use and a third presentation of a rotated
  token revokes the whole session (auth.md → Tokens and sessions).
- It keeps the pending result in a closure and hands it over once: `AuthClient.restore()` takes
  the promise (and the boot script forgets it), instead of starting a refresh of its own. The
  access token stays in memory only, as today; no new storage, no readable cookie.
- Failures change nothing: a network error or 5xx makes `AuthClient` run its normal restore
  (the "unreachable" screen and retries); a 401 is "signed out" as today.
- The API URL is the build's `NEXT_PUBLIC_API_URL`, as for the bundle.

Optionally, the same script requests `GET /me/context` as soon as the refresh answers and hands
that promise to `useMeContext` as its first data (same query key), so step 3 overlaps step 1 too.

**Gain to expect:** the refresh (and possibly `/me/context`) is done by the time React hydrates,
so the page's own requests start right after hydration: about two to four round trips (plus
their preflights) off the critical path on slow 4G, roughly 0.5-1 s on the budget pages.

### B. Cache CORS preflights

`app.enableCors({ maxAge: 7200 })` (Chrome honours at most 2 h). Repeated calls to the same URL
in a session (polling, refetches, coming back to a page) skip the `OPTIONS` round trip. It does
not help the very first load (the preflight cache starts empty). Trade-off: a tightened CORS
allowlist reaches open tabs up to 2 h later. Small change; it is listed here because CORS is
security configuration.

### C. Later, with the deployment: the API on the app's own origin

If the reverse proxy served the API under the app's origin (`app.<domain>/api/…`), no request
would need CORS at all, so no preflights. That changes where the refresh cookie lives (its
`Path`, `SameSite=Strict` still holds), the CORS and CSRF assumptions in auth.md, and the
deployment's DNS (chore/deploy-ready plans `api.<domain>`). It belongs with the deployment
decisions; mentioned here because it removes the same round trips more completely than A and B.

## Risks and how the build would cover them

| Risk                                                     | Cover                                                                                                 |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Two tabs opening at once present the same cookie twice   | The boot script takes the same Web Lock and reuses a broadcast session; e2e: two tabs opened together |
| A tab logs out while another's boot refresh is in flight | The boot result is checked against a `logout` broadcast before it is handed over; e2e in session.spec |
| The hint cookie is forged or stale                       | Unchanged: the refresh answers 401 and the page goes to `/login` (the hint is UX only)                |
| Institute switched in another tab                        | Unchanged: `AuthClient` compares the session's institute with the page's, as today                    |
| An inline script grows a CSP problem later               | Same treatment as the theme and density scripts (a hash or nonce if a CSP is added)                   |
| The handover leaks the token to other scripts            | The promise lives in a closure; any script on the page could already call `/auth/refresh` itself      |

Tests: unit tests for the handover and the lock rules; the existing e2e auth and session specs
plus two-tab and logout-race cases; the step 12 A/B before and after, interleaved.

## What the owner decides

1. A (boot refresh): yes / no; with or without the early `/me/context`.
2. B (preflight cache, 2 h): yes / no, or a shorter time.
3. C (same-origin API): now, with the deployment, or not.

## Numbers

From the step 12 measurement (`apps/web/perf/measure.mjs`, the step 12 branch, six cold runs per
page on the throttled phone profile, 2026-11-14): medians, in seconds after the navigation starts.

| Page               | Refresh sent | Refresh answered | `/me/context` answered | Page's first request | Content | Interactive |
| ------------------ | ------------ | ---------------- | ---------------------- | -------------------- | ------- | ----------- |
| Owner dashboard    | 3.17         | 3.37             | 3.58                   | 3.85                 | 4.36    | 5.60        |
| Students           | 3.29         | 3.49             | 3.70                   | 4.05                 | 4.70    | 4.87        |
| Take attendance    | 3.20         | 3.40             | 3.64                   | 3.82                 | 4.82    | 4.83        |
| Fees counter       | 3.17         | 3.36             | 3.58                   | (none)               | 3.92    | 3.93        |
| Marks entry        | 3.10         | 3.31             | 3.52                   | 3.76                 | 4.22    | 4.24        |
| Guardian dashboard | 3.13         | 3.32             | 3.54                   | 3.82                 | 4.39    | 4.64        |

So about 0.7 s passes between the refresh being sent and the page's first request (two calls,
each with its preflight, and the shell's render), all after the JavaScript has arrived. Proposal A
moves the refresh (and optionally `/me/context`) into the time the JavaScript downloads; on
these numbers the pages would show their content about 0.4-0.7 s sooner. The rest of the gap to
3 s is the JavaScript itself (about 285-310 KB on slow 4G) and, on the owner dashboard, the
second batch of requests after the content (backlog.md → Performance).

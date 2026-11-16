# Fix: a refresh racing a lost refresh signs the user out (a plan for the owner's review)

**Status: approved by the owner on 2026-11-15**, with conditions, as its own PR before sprint 1's
P1:

1. **The cached answer.** The answer holding the new tokens:
   - lives in Redis no longer than the grace window (30 s);
   - is encrypted, under a hashed key;
   - is returned only to a request presenting the same old refresh token, for the same session.
2. **Redis unavailable.** The refresh answers 503 (retry). It never signs the user out and never
   revokes.
3. **Measurements.** After the fix, every measurement below is rerun and reported next to today's
   numbers. Target: zero sign-outs.

Real theft detection stays exactly as today. B8 stays as it is. A review subagent is required; CI
must be green; the PR is not merged by Claude.

**How the conditions shape the fix:**

- The answer for retries is stored **before** the rotation is committed, never after. A Redis
  failure at any step therefore commits nothing and answers 503. Storing it after the commit
  would let a failure leave a rotated token with no answer, which a retry would hit as "reuse".
- Every Redis call on the refresh path has a short time limit, so an unreachable Redis gives a
  quick 503, not a long wait.
- The encrypted answer names its session, and that is checked when it is read back.

## What happened

In the full Playwright run for PR #12, the English half of `exams.spec.ts` ended on the sign-in
page. The run's trace, in the admin's browser context, shows:

1. `/dashboard` loads, and its boot script sends `POST /auth/refresh` (07.622 s).
2. 26 ms later the test navigates to `/exams/…`. The browser drops that refresh's answer, so the
   rotated cookie it carried is never stored.
3. The new page's boot script sends the old cookie again (07.722 s) and gets **401**. The page
   signs out.

## Root cause

Two refreshes presenting the same refresh token are not coordinated on the server. The server
decides "a retry I should answer again" or "a stolen token: revoke" before the first refresh has
finished. The 30-second grace rule only works once the first refresh has stored its answer for
retries. `AuthService.refresh` stores it last, after the rotation is committed and after the user,
memberships and new access token have been built. Two paths lead to the same sign-out:

1. **Revoked as reuse.** The second request arrives after the first committed the rotation but
   before it stored its answer. `rotate()` finds the token rotated with no stored answer, decides
   `REUSE_DETECTED`, revokes the whole session, and answers 401.
2. **401 without a revocation.** Both requests read the token before either rotated it. The one
   that loses the database update polls for the winner's stored answer for 1 s (10 × 100 ms),
   then answers 401. When the winner is the request whose page went away and it needs more than
   1 s, the live page gets 401 and signs out. The session lives on, but no browser holds its new
   cookie.

In both cases the browser signs out every tab (`AuthClient` treats 401 as signed out and
broadcasts it).

## Evidence

All of this was measured locally on 2026-11-15 against `main` after PR #12. The scripts are
investigation-only and not committed.

- **API, deterministic.** With the stored answer delayed 300 ms and a second refresh sent once the
  rotation had committed: the first got 200, the second got 401, and the session was revoked
  `REUSE_DETECTED`.
- **API, natural timing (no delays added).** 200 logins, each refreshed twice, the second sent
  0–60 ms after the first:
  - 0–20 ms apart: always fine (both in the same database update);
  - 25–35 ms apart: **8 of 46 sessions revoked**;
  - from 40 ms apart: fine (the answer was stored).

  On an idle machine, then, the window is about 10–15 ms wide.

- **Browser, the two patterns that lose a refresh** (80 tries each):

  | Server                                  | A: a second page load while the boot refresh is in flight | B: closing a tab mid-refresh while another tab waits for the lock |
  | --------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------- |
  | idle (a refresh takes ~50 ms)           | 0 signed out                                              | 0 signed out                                                      |
  | busy (16 heavy readers; ~1.25 s median) | **74 signed out**                                         | **8 signed out**                                                  |

  Of the busy runs' sign-outs, 9 were reuse revocations (path 1) and the rest were path 2.

- **Browser, pattern A at lighter loads** (60 tries each). Refresh times are as the browser saw
  them, so they count only refreshes that got an answer, including the quick 401s, which makes
  them a rough guide only:

  | Background load | Refresh (median / p90) | Signed out   |
  | --------------- | ---------------------- | ------------ |
  | none            | 88 / 157 ms            | 0 of 60      |
  | 2 heavy readers | 111 / 261 ms           | **23 of 60** |
  | 4 heavy readers | 191 / 310 ms           | **10 of 60** |
  | 8 heavy readers | (only quick answers)   | **58 of 60** |

  The curve is not smooth: the load generator hits its own per-user rate limit at higher
  concurrency. The step is clear, though: once a refresh takes longer than the next page needs to
  start, a large share of these reloads sign the user out.

## Can a real user be signed out mid-work, and how often?

**Yes.** It takes two things at once:

- **The browser loses a refresh's answer.** Every full page load starts a refresh at once (the
  boot refresh). Things that lose its answer:
  - reloading the page or tapping a link before it has finished starting (before hydration, a
    tap is a full page load);
  - closing a tab while it refreshes, when another tab is waiting to refresh;
  - the institute picker's full-page jump.
- **The server is slower than the gap before the next refresh arrives.** On an idle server the
  next page's refresh arrives 100–200 ms later, well past the ~15 ms window, so it practically
  never happens (0 of 160 browser tries). When refreshes slow down, it becomes likely:
  - with light background load (refreshes at roughly 100–300 ms), 10–23 of 60
    reloads-during-start signed the user out;
  - at ~1.25 s, 74 of 80 did.

  On a phone on a slow network the next page's refresh arrives later (its HTML takes a round
  trip or more), so the server must be slower still before it matches. A busy morning is enough.
  There is no production yet, so no count per user per day can be measured.

That is the bad combination: impatient reloading and tapping is exactly what people do when the
server is slow. So this bug hits busy mornings (attendance at the start of the day, many schools
at once), not quiet afternoons. When it hits, every tab of that browser is signed out. On path 1
that login is revoked for good. Anything not yet saved is lost, except attendance drafts, which
the phone keeps.

**Related, recorded, not part of this fix:** decision B8. A refresh lost when a tab closes during
load, then presented again more than 30 s later (the next visit), is revoked as reuse by design.
The person returns to a signed-out app. That is the 30-second grace trade-off, not this race;
`keepalive` on the refresh (backlog) would reduce it.

## The fix

**Serialise refreshes of the same token, and build the answer before committing the rotation.**
Server only, in `apps/api/src/auth`:

1. **A per-token lock in Redis.** `SessionService.withRefreshLock(oldHash, fn)`:
   - `SET refresh-lock:<sha256 of the token> <random> NX PX 10000`, polled every 25 ms for up to
     10 s, released with a compare-and-delete (a Lua script) in `finally`;
   - after 10 s it answers **503 `REFRESH_BUSY`** and changes nothing. The web client treats a
     503 as "unreachable" and retries; it is not a sign-out.

   A second request with the same token waits until the first has stored its answer, then
   decides with full knowledge:
   - rotated with a stored answer and the replacement unused → the same answer again (a retry);
   - replacement used, or more than 30 s since the rotation → reuse, revoke (as today).

2. **Build before committing.** Inside the lock, `AuthService.refresh`:
   1. classifies the token (`SessionService.inspect`: invalid, retry or fresh);
   2. for a fresh token, builds the whole answer (user, memberships and active tenant, the new
      refresh token, the access token);
   3. only then commits the rotation (`SessionService.commitRotation`: the same `updateMany …
rotatedAt: null`, new token row and session update as today);
   4. stores the answer for retries, and returns it.

   A failure while building now happens before anything is committed, so the browser's retry
   rotates normally instead of tripping reuse detection.

3. **The 1-second polling loop goes.** Under the lock no second request can reach the update at
   the same time. If an update still finds the token rotated (only a writer outside this code
   could cause that), the answer is 401 without a revocation, as today.

Unchanged:

- the 30-second grace window;
- the "replacement unused" rule;
- reuse detection and revocation after real reuse;
- the cookie, CORS and every client.

Redis is already required for refreshes (the stored answers, revoked sessions). If Redis is down
the refresh fails before committing anything (503/500), where today it fails after committing.

## Tests (each written first and seen failing on today's code where marked)

In `apps/api/test/refresh.e2e-spec.ts`:

- **Path 1, deterministic (fails today):** "a retry arriving after the rotation committed but
  before its answer was stored gets the same pair, and the session stays live". The stored answer
  is delayed 300 ms (a spy on `storeGrace`); the second refresh is sent once the old token's row
  shows `rotatedAt`. Expect both 200, the same `refreshToken`, and `revokedAt` null. Today: 401
  and `REUSE_DETECTED`.
- **Path 2, deterministic (fails today):** "two refreshes at once, the winner slower than 1 s:
  both get the same pair". The stored answer is delayed 1.5 s, and both requests are fired
  together. Expect both 200 and the same pair. Today: one 401.
- **Natural timing (regression guard; fails today with high probability):** 26 logins, each
  refreshed twice 0–60 ms apart. Expect no 401, no revoked session, and the same pair every time.
- **The lock's limit:** with `refresh-lock:<hash>` held by someone else (set in Redis by the
  test), a refresh answers 503 `REFRESH_BUSY` after the wait, and the token is not rotated. The
  wait is made short for the test, through a field like the start-up checks' `retryDelaysMs`.
- **The lock is released:** after a refresh (success, 401, or an error thrown inside), no
  `refresh-lock:*` key is left.
- **A failure while building rotates nothing:** with `listMembershipsFor` failing once, the
  refresh answers 500. The same token then refreshes normally (200), and no session is revoked.
  Today the rotation is committed first, so the retry is treated as reuse.
- **Unchanged rules still hold:** the existing tests for a retry after the replacement was used,
  a retry after 30 s, unknown tokens, logout and the web cookie keep passing unmodified.

Then the full gates, and the e2e suite (where the original flake lived) twice in a row, plus the
review subagent (an auth change).

## Files

- `apps/api/src/auth/session.service.ts`: `withRefreshLock`, `inspect`, `commitRotation`; `rotate`
  goes, as does the polling loop.
- `apps/api/src/auth/auth.service.ts`: `refresh` in the order above.
- `apps/api/test/refresh.e2e-spec.ts`: the tests above.
- `docs/auth.md` → Tokens and sessions: refreshes of one token are serialised; the order of
  building, committing and storing; 503 `REFRESH_BUSY`.
- `docs/decisions-pending.md`: the decision record. B8 stays as it is.

## What the owner decides

1. The lock's limit: 10 s, then 503 (recommended), or longer.
2. Whether this ships before P1 as its own PR (the brief says yes if it is real; it is).

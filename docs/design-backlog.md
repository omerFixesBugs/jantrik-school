# Design backlog (deferred)

Design work stopped on 2026-10-22, after design v2.1 R4 (the dashboard and the students list), at
the owner's request. Everything below is deferred, not dropped. The system to build with is
`docs/design.md` (the v3 kit, the four themes, the tokens); new screens use it (CLAUDE.md).

Where things are:

- Plan: `docs/plans/design-v2.md` (parts 4b to 7 below come from it).
- Critique snapshots: `apps/web/.impeccable/critique/` (24/40 main, 27/40 checkpoint `6fd66ac`,
  28/40 `803ae37`).
- The owner's reference dashboards: `docs/design/references/` (local only, git-ignored).

## 1. Screens not yet redone with the v3 kit

They already use the themes, tokens and restyled base components (cards float everywhere), and
they passed the R1 dark-mode safety sweep. Their layout and composition are not redone.

- **4b, staff screens:** student profile, new admission, import, staff, setup, the setup wizard.
- **5, attendance:** take attendance, today, register, settings, the student report; the teacher
  dashboard and the guardian dashboard. Take attendance and the guardian screens must be excellent
  in **light** (phones in sunlight); today they pass the light contrast checks in
  `e2e/themes.spec.ts` for every preset.
- **6, auth and platform:** login, institute picker, platform login, overview, institutes,
  billing, usage, settings, audit.
- **7, finish:** Impeccable polish; audit and critique against the 24/40 baseline; the finish
  review; the documenter updates `docs/design.md`; a before/after gallery;
  `docs/reports/design-v2-report.md`.

## 2. Decisions waiting for the owner

1. **Time of day.** Registers not yet taken show amber at any hour, even early in the morning.
   Should they turn amber only after a set time, for example after the first period? (The
   greeting already follows the hour.)
2. **Phone order.** Put "নজর দিন" (needs attention) before the section board and the trend on
   phones? Today it starts about 2,200 px down the dashboard.
3. **Delta pills.** Show attendance changes as "%" or as points (পয়েন্ট)? Screen readers already
   say points.
4. **School theme motif.** Give the School theme a motif of its own, as Madrasa has its geometric
   pattern, or keep it plain?
5. **Performance.** Plan the two changes toward 3 s (section 4), including the auth one?

Asked afterwards, on 2026-10-22:

6. **Coaching's own look.** School and Coaching are the same design apart from colour (accent,
   hero gradient, background tint, chart colours; Coaching's dark glass is too faint to see). The
   proposal, keeping one layout and component set:
   - real glass and glow in dark: a near-black ground, a visible purple glow behind the hero and
     the KPI row, translucent cards with a light hairline (no blur filters, for phones);
   - one accent-filled KPI card ("আজ উপস্থিত" in solid purple, white text);
   - a different hero: a dark card with a mesh glow instead of the full-width gradient band;
   - glow on the active nav pill and the chart lines; hatched bars in purple;
   - School stays calm and trustworthy (its motif is decision 4).

## 3. Open critique items

From the 28/40 re-score of `803ae37` and the reviews after it. `93a556e` and `08a77d4` fixed that
re-score's top five issues; neither is re-scored yet.

- **Facts said more than once.** "১ জন টানা ৩ দিন বা বেশি" appears in the insight, the absent
  tile, the attention list and the absentee chip; "৩টি শাখা বাকি" in the insight, the registers
  tile, the attention list and the board. The KPI hints could add new information instead (the
  names of the pending sections, the time of the last register).
- **Help (2/4).** The 90% target and the 3-day streak are never explained on screen.
- **Insight link wrap.** At 1366 the linked clause can wrap and leave "করুন" alone, underlined, on
  the second line.
- **Year card.** At full width on 1366 it is sparse (a long bar over half-empty space).
- **Phone student rows** are four lines (about 120 px) so the ID, the phone and the class line
  are never cut. Putting the ID back on the class line, as a non-shrinking span, gives three
  lines at the cost of truncating class, section and roll on narrow phones.
- **KPI row at 1280 with three-digit counts:** the 7-day chart goes under the figure and the tiles
  grow. Acceptable; nothing overflows.
- **The 7-day chart is hidden on phones** (below 640 px the figure needs the room). Intended.
- **Detector:** flags the hero gradient as a generic AI palette. Kept: the brief asks for a
  gradient hero.
- **Guardian child cards** were not checked live by the critique (it had no guardian session).
- **Coaching and School look alike** (decision 6).

## 4. Performance budget: ≤ 3 s to interactive

390 px phone, 4× CPU, slow 4G, cold cache, signed in. Measured interleaved against the checkpoint
(six pairs, medians; method in `docs/design.md` → Performance budget):

| Page      | Measure           | Checkpoint `6fd66ac` | Now (v2.1) |
| --------- | ----------------- | -------------------- | ---------- |
| Dashboard | content on screen | 5.9 s                | 5.4 s      |
| Dashboard | to interactive    | 6.6 s                | 6.8 s      |
| Students  | to interactive    | 6.5 s                | 6.2 s      |

Both pages are 3.2 to 3.8 s over budget. Today, on a slow phone, about 340 KB of JavaScript
arrives (about 3 s on the link, then about 1 s of CPU), then the session refresh,
`GET /me/context` and the page's data run one after another.

**a. Without an auth change:**

- Measure first what fills the dashboard's gap from content to interactive (0.8 s at the
  checkpoint, 1.5 s now). Candidates: the sections near the first screen, the 60-day history
  and the setup checklist's requests, which all start right after it.
- A smaller first bundle: split the command palette and the charts out of the first load.
- Start the dashboard's near-the-fold sections, the history and the checklist only once the
  first screen has settled.

**b. The auth idea (plan and owner approval first, per CLAUDE.md):** start the session refresh
before React runs, in parallel with the JavaScript download, instead of after it. A small inline
script in the document head would send `POST /auth/refresh` (and then `GET /me/context`) as soon
as the page starts, and the auth provider would take over that request in flight instead of
starting its own. The plan must settle:

- refresh-token rotation: the early call and the provider must never both refresh;
- several tabs refreshing at once;
- the failure and sign-out paths (an expired or revoked session lands on login, as today);
- where the access token lives (in memory only, never in storage);
- the Content Security Policy for the inline script;
- the e2e session tests (`e2e/session.spec.ts` and the auth specs).

## 5. Small technical notes

- Next's TypeScript plugin flags the `formatShare` and `formatOther` function props of
  `apps/web/src/components/story-charts.tsx` ("Props must be serializable for components in the
  'use client' entry file"). Harmless today, since only client components pass them; it clears if
  the props are renamed or the charts stop being a client entry file.

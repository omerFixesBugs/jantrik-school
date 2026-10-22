# Design v2: dense on the desktop, comfortable on phones, Bangla numerals fixed

Branch `feature/design-v2`, from an up-to-date main (`cfe38e3`, step 8 merged).

Same rules as before:

- One commit per part, only after the full local gates pass: lint, typecheck, format check, all
  shared/db/api tests, build, and the whole Playwright suite on 3200/4200, so your dev servers on
  3000/4000 keep running.
- Before each commit, a fresh review agent checks it; then push and watch CI until both jobs pass.
- No merge, no force-push, no `.env` edits.

## Context

You see broken Bangla numerals and a narrow, padded, slow-to-scroll UI. You want a dense,
desktop-first system for staff, a comfortable one for phones and teachers, real dashboards and
power-user tools, applied to every screen, using Impeccable and Playwright, with before and after
shown.

### Bangla numerals: the real cause

I checked at 4× zoom and with Chromium's `CSS.getPlatformFontsForNode`.

- **The font itself is broken.** Hind Siliguri's **১** is malformed at weights 400, 500 and 600
  (weight 700 is fine). It is the same in Google's own TTFs and from the Google Fonts API.
- **It changes meaning.**
  - "২১/২৪" reads as "২৬/২৪", "১১ জন" as "৬৬ জন" and "৳১,১১০" as "৳৬,৬৬০".
  - The register's day numbers and "১৭ অঙ্ক" on the admission form are affected too.
- **Not the cause:**
  - OpenType features: turning off `tnum`, `locl`, `calt`, `liga` and kerning changes nothing.
  - Line-height.
  - A fallback font: Hind Siliguri draws every digit itself.
- **Second defect: Hind Siliguri has no tabular figures.**
  - `tabular-nums` does nothing; Bangla digit widths vary from 49 to 69 units.
  - Numbers therefore cannot align.
- **Fix (your choice): Noto Sans Bengali for all UI text.** ১ is correct at every weight, and
  every digit has the same width.

### Other findings

The demo owner at 1920 px:

- Content stops in a 1200 px column, leaving about 470 px empty.
- The register scrolls sideways even at 1920.
- The admission form scrolls about 1,900 px, with the save button only at the bottom.
- The dashboard has no charts, and its admission card still says "শীঘ্রই আসছে".
- The date field shows "mm/dd/yyyy" in the Bangla UI.
- "অভিভাবক 1" uses an ASCII digit.
- Dark mode was never wired: nothing sets `.dark`, and only the toasts follow the operating
  system.

### Done before this plan (no product code changed)

- **PRODUCT.md:** `docs/PRODUCT.md`, Impeccable's product record, written from CLAUDE.md, the
  design doc and your answers.
- **Direction:** chosen on Impeccable's decision page. The contract is in
  `apps/web/.impeccable/surfaces/`.
- **Before screenshots:** 226, covering every screen at 1366, 1920 and 390 px in bn and en.
  - Taken with real logins on the e2e database (stack on 3200/4200).
  - Stored in the scratchpad at `...\scratchpad\v2\before\`.
- **Research notes:** Carbon, Polaris, Atlassian, Linear, Stripe, Geist, Attio, Notion,
  WCAG/Apple.

## Visual direction (your choice): Blackboard and coloured chalk

- **Shell:**
  - A flat blackboard-green (#173F35) sidebar with chalk-white text and a chalk-yellow bar on the
    active item.
  - A white top bar on a chalk-dust ground (#F4F6F2).
  - White panels on hairlines, 8 px corners, no shadows, no textures.
- **Platform panel:** the same world on black slate (a near-black board), so Jantrik staff always
  know they are in the platform area.
- **Colour roles:**
  - Data series are coloured chalk only: yellow, pink, sky, mint, orange.
  - One fixed mint ramp for every percentage (the board, the register, reports), so 90% looks the
    same everywhere.
  - Status colours are separate and always carry a shape and a word: ✕ absent, ! warning, a clock
    for late, a leave mark.
- **Type:** Noto Sans Bengali everywhere. Anek Bangla only for the wordmark, page titles and the
  board's section letters. Today Anek is on every h1–h3, including sidebar group labels.
- **Font loading (your requirement):**
  - Noto Sans Bengali comes through `next/font/google`: self-hosted and subset per script into
    `bengali` and `latin` files via `unicode-range`, with `display: 'swap'`.
  - Only the Bengali file is preloaded; the Latin file loads when Latin text appears.
  - I'll measure the transfer size of a first load at 390 px with a slow-3G profile against
    today's Hind Siliguri, and report both.
- **Signature: the section board.**
  - Today's attendance as a class × section chart, like the বর্ণমালা chart, on a small green board.
  - Labels come from `useLabel()`, so a coaching centre reads Course/Batch.
  - Every tile shows its % as text; not-taken tiles are dashed; the lowest is ringed in pink.
  - A tile opens that section's register.
  - Choosing a class brightens its series in every chart.
  - It appears on the dashboard, Attendance today and the take-attendance picker. The login keeps
    the alphabet-chart brand panel.
- **Kept from the declined challengers:**
  - status by shape and word;
  - one type family carried by size steps;
  - one fixed ramp;
  - quiet rows with actions on focus or hover (opacity only; always visible on touch);
  - nothing disappears, it cancels (voided invoices, cancelled invitations and inactive students
    stay visible, struck and labelled);
  - the chosen series burns brightest.
- **Dark mode is out of scope for v2:** the toaster is pinned to light, the doc's claim is
  corrected, and `color-scheme: light` is set.

## Principles for `docs/design.md` (the tracked file; CLAUDE.md links it)

1. **One spacing scale** on a 4 px base: 2, 4, 8, 12, 16, 24, 32, 48, 64. Comfortable moves one
   step up.
2. **Two densities from one token set,** one density per page.
3. **Numbers:**
   - right-aligned and tabular;
   - units in the header;
   - "—" when empty;
   - a totals row in `tfoot`.
4. **Use the width:**
   - lists full width;
   - detail pages as a main column plus a 320 px facts column;
   - content left-aligned up to 1760 px.
5. **Forms:**
   - related short fields side by side: 2 columns from 768 px, 3 from 1280 px;
   - never one long column;
   - the save bar always on screen.
6. **Views:**
   - filters live in the URL;
   - saved views are tabs;
   - column visibility is separate from filters;
   - choices are personal.
7. **List and detail:** on desktop a row opens a side peek (Space, ↑↓, Esc), and the full page is
   one click away.
8. **Keyboard:** Ctrl/⌘+K, `/`, `?`, and `g` plus a letter.
9. **Calm chrome:**
   - fewer borders and icons;
   - KPIs compare with the previous period of the same length and show their recent history.

Each rule cites its sources. Impeccable's documenter writes the tokens section from the built
system at the end.

## The system

### Density

`data-density` on `<html>` redefines the size tokens (`--fs-*`, control heights, row heights,
padding), so call sites keep their `text-sm` and `h-*` classes.

| Token                 | Compact bn / en | Comfortable bn / en |
| --------------------- | --------------- | ------------------- |
| Body                  | 15 / 14 px      | 17 / 16 px          |
| Table cell            | 15 / 14 px      | 16 / 15 px          |
| Labels, secondary     | 14 / 13 px      | 15 / 14 px          |
| Smallest (badges)     | 13 / 12 px      | 14 / 13 px          |
| Table row             | 40 / 36 px      | 56 / 52 px          |
| Input, select, button | 36 / 32 px      | 44 px               |
| Panel padding         | 12–16 px        | 16–20 px            |

**Bangla never gets smaller than today:** density comes from spacing.

**Touch:**

- On touch screens (`pointer: coarse`), targets stay at least 44 × 44 px and inputs at least 16 px
  in either density. That avoids iOS zoom on iPads.
- I'll confirm in Playwright that touch emulation matches `pointer: coarse`.

**Defaults:**

- Compact on screens of 1024 px and wider, for owner, admin, accountant and staff (by
  `primaryRole()`) and the platform.
- Comfortable for teachers and guardians, and on every phone.

**First paint:**

- An inline script in `<head>` sets the device default and any saved choice before first paint.
- The role default applies when `/me/context` arrives; the shell only renders after it anyway.
- `suppressHydrationWarning` goes on `<html>`.

**Switching:** from the user menu or Ctrl+K. The choice is kept per browser, by user (your choice).

### Layout

**Shell:**

- The sidebar stays in the DOM on phones (tests read the institute name there).
- The sidebar is 248 px wide and collapses to a 64 px rail.
- The top bar is 48 or 56 px and holds a search _button_ that opens Ctrl+K. It is not a second
  searchbox, which would collide in tests.
- A sticky page header carries the title, breadcrumb and primary actions.
- Sticky offsets are measured into CSS variables, plus `scroll-padding`.

**Forms:**

- A 12-column field grid: 1 / 2 / 3 columns at under 768, 768 and 1280 px.
- Sections are panels.
- A sticky action bar with save, cancel and "unsaved changes".
- Native selects stay; tests use `selectOption`.
- No folded sections: the 3 columns make the admission form short without hiding fields.

**Date field:**

- A Bangla-friendly DD/MM/YYYY field accepts ০–৯, also accepts ISO, and posts a hidden ISO value.
- It keeps every existing `id`.
- It replaces the 12 `type="date"` inputs: student form, year dialog, attendance settings,
  attendance student report, platform billing, institutes.
- Time inputs (shifts) stay native.

**Tables:**

- Sticky header, sortable columns, numbers right-aligned.
- Column chooser and saved views, versioned in storage and keyed by user and institute.
- Filters in the URL, pagination by 50.
- Phones keep cards.

**Register:**

- A bounded-height scroll area, so its header and first column stick inside it.
- Print styles reset that height so all rows print.

**Detail pages** (student profile, institute detail):

- A main column with a sticky in-page section nav, plus a facts column.
- No hidden tabs, so every section stays in the DOM.

**Side peek** on students, staff and platform institutes, using Base UI `Drawer` (non-modal) at
1280 px and wider.

**RTL:** logical properties throughout (`ps-*`, `start-*`, `border-s`). Charts are `dir="ltr"`,
since Arabic comes later.

### Dashboards (real data only)

**Owner and admin dashboard:**

- **KPIs with history:**
  - students, and how many were added this month;
  - present today, with a 30-day line;
  - absent today, and how many have been absent 3+ days running;
  - registers taken, as a meter;
  - absent SMS against the cap.
- **The rest of the page:**
  - the section board;
  - today's absentees, with streak and a call button;
  - a 30-day trend;
  - the getting-started checklist while it is open.
- **Kept for the tests:**
  - the fees and exams cards stay as small "not running yet" cards, since `auth.spec` checks
    them;
  - the attendance card keeps "২৬ / ২৭" and "৯৬% উপস্থিত";
  - "Total students … Across every class" stays as it is.

**Other dashboards:**

- **Teacher:** their sections today, with take-attendance first, and each section's recent trend
  from one call.
- **Guardian:** each child's month strip and present %. The existing `child-calendar` stays.
- **Platform overview:**
  - Content:
    - institutes by status;
    - trials ending within 14 days;
    - overdue invoices (count and taka);
    - SMS cost for 6 months;
    - recent activity.
  - It uses existing endpoints only, the usage endpoint once per month, so there is no new
    database function.

**Charts:** our own SVG components (your choice): sparkline, line/area, bars, meter, the section
board.

- They use tokens for colour and format numbers with `formatCount`/`formatDate`.
- They carry a screen-reader summary, and show "—" with a reason when there is no data.

### Power-user layer

**Ctrl/⌘+K palette:** Base UI `Dialog` plus an inline `Autocomplete`; no new dependency.

- **Pages:** whatever the person may open, by the same `canSee` rules as the sidebar.
- **Actions:**
  - admit;
  - take attendance;
  - import;
  - add staff;
  - language;
  - density;
  - switch institute;
  - sign out.
- **Students:**
  - Searched through the existing `GET /students?q=` (name, code, and guardian phone for staff
    with full access).
  - Bangla digits are normalised first.
  - Roll search would need a database change, so it is not included.
- **Recent items:** kept per user and cleared on logout, since office PCs are shared.
- **Platform:** its own palette, with pages, actions and an institute search.

**Shortcuts:**

- `?` (the list), `/` (search), `g d` / `g s` / `g a` / `g t`, `n` (new).
- `P` / `A` / `L` / `D` and ↑↓ on the attendance sheet.
- Matched by `event.code` (Bangla keyboard layouts), ignoring IME composition and typing in a
  field.

**Inline editing:** only on setup tables, through the existing PATCH endpoints with the same
validation and audit.

- What can be edited:
  - class name;
  - section name and capacity;
  - shift name and times;
  - subject name and code.
- Enter saves, Esc cancels, and errors show in place.
- Nothing about money, status, roles, guardians or enrolment is edited inline.

## API changes (please approve; read-only, no migrations, no auth or RLS change)

1. **`GET /attendance/reports/trend?days=30&sectionId=&bySection=1`** (ATTENDANCE module):
   - **Access:** OWNER and ADMIN see all sections; TEACHER sees only their own. It goes through
     `mySections`, `currentSection` and `assertMayMark`.
   - **Range:** from the later of today−29 and the year's start.
   - **How it counts:**
     - only the first period per section per day;
     - counts by `groupBy`;
     - days from `settings.nonWorkingDays` are marked;
     - percent is null on days with no register.
2. **`GET /attendance/reports/today`** gains an additive `streak` field on each absent student.
   - It counts consecutive school days absent (LEAVE counts only when the institute counts leave
     as absent).
   - Days without a register are skipped, and the count stops at PRESENT or LATE.
   - It is capped at 30, built from one query over the last 60 days.
3. **`GET /students/summary`** (CORE, OWNER/ADMIN, declared before `:id`):
   - active students by class this year;
   - students added per month for 12 months (labelled "যোগ করা", since `created_at` also counts
     imports);
   - counts by status.
4. **`GET /students` list query:**
   - Adds `sort` (code | name | class | roll) and `dir`, plus `status`.
   - Moves from cursor to `page` / `pageSize` (50, at most 100), with `total` on every page.
   - `q`, `classLevelId` and `sectionId` are unchanged.
   - The web is the only client.

**Tests for each:** API e2e tests covering roles, module gating, teacher scope, tenant isolation
(another institute never appears), and empty or new institutes.

## Screens

Every screen gets the tokens and the shell. Specific changes:

- **App shell and dashboard:** as above.
- **Students:**
  - **List:** a dense table with sort, column chooser, saved views and URL filters; a side peek;
    pages of 50.
  - **Profile:** a header of key facts, then a main column and a facts column.
  - **New admission:** 3 columns, with the guardians side by side.
  - **Import:** a wide preview, status tabs with counts.
- **Attendance:**
  - **Take:**
    - comfortable for teachers, with big targets, live counts and a sticky submit bar;
    - keyboard marking on desktop.
  - **Today:** the section board plus the list.
  - **Register:** all 31 days fit at 1920 px; a sticky first column and header; totals in
    `tfoot`; print unchanged.
  - **Settings:** two-column settings with a sticky save bar.
  - **Student report:** a month calendar and trend.
- **Setup** (overview, classes, shifts, groups, subjects, labels, student code): dense tables and
  inline edits.
- **Staff:** a dense table with a side peek. Your own row still has no buttons.
- **Wizard:** comfortable, with a step rail from 1024 px; `wizard-nav-*` IDs stay.
- **Guardian dashboard:** phone first.
- **Login, institute picker, platform login:** the new world, and fixed digits.
- **Platform:**
  - **Overview:** with charts.
  - **Institutes:** a dense list with a peek.
  - **Institute detail:** a main column and a facts column, all actions visible.
  - **New institute:** a multi-column form.
  - **Billing, usage, settings, audit:** dense, with charts. Usage and billing get the 6-month
    bars.
  - Navigation stays visible on phones.

## Tests

**Existing tests:**

- All must stay green: shared 167, db 161, api 253, Playwright 41.
- Where the structure changes, I keep `data-testid`s, accessible names and the pinned text formats.
- Any test edit is listed in its commit with the reason (for example, rows per page 26 → 31; a
  link name that now also appears in the breadcrumb).

**New e2e `numerals.spec`** (bn): dashboard, register, admission form, platform overview.

- **Font identity:** every element containing Bangla digits is drawn by Noto Sans Bengali,
  according to CDP: no Hind Siliguri and no system fallback.
- **Width:** the ten digits have equal width in the body, label, heading and KPI styles.
- **Shape:** ১ and ৬ are drawn at 400/500/600 on a canvas; they must differ, and ১'s ink must be
  at least as tall as ৬'s. A broken ১ fails this.

**Layout check:**

- It now scrolls the page and the shell's scroll area, and checks at each step, instead of only
  the first screen.
- It runs at 360 px (kept), and at 1366 and 1920 px in bn and en on the main staff and platform
  screens.
- A new 44 × 44 px check at 390 px covers every interactive element. Inline text links are exempt,
  as WCAG 2.5.8 allows.
- A print-emulation check for the register.

**Further new e2e tests:**

- Ctrl+K: by name, by Bangla-digit phone, opening a page, role filtering.
- Density: the switch persists and row heights change.
- Column chooser and saved view.
- Inline edit on setup.
- Dashboard charts with data and when empty.

**Unit tests** live in `packages/shared` (Vitest), because the web app has no unit-test runner:

- chart scales;
- density defaults;
- shortcut matching;
- date-field parsing;
- streak and trend calculation.

## Order and commits

0. **Baseline** (screenshots done):
   - Impeccable audit and critique of the "before", with two isolated agents and the detector.
   - Ignore `apps/web/.impeccable/mocks` and `review` in git; keep `surfaces` and `design.json`.
1. **Foundations:**
   - Noto Sans Bengali, and the numerals spec.
   - Tokens: blackboard palette, density, type, spacing.
   - `docs/design.md` principles.
   - Restyled base components.
   - App shell and platform shell (fluid width, sticky header, density switch).
   - Toaster pinned to light.
2. **Kit:**
   - DataTable, side peek, field grid, sticky action bar, date field.
   - Charts and the section board.
   - Command palette and shortcuts.
   - The layout check upgrades.
3. **API:** the four changes above, with their e2e tests and shared types.
   4a. **Dashboard and the students list.**

**CHECKPOINT (your instruction):** once parts 1, 2, 3 and 4a are committed with CI green, STOP.
Publish a private before/after gallery artifact for those screens (dashboard and students list at
1366, 1920 and 390 px, bn and en). Wait for your review before applying the system anywhere else.

4b. **Remaining staff screens** (after your approval): student profile, new admission, import,
staff, setup, wizard. 5. **Attendance:** take, today, register, settings, student report; the teacher and guardian
dashboards. 6. **Auth and platform:** login, picker, platform login, overview, institutes, billing, usage,
settings, audit. 7. **Finish:**

- Impeccable polish.
- Audit and critique again, to compare scores with the baseline.
- The finish-reviewer agent.
- The documenter writes the tokens into `docs/design.md`.
- The before/after gallery, as a private artifact page.
- `docs/reports/design-v2-report.md`.

## Verification

**For each part:**

- Iterate on the changed screens with Playwright MCP.
- Re-run the screenshot sweep at 1366, 1920 and 390 px in bn and en, with real logins on the e2e
  database.
- Compare each screen with its "before".
- Run the full gates, then the review agent, then push and `gh run watch` until both CI jobs are
  green.

**End-to-end, once more at the end:**

- Log in as the demo owner, a teacher, a guardian and the e2e platform admin.
- Walk every screen at the three widths in both languages.
- Check:
  - the numerals at 4× zoom;
  - keyboard use, including the Ctrl+K flows;
  - contrast of the token pairs.

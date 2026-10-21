# Jantrik School design system (v2)

How the web app (and later the mobile app) looks and feels. Tokens live in
[`apps/web/src/app/globals.css`](../apps/web/src/app/globals.css); this file explains them and
the rules for using them. Product facts (who uses it, principles) are in
[PRODUCT.md](PRODUCT.md). v2 replaced v1's look in October 2026; the plan and the before/after
evidence are in [plans/design-v2.md](plans/design-v2.md).

## Who we design for

- **At a desk, all day:** owners and principals, office admins and accountants, on office laptops
  and desktops from 1366 × 768 to 1920 × 1080. They need dense, fast, keyboard-friendly screens.
- **On a phone:** teachers taking attendance in a classroom, often one-handed and in bright light,
  and guardians checking their children, on low-end Android phones and slow networks.
- **Jantrik's own staff** run the platform panel at a desk.

Many people read Bangla first and are not comfortable with software. Bangla is never smaller,
fainter or more cramped than English.

## Principles

Taken from the density guidance of IBM Carbon, Shopify Polaris and Atlassian, and from how
Linear, Stripe, Vercel (Geist), Attio and Notion build dense product screens. Sources are listed
at the end.

1. **One spacing scale on a 4 px base:** 2, 4, 8, 12, 16, 24, 32, 48, 64. Inside a component
   0–8 px, between related items 8–12 px, between sections 16–24 px (compact) or 24–32 px
   (comfortable). Comfortable moves one step up the scale, never off it (Carbon, Atlassian).
2. **Two densities from one set of tokens, one density per page.** Compact for desk work,
   comfortable for phones and teachers (Carbon's productive/expressive split, Polaris "don't
   change density within a page"). See [Density](#density).
3. **Numbers are tabular and right-aligned.** Text left, numbers right, never centred; units in
   the header, the same number of decimals down a column, "—" for nothing, a totals row in
   `tfoot` (Polaris DataTable, Geist table, Stripe).
4. **Use the width.** List and index pages run full width; detail pages are a main column plus a
   facts column (Stripe, Attio); content is left-aligned up to 1760 px and stops growing there
   (Carbon's high-density model, Polaris `fullWidth`).
5. **Forms are wide, short and always savable.** Related short fields sit side by side: one
   column on a phone, two from 768 px, three from 1280 px. No long single column. The save bar
   stays on screen (Polaris FormLayout.Group; Carbon's wide gutter for labelled inputs).
6. **Views are personal and shareable.** Filters live in the URL; saved views are tabs; choosing
   columns is separate from filtering rows; nothing changes for anyone else (Polaris
   IndexFilters, Notion, Attio, Linear display options).
7. **List and detail.** On a desktop a row opens a side peek (Space, ↑↓, Esc) and the full page is
   one click away; on a phone the row opens the page (Linear peek, Attio record preview).
8. **A keyboard layer for people who live in the app:** Ctrl/⌘ K for everything, `/` to search,
   `?` for the shortcut list, `g` then a letter to go somewhere (Linear, Stripe). Shortcuts never
   fire while typing and follow the key's position (`event.code`), so Bangla layouts work.
9. **Calm chrome.** Fewer borders and icons, low-contrast dividers, row actions that appear on
   hover, focus or selection (always visible on touch), status only when it is not the normal
   state (Linear's 2026 refresh).
10. **A number shows where it came from.** A KPI compares with the previous period of the same
    length and shows its recent history; a module that is not running shows "—" and says what
    will appear, never a made-up number (Stripe; PRODUCT.md principle 4).

## Brand

- **Name:** **Jantrik School** / **যন্ত্রিক স্কুল**. The wordmark is Anek Bangla 600.
- **World:** the institute's own theme (below). v2's flat blackboard shell is retired: the
  shell, cards and data now take the institute's preset, light or dark. The blackboard names
  (`board-*`, `chalk-*`) survive only as aliases of theme tokens until their last users are
  rebuilt (design v2.1, R2–R3).
- **Mark:** a tile with **য** in the accent fill; on the hero and the brand panels it inverts
  (hero text colour, the gradient's first stop as its letter). Component: `Logo` / `LogoMark` in
  `src/components/brand.tsx`.
- **The section board:** today's attendance as a class × section chart, like the বর্ণমালা chart
  every child learns from. Every tile shows its percentage as text in the tile's own label colour
  (`ramp-fg-N`), not-taken tiles are dashed, the lowest is ringed, and a tile opens that section's
  register. Labels come from `useLabel()` (Course/Batch at a coaching centre). It lives on the
  dashboard, Attendance today and the take-attendance picker.
- **The alphabet chart** (letters on the hero gradient, one in the hero accent) stays on the login
  brand panel only.
- **The platform panel** (Jantrik staff) keeps its own look whatever an institute or a person
  chose: School, light, with a black slate header (`data-board="slate"`), so nobody mistakes it
  for an institute.

## Themes

Every colour comes from [`packages/shared/src/themes.ts`](../packages/shared/src/themes.ts):
four presets, each designed in light **and** dark, as data. Never use raw hex values in
components; use the tokens (the one exception: the avatar tones in `person-avatar.tsx`, a light and
a dark pair per tone).

| Preset             | Default for                       | Light                                 | Dark                       | Character                                                   |
| ------------------ | --------------------------------- | ------------------------------------- | -------------------------- | ----------------------------------------------------------- |
| **School**         | NCTB Bangla Version (and any new) | white cards on a cool mist, blue      | navy slate, blue           | trustworthy; blue → teal hero gradient                      |
| **Madrasa**        | madrasa types, when added         | ivory and deep green, gold highlight  | green-black, gold          | a faint eight-fold geometric pattern; no living beings      |
| **Coaching**       | Coaching                          | lavender white, vivid purple          | near-black, purple glow    | designed to look its best in dark, but **never forced**     |
| **English medium** | NCTB English Version              | white and warm white, ink black, gold | warm charcoal, ink inverts | minimal and refined; a soft tinted hero instead of gradient |

**Who chooses what:**

- **The institute's preset:** its type's default (`institute_types.default_theme`), or the
  owner's choice (`PUT /settings/appearance`, OWNER only), with an optional **accent** colour.
  An accent goes through the same derivation and checks as the presets' own: the fill, hover,
  soft fill, text ink, ramp and hero are derived from it, its lightness is nudged until every pair
  passes, and a colour that still cannot pass is refused (`422 ACCENT_CONTRAST`; no `#rrggbb` in
  the test sweep is refused today, so this is a safety net).
- **Each person's mode:** Light, Dark or **System**: the default for everyone, coaching included.
  Kept on their account (`users.color_scheme`), so their other devices follow; in the user menu
  and in Ctrl+K. System follows the device live.
- **How it reaches the page:** the root layout inlines `themeCss()` (one rule per preset and mode
  on `[data-theme][data-mode]`, School light also on `:root`; about 22 KB). A head script
  (`src/lib/theme-script.ts`) sets `data-theme`, `data-mode` and an owner's accent variables before
  the first paint, from the last look this browser showed, so a reload never flashes;
  `ThemeProvider` (`src/lib/theme.tsx`) then applies what `/me/context` and the session say.
  `dark:` utilities follow `data-mode`, never the OS media query directly. A dark page prints in
  its preset's light colours.

**Tokens** (shadcn names plus ours, all per preset and mode):

| Token                                                                             | Use                                                                  |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `background`, `card`, `muted`, `border`, `input`                                  | ground, floating cards, quiet fills, hairlines, control outlines     |
| `foreground`, `muted-foreground`                                                  | body text, secondary text (the lightest text allowed)                |
| `primary` / `primary-foreground` / `primary-hover`                                | the accent as a fill (buttons, the active nav pill) and its text     |
| `primary-ink`                                                                     | the accent as text or a thin mark on a surface (links, chart lines)  |
| `link`                                                                            | links: `primary-ink`, or the gold ink when the accent is ink black   |
| `primary-soft`                                                                    | selected rows, soft accent fills                                     |
| `sidebar-*`                                                                       | the shell's sidebar, its active pill (`sidebar-primary`), its hover  |
| `hero-from` / `hero-to` / `hero-foreground` / `hero-muted` / `hero-accent`        | the hero band and brand panels: gradient stops and the text on them  |
| `accent-warm` / `-soft` / `-ink`                                                  | the second, quieter highlight (gold in the madrasa); `-ink` for text |
| `success`, `warning`, `destructive`, `info` (+ `-soft`), `destructive-foreground` | status, the same in every preset (one set per mode)                  |
| `ramp-1…5` / `ramp-fg-1…5`                                                        | the percent tiers and each tier's own label colour                   |
| `chart-1…5`                                                                       | categorical chart series, in that order                              |
| `bloom-1/2`, `shadow-rgb`                                                         | the canvas's two soft blooms; the theme's shadow tint                |

**Contrast is tested, not eyeballed.** `themes.test.ts` checks every preset × mode and a sweep of
39 owner accents: 4.5:1 for every text pair (body and muted text on every surface, text on the
accent fill, the accent as text, the sidebar, hero text on **both** gradient stops, status text on
its soft fill, each ramp tier's label) and 3:1 for control outlines, the focus ring and chart
marks. The e2e `themes.spec.ts` measures what pages actually paint: every staff screen in dark
(School and Coaching), and the teacher's register and the guardian's screen in light in every
preset (phones outdoors).

**Data colours** (the dataviz gates, also in `themes.test.ts`):

- **Percent ramp:** five ordered tiers of one hue (≤87, 88–90, 91–93, 94–96, 97–100), darker for
  more in light mode and brighter for more in dark mode. Even the faintest tier clears 2:1 on the
  card, so a low section never fades away; tiers are at least 0.06 apart in lightness. The same
  present % has the same colour on the board, the register and every report.
- **Series:** `chart-1…5` per preset and mode. Slot 1 is the theme's hue (gold, not ink black, in
  English medium); the order clears colour-blind ΔE ≥ 8 and normal-vision ΔE ≥ 15 between
  neighbours, stays in one lightness band and reaches 3:1 on the card. Use them in order, never
  cycled; past five, fold into "Other". A single-series chart uses `primary-ink`, so it follows an
  owner's accent.

Rules:

- **Status is never colour alone:** absent ✕, late (clock), leave, warning !, always with the word.
  Status colours are separate from the chart series.
- **The warm highlight is never a status colour.**
- **No faded text** (`text-muted-foreground/70` and the like): use `--muted-foreground`.
- **The chosen series burns brightest:** choosing a class highlights its line or bar in every
  chart and dims the rest.
- **Nothing disappears, it cancels:** voided invoices, cancelled invitations and inactive
  students stay visible, struck through and labelled.
- **Browser surfaces are themed:** selection is the warm soft fill, the caret is the accent ink,
  scrollbars are thin and muted, focus is a full-strength ring (below).

## Typography

| Role                                              | Family                                  | Why                                                                                           |
| ------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------- |
| All UI text, tables, forms, numbers               | **Noto Sans Bengali** (variable weight) | Correct ১ at every weight; all digits one width, Bangla and Latin; one family for every level |
| Wordmark, page titles (`h1`), the board's letters | **Anek Bangla 600**                     | The brand's voice; one static weight                                                          |

v1's body face, Hind Siliguri, drew ১ wrongly at weights 400–600 (in Google's own files), so
"২১/২৪" read as "২৬/২৪" and "৳১,১১০" as "৳৬,৬৬০", and it had no tabular figures at all.
`e2e/numerals.spec.ts` fails on any face that does either.

- **Digits:** Bangla digits (০–৯) for dates, times, counts and money in the Bangla UI; ASCII
  digits for phone numbers, student codes, rolls, registration numbers and IDs. A number inside an
  `h1` is wrapped in `font-numeric`, so every digit on every screen is the body face.
- **Weights:** 400 body, 500 labels and nav, 600 headings and emphasis. Headings other than the
  page title (`h2`–`h4`) are the body face, semibold.
- **No letter-spacing on Bangla, no all-caps labels.** Sentence case everywhere.
- **Paragraphs:** at most ~70 characters (`max-w-prose`). Tables can run wider.
- **Loading:** both faces come through `next/font/google`, self-hosted and split by script with
  `unicode-range`, `display: swap`. Only the Bangla files are preloaded: Noto Sans Bengali
  (105 KB, every weight) and Anek Bangla 600 (55 KB). The Latin files (25 KB and 18 KB) load
  only when Latin text appears. v1 preloaded about 735 KB.

### Type scale (by density and language)

The scale switches on `data-density` and `:lang(bn)`; components use Tailwind's `text-*` classes.
Noto Sans Bengali's glyphs are the same size as Hind Siliguri's at the same pixel size, so
**Bangla keeps v1's sizes in compact** and gets a step larger in comfortable; the density comes
from line-height, spacing and row heights.

| Class       | Compact bn  | Compact en  | Comfortable bn | Comfortable en | Use                            |
| ----------- | ----------- | ----------- | -------------- | -------------- | ------------------------------ |
| `text-xs`   | 13.5 / 1.45 | 12 / 1.4    | 14.5 / 1.5     | 13 / 1.45      | Badges, captions only          |
| `text-sm`   | 15 / 1.5    | 13.5 / 1.45 | 16 / 1.55      | 14.5 / 1.5     | Table cells, labels, secondary |
| `text-base` | 16.5 / 1.55 | 14.5 / 1.5  | 17.5 / 1.6     | 16 / 1.55      | Body, inputs on touch          |
| `text-lg`   | 18.5 / 1.45 | 16 / 1.4    | 19.5 / 1.5     | 18 / 1.45      | Page title, panel titles       |
| `text-xl`   | 21 / 1.4    | 18 / 1.35   | 22 / 1.45      | 20 / 1.4       | Section titles                 |
| `text-2xl`  | 25 / 1.35   | 22 / 1.3    | 26 / 1.4       | 24 / 1.3       | KPI values                     |
| `text-3xl`  | 31 / 1.25   | 28 / 1.2    | 32 / 1.3       | 30 / 1.2       | Greeting, big numbers          |
| `text-4xl`  | 37 / 1.2    | 34 / 1.15   | 38 / 1.25      | 36 / 1.15      | Login headline                 |

## Density

`data-density="compact" | "comfortable"` on `<html>` redefines the size tokens. A small inline
script (`src/lib/density-script.ts`) sets it before the first paint from the last density this
browser showed (or the screen width), so pages never jump; `DensityProvider`
(`src/lib/density.tsx`) then applies the signed-in person's choice or their default.

| Token                                 | Compact bn / en     | Comfortable bn / en |
| ------------------------------------- | ------------------- | ------------------- |
| `--control-h` (input, select, button) | 36 / 32 px          | 44 / 44 px          |
| `--control-h-sm` / `-lg`              | 32 / 28, 44 / 40 px | 40, 52 / 48 px      |
| `--row-h` (table row)                 | 40 / 36 px          | 56 / 52 px          |
| `--cell-px` / `--cell-py`             | 12 / 6 px           | 16 / 10 px          |
| `--panel-p` (panel padding)           | 16 px               | 20 px               |
| `--section-gap`                       | 16 px               | 24 px               |
| `--gap` (between tiles and panels)    | 12 px               | 16 px               |
| `--topbar-h` (bn / en)                | 56 / 52 px          | 60 px               |

- **Defaults** (`defaultDensity` in packages/shared): compact on screens ≥ 1024 px for owners,
  admins, accountants and staff (by their most senior role) and for the platform; comfortable for
  teachers, guardians and students, and on every screen under 1024 px.
- **Switching:** the user menu (Ctrl+K from part 2). The choice is kept per browser, per person
  (`jantrik.density.v1.user.<id>`): office computers are shared.
- **Touch floor:** on touch screens (`pointer: coarse`, the primary pointer) every button, input,
  select and menu item is at least 44 px tall and inputs are at least 16 px (no iOS zoom),
  whatever the density. Checkboxes and switches take their label as part of the target. A touch
  laptop driven by a mouse keeps the desktop sizes (WCAG 2.5.8's 24 px still holds).

## Layout

Parts of this section arrive in design v2 part 2 (the kit: data table, side peek, field grid,
sticky action bar, date field, charts, Ctrl+K) and are applied screen by screen after that; see
[plans/design-v2.md](plans/design-v2.md) for what is done.

- **Width:** content is fluid and left-aligned up to 1760 px, with 24 px gutters (16 px on
  phones). List pages use it all; detail pages are a main column plus a 320 px facts column;
  settings pages put the label and help on the left and the control on the right.
- **Forms:** a 12-column field grid: 1 column on phones, 2 from 768 px, 3 from 1280 px. Sections
  are panels. A sticky action bar holds save, cancel and "unsaved changes". Native selects stay
  (they work on every phone). Dates use the Bangla-friendly date field (DD/MM/YYYY, accepts ০–৯
  and ISO, posts ISO).
- **Tables:** sticky header, sortable columns, numbers right-aligned, a column chooser and saved
  views (per browser, per person and institute), filters in the URL, pages of 50, row actions on
  hover/focus. Phones get cards instead.
- **List and detail:** a side peek on desktop (≥ 1280 px) for students, staff and platform
  institutes.
- **RTL later (Arabic):** logical properties (`ps-*`, `start-*`, `border-s`); charts stay
  `dir="ltr"`.

### App shell

```
Desktop (≥ 1024 px)                              Phone (< 1024 px)
┌────────────┬─────────────────────────────────┐ ┌──────────────────────────────┐
│ ▣ যন্ত্রিক │ Home › Group                    │ │ ☰  Title             EN  ◉   │
│  (board)   │ Title       ⌘K  ২০২৬  EN  ◉     │ │    শিক্ষাবর্ষ ২০২৬           │
│ সংক্ষেপ     ├─────────────────────────────────┤ ├──────────────────────────────┤
│ ▸ Dash     │                                 │ │                              │
│ একাডেমিক    │  page content, fluid,           │ │  page content                │
│ ▸ …   soon │  left-aligned, ≤ 1760 px        │ │                              │
│┌──────────┐│                                 │ └──────────────────────────────┘
││Institute ││                                 │   ☰ opens the same board as a
││ User     ││                                 │     left drawer.
│└──────────┘│                                 │
└────────────┴─────────────────────────────────┘
```

- **Sidebar:** the theme's sidebar surface (`sidebar-*`), 248 px wide, collapsible to a 64 px
  rail (labels stay the accessible names). Group labels are quiet `sidebar-muted` text. The
  active item is the accent pill (`sidebar-primary`; no coloured edge bar). Modules not built yet
  say "শীঘ্রই" (on the active pill, in the pill's own text colour). The institute and the person
  sit on the sidebar's bottom rail, so people always know which institute they are changing.
- **Top bar:** the card surface, sticky, exactly `--topbar-h` tall (so sticky table headers sit right under
  it): breadcrumb and page title on the left; the search that opens Ctrl+K (part 2), the academic
  year (plain text: a fact, not a control), the language toggle and the user menu on the right.
- **Skip link:** the first stop on every page jumps to the content.

## Radius and elevation

- Radius: 4 px (small chips), 6 px (buttons, inputs), 8 px (panels, tables, dialogs), full for
  avatars and status pills.
- Flat: surfaces separate by ground and hairline, never by shadow. Only overlays (menus,
  dialogs, the drawer, the toast) lift, with a soft offset shadow.

## Focus

Every interactive element shows a full-strength focus indicator: buttons and links a 2 px
`--ring` ring (the accent ink, 4.5:1 or more on the card in every theme) with a 2 px gap, inputs
a `--ring` border plus a soft halo, items in the sidebar a `--sidebar-ring` ring. Never a faded
ring alone.

## Icons

- **lucide-react** only, stroke 1.75: 16 px inline, 18 px nav, 20 px buttons on a phone.
- Icons support text, they never replace it (the collapsed rail keeps the label as the accessible
  name). Decorative icons get `aria-hidden`. Never unicode glyphs or emoji as icons.

## Motion

- 150–200 ms, only in response to an action: menus, the drawer, the side peek, the sidebar
  collapse, a state change. No entrance animations, no hover lifts.
- `prefers-reduced-motion` drops transitions to 0.

## Components and patterns

- **Avatar:** photo, else initials on a soft chalk colour picked from the name (mint, yellow, sky,
  pink, orange; ink ≥ 7.5:1). Bangla names show the first letter cluster, Latin names two
  initials, honorifics (Md., মোঃ) skipped.
- **Status badge:** a pill, soft background, full-strength text and a dot; shown only when it is
  not the normal state in a list (an "active" pill on every row is noise).
- **KPI:** label, value (`font-numeric`), its change against the previous period of the same
  length, and its recent history where it has one. A module not running shows "—" and what will
  appear.
- **Greeting:** by the hour in Dhaka (`dayPeriod` in packages/shared): শুভ সকাল 05:00–11:59, শুভ
  দুপুর 12:00–16:59, শুভ সন্ধ্যা 17:00–20:59, শুভ রাত্রি 21:00–04:59. English says "Good evening"
  at night ("Good night" is a goodbye).
- **Empty state:** one sentence on what is empty, one on what to do, and the button when there is
  an action.
- **Errors:** what happened and how to fix it, no apologies; inline under the field when
  possible.
- **Phone lists:** cards, not tables; a phone number is a 44 px call button (`tel:`) with the
  number visible.

## Copy

- Bangla first, the way people speak to a respected colleague (আপনি).
- Name things by what people do: "হাজিরা নিন", not "Attendance module". Buttons are verbs.
- Labels that differ by institute type come from `useLabel()` (Class/Course, Section/Batch).

## Sources

- IBM Carbon: data table sizes (24/32/40/48/64 px rows), productive type set (14 px base), spacing
  scale, 2x grid and condensed gutters:
  carbondesignsystem.com/components/data-table/usage, /elements/typography/type-sets,
  /elements/spacing/overview, /elements/2x-grid/overview.
- Shopify Polaris: 4 px grid, full-width index pages, one density per page, IndexTable and
  DataTable alignment rules, IndexFilters saved views, FormLayout groups:
  shopify.dev/docs/apps/design/layout and the Polaris component guidance on GitHub.
- Atlassian: spacing scale (8 px base), body 14/20, per-component compact spacing:
  atlassian.design/foundations/spacing, /foundations/typography.
- Linear: command menu, `g` navigation, peek, display options vs filters, the 2026 calmer chrome:
  linear.app/docs/select-issues, /docs/peek, /docs/display-options,
  linear.app/now/behind-the-latest-design-refresh.
- Stripe: search syntax in the URL, comparison periods, table alignment and footers:
  docs.stripe.com/dashboard/search, /payments/analytics/acceptance.
- Vercel Geist: 14/20 body, tabular figures for numbers, "—" for empty cells, footer rows:
  vercel.com/geist/typography, /geist/table.
- Attio and Notion: saved views personal until shared, column visibility per view, side peek:
  attio.com/help (views, records), notion.com/help/views-filters-and-sorts.
- WCAG 2.2: target size 24 px (2.5.8 AA) and 44 px (2.5.5 AAA, our phone rule); Apple HIG 44 pt.

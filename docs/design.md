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

## Brand: blackboard and coloured chalk

- **Name:** **Jantrik School** / **যন্ত্রিক স্কুল**. The wordmark is Anek Bangla 600.
- **World:** the institute's own blackboard. A flat blackboard-green shell, chalk-white type on
  it, and coloured chalk as the only data colours. No chalk textures, no hand-drawn fonts, no
  ruled-paper tables: the board lends colour, type, density and one signature, never the layout or
  the controls.
- **Mark:** a tile with **য** and a chalk-yellow dot (the spark): the board tile on light
  grounds, a white tile on the board itself. Component: `Logo` / `LogoMark` in
  `src/components/brand.tsx` (`onBoard` for the sidebar).
- **Signature: the section board.** Today's attendance as a class × section chart, like the
  বর্ণমালা chart every child learns from, drawn on a small blackboard. Every tile shows its
  percentage as text, not-taken tiles are dashed, the lowest is ringed in chalk pink, and a tile
  opens that section's register. Labels come from `useLabel()` (Course/Batch at a coaching centre).
  It lives on the dashboard, Attendance today and the take-attendance picker.
- **The alphabet chart** (chalk letters on the board, one in chalk yellow) stays on the login
  brand panel only.
- **The platform panel** (Jantrik staff) uses the same world on black slate
  (`data-board="slate"`), so nobody mistakes it for an institute.

## Colour

Light only: v2 has no dark theme (the class-based `dark:` variant is kept so shadcn's leftover
`dark:` classes never switch on with the OS). Never use raw hex values in components. Every text
pair below was measured at 4.5:1 or more.

| Token                                  | Value                 | Use                                                     |
| -------------------------------------- | --------------------- | ------------------------------------------------------- |
| `--board`                              | `#173F35`             | Sidebar, section board (slate: `#1F2724`)               |
| `--board-raised`                       | `#21503F`             | Hover and the active item on the board                  |
| `--board-deep`                         | `#133429`             | The board's bottom rail (institute and user)            |
| `--board-foreground` / `--board-muted` | `#E6EEE9` / `#A9C2B8` | Text on the board (9.9:1, 6.2:1)                        |
| `--background`                         | `#F4F6F2`             | Chalk-dust ground behind panels                         |
| `--card`                               | `#FFFFFF`             | Panels, tables, dialogs                                 |
| `--foreground`                         | `#14231E`             | Body text (15:1 on the ground)                          |
| `--muted-foreground`                   | `#56665F`             | Secondary text, the lightest text allowed (5.6:1)       |
| `--primary`                            | `#173F35`             | Primary buttons, focus ring (11.7:1 on white)           |
| `--primary-hover`                      | `#21503F`             | Primary button hover; primary stays green on slate too  |
| `--link`                               | `#1E6B55`             | Text links (6.4:1)                                      |
| `--primary-soft`                       | `#E5EFE9`             | Selected rows, soft fills                               |
| `--accent-warm` (chalk yellow)         | `#F2C641`             | The spark, "today", the active nav icon; ink text on it |
| `--success` / `-soft`                  | `#1A7340` / `#E3F4E9` | Present, paid, active (5.2:1 on soft)                   |
| `--warning` / `-soft`                  | `#A14A06` / `#FDF0E1` | Late, needs attention (5.4:1 on soft)                   |
| `--destructive` / `-soft`              | `#B42318` / `#FDECEA` | Absent, overdue, errors, delete                         |
| `--info` / `-soft`                     | `#2F6F94` / `#E4F0F7` | Leave, neutral notices                                  |
| `--border`                             | `#DCE3DF`             | Hairlines between surfaces                              |
| `--input`                              | `#7F918A`             | Input and select outlines (3.3:1, WCAG 1.4.11)          |

**Coloured chalk (data series only):** yellow `#F2C641`, pink `#E8739A`, sky `#5AB0D8`, mint
`#6CC6A0`, orange `#EE8F3A` for fills (on the board, bars), and the `-ink` variants (yellow
`#8A6D0C`, pink `#C24E76`, sky `#2A77A3`, mint `#2B8460`, orange `#B05E15`) for lines and text on
white (all ≥ 4.5:1). `--chart-1…5` map to the inks in the order mint, orange, sky, yellow, pink,
which passes the colour-blind separation checks (dataviz `validate_palette.js`): use the series
in that order, never cycled.

**Percent ramp (one for every percentage):** ≤87 `#2B5A4E`, 88–90 `#3E7A63`, 91–93 `#57A07F`,
94–96 `#7CC4A0`, 97–100 `#A8E2C4`. White text on the first two steps, ink on the rest. The same
present % has the same colour on the board, the register and every report.

Rules:

- **Status is never colour alone:** absent ✕, late (clock), leave, warning !, always with the word.
  Status colours are separate from the chalk series.
- **Chalk yellow is never a status colour**, and text on it is ink, never white.
- **No faded text** (`text-muted-foreground/70` and the like): use `--muted-foreground`.
- **The chosen series burns brightest:** choosing a class highlights its line or bar in every
  chart and dims the rest.
- **Nothing disappears, it cancels:** voided invoices, cancelled invitations and inactive
  students stay visible, struck through and labelled.
- **Browser surfaces are themed:** selection is chalk yellow, the caret is board green, scrollbars
  are thin and muted, focus is a full-strength ring (below).

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

- **Sidebar:** the blackboard, 248 px wide, collapsible to a 64 px rail (labels stay the
  accessible names). Group labels are quiet chalk-muted text. The active item is the raised board
  colour with a chalk-yellow icon (no coloured edge bar). Modules not built yet say "শীঘ্রই". The
  institute and the person sit on the board's bottom rail, so people always know which institute
  they are changing.
- **Top bar:** white, sticky, exactly `--topbar-h` tall (so sticky table headers sit right under
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
`--ring` ring with a 2 px gap (11.7:1), inputs a `--ring` border plus a soft halo, items on the
board a chalk-yellow ring. Never a faded ring alone.

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

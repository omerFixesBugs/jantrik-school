# Jantrik School design system (v3)

How the web app (and later the mobile app) looks and feels, as it is built. v3 is design v2.1
(October 2026): four institute themes in light and dark, floating cards, pills, story charts,
KPI tiles v3 and the shell v3. It replaces v2's blackboard shell. Colour lives in
[`packages/shared/src/themes.ts`](../packages/shared/src/themes.ts), every other token in
[`apps/web/src/app/globals.css`](../apps/web/src/app/globals.css); this file explains them and the
rules for using them. Product facts (who uses it, principles) are in [PRODUCT.md](PRODUCT.md).
v2's plan and evidence are in [plans/design-v2.md](plans/design-v2.md).

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
10. **A number shows where it came from.** A figure says what it is compared with, in words,
    beside the change, and shows its recent history where it has one; a module that is not
    running shows "—" and says what will appear, never a made-up number (Stripe; PRODUCT.md
    principle 4).

## Brand

- **Name:** **Jantrik School** / **যন্ত্রিক স্কুল**. The wordmark is Anek Bangla 600.
- **World:** each institute looks like itself: one of four themes (below), each in light and
  dark, on one system of floating cards, pills and story charts. It refuses the grey admin
  template, gradient stat tiles that say nothing, and forcing anyone into dark.
- **Mark:** a tile with **য** in the accent fill; on the hero and the brand panels it inverts
  (hero text colour, the gradient's first stop as its letter). `Logo` / `LogoMark` in
  `src/components/brand.tsx`.
- **The section board:** today's attendance as a class × section chart, like the বর্ণমালা chart
  every child learns from (see [Components](#components-and-patterns)). It lives on the
  dashboard, Attendance today and the take-attendance picker.
- **The alphabet chart** (letters on the hero gradient, one in the hero accent) stays on the login
  brand panel only.
- **The platform panel** (Jantrik staff) keeps its own look whatever an institute or a person
  chose: School, light, no institute accent, with a black slate board (`data-board="slate"` on
  its root), so nobody mistakes it for an institute (`usePlatformLook` in `src/lib/theme.tsx`;
  the head script forces it on `/platform` too).

## Themes

Every colour comes from `packages/shared/src/themes.ts`: four presets, each designed in light
**and** dark, as data. Neutrals are chosen per preset and mode; everything that follows the accent
is derived. Never use raw hex values in components; use the tokens (the one exception: the avatar
tones in `person-avatar.tsx`, a light and a dark pair per tone).

| Preset             | Default for                       | Accent           | Light                              | Dark                              | Character                                                    |
| ------------------ | --------------------------------- | ---------------- | ---------------------------------- | --------------------------------- | ------------------------------------------------------------ |
| **School**         | NCTB Bangla Version (and any new) | blue `#2563eb`   | white cards on a cool mist         | navy slate                        | trustworthy; blue → teal hero gradient (hue −70°)            |
| **Madrasa**        | madrasa types, when added         | green `#166534`  | ivory-green ground, gold highlight | green-black, gold                 | the girih lattice on the sidebar and hero; no living beings  |
| **Coaching**       | Coaching                          | purple `#7c3aed` | lavender white, pink highlight     | near-black, glass cards over glow | designed to look its best in dark, but **never forced**      |
| **English medium** | NCTB English Version              | ink `#1c1b19`    | white on warm white, gold data     | warm charcoal, the ink inverts    | minimal; a soft tinted hero instead of a gradient; gold ramp |

**Who chooses what:**

- **The institute's preset:** its type's default (`institute_types.default_theme`), or the
  owner's choice (`PUT /settings/appearance`, OWNER only), with an optional **accent** colour.
  An accent goes through the same derivation and checks as the presets' own (`accentTokens`,
  `fitAccent`): the fill, hover, soft fill, text ink, ramp and hero are derived from it, its
  lightness is nudged until every pair passes in both modes, and a colour that still cannot pass
  is refused (`422 ACCENT_CONTRAST`). A very dark accent in dark mode inverts to a light fill with
  dark text, so a button never disappears into the card. An ink-black accent would make links
  read as body text, so `link` takes the warm gold ink instead.
- **Each person's mode:** Light, Dark or **System**: the default for everyone, coaching included.
  Kept on their account (`users.color_scheme`, `PATCH /me/preferences`), so their other devices
  follow, and in other tabs of the same browser. System follows the device live. Light/dark is
  one tap in the top bar (from 640 px), all three in the user menu and Ctrl+K.

**How a look reaches the page:**

1. The root layout (`src/app/layout.tsx`) inlines `themeCss()`: one rule per preset and mode on
   `[data-theme][data-mode]` (School light also on `:root`), plus a print rule per preset that
   puts a dark page in its light colours. The test keeps it under 28 KB.
2. A head script (`src/lib/theme-script.ts`) sets `data-theme`, `data-mode` and an owner's accent
   variables (`<style id="theme-accent">`) before the first paint, from the last look this
   browser showed (`jantrik.theme.v1.last`), so a reload never flashes. Only variable names and
   `#rrggbb` values pass, so a tampered cache cannot inject CSS.
3. `ThemeProvider` (`src/lib/theme.tsx`) then applies what `/me/context` and the session say,
   rewrites the whole accent sheet (a cached accent never outlives its look), and remembers the
   look for the next first paint.
4. Signing out, or the session ending, calls `resetLook()`: the next person on this browser starts
   from School and their own device's light or dark.

`dark:` utilities follow `data-mode`, never the OS media query directly, and never apply in print.

**Tokens** (shadcn names plus ours, all per preset and mode):

| Token                                                                             | Use                                                                     |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `background` (= `canvas`), `card`, `muted`, `border`, `input`                     | ground, floating cards, quiet fills and tracks, hairlines, outlines     |
| `foreground`, `muted-foreground`                                                  | body text, secondary text (the lightest text allowed)                   |
| `primary` / `primary-foreground` / `primary-hover`                                | the accent as a fill (buttons, the active nav pill, today's column)     |
| `primary-ink` (= `ring`, `accent-foreground`)                                     | the accent as text or a thin mark on a surface (links, chart lines)     |
| `link`                                                                            | links: `primary-ink`, or the gold ink when the accent is ink black      |
| `primary-soft` (= `accent`)                                                       | selected rows, icon chips, soft accent fills                            |
| `sidebar-*`                                                                       | the sidebar card, its active pill (`sidebar-primary`), its hover        |
| `hero-from` / `hero-to` / `hero-foreground` / `hero-muted` / `hero-accent`        | the hero and brand panels: gradient stops and the text on them          |
| `accent-warm` / `-soft` / `-ink`                                                  | the second, quieter highlight (gold, pink in coaching); `-ink` for text |
| `success`, `warning`, `destructive`, `info` (+ `-soft`), `destructive-foreground` | status, the same in every preset (one set per mode)                     |
| `ramp-1…5` / `ramp-fg-1…5`                                                        | the percent tiers and each tier's own label colour                      |
| `chart-1…5`                                                                       | categorical chart series, in that order                                 |
| `bloom-1/2`, `shadow-rgb`                                                         | the canvas's two soft blooms; the theme's shadow tint (black in dark)   |

The blackboard names of v2 (`board-*`, `chalk-*`) are still emitted as aliases of these tokens
(`board` = `sidebar`) until their last users are rebuilt. New code does not use them.

**Contrast is tested, not eyeballed.** `packages/shared/src/themes.test.ts` checks every preset ×
mode and, for every preset, a sweep of 39 owner accents (twelve hues at three lightnesses, plus
black, grey and a bright yellow); each accepted accent must pass every check in both modes, and at
most two may be refused. Pairs: 4.5:1 for every text pair (body and muted text on the ground, the
card and the muted fill; text on the accent fill and its hover; the accent as text; the sidebar
and its active pill; hero text, muted and accent on **both** gradient stops; status text on the
card and on its soft fill; the warm ink; each ramp tier's label) and 3:1 for control outlines,
the focus ring, `chart-1…3` and the strongest ramp tier on the card. The e2e `themes.spec.ts`
measures what pages actually paint.

## Data colours

The dataviz gates, also in `themes.test.ts`.

- **Percent ramp:** five ordered tiers of one hue, fixed bands (`percentRampStep` in
  `packages/shared/src/charts.ts`): below 88, 88–90, 91–93, 94–96, 97–100. Darker for more in
  light mode, brighter for more in dark mode. Even the faintest tier clears 2:1 on the card and
  the sidebar, so a low section never fades away; tiers are at least 0.06 apart in lightness;
  each tier carries its own label colour at 4.5:1. English medium's ramp is gold
  (`rampAccent`), not the ink. The same present % has the same colour on the board, the register
  and every report.
- **Series:** `chart-1…5` per preset and mode. Slot 1 is the theme's hue (gold, not ink black, in
  English medium). Neighbours clear colour-blind ΔE ≥ 8 (protan and deutan) and normal-vision
  ΔE ≥ 15, all five sit in one lightness band, and the first three reach 3:1 on the card. Use them
  in order, never cycled; past five, fold into "Other". A single-series chart uses `primary-ink`,
  so it follows an owner's accent.
- **Status:** `success`, `warning`, `destructive`, `info`, one set per mode, identical in every
  preset. Status carries meaning, never identity, and is separate from the series.

Rules:

- **Status is never colour alone:** absent ✕, late (clock), leave, warning !, always with the word.
- **The warm highlight is never a status colour.**
- **No faded text** (`text-muted-foreground/70` and the like): use `--muted-foreground`.
- **The chosen series burns brightest:** choosing a class highlights its line or bar and dims the
  rest (to 30 %).
- **Nothing disappears, it cancels:** voided invoices, cancelled invitations and inactive
  students stay visible, struck through or marked, and labelled.
- **Browser surfaces are themed:** selection is the warm soft fill, the caret is the accent ink,
  scrollbars are thin and muted, focus is a full-strength ring (below).

## Typography

Fonts come through `next/font/google` (`src/app/layout.tsx`), self-hosted and split by script
with `unicode-range`, `display: swap`. The stacks switch on the page language (`globals.css`).

| Language / role        | Family                                                           | Loading                                            |
| ---------------------- | ---------------------------------------------------------------- | -------------------------------------------------- |
| Bangla pages, all text | **Noto Sans Bengali** (variable), Latin falls to Jakarta         | **preloaded** (the only preload)                   |
| English pages          | **Plus Jakarta Sans**, Bangla names fall through to Noto         | not preloaded: Bangla is the first paint           |
| Arabic (`lang="ar"`)   | **Noto Naskh Arabic**                                            | not preloaded; only if Arabic text shows           |
| Display (Bangla)       | **Anek Bangla 600**: wordmark, `h1`, the greeting, board letters | not preloaded (performance budget); titles swap in |
| Display (English)      | Plus Jakarta Sans 600                                            | —                                                  |

v1's body face, Hind Siliguri, drew ১ wrongly at weights 400–600, so "২১/২৪" read as "২৬/২৪", and
it had no tabular figures. `e2e/numerals.spec.ts` fails on any face that does either.

- **Digits:** Bangla digits (০–৯) for dates, times, counts and money in the Bangla UI; ASCII
  digits for phone numbers, student codes, rolls, registration numbers and IDs. Numbers use
  `font-numeric` (tabular, body face) or `num` (tabular and right-aligned); a number inside an
  `h1` is wrapped in `font-numeric`, so every digit is the body face.
- **Weights:** 400 body, 500 labels and nav, 600 headings and emphasis. **Big figures are light
  (300):** KPI values (36 px, 40 px from 640 px), the hero's week figure (`text-5xl`), the year's
  progress (`text-3xl`) and the donut's total (`text-2xl`). Noto's figures are drawn for it.
- **Headings:** `h1` and `.font-heading` take the display stack at 600; `h2`–`h4` are the body
  face, semibold (the greeting is an `h2` with `font-heading`).
- **No letter-spacing on Bangla, no all-caps labels.** Sentence case everywhere.
- **Paragraphs:** at most ~70 characters (`max-w-prose`). Tables can run wider.

### Type scale (by density and language)

The scale switches on `data-density` and `:lang(bn)`; components use Tailwind's `text-*` classes.
**Bangla keeps v1's sizes in compact** and gets a step larger in comfortable; the density comes
from line-height, spacing and row heights.

| Class       | Compact bn  | Compact en  | Comfortable bn | Comfortable en | Use                            |
| ----------- | ----------- | ----------- | -------------- | -------------- | ------------------------------ |
| `text-xs`   | 13.5 / 1.45 | 12 / 1.4    | 14.5 / 1.5     | 13 / 1.45      | Pills, captions only           |
| `text-sm`   | 15 / 1.5    | 13.5 / 1.45 | 16 / 1.55      | 14.5 / 1.5     | Table cells, labels, secondary |
| `text-base` | 16.5 / 1.55 | 14.5 / 1.5  | 17.5 / 1.6     | 16 / 1.55      | Body, card titles, inputs      |
| `text-lg`   | 18.5 / 1.45 | 16 / 1.4    | 19.5 / 1.5     | 18 / 1.45      | Page title (top bar)           |
| `text-xl`   | 21 / 1.4    | 18 / 1.35   | 22 / 1.45      | 20 / 1.4       | Section titles                 |
| `text-2xl`  | 25 / 1.35   | 22 / 1.3    | 26 / 1.4       | 24 / 1.3       | Greeting (phone), donut total  |
| `text-3xl`  | 31 / 1.25   | 28 / 1.2    | 32 / 1.3       | 30 / 1.2       | Greeting, year progress        |
| `text-4xl`  | 37 / 1.2    | 34 / 1.15   | 38 / 1.25      | 36 / 1.15      | Login headline                 |

KPI figures use a fixed `text-[2.25rem]` / `sm:text-[2.5rem]` and the hero's week `text-5xl`
(Tailwind's default), outside the density scale: a figure is read at a glance, not in a line.

## Density

`data-density="compact" | "comfortable"` on `<html>` redefines the size tokens. A small inline
script (`src/lib/density-script.ts`) sets it before the first paint from the last density this
browser showed (or the screen width), so pages never jump; `DensityProvider`
(`src/lib/density.tsx`) then applies the signed-in person's choice or their default.

| Token                                 | Compact bn / en              | Comfortable bn / en |
| ------------------------------------- | ---------------------------- | ------------------- |
| `--control-h` (input, select, button) | 36 / 32 px                   | 44 / 44 px          |
| `--control-h-sm` / `-xs` / `-lg`      | 32 / 28, 28 / 24, 44 / 40 px | 40, 32, 52 / 48 px  |
| `--row-h` (table row)                 | 40 / 36 px                   | 56 / 52 px          |
| `--cell-px` / `--cell-py`             | 12 / 6 px                    | 16 / 10 px          |
| `--panel-p` (card padding)            | 16 px                        | 20 px               |
| `--section-gap`                       | 16 px                        | 24 px               |
| `--gap` (between tiles and cards)     | 12 px                        | 16 px               |
| `--topbar-h`                          | 56 / 52 px                   | 60 px               |

- **Defaults** (`defaultDensity` in packages/shared): compact on screens ≥ 1024 px for owners,
  admins, accountants and staff (by their most senior role) and for the platform; comfortable for
  teachers, guardians and students, and on every screen under 1024 px.
- **Switching:** the user menu and Ctrl+K. The choice is kept per browser, per person
  (`jantrik.density.v1.user.<id>`): office computers are shared.
- **Touch floor:** on touch screens (`pointer: coarse`) every control is at least 44 px tall and
  inputs are at least 16 px (no iOS zoom), whatever the density. Checkboxes and switches take
  their label as part of the target. A touch laptop driven by a mouse keeps the desktop sizes.

## Layout and the app shell

- **Width:** `main` is fluid and left-aligned up to 1760 px, with 24 px gutters (16 px under
  640 px), `--section-gap` between blocks. List pages use it all; detail pages are a main column
  plus a 320 px facts column; settings pages put the label and help on the left and the control
  on the right.
- **Forms:** a 12-column field grid: 1 column on phones, 2 from 768 px, 3 from 1280 px. Sections
  are cards. A sticky action bar holds save, cancel and "unsaved changes". Native selects stay.
  Dates use the Bangla-friendly date field (DD/MM/YYYY, accepts ০–৯ and ISO, posts ISO).
- **Tables:** see [the data table](#components-and-patterns). Phones get cards instead.
- **RTL later (Arabic):** logical properties (`ps-*`, `start-*`, `border-s`); charts stay
  `dir="ltr"`.

### App shell (`src/components/app-shell.tsx`)

```
Desktop (≥ 1024 px)                                Phone (< 1024 px)
 ╭────────────╮                                    ┌──────────────────────────────┐
 │ ▣ যন্ত্রিক  │ Home › Group          (canvas)     │ ☰  Title        ⌕  EN  ◉     │
 ├────────────┤ Title   ( ⌕ Search… )  ২০২৬ ☾ EN ◉ │    শিক্ষাবর্ষ ২০২৬            │
 │ সংক্ষেপ     │                                    ├──────────────────────────────┤
 │ (● Dash )  │  ╭─────────────╮ ╭──────╮ ╭──────╮  │  page content                │
 │ একাডেমিক    │  │ hero        │ │ card │ │ card │  │                              │
 │  …   soon  │  ╰─────────────╯ ╰──────╯ ╰──────╯  └──────────────────────────────┘
 ├────────────┤                                      ☰ opens the same sidebar as a
 │ Institute  │                                        left drawer (84 %, ≤ 320 px).
 │ User       │
 │ ⇤ Collapse │
 ╰────────────╯
```

- **Sidebar:** a floating card on the canvas (`bg-sidebar`, card radius, hairline,
  `shadow-card`, the girih pattern in the madrasa), sticky and full height with a 12 px inset:
  248 px wide, collapsible to a 64 px rail (labels stay the accessible names, `title` shows them).
  Group labels are quiet `sidebar-muted` text. Nav items are full pills at `--control-h`; the
  active one is the accent fill (`sidebar-primary`, no coloured edge bar), others hover in
  `sidebar-accent`. Modules not built yet say "শীঘ্রই" in an outlined pill (on the active pill, in
  the pill's own text colour). The institute (name and type) and the person sit at the bottom,
  above the collapse button, so people always know which institute they are changing.
- **Top bar:** on the canvas, not a card (`bg-background/90`), sticky, exactly `--topbar-h` tall
  (so sticky table headers sit right under it): breadcrumb (from 640 px, not on the dashboard)
  over the page title on the left; on the right the search pill that opens Ctrl+K (288 px with
  its label from 1024 px, an icon below), the academic year as plain text (a fact, not a control;
  from 768 px), the light/dark toggle (from 640 px), the language toggle and the user menu.
- **Phone header:** the menu button, the title with the academic year under it (one line,
  truncated), then search, language and the user menu; light/dark moves into the user menu.
- **Skip link:** the first stop on every page jumps to `#main`.
- **Loading:** `ShellSkeleton` draws the same frame (sidebar card, top bar, card skeletons).

## Surfaces

- **Cards float** (`src/components/ui/card.tsx`, `data-slot="card"`): `rounded-card` (20 px, 16 px
  under 640 px), a hairline `border`, `bg-card` and `shadow-card`: a contact shadow and a wide soft
  one, tinted by the theme's `shadow-rgb`. In dark the tint is black and the hairline does the
  work. Padding is `--panel-p` (75 % for `size="sm"`). Dashboard panels, KPI tiles, the hero,
  the data table, the side peek and empty states all use this surface.
- **Radius:** card 20/16 px; `rounded-xl` (10 px) for icon chips, board tiles and list rows;
  8 px for the board inside its card, dialogs and menus; 6 px for buttons and inputs; 4 px for
  small chips; full for pills, nav items, segmented controls, the search pill and avatars.
- **Shadows:** `shadow-card` at rest, `shadow-card-hover` for a lifted card and the side peek;
  `shadow-xs` / `-sm` for small raised controls (the search pill, the chosen segment);
  `shadow-md` / `-lg` for overlays.
- **The canvas:** two radial blooms of the theme (`bloom-1` top start, `bloom-2` top end, 85 %)
  on a fixed layer behind everything (`body::before`): not `background-attachment: fixed`, so
  phones do not repaint on scroll, and no blur filters. Never the only thing behind text. Hidden
  in print.
- **The hero** (`DashboardHero`): `bg-linear-to-br` from `hero-from` to `hero-to` with
  `hero-foreground` text, or English medium's soft tint (a pale gold over the card in light, the
  card into `muted` in dark).
- **The madrasa's pattern** (`.girih`): an eight-fold star lattice in `primary-ink` at 7 %, as a
  CSS mask, so it follows light and dark, behind the content of the sidebar and the hero. Other
  presets draw nothing. No living beings.
- **Coaching glass:** in coaching dark, every `data-slot="card"` is 86 % card over the blooms.
  Translucency only, no `backdrop-filter`: blur costs cheap phones every scroll frame.
- **Print:** only `.print-area` prints (the register), on landscape A4, black on white, fills
  kept (`print-color-adjust`), off days hatched; the blooms are dropped and a dark page prints in
  its preset's light colours.

## Components and patterns

- **KpiTile v3** (`src/components/dashboard/kpi.tsx`): a floating card (a link when it opens
  something, then it lifts): an icon chip (36 px, `primary-soft` / `primary-ink`) and the label;
  the figure big and light (`font-numeric`, 300), with a smaller muted suffix ("/ ২৭") that wraps
  rather than overflowing; then the delta pill and, in muted `text-xs`, what it is compared with;
  then a meter row, an aside (a half gauge, hidden under 640 px where the hint says the same) or
  a hint. A `count` counts up once (below); the final text holds the width from the first frame
  and is what screen readers get. Loading is a skeleton, a failed load says so, and "—" (with a
  spoken "not yet") means nothing to show. `KpiPlaceholder` is a dashed card for a module not
  running yet: its name and what will appear.
- **DeltaPill** (`src/components/kit/pill.tsx`): ↗ or ↘ (— for no change) and the size of the
  change, no sign. **Its colour follows the meaning, not the direction:** `better` says which way
  is good, so more absences is red although the number went up; no change is neutral. `label` is
  the whole sentence for screen readers ("২.৪% বেশি, …"); the arrow and number are hidden from
  them.
- **Pill:** a rounded label (`rounded-full`, `text-xs`, 500) in the soft fill of its meaning.
  Tones: `neutral` (muted), `accent` (primary-soft / primary-ink), `success`, `warning`,
  `destructive`, `info`, each a tested ink-on-soft pair. Status pills carry an icon as well as the
  word (`StatusMark` in `students/page.tsx`); in a list, status shows only where a row is not
  "active" (a column of "active" is dropped).
- **SegmentedControl** (`src/components/kit/segmented-control.tsx`): a pill track in `muted`,
  the chosen segment a card pill with an `input` ring and `shadow-sm`, semibold; the others muted
  text. A radio group: one tab stop, the arrows move the choice, Home and End jump to the ends,
  modifier keys stay the browser's. Used for আজ | সপ্তাহ | মাস on the board and the trend.
- **The section board** (`src/components/section-board.tsx`): on the sidebar surface
  (`bg-board`) inside its card. A row per class (the class name is a button that selects the
  class, `aria-pressed`), a tile per section: the section's letter in the display face and its
  percentage as text in the tile's own label colour (`ramp-N` / `ramp-fg-N`). Not taken: dashed
  outline. The lowest (of two or more): a `destructive` ring and a "lowest" pill. A tile opens
  that section's register. A legend shows the five bands as text. Labels come from `useLabel()`
  (Course/Batch at a coaching centre).
- **The trend chart** (`TrendChart` in `src/components/charts.tsx`): present % by school day. A
  smooth line that never invents a high or a low between two days (Steffen's monotone cubic,
  `monotonePath`), 2 px in `primary-ink`, drawing in once; a soft wash under it (22 % to 0); the
  previous period's same school days as a dashed muted ghost; the target (90 %,
  `ATTENDANCE_TARGET`) as a dotted labelled line; a legend when there is a ghost or a target. The
  domain runs from a multiple of 5 below the lowest value to 100 (`percentDomain`). Only the last
  and the lowest point are labelled (the lowest red only when under the target). A crosshair
  snaps to the nearest day on pointer and keyboard with a floating tooltip; every chart has a
  table view. Missing days are gaps, never zeros; days off leave the line but stay in the table.
  Axis labels are measured once the font arrives, so the plot leaves just the room they need.
- **Hatched columns** (`HatchedColumns` in `src/components/story-charts.tsx`): a few periods
  (this week's school days). History is hatched on the `input` mid-tone (3:1 on the card); the
  one that matters (today) is solid `primary`, with its value above it unless the chart is
  `decorative` (inside a KPI tile, whose text says the numbers). A missing day is a short dashed
  stub; a true zero a 2 px hairline. Hatching (`hatch` utility, 135°) is a texture, so meaning
  never rests on colour alone.
- **Half gauge** (`HalfGauge`): a part of a whole on a half circle (registers taken, SMS against
  the cap): a `border` track, the share in `primary` (or `warning`), round caps, the figure under
  the arc; `role="meter"` with the whole sentence as its value text.
- **Donut or bar list, never both wrong:** a whole split into five parts or fewer is a `Donut`:
  a ring in `chart-1…5` (in the order given, 2 px gaps), the total light in the middle, and a list
  beside it with every part's count and share (pointing at a part brings it forward). More than
  five is a `BarList` (one bar per category in its own order, `primary-ink`, 12 px with a 4 px
  rounded end, the value at the tip), never a fold into "other" (`StudentsByClass` in
  `src/components/dashboard/principal.tsx`).
- **Sparkline** (`Sparkline`): a KPI's recent history in the de-emphasis ink, the latest point in
  the accent with a card ring. Decorative.
- **Attention list** (`AttentionCard`): what needs the principal first, from `attentionItems` in
  `packages/shared/src/dashboard.ts`, most urgent first: students absent 3+ school days running
  (severity 3, `destructive` chip), SMS held back by the cap and registers not in yet
  (2, `warning`), sections under the target this week (1, accent), the next setup step (0). Each
  row is a link at least `--control-h` tall: icon chip, the sentence, up to three names in muted
  text, a chevron. When all is well, one calm line ("সব ঠিক আছে, …").
- **Term timeline** (`TermTimeline`): where the academic year stands (`yearProgress`): the percent
  light and big, "week N of M", days left; a track in `muted` filled in `primary` with today as a
  ring; the exams an institute of this type usually holds (`TYPICAL_EXAMS`: half-yearly in June,
  annual in November for NCTB schools) as hollow dashed markers, named in a list ("usually in
  June") until the exams module schedules the real ones. A `progressbar` with the whole sentence.
- **Data table** (`src/components/data-table.tsx`): a floating card; a sticky header under the
  top bar (from 1280 px, unless it scrolls sideways); sortable headers; numbers `num`; rows that
  open on click or Space/Enter with ↑↓ between them; the open row in `primary-soft`; row actions
  hidden until hover or focus (always shown on touch); a column chooser and saved views per
  browser, person and institute; filters in the URL; pages of 50. Row height and padding come
  from the density tokens.
- **Side peek** (`src/components/side-peek.tsx`): from 1280 px, a floating card fixed beside the
  list (`min(26rem, 40vw)`, under the top bar, `shadow-card-hover`); the list makes room and stays
  usable (not a modal). Esc or the close button shuts it; the full page is one link away. Below
  1280 px a row opens its page. Used for students, staff and platform institutes.
- **Appearance settings** (`src/app/(app)/setup/appearance/page.tsx`, owners): the four presets
  as a radio group, each with its name, what it suits, and a light and a dark thumbnail drawn from
  its real tokens; a few accent swatches per preset plus a custom colour input. The colour is
  checked live by `fitAccent`; the nudged colour is what is shown ("adjusted to …") and saved; a
  refusal (`ACCENT_CONTRAST`) is said in words; reset returns to the preset's own accent. Each
  person still picks light, dark or System for themselves.
- **Avatar:** photo, else initials on a soft tone picked from the name (ink ≥ 7.5:1). Bangla
  names show the first letter cluster, Latin names two initials, honorifics (Md., মোঃ) skipped.
- **Greeting:** by the hour in Dhaka (`dayPeriod` in packages/shared): শুভ সকাল 05:00–11:59, শুভ
  দুপুর 12:00–16:59, শুভ সন্ধ্যা 17:00–20:59, শুভ রাত্রি 21:00–04:59. English says "Good evening"
  at night ("Good night" is a goodbye).
- **Empty state:** one sentence on what is empty, one on what to do, and the button when there is
  an action.
- **Errors:** what happened and how to fix it, no apologies; inline under the field when
  possible; a dashboard part that failed says so with a retry.
- **Phone lists:** cards, not tables; a phone number is a 44 px call button (`tel:`) with the
  number visible.

## Dashboards

The principal's dashboard (`src/app/(app)/dashboard/page.tsx`, owners and admins who see
attendance) reads as a story: today in one line, what needs them, the week against the one
before, where the year stands. Everyone else gets the greeting, their figures and what is coming.

**Composition, top to bottom:**

1. **The hero:** today's date in both calendars (the Bangla calendar date in an outlined pill),
   the greeting by name, the insight, the day's jobs (take attendance first), and on the end
   side the present % of the last 7 days with its delta pill "vs the 7 days before".
2. Banners only when they apply: attendance kept on this phone and not yet sent; SMS held back.
3. **Five KPI tiles** (2 columns on a phone, 3 from 768 px, 5 from 1280 px): students (with how
   many were added this month), present today (`/ counted`, delta vs the last 7 days' average,
   this week's school days as hatched columns), absent today (a destructive pill for long
   absences), registers taken (`/ total`, a half gauge), SMS today (`/ cap`, a half gauge that
   turns warning when messages are held or the cap is reached; the full row on a phone).
4. **Two columns** from 1280 px (3 : 2). Main: the section board (today, week or month) and the
   trend (week or month, against the period before and the target). Side: the attention list,
   today's absentees, students by class.
5. **The term timeline**, then getting started and the modules still to come.

**Rules:**

- **One comparison basis, named plainly:** the last 7 days against the 7 days before
  (`splitPeriods`, `periodPercent`, weighted by students), and today against the last 7 days'
  average. Every delta says its basis in words beside it; a percentage change is in points.
- **The insight is facts, never filler** (`dashboardInsight`): at most three, most useful first:
  registers in (or all in), present of those counted, guardians to call; on a quiet day how the
  week moved (only if by a point or more). A day off says so; before setup it says what to set up.
  Always true and never empty. A clause that asks for something links to where it is done.
- **Say a thing once where it can be acted on:** the insight says the day in words (its clauses
  link to where each is done), the tiles carry the figures, the board and the trend the detail.
  The attention list leaves out the setup step because "getting started" on the same page says
  it, and the students list has no chip repeating its result count.
- **Choosing a class** on the board narrows the absentees and the trend to that class.
- **Deferred below the fold** (`Deferred` in `principal.tsx`): the trend, students by class and
  the term timeline render when they come within 400 px of the viewport, a sized skeleton until
  then (nothing jumps). The 60-day history by section is fetched only then, or when the board's
  week or month is chosen; the setup checklist waits for today's report.

## Motion

Three authored moments, each once (`globals.css`, `src/lib/use-count-up.ts`):

| Moment                 | What                                                                                                  | Timing                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **A card lifts**       | `lift`: 2 px up and `shadow-card-hover`, on pointers that hover only                                  | 150 ms, `cubic-bezier(.16,1,.3,1)` |
| **A figure counts up** | `useCountUp`: from zero the first time it comes into view, once per mount; later changes show at once | 600 ms, exponential ease-out       |
| **A line draws in**    | `draw-in`: the trend's line (`pathLength="1"`)                                                        | 700 ms, `cubic-bezier(.16,1,.3,1)` |

Otherwise 150–200 ms, only in response to an action: menus, the drawer, the side peek, the
sidebar collapse (200 ms), a state change, a dimmed series. No entrance animations.

**Reduced motion:** `prefers-reduced-motion: reduce` zeroes every transition and animation in the
base layer, so each lands on its final state; the count-up shows the final number throughout (and
without IntersectionObserver too). Screen readers never hear a count.

## Focus

Every interactive element shows a full-strength focus indicator: buttons, links, pills and cards
that are links a 2 px `--ring` ring (the accent ink, 3:1 or more on the card in every theme,
tested) with a 2 px offset; inputs a `--ring` border plus a soft halo; items in the sidebar and
the board a `--sidebar-ring` ring; links on the hero a `hero-foreground` ring. Never a faded ring
alone.

## Icons

- **lucide-react** only, stroke 1.75: 16 px inline, 18 px nav and icon chips, 20 px buttons on a
  phone.
- Icons support text, they never replace it (the collapsed rail keeps the label as the accessible
  name). Decorative icons get `aria-hidden`. Never unicode glyphs or emoji as icons.

## Accessibility rules

- **Never colour alone:** status has an icon or shape and a word; deltas have an arrow and a
  spoken sentence; the lowest tile has a ring and a word; not taken is dashed; history is
  hatched; charts label their points and have a table view; donut and bar parts are listed with
  their numbers.
- **44 px targets on touch** (`--touch-min`), whatever the density; 16 px inputs.
- **AA in every theme and mode:** 4.5:1 text, 3:1 controls and marks, for all four presets in
  light and dark and every accepted owner accent (`themes.test.ts`); pages measured by
  `e2e/themes.spec.ts`.
- **Light first:** dark is never forced; System is the default, and light is excellent on a
  phone outdoors.
- Every page passes the 360 px overflow check (`e2e/layout.spec.ts`).

## Performance budget

**Target: ≤ 3 s to interactive on a 390 px phone with 4× CPU throttling and slow 4G.**

Median of three cold-cache runs, signed in, with Chrome DevTools throttling (CPU 4×; 150 ms RTT,
1.6 Mbps down); "interactive" is the main content on screen followed by 2 s without a long task.
The checkpoint is commit `6fd66ac` (design v2 part 4a), measured the same way.

| Page      | Checkpoint | Now (v2.1), to interactive | Budget | Status      |
| --------- | ---------- | -------------------------- | ------ | ----------- |
| Dashboard | 7.05 s     | 5.6 s                      | 3 s    | over budget |
| Students  | 7.1 s      | 4.9 s                      | 3 s    | over budget |

What is deferred today:

- **Fonts:** only Noto Sans Bengali is preloaded; Anek Bangla, Plus Jakarta Sans and Noto Naskh
  Arabic load when their text appears (titles show in the body face for a moment and swap).
- **The dashboard below the fold:** the trend, students by class and the term timeline render
  when near the viewport; the 60-day history and the setup checklist are fetched after the first
  screen's own data.
- **No paint costs on phones:** the canvas is a fixed layer without blur, coaching glass has no
  backdrop filter, hover lifts only on hover-capable pointers.
- **Theme CSS** is inlined once (under 28 KB) so there is no theme request and no flash.

Both pages are still over budget; the gap is flagged here until it is closed, not hidden. What
remains on a slow phone: about 340 KB of JavaScript (about 3 s on the link, then about 1 s of CPU),
then the session refresh, `GET /me/context` and the page's data one after another. Closing it
needs a smaller first bundle (the palette and the charts split out) and starting the session
refresh before React runs (an auth change: owner approval first).

## Copy

- Bangla first, the way people speak to a respected colleague (আপনি).
- Name things by what people do: "হাজিরা নিন", not "Attendance module". Buttons are verbs.
- Labels that differ by institute type come from `useLabel()` (Class/Course, Section/Batch).
- Comparisons name their basis in words ("গত ৭ দিনের গড়ের তুলনায়"), never a bare arrow.
- Calm when all is well: say so in one line, do not invent work.

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
- Machado, Oliveira and Fernandes (2009): the colour-vision simulation behind the series gate.

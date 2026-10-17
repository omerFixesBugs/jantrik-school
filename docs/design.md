# Jantrik School design system

How the web app (and later the mobile app) should look and feel. Tokens live in
[`apps/web/src/app/globals.css`](../apps/web/src/app/globals.css); this file explains them and
the rules for using them.

## Who we design for

Principals, madrasa muhtamims, coaching-centre owners, teachers and guardians in Bangladesh. Many
are not comfortable with software, most use a phone, many read Bangla first. Screens are often
small, bright (outdoors) and on slow networks.

The app should feel **trustworthy, warm, calm, modern and easy**. It should not look like a
generic admin template. Every decision below follows from that:

- **Calm:** one primary colour, lots of white space, no decorative gradients, little motion.
- **Warm:** a turmeric accent, friendly copy, greetings, initials avatars with soft colours.
- **Trustworthy:** deep green (the colour of a blackboard and of the flag), consistent layout,
  the institute's name always visible, nothing that looks like an advert.
- **Easy:** big tap targets, plain Bangla, one obvious next action per screen, empty states that
  say what to do.

## Brand

- Name: **Jantrik School** / **যন্ত্রিক স্কুল**. Wordmark is set in the display face
  (Anek), weight 650.
- Mark: a rounded green tile with the letter **য** in white and a turmeric dot (the "spark").
  Component: `Logo` in `src/components/brand.tsx`.
- Signature: the **বর্ণমালা (alphabet chart)** pattern, a grid of Bangla letters like the chart
  every child learns to read from. It appears only on the login brand panel, in chalk-white on
  green with a single turmeric letter. Do not repeat it elsewhere; it is our one bold element.

## Colour

Colours are CSS variables on `:root` (light) and `.dark` (dark), exposed to Tailwind as
`bg-primary`, `text-muted-foreground`, etc. Never use raw hex values in components.

| Token                     | Light     | Dark      | Use                                              |
| ------------------------- | --------- | --------- | ------------------------------------------------ |
| `--background`            | `#F4F7F6` | `#0D1614` | App canvas (behind cards)                        |
| `--card` / `--popover`    | `#FFFFFF` | `#14201D` | Surfaces                                         |
| `--foreground`            | `#15231F` | `#E4EDEA` | Body text (green-black, not neutral black)       |
| `--muted-foreground`      | `#5A6B66` | `#97A9A3` | Secondary text (≥ 4.5:1 on card and background)  |
| `--primary`               | `#0E5E50` | `#4DBFA4` | **Blackboard green**: buttons, links, active nav |
| `--primary-foreground`    | `#FFFFFF` | `#05261F` | Text on primary                                  |
| `--primary-soft`          | `#E2F0EC` | `#173A33` | Active nav background, selected rows, icon tiles |
| `--accent-warm`           | `#E7A019` | `#F0B840` | **Turmeric**: brand spark, "today", highlights   |
| `--accent-warm-soft`      | `#FBF0D6` | `#3A2F15` | Soft turmeric backgrounds                        |
| `--border` / `--input`    | `#DCE5E2` | `#26352F` | Hairlines, input borders                         |
| `--ring`                  | `#0E5E50` | `#4DBFA4` | Focus ring (with 35% alpha halo)                 |
| `--success` / `-soft`     | `#1E7F45` | `#5CC98A` | Saved, present, paid, active                     |
| `--warning` / `-soft`     | `#B45309` | `#F59E5B` | Due soon, partially paid, needs attention        |
| `--destructive` / `-soft` | `#B42318` | `#F97066` | Errors, absent, overdue, delete                  |
| `--sidebar`               | `#FFFFFF` | `#101B18` | Sidebar surface                                  |

Rules:

- **Turmeric is never a status colour.** Warnings are orange-brown (`--warning`), so people never
  confuse "brand highlight" with "something is wrong". Use turmeric at most once or twice per
  screen.
- Text on turmeric is `--foreground`, never white.
- Don't fade text with opacity (`text-muted-foreground/70`): it drops below WCAG AA. Use
  `--muted-foreground` as the lightest text colour.
- Status colours always come with an icon or a word, never colour alone (colour-blind users,
  sunlight).
- Soft (`-soft`) backgrounds carry the full-strength colour as text: `bg-success-soft
text-success`.
- Dark mode: add the `dark` class on `<html>`. Every token has a dark value; components must not
  hard-code light colours.

## Typography

Two families, both with full Bangla and Latin coverage, loaded with `next/font`:

| Role                        | Family                                     | Why                                                                                      |
| --------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Body, UI, tables, forms     | **Hind Siliguri** 400/500/600              | Very legible Bangla at small sizes, open counters, clear conjuncts                       |
| Display: headings, wordmark | **Anek Bangla** (variable, `wdth` 100–112) | Contemporary, slightly wide; Latin and Bangla designed together, so mixed headings match |

`font-heading` selects Anek. Headings use `wdth` 108 (`.font-heading` sets
`font-variation-settings`), which gives them personality without a third family.

### Size scale

Bangla glyphs have a lower effective x-height (the matra and below-base forms take space), so the
**Bangla UI uses larger small sizes and more line-height**. The scale switches on `:lang(bn)`
automatically; components just use Tailwind's `text-*` classes.

| Class       | Latin (en) | Bangla (bn) | Use                                                   |
| ----------- | ---------- | ----------- | ----------------------------------------------------- |
| `text-xs`   | 12.5 / 1.5 | 13.5 / 1.6  | Badges, captions. Never for anything people must read |
| `text-sm`   | 14 / 1.5   | 15 / 1.65   | Secondary text, table cells, labels                   |
| `text-base` | 16 / 1.6   | 16.5 / 1.7  | Body, inputs (≥ 16 px stops iOS zoom)                 |
| `text-lg`   | 18 / 1.5   | 18.5 / 1.6  | Card titles                                           |
| `text-xl`   | 20 / 1.4   | 21 / 1.5    | Section titles                                        |
| `text-2xl`  | 24 / 1.3   | 25 / 1.4    | Page titles                                           |
| `text-3xl`  | 30 / 1.2   | 31 / 1.35   | Greeting, big numbers                                 |
| `text-4xl`  | 36 / 1.15  | 37 / 1.3    | Login headline                                        |

Rules:

- **Minimum readable text is `text-sm`.** `text-xs` is for badges and timestamps only.
- Weights: 400 body, 500 labels and nav, 600 headings and emphasis. No 700+ in body text: heavy
  Bangla clogs.
- Sentence case everywhere. **No all-caps labels** (Bangla has no case; English all-caps reads as
  shouting next to it).
- No letter-spacing on Bangla text, ever (it breaks conjuncts).
- Digits follow the CLAUDE.md rule: Bangla digits for dates/counts/money in the bn UI, ASCII for
  phones, codes, rolls and IDs. Identifiers use `tabular-nums`, not a monospace face.
- **Numerals are always Hind Siliguri**, so ১, ৪, ৫ have one shape on every screen. Anek's Bangla
  digits differ, so anything that shows a number (stat values, step numbers, OTP boxes) uses the
  `font-numeric` utility (body face + tabular figures), even inside a heading. Both faces ship
  the `bengali` subset, so no system fallback font is used for digits (checked with Chromium's
  `CSS.getPlatformFontsForNode` at 1440 px and 390 px).
- Line length for paragraphs: max ~70 characters (`max-w-prose`).

## Spacing and layout

- Base unit 4 px (Tailwind spacing). Common steps: 2, 3, 4, 6, 8, 12.
- Page padding: 16 px phone, 24 px tablet, 32 px desktop. Content max width 1200 px.
- Vertical rhythm: 24 px between page sections, 16 px inside cards, 8–12 px between related
  items.
- Layout grid: one column on phone; dashboards go to 2 columns at `sm`, 4 at `lg`.
- Left-align everything (text, headings, numbers in cards). Centre only empty states and the
  login form on phone.

### App shell

```
Desktop (≥ 1024px)                         Phone (< 768px)
┌──────────┬───────────────────────────┐   ┌──────────────────────────┐
│ ▣ Jantrik│ Title            ২০২৬ EN ◉ │   │ ☰  Title            EN ◉ │
│          │ Home › Section            │   ├──────────────────────────┤
│ Overview │                           │   │                          │
│  ▸ Dash  │   page content            │   │  page content            │
│ Academic │                           │   │                          │
│  ▸ ...   │                           │   │                          │
│ ┌──────┐ │                           │   └──────────────────────────┘
│ │Inst. │ │                           │   ☰ opens the same sidebar as a
│ └──────┘ │                           │     left drawer.
│ ◉ User   │                           │
└──────────┴───────────────────────────┘
```

- Sidebar 264 px, collapsible to 72 px (icons only, names in tooltips/`title` and screen-reader
  text). The choice is remembered per browser.
- Nav groups have quiet sentence-case labels. The active item: `--primary-soft` background,
  primary text, and a 3 px primary bar on the left.
- The institute card (name, type, academic year) sits above the user card, so people always know
  which institute they are changing.
- Top bar: page title + breadcrumb on the left; academic-year badge, language toggle and avatar
  menu on the right. Sticky, white, 1 px bottom border.

## Density

Comfortable by default; people tap with thumbs and read in sunlight.

| Element                  | Size                                      |
| ------------------------ | ----------------------------------------- |
| Tap target (anything)    | ≥ 44 × 44 px on touch; ≥ 36 px on desktop |
| Button default / sm / lg | 40 / 36 / 48 px high                      |
| Input, select            | 44 px phone, 40 px desktop                |
| Table row                | 60 px (avatar + two lines)                |
| Nav item                 | 44 px                                     |
| Card padding             | 20 px desktop, 16 px phone                |

One primary button per view. Secondary actions are `outline` or `ghost`.

## Radius

Radius follows hierarchy, so not everything is the same rounded box:

| Token          | Value | Use                                    |
| -------------- | ----- | -------------------------------------- |
| `rounded-md`   | 8 px  | Badges' inner items, menu items        |
| `rounded-lg`   | 10 px | Buttons, inputs, selects, nav items    |
| `rounded-xl`   | 14 px | Cards, table container, dropdowns      |
| `rounded-2xl`  | 20 px | Large panels (login card, brand panel) |
| `rounded-full` | —     | Avatars, status badges, the year badge |

## Elevation

Mostly flat: surfaces are separated by the canvas colour and a hairline border. Shadows are
green-tinted and soft.

| Token       | Value                                                                  | Use                         |
| ----------- | ---------------------------------------------------------------------- | --------------------------- |
| `shadow-xs` | `0 1px 2px rgb(15 45 38 / 0.05)`                                       | Cards, inputs               |
| `shadow-md` | `0 4px 16px -4px rgb(15 45 38 / 0.10), 0 1px 3px rgb(15 45 38 / 0.06)` | Menus, popovers             |
| `shadow-lg` | `0 16px 40px -12px rgb(15 45 38 / 0.18)`                               | Drawer, dialogs, login card |

## Icons

- **lucide-react** only. Stroke 1.75 (set on the icon or inherited), sizes 16 (inline), 18 (nav),
  20 (buttons on phone), 24 (empty states inside a tinted tile).
- Icons support text, they never replace it. Exception: the collapsed sidebar, where the label is
  still the accessible name.
- Decorative icons get `aria-hidden`.
- Feature icons sit in a 40 px `rounded-lg` tile with `bg-primary-soft text-primary`.

## Motion

- Only in response to an action: drawer slide, menu fade/zoom, sidebar collapse width
  (200 ms ease-out).
- No entrance animations on page content, no hover lifts on cards.
- Respect `prefers-reduced-motion` (transitions drop to 0).

## Components and patterns

- **Avatar:** photo if present, else initials on a soft colour picked from the name (green,
  turmeric, sky, rose, violet). Bangla names show the first letter cluster (grapheme), Latin
  names two initials. Honorifics (Md., মোঃ) are skipped.
- **Status badge:** pill, soft background + strong text + 6 px dot. Student statuses: active
  (success), inactive (neutral), graduated (primary), transferred (neutral), dropped out (danger).
- **Stat card:** label (sm, muted), number (`font-numeric`, 3xl), one line of context. Modules
  not yet running show "—" and say what will appear, never fake numbers. Placeholder text stays
  at full `--muted-foreground` (no opacity): 5.2:1 on the canvas in light, 7.5:1 in dark (WCAG AA).
- **Greeting:** by the hour in Dhaka: শুভ সকাল 05:00–11:59, শুভ দুপুর 12:00–16:59, শুভ সন্ধ্যা
  17:00–20:59, শুভ রাত্রি 21:00–04:59 (`dayPeriod` in packages/shared). English uses "Good
  evening" at night, since "Good night" is a goodbye.
- **Empty state:** tinted icon tile, one sentence saying what is empty, one sentence saying what to
  do, and a button when there is an action.
- **Errors:** say what happened and how to fix it; no apologies. Inline under the field when
  possible, destructive alert otherwise.
- **Phone lists:** cards, not tables. Phone numbers are a 44 px call button (`tel:`), with the
  number visible.
- **Focus:** every interactive element shows a 3 px ring in `--ring` at 35% plus a primary border.

## Copy

- Bangla first, written the way people speak to a respected colleague (আপনি form).
- Name things by what people do: "হাজিরা নিন", not "Attendance module".
- Buttons are verbs: "কোড পাঠান", "ফি আদায় করুন".
- Labels that differ by institute type come from `useLabel()` (Class vs Course, Section vs Batch).

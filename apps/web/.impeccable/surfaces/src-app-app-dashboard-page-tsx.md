---
version: 2
slug: 'src-app-app-dashboard-page-tsx'
primary_target: 'src/app/(app)/dashboard/page.tsx'
related_targets:
  [
    'src/app/(app)/students/page.tsx',
    'src/components/app-shell.tsx',
    'src/app/(app)/setup/appearance/page.tsx',
    'src/app/(platform)/platform/(shell)/layout.tsx',
  ]
---

# Surface brief: the authenticated app (institute staff, teachers, guardians) and the platform panel

Scope: every screen of apps/web (app shell, dashboards, students, attendance, setup, staff,
import, wizard, guardian, login, platform panel). Visitor mode: Operate. The principal's
dashboard is the showcase; work screens (registers, the students list, setup) stay dense and use
the same language more quietly.

Audience and job: office staff working all day at 1366–1920 px desktops (compact density);
teachers taking attendance and guardians checking children on phones, often outdoors (comfortable
density, light mode first); Jantrik platform staff at a desk. Constraints: Bangla first, Noto Sans
Bengali for Bangla, the digit rule from PRODUCT.md, WCAG 2.2 AA in every theme and mode, 44 px
touch targets on phones, the 360 px overflow check, ≤ 3 s to interactive on a 390 px phone with
4× CPU and slow 4G (the budget the owner set; measured, and flagged where missed).

Unresolved: none at direction level. Screen-level work after the dashboard and students list
(the rest of part 4b) waits for the owner's review of the v2.1 gallery.

## Direction contract

THESIS: Each institute looks like itself: one of four themes (School, Madrasa, Coaching, English
medium), each designed in light and dark, on one system of floating cards, pills and story charts.
The principal's morning reads as a story (today in one line, what needs them, the week against
the last, where the year stands); the office's work screens stay dense and calm. It refuses the
grey admin template, gradient stat tiles that say nothing, and forcing anyone into dark.

OWN-WORLD: Colour is data (packages/shared/src/themes.ts): per preset and mode the neutrals, one
accent (an owner may pick another; it is nudged until every pair passes), a ramp of five ordered
tiers, five validated chart series, fixed status colours. Floating cards (20 px radius, 16 on
phones, a hairline, a two-layer tinted shadow; dark uses the hairline and a glow), a soft canvas of
two blooms, pills for nav, tabs, segmented controls, filters and deltas. Type: Noto Sans Bengali on
Bangla pages, Plus Jakarta Sans on English pages, Anek Bangla for the wordmark, titles and the
greeting, figures light (300) and big on the dashboard. Madrasa: a faint eight-fold lattice, no
living beings. Coaching: glass cards over the glow in dark. English medium: ink black, gold data.

STORY: The principal opens the day on a hero that says it in one true sentence ("৪টি শাখার মধ্যে
১টির হাজিরা এসেছে · ২৭ জনে ২৬ জন উপস্থিত · ১ জনের অভিভাবককে ফোন করুন"), sees the five
figures with how they moved, what needs attention first, the board by today, week or month, the
trend against the period before and the target, who the students are and where the year stands,
and acts from the same screen or Ctrl+K.

FIRST VIEWPORT: Floating sidebar card with pill nav; the top bar on the canvas (search pill, light
or dark in one tap, language, the person). The hero on the theme's gradient: both calendars, the
greeting by name, the insight, হাজিরা নিন first, this week's present % with its delta pill. Five
KPI cards: icon chip, a light figure counting up once, a delta pill coloured by meaning, a hatched
week or a half gauge.

FORM: Pinned by the owner's brief and nineteen reference dashboards (docs/design/, not committed):
hero numbers, delta pills, floating cards, pill tabs, story charts (smooth curve with gradient,
dashed ghost, target line, floating tooltip; hatched bars with one solid; rounded heatmap; half
gauge; donut with the total in the middle), an Academia-style greeting with a real insight, a term
timeline. seed: none (unavailable): no concept roll ran for v2.1; the owner's pinned brief is the authority. Signature interaction: a board tile opens that
section's register; choosing a class makes its series burn brightest. Motion: a card lifts 2 px,
a figure counts up, a line draws in, once each, all at rest under reduced motion.

FINISH: unreviewed and undocumented is unfinished; this build ends with the critique (before and
after), the finish review, docs/design.md v3, the performance table against the checkpoint, and the
gallery for the owner's review.

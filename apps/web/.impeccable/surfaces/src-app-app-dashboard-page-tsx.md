---
version: 1
slug: 'src-app-app-dashboard-page-tsx'
primary_target: 'src/app/(app)/dashboard/page.tsx'
related_targets: ['src/components/app-shell.tsx', 'src/app/(platform)/platform/(shell)/layout.tsx']
---

# Surface brief: the authenticated app (institute staff, teachers, guardians) and the platform panel

Scope: every screen of apps/web (app shell, dashboards, students, attendance, setup, staff,
import, wizard, guardian, login, platform panel). Visitor mode: Operate.

Audience and job: office staff working all day at 1366–1920 px desktops (compact density);
teachers taking attendance and guardians checking children on phones (comfortable density);
Jantrik platform staff at a desk. Constraints: Bangla first, Noto Sans Bengali, digit rule from
PRODUCT.md, WCAG 2.2 AA, 44 px touch targets on phones, the 360 px overflow check.

Unresolved: none at direction level; screen-level decisions live in docs/plans/design-v2.md.

## Direction contract

THESIS: The institute's own blackboard runs the office: a blackboard-green shell, chalk-white type and coloured chalk as the only data colours. It refuses the grey admin template with a blue accent and gradient stat tiles.

OWN-WORLD: Flat blackboard green #173F35 owns the sidebar, the section board and primary buttons; chalk-dust ground #F4F6F2; white panels on hairlines #DCE3DF; ink #14231E. Chalk series: yellow #F2C641, pink #E8739A, sky #2F86B5, mint #3FA37A, orange #EE8F3A. One fixed mint ramp for every percentage. Status by shape plus word. Noto Sans Bengali everywhere; Anek Bangla only for wordmark, page titles, board letters. 8 px radii, no shadows, no texture.

STORY: Staff open the day and see which sections are taken, who is absent and whom to call, act from the same screen, and move by keyboard or Ctrl+K.

FIRST VIEWPORT: Green sidebar; white top bar with Ctrl+K search; date and greeting row, quick actions right (primary হাজিরা নিন); five KPI tiles with chalk sparklines; left 60% the blackboard section board (class rows × ক খ গ tiles, ramp-filled, dashed when not taken, pink ring on the lowest); right 40% absentees table above the 30-day trend.

FORM: Blackboard and coloured chalk, candidate 6 of 7 on my ordered list, seed:ff5a0663bbccfe91. Signature interaction: a board tile opens that section's register; choosing a class makes its series burn brightest in every chart. Motion: 150–200 ms state changes only. Raises kept: status by shape, one type family by size steps, one fixed ramp, quiet rows with actions on focus, nothing disappears (it cancels), the chosen series burns brightest.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

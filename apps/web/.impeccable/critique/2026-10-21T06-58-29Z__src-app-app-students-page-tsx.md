---
target: "checkpoint 6fd66ac: dashboard and students list (one surface)"
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:D:\\work-softwares\\jantrik-school\\jantrik\\apps\\web\\src\\app\\(app)\\students\\page.tsx"
target_fingerprint: "sha256:12b6666220f93a43dd3771151c341b84179b07b0665c605465fc95e320afad95"
target_path: "D:\\work-softwares\\jantrik-school\\jantrik\\apps\\web\\src\\app\\(app)\\students\\page.tsx"
timestamp: 2026-10-21T06-58-29Z
slug: src-app-app-students-page-tsx
---
Method: dual-agent (A: design review · B: detector + browser overlay). Target: checkpoint `6fd66ac` (design v2 part 4a), dashboard and students list scored as one surface.

## Design Health Score: 27/40 (Acceptable, top of the band; baseline on main was 24/40)

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | "২৬/২৭ · ৯৬%" never says only 1 of 4 registers is in |
| 2 | Match system / real world | 3 | Bangla-native; "SMS ০/৭২" quota is system-speak |
| 3 | User control and freedom | 3 | Clear filters, Esc, URL state and Back all work |
| 4 | Consistency and standards | 3 | "ফিল্টার মুছুন" vs "এই ছাঁকনি রাখুন"; an all-"Active" status column |
| 5 | Error prevention | 2 | "ফি আদায় করুন" is a dead end; class filter offers empty classes without counts |
| 6 | Recognition rather than recall | 3 | Saved views hidden until you filter; board class names do not look like toggles |
| 7 | Flexibility and efficiency | 3 | Strong keyboard layer; no bulk select, export or print |
| 8 | Aesthetic and minimalist design | 2 | Today's attendance appears in 5 places; placeholders and setup take prime space |
| 9 | Error recovery | 3 | Per-panel error with retry; empty state offers clear filters |
| 10 | Help and documentation | 2 | Shortcut sheet only; no contextual help (SMS cap, the ramp) |
| **Total** | | **27/40** | **Acceptable** |

## Design specificity verdict

LLM assessment: a category-interchangeable shell around one authored element. The section board, the blackboard sidebar, the Bangla calendar chip and the "টানা ৩ দিন" streak are this product's own; everything around them (greeting plus button cluster, five equal white KPI cards with corner sparklines, a 3fr/2fr panel grid, dashed placeholder cards, a stock table) is the SaaS admin template. Reads cheap because of one surface tier for everything (white card, grey hairline, 8 px, a card inside a card), flat type (the largest text is the greeting, panel titles at body size), decoration that looks broken (hairline grey sparklines; the trend's area wash split into pale columns by off days), dashed borders meaning three things, and dead space at 1920.

Deterministic scan: 0 findings in 9 source files (exit 0, also with --no-config). Browser overlay: 5 per page, all in the shell: `gray-on-color` ×4 on the sidebar group labels (#a9c2b8 on #173f35, 6.17:1, a false positive: a tint of the sidebar green that passes AA) and `flat-type-hierarchy` ×1 (the top-bar h1 at 18.5 px is smaller than the 31 px greeting h2; three panel titles at body size; the sidebar labels are h2 and pollute the outline). The type finding agrees with the design review.

## What is working

1. The section board is genuinely authored (class × section, percentages as text, lowest ringed; picking a class re-scopes absentees and trend).
2. A power-grade keyboard and URL-state layer (Ctrl+K, ?, /, g s, n, ↑↓/Space/Esc, Back keeps the view).
3. Numbers follow the rules (Bangla counts, ASCII identifiers, right-aligned rolls, "—", streak by icon plus word).

## Priority issues

- [P1] No single "today" answer: the head reads a greeting first and the answer is split across five places. Fix: one true sentence with coverage ("৪ শাখার ১টির হাজিরা এসেছে · ২৭ জনে ২৬ উপস্থিত · ১ জনকে ফোন করুন") as the lead, absentees beside the board, the greeting reduced to a line, setup to a slim strip. (/impeccable layout, distill)
- [P1] Numbers that mislead (principles 1 and 4): 96% reads school-wide from 1 of 4 registers; the SMS tile promises "আরও ৭২টি" while absent SMS is off; "ফি আদায় করুন" leads nowhere. Fix: state coverage, "SMS বন্ধ" with a turn-on action, hide actions for modules not running. (/impeccable clarify)
- [P1] Generic surfaces and flat type, the main source of "cheap". Fix: 2–3 surface tiers, a stronger type scale (bigger KPI numbers, semibold larger panel titles), sparklines drawn properly or removed, no gap-split area wash, one quiet line instead of dashed placeholder cards. (/impeccable bolder, typeset, polish)
- [P2] The students list is a stock table, not a register: drop the all-"Active" column unless non-active students are in view, group by class·section with counts when sorted by class, counts in filter options, bulk actions later. (/impeccable layout)
- [P2] The side peek adds nothing the row does not show: give it 30-day attendance, the streak, all guardians with relation, the admission date and actions. (/impeccable layout)

## Persona red flags

- Busy head teacher: would report "attendance is great" off one register; on a phone the absentees to call sit ~1,450 px down below the setup checklist; the fee button betrays him.
- Office admin, not software-savvy: will not find the board's class toggles (muted hint on dark green); "ছাঁকনি" is unfamiliar; an empty class result reads like lost data; "SMS ০/৭২" means nothing.
- Power user: keyboard layer is good; no bulk actions, export or print; no keyboard toggle for board classes; peek has no actions.

## Minor observations

Roll header sort icon misaligned; "টেবিলে দেখুন" on its own row; trend x-axis below the fold at 1366; the students page has no in-content heading; the breadcrumb's "একাডেমিক" is not a page; English shows "Class 6 · ক"; phone cards ~190 px each; demo data names are templated.

## Questions to consider

- If the owner saw one sentence at 8:30, what would it be, and why is it not the biggest text on the page?
- What if the board were the top of the page rather than a card inside a card?
- Would the paper register's shape (class → section → roll, with counts) beat a generic sortable table?

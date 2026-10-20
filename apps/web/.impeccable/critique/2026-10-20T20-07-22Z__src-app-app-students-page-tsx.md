---
target: students list (before)
total_score: 24
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 2
target_identity: "file:D:\\work-softwares\\jantrik-school\\jantrik\\apps\\web\\src\\app\\(app)\\students\\page.tsx"
target_fingerprint: 'sha256:3e54e347ddb7fa84d9ab40de30e73efb7cb52e7fc3b49d4b4172a9ec76cc6191'
target_path: "D:\\work-softwares\\jantrik-school\\jantrik\\apps\\web\\src\\app\\(app)\\students\\page.tsx"
timestamp: 2026-10-20T20-07-22Z
slug: src-app-app-students-page-tsx
---

Method: dual-agent (A: design review · B: detector + browser overlay). Before state (main @ cfe38e3).

## Design Health Score — students list: 24/40 (Acceptable)

| #   | Heuristic                   | Score | Key issue                                                   |
| --- | --------------------------- | ----- | ----------------------------------------------------------- |
| 1   | Visibility of system status | 3     | Live count, skeletons, load-more                            |
| 2   | Match system / real world   | 3     | Ordered by code, not class/section/roll                     |
| 3   | User control and freedom    | 2     | Filters, search and pages reset on Back                     |
| 4   | Consistency and standards   | 3     | Kebab duplicates row links; identifiers in text-xs          |
| 5   | Error prevention            | 3     | Section select disabled until a class is chosen             |
| 6   | Recognition over recall     | 3     | Labelled filters and search                                 |
| 7   | Flexibility and efficiency  | 1     | No sort, status filter, bulk, export, shortcut; 25 per load |
| 8   | Aesthetic and minimalist    | 2     | 25 identical green pills; ~6 rows above the fold            |
| 9   | Error recovery              | 3     | Retry alert; filtered vs empty states differ                |
| 10  | Help and documentation      | 1     | Only the empty-state hint                                   |

Design specificity: a competent shadcn table; authored digit rules and tel: links; not yet the office's register (class → section → roll).
Deterministic scan: 0 CLI findings; overlay on /students: 3 × low-contrast, the "সক্রিয়" badge #1e7f45 on #e3f4e9 = 4.4:1.
Priority issues: [P1] list state only in useState (lost on Back); [P1] too sparse (65 px rows, 25 per load); [P2] order doesn't match the office; [P2] noise (pills, kebab, filled call buttons); [P3] identifiers too small, no tabular figures.

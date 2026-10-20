---
target: owner dashboard (before)
total_score: 24
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 3
target_identity: "file:D:\\work-softwares\\jantrik-school\\jantrik\\apps\\web\\src\\app\\(app)\\dashboard\\page.tsx"
target_fingerprint: 'sha256:b04e406e74933e766ff78ac1e091d971e31e4a3b7bf4a5984f4c2c1aec798ff2'
target_path: "D:\\work-softwares\\jantrik-school\\jantrik\\apps\\web\\src\\app\\(app)\\dashboard\\page.tsx"
timestamp: 2026-10-20T20-07-22Z
slug: src-app-app-dashboard-page-tsx
---

Method: dual-agent (A: design review · B: detector + browser overlay). Before state (main @ cfe38e3).

## Design Health Score — owner dashboard: 24/40 (Acceptable)

| #   | Heuristic                   | Score | Key issue                                                                           |
| --- | --------------------------- | ----- | ----------------------------------------------------------------------------------- |
| 1   | Visibility of system status | 3     | Pending sections are not named                                                      |
| 2   | Match system / real world   | 2     | "২১ অক্টোবর" reads as "২৬" (Hind Siliguri ১)                                        |
| 3   | User control and freedom    | 3     | Finished checklist cannot be dismissed                                              |
| 4   | Consistency and standards   | 2     | Admit shows "coming soon" though it works; Collect fee looks live but is a dead end |
| 5   | Error prevention            | 3     | Held-SMS confirm shows counts before spending                                       |
| 6   | Recognition over recall     | 3     | Stat cards are links with only a hover hint                                         |
| 7   | Flexibility and efficiency  | 2     | No shortcuts, no jump-to-student                                                    |
| 8   | Aesthetic and minimalist    | 2     | Half the KPI row is empty; done checklist takes ~350 px                             |
| 9   | Error recovery              | 2     | Stat queries have no error state                                                    |
| 10  | Help and documentation      | 2     | Only the checklist guides                                                           |

Design specificity: partly authored (Dhaka greeting, Bangla date chip, honest placeholders), structurally the stock SaaS dashboard; the school day (which sections, who is absent, whom to call) is missing.
Deterministic scan: 0 CLI findings; overlay on /dashboard: no anti-patterns.
Priority issues: [P1] misreadable digits; [P1] quick actions wrong both ways; [P1] hierarchy upside down for daily use; [P2] teacher view doesn't lead with the job; [P2] silent failures on stat cards.

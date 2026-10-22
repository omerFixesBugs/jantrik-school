---
target: owner dashboard and students list (after, 803ae37)
total_score: 28
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:D:\\work-softwares\\jantrik-school\\jantrik\\apps\\web\\src\\app\\(app)\\students\\page.tsx"
target_fingerprint: "sha256:207410d42d805e7f44ce262d9a3aa0028bb849d8ab27fd7c4cc9fba1d35ade3d"
target_path: "D:\\work-softwares\\jantrik-school\\jantrik\\apps\\web\\src\\app\\(app)\\students\\page.tsx"
timestamp: 2026-10-21T21-26-07Z
slug: src-app-app-students-page-tsx
---
Method: dual-agent (A: design review · B: detector + browser overlay). After state: the R4 polish (803ae37), School theme, bn, 1366×900 and 390×844 light, dark once. Earlier in this round: main 24/40, checkpoint 6fd66ac 27/40, R3 build 76d0665 27/40.

## Design Health Score — owner dashboard and students list: 28/40 (Good)

| #   | Heuristic                   | Score | Key issue                                                                              |
| --- | --------------------------- | ----- | -------------------------------------------------------------------------------------- |
| 1   | Visibility of system status | 3     | SMS tile drew "০ / ৭২" and a gauge while absent SMS was off                            |
| 2   | Match system / real world   | 3     | Genitives right (শাখার); the same 7 days still called "এই সপ্তাহ" in two places         |
| 3   | User control and freedom    | 3     | Resets, Back, URL-held views, the peek closes                                          |
| 4   | Consistency and standards   | 2     | "গত ৭ দিন" named two windows; phone rows cut off IDs and phones, clipped Bangla names  |
| 5   | Error prevention            | 3     | No hero action into the unbuilt fees module; held SMS confirmed with counts            |
| 6   | Recognition over recall     | 3     | Captions say what each delta is compared with                                          |
| 7   | Flexibility and efficiency  | 3     | About 5 phone rows a screen (was 1.5); peek-open rows grew to 80–103 px                |
| 8   | Aesthetic and minimalist    | 3     | Repetition cut; insight facts still restated 3–4 times; 262 px KPI tiles, half empty   |
| 9   | Error recovery              | 3     | Unchanged                                                                              |
| 10  | Help and documentation      | 2     | The 90% target and the 3-day streak are never explained                                |

Design specificity: the themed direction (floating cards, light hero numbers, hatched week, gauges, donut, term timeline) reads as authored; the school day leads (registers due, who is long absent, whom to call).
Deterministic scan: source clean; live overlay flags ai-color-palette on the hero gradient (the owner's brief asks for it), flat-type-hierarchy (panel titles raised a step in R4), repeating-stripes (exposed a 0 px chart slot, fixed in R4).
Priority issues: [P1] phone student rows cut off IDs and phones and clip names; [P1] peek-open table rows inflate (guardian column wraps); [P1] one window, three names, two meanings for "গত ৭ দিন"; [P2] insight restated and its call link goes to a page; [P2] KPI row proportions (flat hatched bars on a zero-based scale, SMS gauge while off).
Addressed after this score (not re-scored): all five, in the commit after 4e09cb7.

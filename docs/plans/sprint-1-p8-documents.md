# Sprint 1, P8: documents — the designer, presets per institute type, ID cards (implementation plan)

**Status: plan only (day run 2026-11-18), not approved, no code yet.** Written while the owner was
away. It details [sprint-1.md](sprint-1.md) → "P8: Documents: designer, presets, ID cards", which
the owner approved on 2026-11-14 with decision S31 (ID card QR: a stable code per student, revoked
on reissue; cards print front and back) and S3 (no new module key: documents sit under CORE).
Nothing here reopens those. The new decisions this plan needs are P8-A to P8-P at the end, each
with a recommended default. Nothing is built until the owner approves (S1). If the sprint runs
late, P8 and P9 move to Sprint 2 together (the owner's rule); tests are never reduced.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.
> One review subagent per PR (database, template safety).

**Goal:** an owner or admin prints their institute's student ID cards from a ready preset in
minutes, on a card printer (CR80) or on A4 sheets with crop marks, front and back; and can open
any preset in a designer, move and restyle its parts, add their own artwork, and save it as the
institute's template for ID cards, admit cards, transfer certificates, testimonials and the
marksheet's header and footer (P9 issues those).

**Architecture:**

- **A template is data, never markup.** A layout is a versioned JSON document (`front`, `back`)
  of positioned elements in 0.1 mm units: `text`, `image`, `qr`, `rect`, `line`, the admit
  card's routine block and the marksheet's header and footer bands. It is validated by one zod
  schema in `@jantrik/shared` on the API (on every save) and in the web (in the designer), and
  bounded by CHECKs in the database. Text is static strings and whitelisted fields only; colours
  are `#rrggbb`; fonts are one of four named faces; sizes are integers in range. The renderer
  turns it into React elements with numeric inline styles: no HTML, CSS or URL from a template
  ever reaches the page, so a template cannot inject script or style (review focus 1).
- **Presets are global seed data** (`document_template_presets`, `GRANT SELECT` only), keyed by
  `institute_types.key` (null = every type), seeded from `packages/db/src/reference-data/` like
  the class templates. An institute copies a preset into its own `document_templates` row and
  edits that copy. No code anywhere names an institute type (CLAUDE.md rule 2; a code scan
  enforces it).
- **Every save is a new immutable version** (`document_template_versions`, decision P8-B), so P9's
  issued documents can point at the exact layout they were printed with.
- **Printing is the browser's own** (as report cards and receipts today, decision P8-D): the print
  page lays out exact millimetre pages with named `@page` rules (CR80 85.6 × 54 mm, A4, A5), the
  person prints or saves as PDF. The API sends data, never PDFs; no new PDF dependency.
- **Images come from `FileStore`** (P2): the student's photo, the logo, the head's signature and
  the seal through their existing entity routes, the designer's own artwork as `DOCUMENT_ASSET`
  files tied to the template (`document_template_assets`, decision P8-C), and photos for a
  whole class through one batch route (bulk printing, review focus 4).
- **The ID card's QR comes from P9.** S31's stable per-student code lives in P9's
  `issued_documents` (the sprint plan's table split). P8 builds the `qr` element, the designer's
  sample QR and the print path for it; until P9 is merged the QR box prints empty (decision P8-A).

**Tech stack:** NestJS, Prisma/PostgreSQL 16, Next.js (App Router, v3 kit), next-intl, zod,
Vitest, Playwright. Existing dependencies only: `qrcode` (already in `apps/web`) for P9's QR,
`sharp` (P2) for uploaded artwork. No drag-and-drop library (pointer events), no PDF library.

**Spec:** sprint-1.md → P8; S3, S31; "New tables at a glance" (`document_templates` S I U,
`document_template_presets` S global); global constraints; review focus (none of the sprint's five
is in P8; this plan adds its own).

**Branches:** `feature/sprint-1-p8a-documents-print` from `main` after P2 (#18) is merged, then
`feature/sprint-1-p8b-documents-designer` from `main` after P8a is merged (decision P8-O). While
PRs #16, #18 and #17 are unmerged, both branch from `integration/sprint-1` and are rebased after
those merge.

## What exists today (verified in the code on 2026-11-18, `integration/sprint-1` at `c8571025`)

- **Printing is browser print**, never a server PDF.
  - `apps/web/src/app/globals.css:504-700`: one `@media print` block. The default `@page` is A4
    landscape with 10 mm margins (the attendance register, `:505`); named pages `receipt-a5`,
    `receipt-80` (`:590-597`) and `exam-a4` (A4 portrait, 10 mm, `:634-637`). Each printable area
    isolates itself with `body:has(.x.print-area) :not(:has(.x))… { display: none }` so only it
    stays in the flow (`:601-621`, `:638-657`); `print-color-adjust: exact` keeps fills.
  - `PrintToolbar` (`apps/web/src/components/exams/print-pages.tsx:28`) calls `window.print()`;
    "the browser's own Save as PDF makes the PDF" (its comment).
  - Admit cards: `AdmitCardsPrint` (`print-pages.tsx:210`) puts two cards on an A4 sheet with a
    dashed cut line; data from `GET /exams/:id/admit-cards` (`apps/api/src/exams/exams.module.ts:528`,
    `ExamsAdminController`, OWNER/ADMIN, EXAMS, `:430-432`), typed `AdmitCards`
    (`packages/shared/src/exams-api.ts:507`), institute name from `tenants.name`
    (`apps/api/src/exams/seats/seat-plan.service.ts:149`).
  - Report cards: `ReportCardsPrint` (`apps/web/src/components/exams/report-card.tsx:28`), one A4
    per student, institute name as plain text in the header (`:71-75`), the photo through
    `StudentPhoto` (`:112`). No logo, signature or seal yet (decision F12 in decisions-pending).
  - `qrcode@1.5.4` is a web dependency used once, for the platform's TOTP enrolment
    (`apps/web/src/app/(platform)/platform/login/page.tsx:12`, `toDataURL` at `:207`). The API has
    no QR or PDF library (`apps/api/package.json:15-38`).
- **Files (P2, #18):**
  - `FileStore` (`apps/api/src/files/file-store.ts`): `lock`, `put`, `get`, `meta`, `delete`,
    `usage`; only `PostgresFileStore` touches `stored_files` (`file-store-access.spec.ts`).
  - `stored_files.kind` includes `DOCUMENT_ASSET` (`packages/db/prisma/schema.prisma:3132-3141`)
    with "no route yet" (docs/files.md): JPEG, PNG or WebP, ≤ 256 KB, no box
    (`packages/shared/src/files.ts:47-50`). `UNIQUE (tenant_id, id, kind)` is the target of
    kind-bound foreign keys (`stored_files`, `schema.prisma:3145-3176`).
  - `ImageUploads.prepare(kind, upload)` / `store()` and `sendStoredImage()`
    (`apps/api/src/files/files.module.ts:51-104`): re-encode first, no transaction during the
    upload (`@OwnTransaction`, docs/auth.md → Request pipeline), strong `ETag`,
    `Cache-Control: private, no-cache`. 60 uploads per person per 10 minutes.
  - Image routes: `GET /students/:id/photo` (OWNER/ADMIN; a TEACHER of the current section),
    `GET /institute/profile/logo` (every member,
    `apps/api/src/institute/institute-profile.module.ts:274-276`), `GET
/institute/profile/:slot` for signature and seal (OWNER/ADMIN, `:281-282`; decision F1: "P8/P9
    widen this for printing").
  - The web fetches each image with the bearer token: `useAuthedImage(path, fileId)`
    (`apps/web/src/lib/authed-image.ts`), one request per image, **at most 100 object URLs cached**
    (`MAX_CACHED`, `:13`; the oldest is revoked when a 101st arrives). A print of more than 100
    photos cannot use it as is.
  - `InstituteProfileModule` exports nothing (`institute-profile.module.ts:310`); P8 needs
    `InstituteProfileService` exported (CLAUDE.md rule 4).
- **Institute profile** (`institute_profiles`, `schema.prisma:3194`): names bn/en, short
  name, EIIN, addresses bn/en, phone, email, website, head title and name bn/en, established year,
  `logo_file_id`, `head_signature_file_id`, `seal_file_id`. `tenants.name` stays the
  platform-registered name; the app cannot change it (`REVOKE UPDATE … ON tenants FROM
jantrik_app`, migration `20261022000000_platform_institutes:84`).
- **Students:** `students.photo_file_id` (kind-bound, `schema.prisma:1013-1016`), names bn/en,
  `student_code`, parents' names bn/en, DOB, gender, religion, blood group, birth registration,
  addresses (`:1004-1028`). Statuses `ACTIVE | INACTIVE | GRADUATED | TRANSFERRED | DROPPED_OUT`
  (`:212`).
- **Institute types and templates:** global reference data in
  `packages/db/src/reference-data/templates.ts` ("never code branches on the type key", `:12-14`).
  Three types: `COACHING` (`:261`), `NCTB_SCHOOL_BN` (`:306`), `NCTB_SCHOOL_EN` (`:318`).
  `seedTemplates()` (`:336`) upserts them as `jantrik_owner` under an advisory lock; labels per
  type (`class_level` = Course for coaching, `roll` = ID) reach the web through `useLabel()`.
- **Fonts** (`apps/web/src/app/layout.tsx:29-75`, docs/design.md → Typography): Noto Sans Bengali
  (variable 100–900, Bangla subset, `--font-body`, preloaded), Anek Bangla (600 only, Bangla
  subset, `--font-display`), Plus Jakarta Sans (Latin, `--font-latin`, not preloaded), Noto Naskh
  Arabic (`--font-arabic`). All `display: swap`: a print started before a face arrives prints the
  fallback.
- **Digits:** `formatIdentifier`, `formatDate`, `formatCount` in `packages/shared/src/format.ts`;
  ASCII for IDs, rolls, codes and phones, Bangla digits for dates and counts in bn (CLAUDE.md).
- **Rate limits:** authenticated requests 300 a minute per user (docs/auth.md → Rate limits), so
  one request per photo for a class of 300 would hit it.
- **No CSP header** (`apps/web/next.config.ts` has no `headers()`), so the renderer's safety must
  not rely on one.
- **Not in this branch, needed later:** P3 (#23/#24) adds `WEB_PUBLIC_URL` (the QR's address, P9);
  P1-J8 (#20) signs the request context (new policies call `(SELECT app_current_tenant_id())`).

## Global constraints

- **Module and roles:** every route `@RequireModule('CORE')` (S3) and `@Roles('OWNER', 'ADMIN')`
  (decision P8-E); ADMIT_CARD and MARKSHEET templates also need EXAMS enabled (checked in the
  service, 422 `MODULE_DISABLED`). Pages belong to module CORE in `navigation.ts`. All document
  routes take their module from one constant, so Sprint 2's M0/M-3 (a DOCUMENTS key) is a
  one-line change.
- **Tables:** the database.md checklist for each tenant table; templates are archived, never
  deleted; versions and assets are insert-only.
- **No type checks:** nothing under `apps/api/src/documents/`, `apps/web/src/**/documents/` or
  `packages/shared/src/documents/` names an institute type key (code scan, Task 4).
- **Template safety (review focus 1):** no `dangerouslySetInnerHTML`, no `style` strings, no `href`
  or `src` built from template data anywhere under `components/documents/` (code scan + ESLint
  `react/no-danger` for that folder); colours, fonts and sizes only through the schema's enums
  and ranges.
- **Units:** layouts in integer 0.1 mm; font sizes in integer 0.1 pt; the screen scales, print is
  exact.
- **Strings and digits:** bn and en through a new route namespace `documents`; a template has one
  language (`locale`) that decides its digits and dates; identifiers (student code, roll, serial,
  verification code, phone, EIIN, blood group) always ASCII, through the shared formatters.
- **Transactions:** request transactions stay under 15 s: a print loads at most 100 students
  (decision P8-J), photos at most 20 per request.
- **Audit:** template create, save (version numbers only, never the layout), default, archive and
  restore; asset upload (CLAUDE.md rule 6 and the sprint plan's audit line).
- **Screens:** v3 kit, light first; screenshot checks bn at 1366 and 390 px; the designer is
  desktop-only (≥ 1024 px), phones get a read-only preview.
- **Gates:** affected tests during the work; at the end of each PR `pnpm lint`, `pnpm typecheck`,
  `pnpm format:check`, `pnpm test`, `pnpm build`, Playwright, then the review subagent, then the PR
  with CI green.

## Review focus

1. **Template injection.** A static text of `<img src=x onerror=alert(1)>`, a colour of
   `red;background:url(https://evil)`, a font of `x}body{display:none`, an element type `html`, a
   field key `__proto__` or `student.password_hash`, a QR with a `url`, an image with a `src`.
   Expected: the schema refuses every non-whitelisted shape on save (422 `LAYOUT_INVALID` with the
   path); text that passes prints literally. Test: Task 1 (schema), Task 7 (Playwright: the literal
   text on the page, no dialog).
2. **Cross-institute and cross-kind references.** An asset id of another institute, a stored file
   of kind `STUDENT_PHOTO` used as artwork, institute B's student or section ids in a print
   request, B's template id. Expected: refused or absent, never B's data. Test: Tasks 3, 6, 10.
3. **Exact geometry.** A CR80 page is 85.6 × 54 mm, A4 sheet positions add up, backs mirror for
   the chosen duplex edge, nothing falls outside the page or the sheet. Test: Task 2 (pure),
   Task 7 (computed sizes in print emulation).
4. **Bulk printing stays bounded.** A class of 600: the print splits into parts of 100, photos
   come 20 per request within the per-person limit, the browser keeps every object URL until the
   page closes and scales photos to print size. Test: Tasks 6 and 7.
5. **Presets are data.** Each launch type lists exactly its presets; no code names a type.
   Test: Task 4.
6. **Two people editing one template.** Expected: the second save gets 409 `TEMPLATE_CHANGED`;
   versions never change after they are written. Test: Tasks 3 and 5.

---

## The layout model (`packages/shared/src/documents/layout.ts`)

A template has a page, an orientation, an optional sheet, and one or two sides. Each side is a
`Layout`:

```ts
// Schema version 1. Every number is an integer.
type Layout = {
  v: 1;
  background: Hex | null; // '#rrggbb'
  bands: { header: number; footer: number } | null; // MARKSHEET only (S29), 0.1 mm
  elements: Element[]; // at most 80 per side
};
type Base = {
  id: string; // ^[a-z0-9]{1,12}$, unique in the side
  x: number;
  y: number;
  w: number;
  h: number; // 0.1 mm, inside the page
  rotate: 0 | 90 | 180 | 270;
  opacity: number; // 10..100 (%)
  layer: 'normal' | 'watermark'; // watermark: behind everything, opacity <= 30
};
type Text = Base & {
  type: 'text';
  content: ({ s: string } | { f: FieldKey })[]; // 1..40 segments, static text 500 chars in all
  font: 'body' | 'display' | 'latin' | 'arabic'; // Noto Sans Bengali, Anek Bangla 600, Jakarta, Naskh
  size: number; // 0.1 pt, 50..720
  weight: 400 | 500 | 600 | 700; // display: 600 only
  color: Hex;
  align: 'start' | 'center' | 'end' | 'justify';
  valign: 'top' | 'middle' | 'bottom';
  lineHeight: number; // 100..200 (%)
  fit: 'wrap' | 'shrink'; // shrink: down to 6 pt (decision P8-I)
};
type Image = Base & {
  type: 'image';
  source:
    | 'student.photo'
    | 'institute.logo'
    | 'institute.signature'
    | 'institute.seal'
    | { asset: string };
  fit: 'contain' | 'cover';
  border: { color: Hex; width: number } | null; // 1..20 (0.1 mm)
  radius: number; // 0..100 (0.1 mm)
};
// w 120..800 (12–80 mm); h = w, or w + 40 with showCode (the code on one line under the QR).
// The URL is never in the layout: P9 supplies it per document.
type Qr = Base & { type: 'qr'; showCode: boolean };
type Rect = Base & {
  type: 'rect';
  fill: Hex | null;
  stroke: Hex | null;
  strokeWidth: number;
  radius: number;
};
type Line = Base & {
  type: 'line';
  stroke: Hex;
  strokeWidth: number;
  dash: 'solid' | 'dashed' | 'dotted';
};
type Block = Base & { type: 'block'; block: 'exam_routine' }; // ADMIT_CARD only (P9)
```

**Validation** (`layoutSchema(kind, page, orientation)`, zod `strict()` everywhere, so an unknown
key anywhere is an error):

- Every element inside the page (`x + w ≤ pageW`, `y + h ≤ pageH`; for 90° and 270° the rotated
  box), at least 1 mm wide and high (lines excepted). On A4 and A5 pages every element also keeps
  5 mm from the edges (office printers cannot print there); a CR80 card may go to its edge (card
  printers print edge to edge).
- Field keys must be in `DOCUMENT_FIELDS` for the template's kind (below); image sources and blocks
  likewise; `{ asset }` ids must be among the template's assets (checked by the API against
  `document_template_assets`).
- At most one `qr` per side, only on kinds P9 registers (`REGISTERED_KINDS`: ID_CARD, TC,
  TESTIMONIAL, MARKSHEET; decision P9-F), at least 12 mm (the designer warns under 16 mm).
- MARKSHEET: `bands` required; every non-watermark element lies wholly in the header band (top) or
  the footer band (bottom); the body between them is the report card's own data-driven table
  (S29).
- Serialized size ≤ 64 KB per side (the CHECK); at most 80 elements; static text ≤ 500 characters
  per element.
- `parseLayout()` returns the typed layout or the zod issues with their paths; the API answers 422
  `LAYOUT_INVALID {issues: [{path, code}]}`.

**Pages** (`pages.ts`, 0.1 mm, portrait width × height): `CR80` 540 × 856 (ISO ID-1 is
53.98 × 85.60 mm; 0.02 mm is below any printer's accuracy), `A5` 1480 × 2100, `A4` 2100 × 2970.
Landscape swaps them.

**Sheets** (`sheet` on the template, only for a page smaller than A4; decision P8-K):

```ts
type Sheet = {
  paper: 'A4';
  cols: number;
  rows: number; // 1..6 each
  gapX: number;
  gapY: number; // 0..100 (0.1 mm); 0 = cards butt, one cut per line
  cropMarks: boolean; // 3 mm marks in the margins, 2 mm from the cards
  duplex: 'long' | 'short' | 'none'; // which edge the printer flips on; 'none' = backs not mirrored
};
```

`sheetFits(page, orientation, sheet)` refuses cards that leave the paper, and a CR80 sheet that
leaves less than 5 mm of paper on any side. An A5 page goes 1 × 2 on A4 with no margin (its own
5 mm safe area takes that role). Defaults: landscape CR80 2 × 5, portrait CR80 3 × 3, A5
landscape 1 × 2 (admit cards, P9), gaps 0, crop marks on for CR80, duplex long.

### Fields (`packages/shared/src/documents/fields.ts`)

One registry: each key's kinds and its format. The format decides the digits, never the template.

| Keys                                                                                                                                        | Kinds                                  | Format                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| `institute.name_bn`, `.name_en`, `.short_name`, `.address_bn`, `.address_en`, `.email`, `.website`, `.head_title_bn/en`, `.head_name_bn/en` | all                                    | text                                                       |
| `institute.phone`, `institute.eiin`                                                                                                         | all                                    | identifier (ASCII)                                         |
| `institute.established_year`                                                                                                                | all                                    | year (Bangla digits in bn)                                 |
| `label.class_level`, `.section`, `.roll`, `.student`, `.study_group`, `.academic_year`, `.shift`                                            | all                                    | the institute's `tenant_labels` in the template's language |
| `student.name_bn`, `.name_en`, `.father_name_bn/en`, `.mother_name_bn/en`                                                                   | all                                    | text                                                       |
| `student.code`                                                                                                                              | all                                    | identifier                                                 |
| `student.date_of_birth`                                                                                                                     | ID_CARD, TC, TESTIMONIAL               | date                                                       |
| `student.blood_group`                                                                                                                       | ID_CARD, TC, TESTIMONIAL               | identifier (`A+`)                                          |
| `student.gender`, `.religion`                                                                                                               | TC, TESTIMONIAL                        | the enum's label                                           |
| `student.birth_registration_no`, `.present_address`, `.permanent_address`                                                                   | TC, TESTIMONIAL                        | identifier / text                                          |
| `student.child_relation_en` ("son" / "daughter" / "child"), `student.pronoun_en` ("he" / "she" / "they")                                    | TC, TESTIMONIAL                        | text, from `gender`                                        |
| `enrolment.year`, `.class_bn`, `.class_en`, `.section`, `.group_bn`, `.group_en`, `.shift`                                                  | all                                    | text                                                       |
| `enrolment.roll`                                                                                                                            | all                                    | identifier                                                 |
| `guardian.phone` (the primary guardian)                                                                                                     | ID_CARD                                | identifier (decision P8-M)                                 |
| `document.issue_date`                                                                                                                       | all                                    | date                                                       |
| `document.valid_until`                                                                                                                      | ID_CARD                                | date (the academic year's end, decision P8-L)              |
| `document.serial`, `document.verify_code`                                                                                                   | REGISTERED_KINDS                       | identifier (filled by P9; empty in P8)                     |
| `document.duplicate_mark`                                                                                                                   | TC, TESTIMONIAL, MARKSHEET             | text (P9-J)                                                |
| `tc.*`, `board.*`, `exam.*`, `seat.*`                                                                                                       | TC; TESTIMONIAL; ADMIT_CARD, MARKSHEET | defined by P9 (the keys are reserved here)                 |

A field without a value prints nothing (no "null", no placeholder). `resolveText(content, data,
locale, labels)` is a pure function used by the designer's preview and by the print page alike.

## Database

All tenant tables follow the [database.md](../database.md) checklist. One migration,
`<ts>_document_templates` (timestamp assigned when written, after every Sprint 1 migration merged
before it), hand-written SQL appended to Prisma's output. No value is added to an existing enum and
nothing is backfilled.

### Enums

- `document_kind`: `ID_CARD`, `ADMIT_CARD`, `TC`, `TESTIMONIAL`, `MARKSHEET` (Sprint 2 adds
  `HIFZ_COMPLETION` and `BOARD_FORM`, each in its own migration).
- `document_page`: `CR80`, `A5`, `A4`.
- `document_orientation`: `PORTRAIT`, `LANDSCAPE`.

### `document_template_presets` (global; jantrik_app SELECT only)

| Column                     | Type               | Rule                                                                      |
| -------------------------- | ------------------ | ------------------------------------------------------------------------- |
| `id`                       | uuid v7            | PK                                                                        |
| `key`                      | text NOT NULL      | UNIQUE; CHECK `~ '^[a-z0-9-]{3,60}$'` (`id-card-landscape-bn`)            |
| `institute_type_key`       | text NULL          | FK → `institute_types (key)` ON UPDATE/DELETE RESTRICT; NULL = every type |
| `kind`                     | document_kind      |                                                                           |
| `name_bn`, `name_en`       | text NOT NULL      | 1–80 each                                                                 |
| `locale`                   | locale             | the preset's language                                                     |
| `page`, `orientation`      | enums              |                                                                           |
| `sheet`                    | jsonb NULL         | as `document_templates`                                                   |
| `front`, `back`            | jsonb / jsonb NULL | as `document_templates`                                                   |
| `schema_version`           | smallint           | 1                                                                         |
| `is_default`               | boolean            | offered first for its kind and type                                       |
| `sort_order`               | int                |                                                                           |
| `created_at`, `updated_at` | timestamptz(3)     |                                                                           |

- Global like `template_*`: no `tenant_id`, no RLS, `GRANT SELECT … TO jantrik_app` only (reason:
  the same for every institute, changed only by Jantrik's seed). database.md's "Two kinds of
  tables" gains it.
- Seeded by `seedTemplates()` (owner) from `DOCUMENT_PRESETS` in a new
  `packages/db/src/reference-data/document-presets.ts`; idempotent upsert by `key`; a preset whose
  key leaves the list is deleted (no tenant row points at a preset: templates keep only the key).

### `document_templates` (tenant; jantrik_app S I U, archived not deleted)

| Column                           | Type                | Rule                                                                                                             |
| -------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `id`                             | uuid v7             | PK                                                                                                               |
| `tenant_id`                      | uuid NOT NULL       | FK tenants                                                                                                       |
| `kind`                           | document_kind       | never changes (no UPDATE grant)                                                                                  |
| `name`                           | text NOT NULL       | CHECK `char_length(name) BETWEEN 1 AND 80`                                                                       |
| `locale`                         | locale              | digits and dates follow it                                                                                       |
| `page`, `orientation`            | enums               |                                                                                                                  |
| `sheet`                          | jsonb NULL          | CHECK `sheet IS NULL OR (page <> 'A4' AND jsonb_typeof(sheet) = 'object' AND octet_length(sheet::text) <= 2048)` |
| `front`                          | jsonb NOT NULL      | CHECK `jsonb_typeof(front) = 'object' AND octet_length(front::text) <= 65536`                                    |
| `back`                           | jsonb NULL          | CHECK `back IS NULL OR (jsonb_typeof(back) = 'object' AND octet_length(back::text) <= 65536)`                    |
| `schema_version`                 | smallint NOT NULL   | CHECK `BETWEEN 1 AND 100`                                                                                        |
| `version`                        | int NOT NULL        | default 1; CHECK `>= 1`; bumped by every save                                                                    |
| `is_default`                     | boolean NOT NULL    | default false                                                                                                    |
| `source_preset_key`              | text NULL           | the preset it was copied from (no FK: presets may be re-keyed)                                                   |
| `archived_at`                    | timestamptz(3) NULL | CHECK `NOT (is_default AND archived_at IS NOT NULL)`                                                             |
| `created_by_id`, `updated_by_id` | uuid NULL           | FK users ON DELETE SET NULL (as `stored_files.created_by_id`)                                                    |
| `created_at`, `updated_at`       | timestamptz(3)      |                                                                                                                  |

- Unique: `(tenant_id, id)`; partial UNIQUE `(tenant_id, kind) WHERE is_default AND archived_at IS
NULL` (one default per kind; setting a new one clears the old in the same transaction).
- Index: `(tenant_id, kind, archived_at)`.
- Grants: `SELECT, INSERT, UPDATE (name, locale, page, orientation, sheet, front, back,
schema_version, version, is_default, archived_at, updated_by_id, updated_at)`. Not `kind`,
  `source_preset_key`, `created_*`, `tenant_id`. No DELETE.
- Checklist: ☐ tenant_id NOT NULL ☐ `(tenant_id, id)` unique ☐ composite FKs ☐ ON UPDATE RESTRICT
  ☐ leading index ☐ ENABLE + FORCE RLS ☐ `tenant_isolation` with `(SELECT
app_current_tenant_id())` ☐ explicit grants ☐ schema-safety list ☐ isolation test.

### `document_template_versions` (tenant; jantrik_app S I; decision P8-B)

| Column                                                            | Type           | Rule                                                         |
| ----------------------------------------------------------------- | -------------- | ------------------------------------------------------------ |
| `tenant_id`, `template_id`                                        | uuid NOT NULL  | composite FK → `document_templates (tenant_id, id)` RESTRICT |
| `version`                                                         | int NOT NULL   | PK `(tenant_id, template_id, version)`                       |
| `page`, `orientation`, `sheet`, `front`, `back`, `schema_version` |                | copies, with the same CHECKs                                 |
| `created_by_id`                                                   | uuid NULL      | FK users ON DELETE SET NULL                                  |
| `created_at`                                                      | timestamptz(3) |                                                              |

- Insert-only (S I): a version never changes, so a P9 document points at exactly what it was
  printed with. The composite primary key is the `(tenant_id, …)` unique key and the leading
  index (as P3's applicant photos).
- Written in the same transaction as each create and save of a template; a test checks the
  template's current layout always equals its latest version.

### `document_template_assets` (tenant; jantrik_app S I; decision P8-C)

| Column          | Type             | Rule                                                                                                              |
| --------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `id`            | uuid v7          | PK; the id a layout's `{ asset }` names                                                                           |
| `tenant_id`     | uuid NOT NULL    |                                                                                                                   |
| `template_id`   | uuid NOT NULL    | composite FK → `document_templates`, RESTRICT                                                                     |
| `file_id`       | uuid NOT NULL    | with `file_kind`: composite FK `(tenant_id, file_id, file_kind)` → `stored_files (tenant_id, id, kind)`, RESTRICT |
| `file_kind`     | stored_file_kind | default `DOCUMENT_ASSET`; CHECK `= 'DOCUMENT_ASSET'`                                                              |
| `created_by_id` | uuid NULL        | FK users ON DELETE SET NULL                                                                                       |
| `created_at`    | timestamptz(3)   |                                                                                                                   |

- Unique: `(tenant_id, id)`; `(tenant_id, file_id, file_kind)` (a file is used in one place, as
  P2's references); index `(tenant_id, template_id)`.
- No DELETE grant: an asset lives as long as its template (templates are archived, never
  deleted), so a version that names it can always be printed. At most 8 per template (service,
  under the template's row lock; test).
- The kind-bound foreign key means artwork can only be a `DOCUMENT_ASSET` of this institute, and
  `FileStore.delete` cannot remove one still attached.

### Migration notes

- Policies use the wrapped form `tenant_id = (SELECT app_current_tenant_id())` (P1-J8, #20).
- `schema-safety.test.ts`: the three tenant tables in its list; the global presets table in the
  global list with SELECT only.
- Drift check with `prisma migrate diff`; applied to a scratch database only.

## API

`DocumentsModule` (`apps/api/src/documents/`), all `@RequireModule('CORE')`,
`@Roles('OWNER', 'ADMIN')`.

| Route                                                                                                   | Does                                                                                                                                                            | Errors                                                                         |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /documents/presets?kind`                                                                           | presets for the institute's type plus every-type ones (P8-F), with a thumbnail layout                                                                           |                                                                                |
| `GET /documents/templates?kind&archived`                                                                | the institute's templates: kind, name, page, default, version, updated                                                                                          |                                                                                |
| `POST /documents/templates` `{presetKey}` or `{copyOf, name}` or `{kind, page, orientation, name}`      | a copy of a preset or template, or a blank one; version 1 written; copying a template copies its assets into new files                                          | 404 preset/template; 413 `STORAGE_FULL` (asset copies); 422 `MODULE_DISABLED`  |
| `GET /documents/templates/:id`                                                                          | the template with its assets' ids                                                                                                                               | 404                                                                            |
| `PUT /documents/templates/:id` `{expectedVersion, name, locale, page, orientation, sheet, front, back}` | validates (`parseLayout`, assets of this template, sheet fits), bumps `version`, writes the version row                                                         | 409 `TEMPLATE_CHANGED`; 422 `LAYOUT_INVALID {issues}`; 409 `TEMPLATE_ARCHIVED` |
| `POST /documents/templates/:id/default`                                                                 | makes it the kind's default                                                                                                                                     | 409 `TEMPLATE_ARCHIVED`                                                        |
| `POST /documents/templates/:id/archive`, `…/restore`                                                    | archive (a default stops being one) / restore                                                                                                                   |                                                                                |
| `GET /documents/templates/:id/versions`, `…/versions/:v`                                                | the version list (who, when) / one version's layout (P9 reprints)                                                                                               | 404                                                                            |
| `PUT /documents/templates/:id/assets` (multipart `file`) — P8b                                          | `@OwnTransaction`, `ImageUploads.prepare('DOCUMENT_ASSET')`, then `store` + an asset row; audited                                                               | P2's image errors; 409 `TOO_MANY_ASSETS` (8)                                   |
| `GET /documents/templates/:id/assets/:assetId` — P8b                                                    | the image (`sendStoredImage`: ETag, `private, no-cache`)                                                                                                        | 404 (also another template's asset)                                            |
| `GET /documents/preview-data?kind&studentId`                                                            | the resolved `DocumentData` for one student (the designer's live preview)                                                                                       | 404 student                                                                    |
| `POST /documents/id-cards/print-data` `{templateId, sectionId?, studentIds?}`                           | ≤ 100 students: per student `DocumentData` and `photo {fileId, sha256}`; the template's current version; the institute's image ids; P9 adds each live card's QR | 422 `TOO_MANY` (> 100, with the count); 404 template; 422 `KIND_MISMATCH`      |
| `POST /documents/photos` `{studentIds}`                                                                 | ≤ 20 photos in one `multipart/form-data` answer (one part per student, named by id); students without a photo are left out                                      | 422 `TOO_MANY`; ids of another institute are simply absent                     |

- **`DocumentData`** (`packages/shared/src/documents/data.ts`): the raw values the fields read
  (`institute`, `labels`, `student`, `enrolment`, `guardian`, `document`), plus image refs
  `{fileId, sha256}` for photo, logo, signature and seal. Built by `DocumentDataService` from
  CORE rows in the request transaction (students, enrolments of the current year, the primary
  guardian, `tenant_labels`) and `InstituteProfileService.get()` (exported now). A student
  without an enrolment this year gets `enrolment: null` (the card prints without class and roll).
  Deactivated students are refused (404), leavers allowed (P9's TC needs them).
- **Photos route:** one query for the photo ids of the requested students of this institute, then
  `FileStore.get()` per file inside the request transaction (≤ 20 × 200 KB). The answer is
  `multipart/form-data` (the browser's `Response.formData()` parses it; no dependency), with
  `Cache-Control: private, no-store`. Counts against the per-person request limit like any call:
  a class of 100 is 5 requests.
- **Why not the existing photo route per student:** 100+ requests exceed the 300-a-minute limit
  and `useAuthedImage`'s 100-entry cache revokes URLs still on the page.
- **Saving** takes the template row `FOR UPDATE`, compares `version` with `expectedVersion`,
  validates, writes the template and the version row, and audits `document_template` `UPDATE` with
  `{fromVersion, toVersion}`.
- **Copying a preset** takes the institute's type through the tenant row (the API never trusts a
  type from the client) and refuses a preset of another type (404).

## Web

Route namespace `documents`; menu "ডকুমেন্ট" / "Documents" for OWNER/ADMIN (module CORE).

- **`/documents`**: templates grouped by kind (default chip, archived toggle), "Start from a
  preset" (cards with a scaled preview), "New blank". ADMIT_CARD and MARKSHEET appear only with
  EXAMS on.
- **`/documents/templates/[id]`** (P8b): the designer at ≥ 1024 px; below that a read-only preview
  with "Open on a computer to edit".
  - Canvas: the page at a fitted scale (mm → px), the 5 mm safe-area guide on A4/A5 and 1.5 mm
    on CR80, the bands on a marksheet, front/back tabs.
  - Pointer drag and 8-handle resize with a 0.5 mm snap and snapping to the page's centre lines;
    arrow keys move 0.5 mm, Shift + arrow 5 mm; Delete; Ctrl + D duplicates.
  - Property panel per element type (text: segments with a field picker grouped by subject,
    font, size in pt, weight, colour, alignment, fit; image: source, fit, border; QR: size, show
    code); a layers list (order, hide, lock).
  - Undo and redo (Ctrl + Z / Ctrl + Shift + Z, 100 steps) over a pure reducer
    (`apps/web/src/lib/documents/designer-state.ts`).
  - Live preview with a real student (a picker; `GET /documents/preview-data`); overflowing text
    is outlined in the preview (decision P8-I).
  - Save (with `expectedVersion`; on 409 "Someone saved this template meanwhile: reload or save
    as a copy"), unsaved-changes guard, version history (read-only).
  - Artwork upload (the asset route) through the existing browser shrink
    (`apps/web/src/lib/image-shrink.ts`).
- **`/documents/id-cards`**: choose a class and section (or search students), a template, the
  paper (CR80 one card per page, or the template's A4 sheet), the sides (both, fronts only, backs
  only), then "Prepare". A section over 100 is offered as parts ("1–100", "101–160").
- **`/documents/id-cards/print`**: the print page (below), with `PrintToolbar` and a "Test page"
  (a 100 mm ruler and a CR80 outline) to check the printer's scale.

### The renderer and the print page

- `DocumentSide` (`apps/web/src/components/documents/document-side.tsx`) renders one side: a box
  of `w/10 mm × h/10 mm`, each element an absolutely positioned child with numeric styles only
  (`left`, `top`, `width`, `height` in mm; `fontSize` in pt; `color` from the validated hex;
  `fontFamily` from a fixed map to the four CSS variables). Text is React children (escaped);
  images are `<img src={objectUrl}>` from blobs we fetched; the QR is an `<svg>` built from
  `QRCode.create(url).modules` (P9), never markup from a library.
- **Named pages** in `globals.css`, one per page and orientation, margin 0: `doc-cr80-l`
  (85.6mm 54mm), `doc-cr80-p`, `doc-a5-p`, `doc-a5-l`, `doc-a4-p`, `doc-a4-l`; the receipt's
  isolation block for `.doc-print.print-area`. Page sizes come from this fixed set, never from
  template data.
- **Sheets:** `sheetPositions()` places cards; backs are mirrored for the chosen edge; crop marks
  are 0.1 mm lines in the margins. Order for "both": front sheet, its back, next front sheet…
  (duplex printers); "fronts only" and "backs only" for printers without duplex.
- **Ready before print:** the Print button stays disabled ("Preparing 37 of 100 photos…") until
  every used face and weight has loaded (`document.fonts.load`) and every image has decoded
  (`img.decode()`). Photos are scaled in the browser to the element's printed size at 300 dpi
  (`createImageBitmap` with `resizeWidth`, then a JPEG blob), so 100 cards hold about 100 small
  bitmaps instead of 100 × 600 × 800. Object URLs live until the page unmounts (no shared cache).
- **Shrink to fit:** after fonts load, a text element with `fit: 'shrink'` steps its size down by
  0.5 pt until its content fits the box (at least 6 pt); still too long → the preview outlines it
  in red, the print shows it clipped, and the print page lists "3 cards have text that does not
  fit".
- **Bangla in print:** Chrome shapes conjuncts with HarfBuzz and embeds the subset faces in "Save
  as PDF"; the faces are the app's own (decision P8-G). A Playwright check renders a document
  with Bangla digits and asserts the computed font is Noto Sans Bengali (as `numerals.spec.ts`).

## Presets (`packages/db/src/reference-data/document-presets.ts`)

Data only, each validated by `layoutSchema` in a test. Static words come from the preset's
language; labels that differ by type (Class/Course, Roll/ID) are `label.*` fields, so one preset
serves every type.

| Preset key(s)                                  | Type             | Kind            | Page, sheet                                 |
| ---------------------------------------------- | ---------------- | --------------- | ------------------------------------------- |
| `id-card-landscape-bn`, `id-card-landscape-en` | every type       | ID_CARD         | CR80 landscape, 2 × 5 on A4, front and back |
| `id-card-portrait-bn`, `id-card-portrait-en`   | every type       | ID_CARD         | CR80 portrait, 3 × 3 on A4, front and back  |
| `admit-card-bn`, `admit-card-en`               | every type       | ADMIT_CARD      | A5 landscape, 1 × 2 on A4 (today's card)    |
| `marksheet-header-bn`, `marksheet-header-en`   | every type       | MARKSHEET       | A4 portrait, header and footer bands        |
| `tc-bn`, `testimonial-bn`                      | `NCTB_SCHOOL_BN` | TC, TESTIMONIAL | A4 portrait                                 |
| `tc-en`, `testimonial-en`                      | `NCTB_SCHOOL_EN` | TC, TESTIMONIAL | A4 portrait                                 |

- ID card front: logo, institute name, photo, name, class, section, roll, student code, blood
  group, valid until, QR (bottom right, 16 mm). Back: "If found, please return to", the institute's
  address and phone, the guardian's phone, the head's signature and title.
- The TC and testimonial texts are first drafts in plain words **(to verify with the owner and one
  real school's papers before release)**; they are data and each institute edits its copy.
- Coaching centres get no TC or testimonial preset (they do not issue them); they can still start
  a blank one. Madrasa presets (Sprint 2, M1) are new rows in the same file.

## Environment

None. (P9 adds `DOCUMENT_CODE_KEY` and uses P3's `WEB_PUBLIC_URL`.)

## Files

| File                                                                                                                                                                                            | Change                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `packages/shared/src/documents/` (`layout.ts`, `fields.ts`, `pages.ts`, `geometry.ts`, `data.ts`, `api.ts`, `index.ts`) + tests                                                                 | the model, geometry, types                                  |
| `packages/db/prisma/schema.prisma` + 1 migration                                                                                                                                                | enums, four tables, RLS, grants                             |
| `packages/db/src/reference-data/document-presets.ts`, `templates.ts` (`seedTemplates` calls it)                                                                                                 | presets                                                     |
| `packages/db/test/documents-rls.test.ts`, `document-presets.test.ts`, `schema-safety.test.ts`                                                                                                   | isolation, CHECKs, grants, seed                             |
| `apps/api/src/documents/` (`documents.module.ts`, `templates.service.ts`, `template-assets.service.ts`, `document-data.service.ts`, `id-cards.service.ts`, `photos.ts`, `no-type-keys.spec.ts`) | the API                                                     |
| `apps/api/src/institute/institute-profile.module.ts`                                                                                                                                            | export `InstituteProfileService`                            |
| `apps/api/src/app.module.ts`                                                                                                                                                                    | the module                                                  |
| `apps/api/test/documents-templates.e2e-spec.ts`, `documents-print.e2e-spec.ts`, `documents-assets.e2e-spec.ts`                                                                                  | API tests                                                   |
| `apps/web/src/components/documents/**`, `apps/web/src/lib/documents/**` (+ unit tests)                                                                                                          | renderer, print, designer                                   |
| `apps/web/src/app/(app)/documents/**`, `apps/web/src/lib/navigation.ts`, `app-shell.tsx`                                                                                                        | pages, menu                                                 |
| `apps/web/src/app/globals.css`                                                                                                                                                                  | the six named pages and the isolation block                 |
| `apps/web/messages/documents/*.{bn,en}.json`, `i18n/route-messages.ts`, `load-messages.ts`                                                                                                      | strings                                                     |
| `apps/web/e2e/documents.spec.ts`                                                                                                                                                                | Playwright                                                  |
| `apps/web/eslint.config.*`                                                                                                                                                                      | `react/no-danger` as an error under `components/documents/` |
| `docs/documents.md` (new), `database.md`, `files.md`, `design.md` (print), `decisions-pending.md`                                                                                               | docs                                                        |

---

## P8a: the model, presets and ID card printing

### Task 1: The layout model and fields (shared)

**Files:** `packages/shared/src/documents/layout.ts`, `fields.ts`, `pages.ts`, `data.ts`,
`layout.test.ts`, `fields.test.ts`, `index.ts`.

- [ ] **Step 1: Write the failing tests** (`layout.test.ts`):
  - a valid ID card front parses;
  - **unknown field:** `{ f: 'student.password' }`, `{ f: '__proto__' }`, `tc.left_on` on an
    ID card → issues at those paths;
  - **off page:** `x + w` one unit past the CR80 width; a 90°-rotated box that leaves the page;
  - **oversize:** 81 elements; a static text of 501 characters; a side whose JSON is over 64 KB;
  - **injection shapes:** colour `red;background:url(x)`, colour `#fff` (three digits), font
    `x}body{`, weight 650, an extra key `style` or `html` on any element, `type: 'html'`, a QR
    with `url`, an image with `src` → each refused;
  - text `<img src=x onerror=alert(1)>` as a static segment → accepted as a plain string;
  - two QRs on one side; a QR on ADMIT_CARD; a QR of 11 mm; a QR whose height is neither its
    width nor its width + 4 mm → refused;
  - MARKSHEET: an element in the body area → refused; without `bands` → refused;
  - duplicate element ids → refused.
  - `fields.test.ts`: in bn, `enrolment.roll` 7 → `7`, `student.code` → ASCII, `document.issue_date`
    → Bangla digits; `student.child_relation_en` from each gender; a missing value → empty.
- [ ] **Step 2: Run them** (`pnpm --filter @jantrik/shared exec vitest run src/documents`).
      Expected: FAIL.
- [ ] **Step 3: Implement** the schema (`strict()` objects, integer ranges, enums) and
      `resolveText`.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit:** "Document layouts as validated data: positioned elements in 0.1 mm,
      whitelisted fields per kind, no markup (sprint 1 P8)".

### Task 2: Print geometry (shared)

**Files:** `packages/shared/src/documents/geometry.ts`, `geometry.test.ts`.

**Produces:** `pageSize(page, orientation)`, `sheetFits()`, `sheetPositions(page, orientation,
sheet, side)` → `[{x, y}]` in 0.1 mm, `cropMarks()`, `printOrder(count, sheet, sides)`.

- [ ] **Step 1: Tests:**
  - CR80 landscape is 856 × 540, portrait 540 × 856; A4 2100 × 2970; A5 1480 × 2100;
  - landscape CR80 2 × 5 on A4, no gaps: the first card at (194, 135), the last at (1050, 2295),
    every card inside A4 with ≥ 5 mm margins; with 4 mm gaps likewise;
  - portrait CR80 3 × 3: the first card at (240, 201);
  - A5 landscape 1 × 2: cards at (0, 0) and (0, 1480); an element 4 mm from an A5 page's edge is
    refused by `layoutSchema` (the safe area), a CR80 background rect to the edge is accepted;
  - back, long edge: card (row 0, col 0)'s back sits at the mirrored x (`2100 − x − w`), same y;
    short edge: mirrored y; `none`: same position;
  - a 3 × 6 landscape sheet → `sheetFits` false;
  - crop marks: 4 per card corner group, all in the margins, none over a card;
  - `printOrder(23, 2 × 5, 'both')` → front 1, back 1, front 2, back 2, front 3 (3 cards), back 3.
- [ ] **Steps 2–5.** Commit: "Print geometry for CR80 cards and A4 sheets: positions, mirrored
      backs for duplex, crop marks".

### Task 3: The tables

**Files:** `schema.prisma`, the migration, `packages/db/test/documents-rls.test.ts`,
`schema-safety.test.ts`.

- [ ] **Step 1: Write the failing tests** (pattern of `files-rls.test.ts`):
  - each tenant table: institute A's rows invisible in B's context and with no context;
  - a template of B as the parent of A's version or asset → FK error;
  - an asset row pointing at A's `STUDENT_PHOTO` file → FK error (kind-bound); at B's
    `DOCUMENT_ASSET` → FK error; a file used by two asset rows → unique error;
  - CHECKs: a 65 537-byte `front`; `front` an array; a `sheet` on an A4 template; a default and
    archived template; version 0 → each refused;
  - two defaults of one kind → unique error; an archived default slot is free again;
  - the app cannot DELETE a template, a version or an asset, cannot UPDATE a version, and cannot
    UPDATE a template's `kind` or `source_preset_key`;
  - `FileStore`'s delete of an attached asset file → FK error;
  - the presets table: app SELECT works, INSERT/UPDATE/DELETE refused.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Schema and migration**; drift check empty.
- [ ] **Step 4: Run them and `schema-safety.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit:** "Document template tables: presets (global), templates, immutable
      versions and artwork tied to its template, with RLS and column grants (sprint 1 P8)".

### Task 4: Presets per institute type (data)

**Files:** `document-presets.ts`, `templates.ts`, `packages/db/test/document-presets.test.ts`,
`apps/api/src/documents/no-type-keys.spec.ts`.

- [ ] **Step 1: Write the failing tests:**
  - after `seedTemplates`: `COACHING` sees exactly the eight every-type presets;
    `NCTB_SCHOOL_BN` those plus `tc-bn`, `testimonial-bn`; `NCTB_SCHOOL_EN` plus `tc-en`,
    `testimonial-en`; seeding twice changes nothing; a preset dropped from the list is deleted;
  - every preset's sides pass `layoutSchema(kind, page, orientation)` and its sheet `sheetFits`;
  - code scan: no file under `apps/api/src/documents/`, `apps/web/src/components/documents/`,
    `apps/web/src/app/(app)/documents/` or `packages/shared/src/documents/` contains `COACHING`,
    `NCTB_SCHOOL` or `institute_type` comparisons (the presets file itself is excluded).
- [ ] **Steps 2–5.** Commit: "Document presets for the three launch types as seed data, keyed by
      institute type (no type checks in code)".

### Task 5: Templates API

**Files:** `documents.module.ts`, `templates.service.ts`, `institute-profile.module.ts` (export),
`apps/api/test/documents-templates.e2e-spec.ts`.

- [ ] **Step 1: Write the failing tests:**
  - presets list for a Bangla school: the ten expected keys; for a coaching centre: eight;
  - copy `id-card-landscape-bn` → version 1, `source_preset_key` set, a version row; copy a preset
    of another type by key → 404;
  - save with the right `expectedVersion` → version 2 and a second version row equal to the
    template; save with version 1 again → 409 `TEMPLATE_CHANGED`; two saves at once → one 200, one
    409;
  - an invalid layout → 422 `LAYOUT_INVALID` with paths, nothing written;
  - an `{asset}` id of another template → 422;
  - default: setting B as default clears A; archiving a default leaves the kind without one;
  - ADMIT_CARD with EXAMS off → 422 `MODULE_DISABLED`;
  - TEACHER, ACCOUNTANT, GUARDIAN → 403; another institute's template id → 404;
  - audit rows for create, save (`fromVersion`, `toVersion`, no layout), default, archive.
- [ ] **Steps 2–5.** Commit: "Document templates API: copy a preset, save with versions and a
      stale-save check, default and archive".

### Task 6: Document data, ID card print data and the photo batch

**Files:** `document-data.service.ts`, `id-cards.service.ts`, `photos.ts`,
`apps/api/test/documents-print.e2e-spec.ts`.

- [ ] **Step 1: Write the failing tests:**
  - preview data for a student with an enrolment: names, class, section, roll, labels (coaching:
    "Course", "ID"), institute fields from the profile, the primary guardian's phone, photo
    `{fileId, sha256}`; a student without an enrolment this year → `enrolment: null`; a
    deactivated student → 404;
  - print data for a section of 30 → 30 entries in roll order; 101 student ids → 422 `TOO_MANY`
    with the count; B's section or student ids → 404 / absent; an ADMIT_CARD template id → 422
    `KIND_MISMATCH`;
  - photos: 20 ids → a multipart answer with one part per student that has a photo, each part's
    bytes equal to the stored file; 21 ids → 422; B's student id among them → not in the answer;
    `Cache-Control: private, no-store`;
  - a class of 100 prepared in under 1 s on the test database (measured, not assumed);
  - TEACHER → 403.
- [ ] **Steps 2–5.** Commit: "ID card print data for up to 100 students and their photos in
      batches of 20".

### Task 7: The renderer and the ID card print page (web)

**Files:** `apps/web/src/components/documents/document-side.tsx`, `print-sheet.tsx`,
`use-print-assets.ts`, `apps/web/src/app/(app)/documents/**` (home, id-cards, print),
`globals.css`, messages, `route-messages.ts`, `navigation.ts`, `apps/web/e2e/documents.spec.ts`,
unit tests for `use-print-assets` helpers.

- [ ] **Step 1: Playwright (CI):**
  - an owner copies the bn landscape ID card preset, prints class 6 section A on A4 sheets: in
    print emulation, each `.doc-card` measures 85.6 × 54 mm (± 0.2 mm, from computed px at
    96 px/in), there are ⌈n/10⌉ front and back sheets interleaved, the back of the first card sits
    at the mirrored column, crop marks exist;
  - the CR80 option: one card per page of 85.6 × 54 mm;
  - the Print button is disabled until fonts and photos are ready;
  - a template whose static text is `<img src=x onerror=…>` (saved through the API) shows that
    text literally; no dialog fires;
  - Bangla digits in the issue date, ASCII roll and code; the computed font of a Bangla name is
    Noto Sans Bengali;
  - a teacher has no menu item and gets the not-available page at `/documents`;
  - screenshots bn at 1366 and 390 px.
- [ ] **Steps 2–4:** the renderer, the print page, the named pages; `react/no-danger` for the
      folder; the code scan for `dangerouslySetInnerHTML`, `style={…string…}` and `src`/`href`
      from template data.
- [ ] **Step 5: Commit:** "Print ID cards from a preset: exact CR80 pages or A4 sheets with crop
      marks, front and back".

### Task 8: P8a docs, gates, review, PR

- [ ] `docs/documents.md` (the model, fields, presets, printing, what P9 adds), `database.md`
      (the tables, the global presets table), `design.md` (print: the document pages),
      `decisions-pending.md` (a "Sprint 1, P8" section with P8-A to P8-P as approved or changed).
- [ ] Full gates; review subagent (database, template safety: review focus 1–5); PR (draft,
      depends on #16/#18/#17 until merged); CI green.

## P8b: the designer

### Task 9: Designer state (pure)

**Files:** `apps/web/src/lib/documents/designer-state.ts`, `designer-state.test.ts`.

**Produces:** a reducer over `{front, back, selection, past, future}` with `add`, `move`,
`resize`, `update`, `remove`, `duplicate`, `reorder`, `undo`, `redo`; `snap(v, 5)`; every action
keeps the layout valid (an action that would leave the page is clamped).

- [ ] **Step 1: Tests:** moving by 3.3 mm lands on 3.5 mm; resize from the top-left keeps the
      bottom-right; undo after five moves restores the original and redo replays them; the
      101st step drops the oldest; a move past the right edge clamps; duplicate gets a new id;
      the result always passes `layoutSchema`.
- [ ] **Steps 2–5.** Commit: "Designer state: snap, clamp, undo and redo as a pure reducer".

### Task 10: Artwork uploads

**Files:** `template-assets.service.ts`, `documents.module.ts`,
`apps/api/test/documents-assets.e2e-spec.ts`.

- [ ] **Step 1: Tests:** a PNG → stored as `DOCUMENT_ASSET` (re-encoded, ≤ 256 KB), an asset row,
      an audit row; the 9th → 409 `TOO_MANY_ASSETS`; a text file → 422 `IMAGE_INVALID`; over the
      institute's cap → 413 `STORAGE_FULL`; B's template → 404; the image route serves it with
      an ETag and 304 on `If-None-Match`; another template's asset id → 404; the upload holds no
      transaction while the body arrives (as P2's routes, the same test hook).
- [ ] **Steps 2–5.** Commit: "Artwork for document templates through the image pipeline (P2),
      at most eight per template".

### Task 11: The designer page

**Files:** `apps/web/src/components/documents/designer/**`,
`apps/web/src/app/(app)/documents/templates/[id]/**`, messages, `documents.spec.ts`.

- [ ] **Step 1: Playwright (CI, 1366 px):** open the copied ID card, drag the photo 10 mm right
      (it lands on the 0.5 mm grid), change the name's size to 11 pt, add a static text in Bangla,
      bind a field from the picker, upload a logo as artwork and place it, undo twice and redo
      once, save → version 2; a second tab saves a stale copy → the conflict message; the preview
      with another student shows their name; at 390 px the page is read-only.
- [ ] **Steps 2–4**, screenshots bn at 1366 and 390 px.
- [ ] **Step 5: Commit:** "The document designer: drag, resize, snap, properties, artwork, live
      preview, undo, versions".

### Task 12: P8b docs, gates, review, PR

- [ ] `docs/documents.md` (the designer, artwork), `files.md` (`DOCUMENT_ASSET` now has a route),
      `decisions-pending.md`.
- [ ] Full gates; review subagent (uploads, template safety); PR; CI green.

## Madrasa pack overlap (Sprint 2)

[sprint-2-madrasa-pack.md](sprint-2-madrasa-pack.md) builds on P8; nothing in P8 blocks it:

- **New kinds** `HIFZ_COMPLETION` (M3) and `BOARD_FORM` (M6) are `document_kind` values in their
  own migrations, with their fields added to the registry.
- **New fields:** `date.hijri` (M2, a per-document choice) and `*.name_ar` (M0) are registry
  entries; the `arabic` font is already in the model.
- **Madrasa presets** (M1) are rows in `document-presets.ts` keyed by `QAWMI`, `ALIYA`, `HAFIZIA`,
  `NURANI`; Qawmi labels (Jamaat, Kitab) reach them through `label.*` fields.
- **M-3** (adding Sprint 1's module keys, DOCUMENTS among them) changes one constant here.

## Risks

- **The QR waits for P9** (P8-A). Cards printed with P8 alone carry no QR; reprinting PVC cards
  costs institutes money, so P8 should reach institutes with P9.
- **Browsers and printers differ.** Named pages and exact millimetres work in current Chrome,
  Edge and Firefox; scaling ("Fit to page") or a printer's own margins can shrink a sheet. The
  test page and docs/documents.md show how to check; card printers need their driver's CR80
  paper.
- **Memory on old office PCs** while 100 cards with photos are rendered: photos are scaled to
  print size and a print is capped at 100; measured on the CI machine at Task 7.
- **No bleed.** Cards butt on the sheet; a coloured background to the edge can show a hairline
  after a slightly off cut. The presets use light backgrounds; docs say so.
- **Preset wording** for TC and testimonial is a draft until checked against real papers.
- **Template safety depends on the renderer staying strict.** The code scan and the ESLint rule
  make a later `dangerouslySetInnerHTML` fail CI.

## Size and split

**Large.** About 1 migration with four tables, 13 routes, 5 pages, ~10 test files. Recommended as
**two PRs** (decision P8-O):

- **P8a** (Tasks 1–8): the model, geometry, tables, presets, templates API, ID card printing from
  a preset. Reviewable as a database and template-safety change; useful on its own (with P9).
- **P8b** (Tasks 9–12): the designer and artwork uploads, mostly web.

## Self-review

- **Sprint plan coverage (P8):** `document_templates` with kind, name, page and orientation,
  sheet, front and back validated by a versioned zod schema with a 64 KB CHECK, default per kind,
  version, source preset (Task 3); presets global, `GRANT SELECT`, keyed by type, for the three
  launch types incl. ID card portrait and landscape, admit card, TC, testimonial, marksheet header
  (Task 4); elements in 0.1 mm: text (static or whitelisted field, the three faces, size, weight,
  colour, alignment), image (photo, logo, signature, seal, asset), QR, rect and line (Task 1);
  designer with drag, resize, 0.5 mm snap, property panel, live preview with a real student, undo,
  duplicating a preset, read-only on phones (Tasks 9–11); ID cards by section or students, CR80 or
  A4 2 × 5 with crop marks and mirrored backs, photos by authenticated fetch (Tasks 2, 6, 7); the
  sprint's tests: schema validation (Task 1), presets per type without type checks (Task 4), print
  geometry (Tasks 2, 7), RLS (Task 3).
- **Departures from the sprint plan, each a decision:** the QR on ID cards arrives with P9
  (P8-A); two extra tables, versions (P8-B) and assets (P8-C); the font list adds Noto Naskh
  Arabic (P8-G); blocks and bands for P9's admit card and marksheet.
- **Names used the same everywhere:** `layoutSchema`, `parseLayout`, `DOCUMENT_FIELDS`,
  `REGISTERED_KINDS`, `DocumentData`, `resolveText`, `sheetPositions`, `sheetFits`,
  `DocumentSide`, `LAYOUT_INVALID`, `TEMPLATE_CHANGED`, `TOO_MANY`, `TOO_MANY_ASSETS`,
  `KIND_MISMATCH`.

## Decisions for the owner

The approved S3 and S31 stand. These are new; each default is what the plan builds unless you
change it.

| #    | Decision                          | Recommended default                                                                                                                                                                                                                                         | Alternative                                                                                      |
| ---- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| P8-A | The ID card QR before P9          | Keep the sprint plan's split: the stable code lives in P9's register; P8 prints the QR box empty, and P8 reaches institutes only together with P9 (QR-less PVC cards would have to be reprinted)                                                            | Move `issued_documents` and the serial counters into P8 (P9 keeps verification, TC and the rest) |
| P8-B | Template history                  | Every save writes an immutable `document_template_versions` row; P9's documents point at the exact version; the audit row holds version numbers only                                                                                                        | Current layout only; reprints use today's layout                                                 |
| P8-C | Uploaded artwork                  | `document_template_assets`: a kind-bound foreign key to a `DOCUMENT_ASSET` file, never deleted while the template exists, at most 8 per template                                                                                                            | File ids only inside the layout JSON, checked at save (not enforced by the database)             |
| P8-D | How documents become paper or PDF | Browser print and "Save as PDF", as report cards and receipts today; no server PDF dependency                                                                                                                                                               | A headless-Chrome PDF worker (a heavy new dependency, its own decision later)                    |
| P8-E | Who designs and prints            | OWNER/ADMIN only; the signature and seal routes stay OWNER/ADMIN (F1 unchanged)                                                                                                                                                                             | Teachers print their own section's ID cards (widens F1 for signatures)                           |
| P8-F | How presets reach an institute    | Listed from the global table for the institute's type; copied into the institute's templates on "Use this preset"; no copy at provisioning and no backfill                                                                                                  | Copy every preset at provisioning (old institutes still need the lazy path)                      |
| P8-G | Fonts in documents                | The app's own faces: Noto Sans Bengali (400–700), Anek Bangla (600), Plus Jakarta Sans, Noto Naskh Arabic; no uploaded fonts                                                                                                                                | Uploaded fonts (licence and file-safety review needed)                                           |
| P8-H | What a template may contain       | Static text and whitelisted fields (also mixed in one paragraph), images from four named sources or its own artwork, QR, rectangles, lines; never HTML, CSS, URLs or scripts                                                                                | —                                                                                                |
| P8-I | Text longer than its box          | Per element: wrap, or shrink to fit down to 6 pt; still too long → outlined in the preview and listed before printing                                                                                                                                       | Always wrap (names may run into other elements)                                                  |
| P8-J | Size of one print                 | At most 100 students per print (a bigger section prints in parts); photos 20 per request, scaled in the browser to print size                                                                                                                               | 300 per print (more memory on office PCs)                                                        |
| P8-K | A4 sheets                         | Landscape cards 2 × 5, portrait 3 × 3, cards butting (one cut per line), crop marks in the margins; duplex flips on the long edge by default; short edge and "backs not mirrored" selectable; fronts-only and backs-only prints for printers without duplex | Gaps between cards (two cuts per line)                                                           |
| P8-L | "Valid until" on an ID card       | The current academic year's end date (printed only; P9's verification follows revocation and the student's status)                                                                                                                                          | A date typed at print                                                                            |
| P8-M | Personal data an ID card may show | Name, code, class, section, roll, group, shift, photo, date of birth, blood group, the primary guardian's phone; not the birth registration number or addresses (TC and testimonial only)                                                                   | No guardian phone on cards                                                                       |
| P8-N | Language of a template            | One language per template (its dates and digits follow it); a bilingual card places both name fields                                                                                                                                                        | Per element language                                                                             |
| P8-O | One PR or two                     | Two: P8a (model, presets, ID card printing), P8b (designer, artwork)                                                                                                                                                                                        | One large PR                                                                                     |
| P8-P | TC and testimonial preset wording | Drafts in this plan's PR, checked with you and one real school's papers before release; each institute edits its copy                                                                                                                                       | Ship blank TC/testimonial templates only                                                         |

# Sprint 1, P2: institute profile, file storage, student photos (implementation plan)

**Status: written and built during the unattended day run of 2026-11-16, for the owner's review
together with the PR.** The owner asked for this phase to be planned and built while away; the PR
is the approval step (nothing reaches `main` until the owner merges it). The sprint plan is
[sprint-1.md](sprint-1.md) → P2, with decisions S7 (Postgres storage behind `FileStore`,
server-side resize and compression, caps per file and per institute) and S8 (`sharp`). New
decisions taken during the run are F1–F12 below; each is the safe default and is listed in
`docs/decisions-pending.md` → "Sprint 1, P2".

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (one implementer,
> one review subagent at the end of the phase). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an institute keeps its own profile (names, EIIN, contact, head of institute, logo,
head's signature, seal), and staff can add a student's photo. Files are stored safely: re-encoded
on the server, small, capped per file and per institute, and isolated by RLS like every other
tenant row.

**Architecture:**

- Files live in Postgres (`stored_files.bytes`, `bytea`) under forced RLS. Only one class touches
  that table: `PostgresFileStore`, behind the `FileStore` interface (`put`, `get`, `meta`,
  `delete`). A code-scan test fails the build if anything else does. A later move to R2/S3 is a
  new `FileStore` backend plus a copy job; no caller changes.
- Uploads are multipart (`file`, ≤ 5 MB). `ImageService` (sharp) decodes the upload, refuses
  anything that is not a JPEG, PNG or WebP image or that has more than 50 megapixels, applies the
  EXIF orientation, resizes, and re-encodes. Only the re-encoded bytes are stored; metadata (EXIF,
  GPS, ICC, comments) is never copied.
- The per-institute total lives in `stored_file_usage` (one row per institute), changed in the
  same transaction as every `put` and `delete`, under a per-institute advisory lock.
- Files are served only through entity routes, never `/files/:id`: a student's photo, a guardian's
  own child's photo, and the institute's logo, signature and seal. Each answers with a strong
  `ETag` (the SHA-256) and `Cache-Control: private, no-cache`; `If-None-Match` gets 304.
- The web fetches an image with the bearer token (`AuthClient.download`) and shows it through an
  object URL, cached per path and file id. No signed URLs, so there is no new auth mechanism.

**Tech stack:** NestJS (multer through `@nestjs/platform-express`, already used by the device
import), `sharp` 0.35.5 (already in the lockfile through Next.js; now a direct API dependency,
S8), Prisma/PostgreSQL 16, Next.js (v3 kit), next-intl, Vitest, Playwright.

**Branch:** `feature/sprint-1-p2-files`, from `main` at `7de4f5a`. P1-J
(`feature/sprint-1-p1j-password-hash`) adds migration `20261116000000_*` and should merge first;
this branch's migrations are `20261116100000_*` and later, so the order holds either way.

## Global constraints

- **Tables:** the database.md checklist for every new table (ticked below), composite foreign keys
  to tenant tables (optional ones too), every new foreign key `ON UPDATE RESTRICT`, an index
  leading with `tenant_id`, enabled and forced RLS with `tenant_isolation`, explicit grants.
- **No backfill:** existing institutes have no profile and no usage row; both are created on first
  use (the profile on the first save or image upload, the usage row on the first `put`).
- **Caps (S7), in code and by CHECK:**

  | Kind              | Output                                   | Max size | Max box   |
  | ----------------- | ---------------------------------------- | -------- | --------- |
  | `STUDENT_PHOTO`   | JPEG                                     | 200 KB   | 600 × 800 |
  | `APPLICANT_PHOTO` | JPEG (P3 uses it)                        | 200 KB   | 600 × 800 |
  | `LOGO`            | PNG, or WebP when the PNG does not fit   | 100 KB   | 512 × 512 |
  | `SEAL`            | PNG, or WebP when the PNG does not fit   | 100 KB   | 512 × 512 |
  | `SIGNATURE`       | PNG                                      | 100 KB   | 600 × 240 |
  | `DOCUMENT_ASSET`  | JPEG, PNG or WebP (P8 uses it; no route) | 256 KB   | —         |

  Per institute: `FILE_STORAGE_PER_TENANT_MB` (default 1024). Over it: 413 `STORAGE_FULL`.

- **Inputs:** at most 5 MB (multer `fileSize`, one file, no other fields); at most 50 megapixels
  (`limitInputPixels`); JPEG, PNG or WebP by content (the declared type and file name are ignored);
  only the first frame of an animated image is used.
- **Transactions:** the image work runs before the file is stored, in the request; it takes
  ~0.1–0.5 s, well inside the 15 s request transaction. At most two images are processed at once
  per API process (a small in-process limiter), so a burst of uploads cannot exhaust memory.
- **Audit:** every profile change (field values), every image set or removed (`{kind, fileId}`
  only, never bytes) and every student photo change (`photoFileId` old/new).
- **Strings:** bn and en through translation keys. Bangla digits are accepted in EIIN, phone and
  year (`toAsciiDigits`). The v3 kit, light-first; screenshots bn at 1366 and 390 px.
- **Secrets:** none new. `FILE_STORAGE_PER_TENANT_MB` is a setting, not a secret.

## Review focus

1. **Another institute's file.** A UUID from institute A used in B: every route answers 404, RLS
   hides the row, and a composite foreign key refuses to point B's student or profile at A's
   file. Test: Task 1 (database), Task 5 (routes).
2. **A hostile image.** A 50 000 × 50 000 PNG of a few KB (decompression bomb), a text file named
   `.jpg`, a truncated JPEG, a GIF, a 6 MB upload. Expected: 413 for the size, 422 for the rest,
   nothing stored, the usage unchanged. Test: Tasks 3 and 5.
3. **Location leaks.** A phone photo with EXIF GPS: the stored JPEG has no EXIF at all (and the
   orientation is applied first, so the photo is not sideways). Test: Task 3.
4. **The per-institute cap under concurrency.** Two uploads at once when only one fits: exactly
   one is stored, the other gets 413 `STORAGE_FULL`, and the usage equals the sum of the stored
   files. Test: Task 4.
5. **A guardian reaching another child's photo.** `GET /me/children/:id/photo` answers 404 for any
   student not linked to the caller; staff routes answer 403 for guardians. Test: Task 5.

## Decisions taken during the run (F1–F12, the owner reviews them with the PR)

- **F1. Who sees what.** A student's photo is part of the full record, as on the student's page
  (the basic view for a teacher of another section already left it out): `OWNER` and `ADMIN` for
  every student, a `TEACHER` for the students of their current sections, guardians for their own
  children only; anyone else gets 404. Logo: every member of the institute (guardians too).
  Head's signature and seal: `OWNER` and `ADMIN` only (they can be misused on forged papers;
  printing roles widen in P8/P9). Profile fields: `OWNER` and `ADMIN` (the settings page).
- **F2. Lists keep initials.** The student list, the board and the other lists do not load photos
  (50 photos of up to 200 KB each would break the 3 s budget on slow 4G). Photos show on the
  student's page, the guardian's child card and the report card. A small thumbnail kind for lists
  is a follow-up (backlog).
- **F3. `photoId` replaces `photoUrl`** in every API type (student list, profile, guardian
  children, report cards, admit cards): the stored file's id, or null. It doubles as the cache
  key, so a replaced photo is fetched again.
- **F4. EIIN is exactly 6 digits** (BANBEIS EIIN), optional. Widening it later is one CHECK.
- **F5. The institute's phone** may be a mobile or a landline: stored as 5–15 ASCII digits with an
  optional leading `+` (a Bangladeshi mobile is stored as E.164).
- **F6. At least one name** (Bangla or English) is required in a saved profile. An image uploaded
  before the first save creates the profile with the institute's registered name (`tenants.name`)
  in the matching script.
- **F7. Formats.** HEIC/HEIF is refused (iPhones send JPEG to browsers for `image/*` inputs; the
  prebuilt sharp has no HEVC decoder). Transparent PNG photos are flattened on white.
- **F8. Upload limit:** 60 uploads per person per 10 minutes (`file-upload:<userId>`), on top of
  the general request limits, because each upload costs CPU.
- **F9. Deactivated students:** their photo can still be viewed by OWNER/ADMIN, but not changed
  (409 `DEACTIVATED`, as other student writes).
- **F10. Replacing a file deletes the old one** in the same transaction (no orphans, no history of
  images). The audit row keeps the old and new file ids.
- **F11. The usage row is counted, not recomputed:** `bytes_used` and `file_count` move with every
  `put`/`delete` under the institute's advisory lock; a test checks they equal the sums of the
  rows.
- **F12. No report-card logo or institute header in P2.** The profile and its images exist for P3
  (admission slip), P8 and P9 (documents); the report card gains only the student photo, as the
  sprint plan says.

## Database (migrations `20261116100000_files_and_institute_profile`, `20261116100100_students_photo_file`)

### `stored_file_kind` (enum)

`STUDENT_PHOTO`, `APPLICANT_PHOTO`, `LOGO`, `SIGNATURE`, `SEAL`, `DOCUMENT_ASSET` (a new type, so
it is created with the table; no value is added to an existing enum).

### `stored_files` (S I D, no UPDATE)

| Column          | Type               | Rule                                                                   |
| --------------- | ------------------ | ---------------------------------------------------------------------- |
| `id`            | uuid (v7)          | primary key                                                            |
| `tenant_id`     | uuid               | NOT NULL, FK `tenants` RESTRICT/RESTRICT                               |
| `kind`          | `stored_file_kind` | NOT NULL                                                               |
| `mime`          | text               | CHECK `image/jpeg`, `image/png`, `image/webp`, and the kind/mime pairs |
| `bytes`         | bytea              | NOT NULL                                                               |
| `size_bytes`    | integer            | CHECK `= octet_length(bytes)` and ≤ the kind's cap                     |
| `sha256`        | char(64)           | CHECK `^[0-9a-f]{64}$`                                                 |
| `width`         | integer            | CHECK 1–4000                                                           |
| `height`        | integer            | CHECK 1–4000                                                           |
| `created_by_id` | uuid, null         | FK `users` (global, cannot be composite; the uploader is the caller)   |
| `created_at`    | timestamptz(3)     | no `updated_at`: rows never change                                     |

Indexes: `UNIQUE (tenant_id, id)`, `(tenant_id, kind)`.

### `stored_file_usage` (S I U, no DELETE)

`id`, `tenant_id` (UNIQUE), `bytes_used bigint` CHECK ≥ 0, `file_count integer` CHECK ≥ 0,
`created_at`, `updated_at`. `UNIQUE (tenant_id, id)`.

### `institute_profiles` (S I U, no DELETE; ≤ 1 per institute)

`id`, `tenant_id` (UNIQUE), `name_bn`, `name_en`, `short_name`, `eiin`, `address_bn`,
`address_en`, `phone`, `email`, `website`, `head_title_bn`, `head_title_en`, `head_name_bn`,
`head_name_en`, `established_year smallint`, `logo_file_id`, `head_signature_file_id`,
`seal_file_id`, `created_at`, `updated_at`.

- CHECKs (each tests `IS NULL` first): at least one name; lengths (names 200, short name 30,
  addresses 300, head titles 60, head names 100, email 254, website 200); `eiin ~ '^[0-9]{6}$'`;
  `phone ~ '^\+?[0-9]{5,15}$'`; a simple e-mail shape; `website ~ '^https?://\S+$'`;
  `established_year BETWEEN 1800 AND 2100`.
- The three file columns: composite FKs `(tenant_id, x) → stored_files (tenant_id, id)` ON DELETE
  RESTRICT ON UPDATE RESTRICT, each UNIQUE with `tenant_id` (a file belongs to one place).

### `students`

- `photo_file_id uuid` null, composite FK to `stored_files` RESTRICT/RESTRICT,
  `UNIQUE (tenant_id, photo_file_id)` (also the FK's index).
- `photo_url` is dropped (never written: always null).

### RLS checklist (every new table)

| Step                                                      | `stored_files` | `stored_file_usage` | `institute_profiles` |
| --------------------------------------------------------- | -------------- | ------------------- | -------------------- |
| `tenant_id NOT NULL`, tenant relation                     | ✅             | ✅                  | ✅                   |
| `@@unique([tenantId, id])`                                | ✅             | ✅                  | ✅                   |
| composite FKs to tenant tables (optional ones too)        | — (none)       | — (none)            | ✅ three files       |
| every FK `ON UPDATE RESTRICT`                             | ✅             | ✅                  | ✅                   |
| index leading with `tenant_id`                            | ✅             | ✅ (unique)         | ✅ (unique)          |
| ENABLE + FORCE RLS, `tenant_isolation` USING + WITH CHECK | ✅             | ✅                  | ✅                   |
| explicit grants, nothing more                             | S I D          | S I U               | S I U                |
| CHECKs test nullable columns with `IS NULL` first         | ✅             | n/a                 | ✅                   |
| no tenant backfill in the migration                       | ✅             | ✅                  | ✅                   |
| added to `schema-safety.test.ts`                          | ✅             | ✅                  | ✅                   |
| isolation test in `packages/db/test/files-rls.test.ts`    | ✅             | ✅                  | ✅                   |
| drift check (`prisma migrate diff` empty)                 | ✅             | ✅                  | ✅                   |

## API

| Route                                      | Roles                        | Answer                               |
| ------------------------------------------ | ---------------------------- | ------------------------------------ |
| `GET /institute/profile`                   | OWNER, ADMIN                 | `InstituteProfile`                   |
| `PUT /institute/profile`                   | OWNER, ADMIN                 | `InstituteProfile`                   |
| `PUT /institute/profile/:slot` (multipart) | OWNER, ADMIN                 | `InstituteProfile`                   |
| `DELETE /institute/profile/:slot`          | OWNER, ADMIN                 | `InstituteProfile`                   |
| `GET /institute/profile/logo`              | every member (guardians too) | the image, 404 if none               |
| `GET /institute/profile/signature`, `seal` | OWNER, ADMIN                 | the image, 404 if none               |
| `GET /students/:id/photo`                  | OWNER, ADMIN, TEACHER        | the image, 404 if none               |
| `PUT /students/:id/photo` (multipart)      | OWNER, ADMIN                 | `StudentProfile`                     |
| `DELETE /students/:id/photo`               | OWNER, ADMIN                 | `StudentProfile`                     |
| `GET /me/children/:id/photo`               | GUARDIAN (own children)      | the image, 404 if none or not theirs |

`:slot` is `logo`, `signature` or `seal`. All routes are `@RequireModule('CORE')`.

Errors: 400 `FILE_REQUIRED`; 413 (multer, over 5 MB); 422 `IMAGE_INVALID` (not a supported
image, corrupt); 422 `IMAGE_TOO_BIG` (over 50 megapixels); 422 `IMAGE_CANNOT_SHRINK` (could not
reach the cap, practically never); 413 `STORAGE_FULL`; 409 `DEACTIVATED`; 429 with
`Retry-After`.

## Files

| File                                                                                      | Change                                                                                |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `packages/db/prisma/schema.prisma` + 2 migrations                                         | tables, enum, students column                                                         |
| `packages/db/test/files-rls.test.ts`, `schema-safety.test.ts`                             | isolation, grants, CHECKs, FKs                                                        |
| `packages/shared/src/files.ts`, `files-schema.ts` (+ tests), `index.ts`                   | caps, types, the profile schema                                                       |
| `apps/api/src/files/*`                                                                    | `FileStore`, `PostgresFileStore`, `ImageService`, the code scan, the upload decorator |
| `apps/api/src/institute/institute-profile.module.ts`                                      | profile routes                                                                        |
| `apps/api/src/students/student-photo.service.ts`, `students.module.ts`                    | photo routes                                                                          |
| `apps/api/src/me/me.module.ts`                                                            | the guardian's child photo                                                            |
| `apps/api/src/config/env.ts`                                                              | `FILE_STORAGE_PER_TENANT_MB`                                                          |
| `photoUrl` → `photoId` in the API and shared types                                        | F3                                                                                    |
| `apps/api/test/files.e2e-spec.ts`, `institute-profile.e2e-spec.ts`                        | API tests                                                                             |
| `apps/web/src/lib/authed-image.ts`, `components/student-photo.tsx`                        | object URLs                                                                           |
| `apps/web/src/app/(app)/setup/profile/page.tsx`, `components/setup/setup-kit.tsx`         | Settings → Institute profile                                                          |
| `apps/web/src/app/(app)/students/[id]/page.tsx`, `components/students/photo-dialog.tsx`   | the photo on the student page                                                         |
| `apps/web/src/components/exams/report-card.tsx`, `dashboard/page.tsx`                     | the photo on the report card and child card                                           |
| `apps/web/messages/{bn,en}.json`                                                          | strings                                                                               |
| `apps/web/e2e/files.spec.ts`                                                              | Playwright                                                                            |
| `docs/files.md` (new), `database.md`, `deploy.md`, `.env.example`, `decisions-pending.md` | docs                                                                                  |

---

### Task 1: The database

**Files:** `schema.prisma`; the two migrations (written by hand: Prisma's `--create-only` needs
a development database, and this run uses scratch databases only); `files-rls.test.ts`;
`schema-safety.test.ts`.

- [ ] **Step 1: Write the failing tests** (`files-rls.test.ts`):
  - another institute cannot read, delete, or insert a `stored_files` row with A's `tenant_id`;
    nobody may UPDATE a file (permission denied);
  - the CHECKs: an unknown mime, a GIF, a 210 KB photo, a 110 KB logo, a PNG photo, a JPEG
    signature, `size_bytes` ≠ `octet_length(bytes)`, a bad sha256, width 0 → refused; a 200 KB
    photo and a 256 KB document asset → accepted;
  - `stored_file_usage`: isolation, no DELETE, `bytes_used` ≥ 0;
  - `institute_profiles`: isolation, one per institute, no DELETE, the CHECKs (no name, 5-digit
    EIIN, `abc` phone, `x@` e-mail, `ftp://` website, year 1700), pointing the logo at another
    institute's file → refused (composite FK), deleting a file a profile uses → refused;
  - `students.photo_file_id`: another institute's file → refused; two students cannot share one
    file; `photo_url` is gone;
  - `schema-safety.test.ts`: the three tables in the tenant table list.
- [ ] **Step 2: Run them and see them fail** (`pnpm --filter @jantrik/db exec vitest run
test/files-rls.test.ts` on the scratch database).
- [ ] **Step 3: Schema and migrations** as in "Database" above; RLS, grants and CHECKs in the
      same migration file. Regenerate the client; the test setup applies the migrations.
- [ ] **Step 4: Run them and see them pass;** drift check against the scratch database.
- [ ] **Step 5: Commit.**

### Task 2: Shared caps, types and the profile schema

**Files:** `packages/shared/src/files.ts` (no zod: the web imports it), `files-schema.ts`, tests.

- Produces: `STORED_FILE_KINDS`, `FILE_LIMITS` (per kind: `maxBytes`, `box`, `mimes`),
  `UPLOAD_MAX_BYTES = 5 * 1024 * 1024`, `UPLOAD_MAX_PIXELS = 50_000_000`, `INSTITUTE_IMAGE_SLOTS`,
  types `FileRef` and `InstituteProfile`, `instituteProfileSchema` (trims; empty → null;
  `toAsciiDigits` for EIIN, phone, year; a BD mobile normalised to E.164; at least one name).
- Tests: Bangla digits in EIIN/phone/year; landline and mobile phones; every CHECK of Task 1 has
  a matching schema refusal; caps equal the CHECK values.
- Commit.

### Task 3: Image processing (`ImageService`)

**Files:** `apps/api/src/files/image.service.ts`, `image.service.spec.ts`, `apps/api/package.json`
(`sharp` 0.35.5).

- Produces: `ImageService.process(kind, input: Buffer) → { bytes, mime, width, height }`.
  - `sharp(input, { limitInputPixels: UPLOAD_MAX_PIXELS, failOn: 'error' })`, metadata first:
    format must be `jpeg`, `png` or `webp`, else `IMAGE_INVALID`; over the pixel limit →
    `IMAGE_TOO_BIG`.
  - `.rotate()` (EXIF orientation), `.resize(box, { fit: 'inside', withoutEnlargement: true })`.
  - Photos: flatten on white, JPEG (mozjpeg) at quality 85 → 75 → 65 → 55 → 45, then 80 %
    smaller dimensions, until under 200 KB. Logo and seal: palette PNG, else WebP 90 → 50, then
    smaller. Signature: palette PNG with 256 → 64 → 16 colours, then smaller.
  - Metadata is never kept (no `withMetadata`/`keepMetadata`).
  - At most two `process` calls run at once per process.
- Tests (images made with sharp in the test): JPEG/PNG/WebP in → JPEG ≤ 200 KB and ≤ 600 × 800;
  a 4000 × 3000 noisy photo fits; EXIF GPS and orientation 6 → no EXIF, rotated size; a
  transparent PNG logo keeps its alpha; a signature is PNG; a text file, a GIF, a truncated JPEG →
  `IMAGE_INVALID`; a crafted 50 000 × 50 000 PNG header → `IMAGE_TOO_BIG` without decoding.
- Commit.

### Task 4: `FileStore` and the per-institute cap

**Files:** `apps/api/src/files/file-store.ts` (interface + token), `postgres-file-store.ts`,
`files.module.ts`, `file-store-access.spec.ts` (code scan), `config/env.ts`.

- `put({kind, mime, bytes, width, height})`: checks the kind's cap and mime (a programming error
  if it fails: 500), takes `pg_advisory_xact_lock(hashtextextended('stored-files:' ||
app_current_tenant_id()::text, 0))`, upserts the usage row, refuses with 413 `STORAGE_FULL`
  when `bytes_used + size > cap`, inserts the file (sha256 computed here), adds to the usage.
- `get(id)`, `meta(id)` (no bytes), `delete(id)` (lock, delete, subtract).
- Code scan: in `apps/api/src`, only `files/postgres-file-store.ts` mentions `storedFile`,
  `storedFileUsage`, `stored_files` or `stored_file_usage`.
- Tests (in `files.e2e-spec.ts`): usage equals the sums after puts, a replace and a delete; a
  preset usage near the cap → 413; review focus 4 (two parallel uploads, one fits).
- Commit.

### Task 5: The routes

**Files:** `apps/api/src/files/upload.ts` (`ImageUpload()` decorator: `FileInterceptor('file',
{ limits: { fileSize: 5 MB, files: 1, fields: 0 } })`), `files/serve.ts` (headers, 304),
`institute/institute-profile.module.ts`, `students/student-photo.service.ts`,
`students/students.module.ts`, `me/me.module.ts`, `app.module.ts`; `photoUrl` → `photoId` in the
services and shared types (F3).

- Tests (`files.e2e-spec.ts`, `institute-profile.e2e-spec.ts`):
  - admin uploads a photo → profile with `photoId`; `GET` → 200 `image/jpeg`, `ETag`,
    `Cache-Control: private, no-cache`; `If-None-Match` → 304; teacher → 200; accountant → 403;
    guardian → 403;
  - another institute's admin → 404 (`GET`, `PUT`, `DELETE`);
  - the guardian of that child → 200 at `/me/children/:id/photo`; another guardian → 404;
  - replace → the old file is gone and the usage is the new size; `DELETE` → 404 afterwards;
  - 6 MB → 413; a text file → 422 `IMAGE_INVALID`; a bomb → 422 `IMAGE_TOO_BIG`; nothing stored
    and the usage unchanged after each;
  - a deactivated student → 409 `DEACTIVATED`;
  - audit rows (student `photoFileId`; institute profile values; image `{kind, fileId}`);
  - the profile: default from `tenants.name`; `PUT` validation (400 for bad EIIN); teacher → 403;
    logo `GET` as guardian → 200; signature and seal as teacher → 403; an image before the first
    save creates the profile (F6); another institute → 404;
  - the upload limit (F8): the 61st upload in 10 minutes → 429.
- Commit (routes), then commit (types).

### Task 6: The web

- `lib/authed-image.ts`: `useAuthedImage(path, version)`: `client.download(path)` → object URL,
  cached by `path#version` (up to 100, revoked on eviction); null while loading or on 404.
- `StudentPhoto` / `StudentAvatar`: `PersonAvatar` with the object URL; initials meanwhile.
- **Settings → Institute profile** (`/setup/profile`, tab "Institute profile", OWNER/ADMIN): the
  form (names, short name, EIIN, addresses, phone, e-mail, website, head's title and name,
  established year) and an "Images" card with logo, head's signature and seal: preview, upload or
  replace, remove, the size and format hint. Errors by code.
- **Student page:** the avatar shows the photo; OWNER/ADMIN get "Photo" (upload/replace, remove)
  in a dialog with a local preview, a client-side 5 MB check and the hint.
- **Report card:** the photo through the hook. **Guardian dashboard:** the child card's avatar.
- Strings bn/en; route messages unchanged (`setup` and `profile` namespaces already sent).
- Playwright (`e2e/files.spec.ts`, CI): the owner fills the profile and uploads a logo (preview
  appears); the admin uploads a student photo and sees it on the student page.
- Commit.

### Task 7: Docs and gates

- `docs/files.md` (storage, caps, routes, how to move to a bucket, backups), `database.md`
  (the tables and the `FileStore` rule), `deploy.md` (backup growth, `FILE_STORAGE_PER_TENANT_MB`),
  `.env.example`, `decisions-pending.md` (F1–F12).
- Gates: lint, typecheck, format, tests package by package, build, size budget; Playwright in CI.
- Review subagent (database, uploads), fixes, PR.

## Changed after the review (2026-11-16)

- **R1. Uploads no longer run inside the request transaction** (must-fix). `TenantContextInterceptor`
  (a global interceptor) opened the 15 s transaction and took a pool connection before multer read
  the body: a 2–5 MB photo on slow 4G took longer than 15 s (a 500 every time), and ten slow
  uploads could hold all 10 connections (every other institute failing). The two upload routes
  are now `@OwnTransaction()`: the body is read, the upload limit applied and the image decoded
  with no connection; then `RequestTransaction.run` (the interceptor's own logic, moved into a
  service) opens the same tenant transaction for the short store. The image queue is bounded (8
  waiting; more get 503 `IMAGE_BUSY`), and the browser shrinks a chosen image to 1600 px on the
  long side (JPEG 0.85 for photos, PNG for the others) before sending, so a phone sends about
  300 KB. Test: while a slow body arrives, no session of the app login is idle in a transaction.
- **R2. The code scan also catches Prisma relation fields** (`photoFile`, `logoFile`,
  `signatureFile`, `sealFile`, `storedFiles`, `storedFileUsage`, `storedFilesCreated`, the
  `profile*` back-relations).
- **R3. The guardian's report card shows the photo** through `/me/children/:id/photo`
  (`ReportCardsPrint as="guardian"`); Playwright checks it in the exams spec.
- **R4. The web address's scheme is stored in lower case** (`HTTPS://x` → `https://x`), as the
  database CHECK is case-sensitive; it was a 500.
- **R5. The image queue hands a freed slot straight to the next waiter**, so it can never run
  three at once.
- **R6. A file reference is tied to its kind in the database.** `stored_files` has
  `UNIQUE (tenant_id, id, kind)`; `students.photo_file_kind` (always `STUDENT_PHOTO`) and
  `institute_profiles.logo_file_kind`, `head_signature_file_kind`, `seal_file_kind` (always
  `LOGO`, `SIGNATURE`, `SEAL`, by CHECK) are part of each foreign key, so a photo column can only
  hold a photo, a logo column a logo, and so on.
- **R7. Replacing an image near the cap is allowed** when the total would not grow: `put` takes the
  id it replaces (read under the file lock) and counts it.
- **R8. The first image and the first save cannot collide:** the row an image creates is inserted
  with `ON CONFLICT DO NOTHING`.
- **R9.** F1 above now says what the code does (a teacher sees photos of their own sections only).
- **R10.** The database tests name the rule that refuses each write; a PNG `eXIf` GPS case was
  added to the image tests.

## Changed after the review, round 2 (2026-11-16)

- **R11. Uploads in flight are bounded.** With R1 nothing limited how many upload bodies could be
  in memory. `UploadGuard` (before multer) allows 16 per process and 2 per person, refuses more at
  once with 503 `IMAGE_BUSY`, gives the slot back when the response closes (sent, failed or
  dropped by the client), and drops a body not received within 60 s.
- **R12. `RequestTransaction.run` refuses to nest** inside a request transaction (it would replace
  the outer one in the request context). The interceptor itself uses an unchecked entry (`around`): it is the outermost transaction, and a request made from inside a running job (as some tests do) inherits that job\'s request context.
- **R13. The upload's transaction re-checks the session and the route's roles** (OWNER/ADMIN),
  read in the transaction, besides the institute's status and the membership: an admin
  downgraded, or a session revoked, while the body arrives stores nothing (403 / 401).
- **R14. The target is checked before decoding:** a student photo for an unknown or deactivated
  student, or any upload in a suspended institute or by someone who lost the role, is refused
  before the image is decoded or the upload quota is used.
- **R15. sharp's own 10 s timeout** on the decode and each encode → 422 `IMAGE_TIMEOUT`.
- **R16. A replacement no bigger than the old file is never refused**, even when the total is over
  a lowered cap; `FileStore.put`'s contract says the caller deletes the replaced file in the same
  transaction.
- **R17. A profile save takes the file lock before reading the row**, so a first save racing a
  first image is audited as an UPDATE (one CREATE per institute).
- **R18. The browser asks for the EXIF orientation explicitly** (`imageOrientation:
'from-image'`); an engine without it sends the original, which the server turns upright.
- **Tests:** a deterministic database test of the ON CONFLICT path (an insert held uncommitted);
  the slow-body check sampled every 100 ms, for the logo route too; suspended institute and
  disabled member → 403 with nothing stored; the signature column's wrong kind; the exams spec
  removes the demo child's photo in an `afterEach`.
- **Migrations edited in place:** both migrations of this PR changed after it was first pushed
  (R6). Nothing outside this run's scratch databases applied them; any database that did needs
  a fresh one (or a reset) before applying the final versions.

## Changed after the review, round 3 (2026-11-16)

- **R19. No upload slot leaks when the client leaves early** (must-fix). If the socket closed while
  the global guards awaited Redis, the response's one 'close' event was already past when
  `UploadGuard` listened for it, so the slot was never given back. A client already gone (the
  test on-finished uses: the request or response destroyed, the answer sent, or the socket no
  longer writable) now gets no slot, and every slot is given back after 5 minutes at the latest
  (a backstop).
- **R20. The revoked-session check runs before the transaction**, with Redis's 2 s deadline (503
  `SERVICE_UNAVAILABLE`), so a slow Redis never holds a pooled connection; the roles are still
  read in the transaction.
- **R21. A browser that predates `imageOrientation`** (a TypeError) decodes without it when the
  photo needs no turning (no EXIF orientation, or 1; a small JPEG reader checks), and sends the
  original otherwise (the server turns it upright).
- **R22.** The timeout test uses sharp 0.35.5's real message (`timeout: N% complete`).

## Risks

- **Backups grow** (about 100 MB per 2 000 photos). `pg_dump` custom format does not compress
  JPEG further. If the backup window suffers, `FileStore` moves to a bucket (S7).
- **sharp is native code.** The Docker image is Alpine (musl): the lockfile already holds
  `@img/sharp-linuxmusl-x64`, which `pnpm install` picks there; CI uses linux-x64. A missing
  binary fails at start-up (the module is imported), never silently.
- **A hand-written migration** (no development database in this run): the drift check against
  the scratch database covers it.

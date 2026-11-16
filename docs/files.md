# Files: photos, logos, signatures and seals

How Jantrik stores images (sprint 1 P2, decision S7). The plan with its decisions F1–F12 is
[plans/sprint-1-p2-files.md](plans/sprint-1-p2-files.md).

## Where files live

- **In Postgres**, table `stored_files` (`bytes bytea`), a tenant table under forced RLS like every
  other. The existing backups (`pg_dump`) cover the files; nothing else to back up.
- **Only `PostgresFileStore`** (`apps/api/src/files/postgres-file-store.ts`) touches
  `stored_files` and `stored_file_usage`. Everything else uses the `FileStore` interface
  (`file-store.ts`: `lock`, `put`, `get`, `meta`, `delete`, `usage`).
  `file-store-access.spec.ts` fails the build if other code names those tables.
- **Moving to a bucket (R2/S3) later** is a new `FileStore` implementation plus a one-off job that
  copies each row's bytes to the bucket. Callers and routes do not change; `stored_files` keeps
  the metadata and loses the bytes.

## What is stored

Never the uploaded file. `ImageService` (`apps/api/src/files/image.service.ts`, `sharp`):

1. checks the magic bytes: JPEG, PNG or WebP only (no SVG, GIF, HEIC, PDF), whatever the browser
   said the type or name was;
2. reads only the header and refuses more than 50 megapixels (`UPLOAD_MAX_PIXELS`) before
   decoding anything, so a decompression bomb costs nothing;
3. decodes once (the first frame of an animation), turns it upright (EXIF orientation), shrinks it
   into the kind's box, and re-encodes it until it fits the kind's cap;
4. never copies metadata: EXIF (with GPS), ICC, XMP and comments are gone.

At most two images are processed at once per API process; at most 8 more wait (more get 503
`IMAGE_BUSY`), and a freed slot goes straight to the next one. sharp's own timer stops a decode or
an encode after 10 s (422 `IMAGE_TIMEOUT`).

**Uploads in flight** (`UploadGuard`, before multer reads a byte): at most 16 per API process and
2 per person; more get 503 `IMAGE_BUSY` at once. The slot is given back when the response closes,
however it ends, and a body not received within 60 s is dropped.

**No database connection while an upload arrives.** The upload routes are `@OwnTransaction()`
([auth.md](auth.md) → Request pipeline): multer reads the body and `ImageService` decodes it
before any transaction is opened; then one short request transaction stores the file and changes
the row. That transaction re-checks what the guards checked when the request arrived (the
session, the institute's status, the membership and the route's roles), and a short one before
decoding refuses an unknown or deactivated student, a suspended institute or a lost role without
decoding anything. The browser also shrinks a chosen image to 1600 px on the long side before sending
(`apps/web/src/lib/image-shrink.ts`: JPEG 0.85 for photos, PNG otherwise; the original when the
browser cannot decode it or the copy is not smaller), so a phone photo is about 300 KB.

| Kind              | Stored as                         | Cap    | Box       | Used by                                  |
| ----------------- | --------------------------------- | ------ | --------- | ---------------------------------------- |
| `STUDENT_PHOTO`   | JPEG (transparency on white)      | 200 KB | 600 × 800 | the student's page, report cards         |
| `APPLICANT_PHOTO` | JPEG                              | 200 KB | 600 × 800 | P3 (online admission)                    |
| `LOGO`, `SEAL`    | PNG, or WebP when a PNG won't fit | 100 KB | 512 × 512 | the institute profile                    |
| `SIGNATURE`       | PNG                               | 100 KB | 600 × 240 | the institute profile (the head)         |
| `DOCUMENT_ASSET`  | JPEG, PNG or WebP                 | 256 KB | —         | P8 (the document designer; no route yet) |

The caps are in `packages/shared/src/files.ts` (`FILE_LIMITS`) and again in the database
(`stored_files_size`, `stored_files_mime`), so a bug in the code cannot store more.

## The per-institute total

- `stored_file_usage` (one row per institute, created by the first upload): `bytes_used`,
  `file_count`.
- Every `put` and `delete` takes the institute's advisory lock
  (`hashtextextended('stored-files:' || tenant)`) and changes the total in the same transaction,
  so the total always equals the sum of the rows, even with uploads at the same moment.
- Over `FILE_STORAGE_PER_TENANT_MB` (default 1024): 413 `STORAGE_FULL` with `bytesUsed` and
  `capBytes`. A per-institute limit set by the platform can come later.
- Code that replaces or clears an image calls `lock()` **before** reading which file a row points
  at, so two changes of one image cannot both delete or keep the same old file. A replacement
  passes the old id to `put(file, { replaces })`, which counts it: a replacement that does not
  grow the total is allowed near the cap, and one no bigger than the old file even over a
  lowered cap. The caller deletes the old file in the same transaction.
- **Each reference is tied to its kind:** `UNIQUE (tenant_id, id, kind)` on `stored_files`, and a
  fixed kind column in each foreign key (`students.photo_file_kind` is always `STUDENT_PHOTO`,
  `institute_profiles.logo_file_kind` `LOGO`, and so on), so a logo can never be used as a photo.

## Routes

Entity routes only; there is no `/files/:id`.

| Route                                      | Who                                                      |
| ------------------------------------------ | -------------------------------------------------------- |
| `GET /students/:id/photo`                  | OWNER, ADMIN; a TEACHER of the student's current section |
| `PUT`, `DELETE /students/:id/photo`        | OWNER, ADMIN (not for a deactivated student: 409)        |
| `GET /me/children/:id/photo`               | the guardian, for their own children only (else 404)     |
| `GET`, `PUT /institute/profile`            | OWNER, ADMIN                                             |
| `PUT`, `DELETE /institute/profile/:slot`   | OWNER, ADMIN (`logo`, `signature`, `seal`)               |
| `GET /institute/profile/logo`              | every member, guardians too                              |
| `GET /institute/profile/signature`, `seal` | OWNER, ADMIN                                             |

- A student's photo is part of the full record, as on the student's page: a teacher of another
  section, and the student list for them, get no photo (404 / `photoId: null`).
- Uploads are `multipart/form-data` with one field, `file`, at most 5 MB (`UPLOAD_MAX_BYTES`;
  bigger: 413), at most 60 per person per 10 minutes (429).
- Errors: 400 `FILE_REQUIRED`, 422 `IMAGE_INVALID`, 422 `IMAGE_TOO_BIG`, 422 `IMAGE_CANNOT_SHRINK`,
  422 `IMAGE_TIMEOUT`, 413 `STORAGE_FULL`, 409 `DEACTIVATED`, 503 `IMAGE_BUSY`, 403 when the
  role was lost while the upload arrived.
- Answers carry a strong `ETag` (the SHA-256 of the stored bytes) and
  `Cache-Control: private, no-cache`; a matching `If-None-Match` gets 304 without the bytes being
  read.
- Replacing an image deletes the old file in the same transaction; the audit row keeps both ids
  (`student` → `photoFileId`, `institute_profile` → `{image, fileId}`).

## The web

- Images need the bearer token, so `<img src>` cannot load them: `useAuthedImage(path, fileId)`
  (`apps/web/src/lib/authed-image.ts`) fetches with `AuthClient.download` and returns an object
  URL, shared by every component and cached per path and file id (a replaced image has a new id).
- `StudentAvatar` / `StudentPhoto` (`components/student-photo.tsx`) show a student's photo, from
  the staff route or, with `as="guardian"`, the guardian's own (the guardian's report card). Lists
  keep initials (decision F2): fifty photos would not fit the 3 s budget on slow 4G.
- API types carry `photoId` (the stored file's id or null), never a URL.

## Backups and size

About 100 MB per 2 000 photos. The custom-format `pg_dump` does not shrink JPEGs further, so the
backup grows by about that much; see [deploy.md](deploy.md) → Backups.

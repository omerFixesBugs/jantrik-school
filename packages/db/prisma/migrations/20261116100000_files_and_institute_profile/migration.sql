-- Sprint 1 P2 (docs/plans/sprint-1-p2-files.md, docs/files.md): images stored in the database
-- behind the API's FileStore, the per-institute usage total, and the institute's own profile.

-- CreateEnum
CREATE TYPE "stored_file_kind" AS ENUM ('STUDENT_PHOTO', 'APPLICANT_PHOTO', 'LOGO', 'SIGNATURE', 'SEAL', 'DOCUMENT_ASSET');

-- CreateTable
CREATE TABLE "stored_files" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "stored_file_kind" NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stored_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stored_file_usage" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "bytes_used" BIGINT NOT NULL DEFAULT 0,
    "file_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stored_file_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institute_profiles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name_bn" TEXT,
    "name_en" TEXT,
    "short_name" TEXT,
    "eiin" TEXT,
    "address_bn" TEXT,
    "address_en" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "website" TEXT,
    "head_title_bn" TEXT,
    "head_title_en" TEXT,
    "head_name_bn" TEXT,
    "head_name_en" TEXT,
    "established_year" SMALLINT,
    "logo_file_id" UUID,
    "head_signature_file_id" UUID,
    "seal_file_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "institute_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stored_files_tenant_id_kind_idx" ON "stored_files"("tenant_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "stored_files_tenant_id_id_key" ON "stored_files"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stored_file_usage_tenant_id_key" ON "stored_file_usage"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "stored_file_usage_tenant_id_id_key" ON "stored_file_usage"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "institute_profiles_tenant_id_key" ON "institute_profiles"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "institute_profiles_tenant_id_id_key" ON "institute_profiles"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "institute_profiles_tenant_id_logo_file_id_key" ON "institute_profiles"("tenant_id", "logo_file_id");

-- CreateIndex
CREATE UNIQUE INDEX "institute_profiles_tenant_id_head_signature_file_id_key" ON "institute_profiles"("tenant_id", "head_signature_file_id");

-- CreateIndex
CREATE UNIQUE INDEX "institute_profiles_tenant_id_seal_file_id_key" ON "institute_profiles"("tenant_id", "seal_file_id");

-- AddForeignKey
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stored_file_usage" ADD CONSTRAINT "stored_file_usage_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "institute_profiles" ADD CONSTRAINT "institute_profiles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "institute_profiles" ADD CONSTRAINT "institute_profiles_tenant_id_logo_file_id_fkey" FOREIGN KEY ("tenant_id", "logo_file_id") REFERENCES "stored_files"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "institute_profiles" ADD CONSTRAINT "institute_profiles_tenant_id_head_signature_file_id_fkey" FOREIGN KEY ("tenant_id", "head_signature_file_id") REFERENCES "stored_files"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "institute_profiles" ADD CONSTRAINT "institute_profiles_tenant_id_seal_file_id_fkey" FOREIGN KEY ("tenant_id", "seal_file_id") REFERENCES "stored_files"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Row-Level Security (docs/database.md → Checklist).
ALTER TABLE stored_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE stored_files FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stored_files
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE stored_file_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE stored_file_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stored_file_usage
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE institute_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE institute_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON institute_profiles
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- A file never changes (a replaced image is a new row; the old one is deleted). The usage total
-- and the profile are never deleted.
GRANT SELECT, INSERT, DELETE ON stored_files TO jantrik_app;
GRANT SELECT, INSERT, UPDATE ON stored_file_usage TO jantrik_app;
GRANT SELECT, INSERT, UPDATE ON institute_profiles TO jantrik_app;

-- The caps of docs/files.md, also checked in code (packages/shared/src/files.ts → FILE_LIMITS):
-- formats per kind, bytes per kind, and the stored size is the bytes' real length.
ALTER TABLE stored_files
  ADD CONSTRAINT stored_files_mime CHECK (
    (kind IN ('STUDENT_PHOTO', 'APPLICANT_PHOTO') AND mime = 'image/jpeg')
    OR (kind IN ('LOGO', 'SEAL') AND mime IN ('image/png', 'image/webp'))
    OR (kind = 'SIGNATURE' AND mime = 'image/png')
    OR (kind = 'DOCUMENT_ASSET' AND mime IN ('image/jpeg', 'image/png', 'image/webp'))
  ),
  ADD CONSTRAINT stored_files_size CHECK (
    size_bytes = octet_length(bytes)
    AND size_bytes > 0
    AND size_bytes <= CASE kind
      WHEN 'STUDENT_PHOTO' THEN 204800
      WHEN 'APPLICANT_PHOTO' THEN 204800
      WHEN 'DOCUMENT_ASSET' THEN 262144
      ELSE 102400
    END
  ),
  ADD CONSTRAINT stored_files_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT stored_files_dimensions CHECK (width BETWEEN 1 AND 4000 AND height BETWEEN 1 AND 4000);

ALTER TABLE stored_file_usage
  ADD CONSTRAINT stored_file_usage_non_negative CHECK (bytes_used >= 0 AND file_count >= 0);

ALTER TABLE institute_profiles
  ADD CONSTRAINT institute_profiles_name CHECK (name_bn IS NOT NULL OR name_en IS NOT NULL),
  ADD CONSTRAINT institute_profiles_lengths CHECK (
    (name_bn IS NULL OR char_length(name_bn) BETWEEN 1 AND 200)
    AND (name_en IS NULL OR char_length(name_en) BETWEEN 1 AND 200)
    AND (short_name IS NULL OR char_length(short_name) BETWEEN 1 AND 30)
    AND (address_bn IS NULL OR char_length(address_bn) BETWEEN 1 AND 300)
    AND (address_en IS NULL OR char_length(address_en) BETWEEN 1 AND 300)
    AND (head_title_bn IS NULL OR char_length(head_title_bn) BETWEEN 1 AND 60)
    AND (head_title_en IS NULL OR char_length(head_title_en) BETWEEN 1 AND 60)
    AND (head_name_bn IS NULL OR char_length(head_name_bn) BETWEEN 1 AND 100)
    AND (head_name_en IS NULL OR char_length(head_name_en) BETWEEN 1 AND 100)
  ),
  ADD CONSTRAINT institute_profiles_eiin CHECK (eiin IS NULL OR eiin ~ '^[0-9]{6}$'),
  ADD CONSTRAINT institute_profiles_phone CHECK (phone IS NULL OR phone ~ '^\+?[0-9]{5,15}$'),
  ADD CONSTRAINT institute_profiles_email CHECK (
    email IS NULL OR (char_length(email) <= 254 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
  ),
  ADD CONSTRAINT institute_profiles_website CHECK (
    website IS NULL OR (char_length(website) <= 200 AND website ~ '^https?://\S+$')
  ),
  ADD CONSTRAINT institute_profiles_established_year CHECK (
    established_year IS NULL OR established_year BETWEEN 1800 AND 2100
  ),
  -- One file in one place: the unique indexes cover each column; this covers the row's three.
  ADD CONSTRAINT institute_profiles_distinct_files CHECK (
    (logo_file_id IS NULL OR (logo_file_id IS DISTINCT FROM head_signature_file_id
                              AND logo_file_id IS DISTINCT FROM seal_file_id))
    AND (head_signature_file_id IS NULL OR head_signature_file_id IS DISTINCT FROM seal_file_id)
  );

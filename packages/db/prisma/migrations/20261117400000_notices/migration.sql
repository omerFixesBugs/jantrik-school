-- Notices (sprint 1 P6a, docs/notices.md): notices, their class/section targets and who read them.
-- Forced RLS on all three; the policies call the context functions wrapped in (SELECT …).
-- CreateEnum
CREATE TYPE "notice_audience" AS ENUM ('ALL', 'STAFF', 'GUARDIANS');

-- CreateEnum
CREATE TYPE "notice_status" AS ENUM ('DRAFT', 'PUBLISHED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "notices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audience" "notice_audience" NOT NULL,
    "status" "notice_status" NOT NULL DEFAULT 'DRAFT',
    "publish_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID NOT NULL,
    "published_by_id" UUID,
    "withdrawn_by_id" UUID,
    "withdrawn_at" TIMESTAMPTZ(3),
    "withdrawn_reason" TEXT,
    "edited_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notice_targets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "notice_id" UUID NOT NULL,
    "class_level_id" UUID NOT NULL,
    "section_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notice_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notice_reads" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "notice_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "read_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notice_reads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notices_tenant_id_status_publish_at_idx" ON "notices"("tenant_id", "status", "publish_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "notices_tenant_id_id_key" ON "notices"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "notice_targets_tenant_id_notice_id_idx" ON "notice_targets"("tenant_id", "notice_id");

-- CreateIndex
CREATE UNIQUE INDEX "notice_targets_tenant_id_id_key" ON "notice_targets"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "notice_reads_tenant_id_user_id_idx" ON "notice_reads"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "notice_reads_tenant_id_id_key" ON "notice_reads"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notice_reads_tenant_id_notice_id_user_id_key" ON "notice_reads"("tenant_id", "notice_id", "user_id");

-- AddForeignKey
ALTER TABLE "notices" ADD CONSTRAINT "notices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "notices" ADD CONSTRAINT "notices_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "notices" ADD CONSTRAINT "notices_published_by_id_fkey" FOREIGN KEY ("published_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "notices" ADD CONSTRAINT "notices_withdrawn_by_id_fkey" FOREIGN KEY ("withdrawn_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "notice_targets" ADD CONSTRAINT "notice_targets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "notice_targets" ADD CONSTRAINT "notice_targets_tenant_id_notice_id_fkey" FOREIGN KEY ("tenant_id", "notice_id") REFERENCES "notices"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "notice_targets" ADD CONSTRAINT "notice_targets_tenant_id_class_level_id_fkey" FOREIGN KEY ("tenant_id", "class_level_id") REFERENCES "class_levels"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "notice_targets" ADD CONSTRAINT "notice_targets_tenant_id_section_id_class_level_id_fkey" FOREIGN KEY ("tenant_id", "section_id", "class_level_id") REFERENCES "sections"("tenant_id", "id", "class_level_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "notice_reads" ADD CONSTRAINT "notice_reads_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "notice_reads" ADD CONSTRAINT "notice_reads_tenant_id_notice_id_fkey" FOREIGN KEY ("tenant_id", "notice_id") REFERENCES "notices"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "notice_reads" ADD CONSTRAINT "notice_reads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ───────────────────────────── RLS ─────────────────────────────
ALTER TABLE notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE notices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notices
  USING (tenant_id = (SELECT app_current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant_id()));

ALTER TABLE notice_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE notice_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notice_targets
  USING (tenant_id = (SELECT app_current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant_id()));

ALTER TABLE notice_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE notice_reads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notice_reads
  USING (tenant_id = (SELECT app_current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant_id()));
-- Nobody marks a notice read for someone else. SELECT stays institute-wide (the admin's counts).
CREATE POLICY notice_reads_own_insert ON notice_reads AS RESTRICTIVE FOR INSERT
  WITH CHECK (user_id = (SELECT app_current_user_id()));

-- ───────────────────────────── Grants ─────────────────────────────
-- No DELETE on notices: withdrawn, never deleted. Targets are replaced whole (delete + insert).
-- Reads are history: no UPDATE, no DELETE.
GRANT SELECT, INSERT ON notices TO jantrik_app;
GRANT UPDATE (title, body, audience, status, publish_at, expires_at, pinned, published_by_id,
  withdrawn_by_id, withdrawn_at, withdrawn_reason, edited_at, updated_at) ON notices TO jantrik_app;
GRANT SELECT, INSERT, DELETE ON notice_targets TO jantrik_app;
GRANT SELECT, INSERT ON notice_reads TO jantrik_app;

-- ───────────────────────────── Checks ─────────────────────────────
ALTER TABLE notices
  ADD CONSTRAINT notices_title_length CHECK (char_length(btrim(title)) BETWEEN 1 AND 150),
  ADD CONSTRAINT notices_body_length CHECK (char_length(body) BETWEEN 1 AND 5000),
  ADD CONSTRAINT notices_published_by CHECK (
    status <> 'PUBLISHED' OR (publish_at IS NOT NULL AND published_by_id IS NOT NULL)),
  ADD CONSTRAINT notices_withdrawn_by CHECK (
    status <> 'WITHDRAWN' OR (withdrawn_at IS NOT NULL AND withdrawn_by_id IS NOT NULL)),
  ADD CONSTRAINT notices_expiry_after_publish CHECK (
    expires_at IS NULL OR publish_at IS NULL OR expires_at > publish_at),
  ADD CONSTRAINT notices_withdrawn_reason_length CHECK (
    withdrawn_reason IS NULL OR char_length(withdrawn_reason) <= 300);

-- SMS broadcasts (sprint 1 P6b, docs/notices.md → Broadcasts): a text to guardians or staff, sent now
-- or at a set time, whole or not at all over the daily cap (S18). Forced RLS; never deleted (money
-- history); the policies call the context functions wrapped in (SELECT …).
-- CreateEnum
CREATE TYPE "broadcast_recipients" AS ENUM ('PRIMARY_GUARDIANS', 'ALL_GUARDIANS', 'STAFF');

-- CreateEnum
CREATE TYPE "broadcast_status" AS ENUM ('DRAFT', 'SCHEDULED', 'SENT', 'CANCELLED', 'FAILED_OVER_CAP');

-- CreateTable
CREATE TABLE "sms_broadcasts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "notice_id" UUID,
    "recipients" "broadcast_recipients" NOT NULL,
    "status" "broadcast_status" NOT NULL DEFAULT 'DRAFT',
    "scheduled_at" TIMESTAMPTZ(3),
    "preview_count" INTEGER,
    "segments" SMALLINT,
    "estimated_cost_paisa" INTEGER,
    "queued_count" INTEGER,
    "local_date" DATE,
    "created_by_id" UUID NOT NULL,
    "scheduled_by_id" UUID,
    "sent_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "failure" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_broadcast_targets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "broadcast_id" UUID NOT NULL,
    "class_level_id" UUID NOT NULL,
    "section_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_broadcast_targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sms_broadcasts_tenant_id_status_scheduled_at_idx" ON "sms_broadcasts"("tenant_id", "status", "scheduled_at");

-- CreateIndex
CREATE INDEX "sms_broadcasts_tenant_id_notice_id_idx" ON "sms_broadcasts"("tenant_id", "notice_id");

-- CreateIndex
CREATE UNIQUE INDEX "sms_broadcasts_tenant_id_id_key" ON "sms_broadcasts"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "sms_broadcast_targets_tenant_id_broadcast_id_idx" ON "sms_broadcast_targets"("tenant_id", "broadcast_id");

-- CreateIndex
CREATE UNIQUE INDEX "sms_broadcast_targets_tenant_id_id_key" ON "sms_broadcast_targets"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "sms_broadcasts" ADD CONSTRAINT "sms_broadcasts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sms_broadcasts" ADD CONSTRAINT "sms_broadcasts_tenant_id_notice_id_fkey" FOREIGN KEY ("tenant_id", "notice_id") REFERENCES "notices"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sms_broadcasts" ADD CONSTRAINT "sms_broadcasts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sms_broadcasts" ADD CONSTRAINT "sms_broadcasts_scheduled_by_id_fkey" FOREIGN KEY ("scheduled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sms_broadcasts" ADD CONSTRAINT "sms_broadcasts_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sms_broadcast_targets" ADD CONSTRAINT "sms_broadcast_targets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sms_broadcast_targets" ADD CONSTRAINT "sms_broadcast_targets_tenant_id_broadcast_id_fkey" FOREIGN KEY ("tenant_id", "broadcast_id") REFERENCES "sms_broadcasts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sms_broadcast_targets" ADD CONSTRAINT "sms_broadcast_targets_tenant_id_class_level_id_fkey" FOREIGN KEY ("tenant_id", "class_level_id") REFERENCES "class_levels"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sms_broadcast_targets" ADD CONSTRAINT "sms_broadcast_targets_tenant_id_section_id_class_level_id_fkey" FOREIGN KEY ("tenant_id", "section_id", "class_level_id") REFERENCES "sections"("tenant_id", "id", "class_level_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ───────────────────────────── RLS ─────────────────────────────
ALTER TABLE sms_broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_broadcasts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sms_broadcasts
  USING (tenant_id = (SELECT app_current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant_id()));

ALTER TABLE sms_broadcast_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_broadcast_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sms_broadcast_targets
  USING (tenant_id = (SELECT app_current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant_id()));

-- ───────────────────────────── Grants ─────────────────────────────
-- No DELETE on broadcasts (money history). UPDATE on every column except the id, the institute,
-- who created it and when. Targets are replaced whole (delete + insert), so no UPDATE.
GRANT SELECT, INSERT ON sms_broadcasts TO jantrik_app;
GRANT UPDATE (body, notice_id, recipients, status, scheduled_at, preview_count, segments,
  estimated_cost_paisa, queued_count, local_date, scheduled_by_id, sent_at, cancelled_by_id,
  cancelled_at, cancel_reason, failure, updated_at) ON sms_broadcasts TO jantrik_app;
GRANT SELECT, INSERT, DELETE ON sms_broadcast_targets TO jantrik_app;

-- ───────────────────────────── Checks ─────────────────────────────
ALTER TABLE sms_broadcasts
  ADD CONSTRAINT sms_broadcasts_body_length CHECK (char_length(body) BETWEEN 1 AND 480),
  ADD CONSTRAINT sms_broadcasts_scheduled CHECK (
    status NOT IN ('SCHEDULED', 'SENT', 'FAILED_OVER_CAP')
    OR (scheduled_at IS NOT NULL AND scheduled_by_id IS NOT NULL)),
  ADD CONSTRAINT sms_broadcasts_sent CHECK (
    status <> 'SENT' OR (sent_at IS NOT NULL AND queued_count IS NOT NULL AND local_date IS NOT NULL)),
  ADD CONSTRAINT sms_broadcasts_cancelled CHECK (
    status <> 'CANCELLED' OR (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL)),
  ADD CONSTRAINT sms_broadcasts_cancel_reason CHECK (
    cancel_reason IS NULL OR cancel_reason IN ('BY_ADMIN', 'ACTOR_NOT_ADMIN')),
  ADD CONSTRAINT sms_broadcasts_failed CHECK (status <> 'FAILED_OVER_CAP' OR failure IS NOT NULL),
  ADD CONSTRAINT sms_broadcasts_counts CHECK (
    (queued_count IS NULL OR queued_count >= 0)
    AND (preview_count IS NULL OR preview_count >= 0)
    AND (estimated_cost_paisa IS NULL OR estimated_cost_paisa >= 0)),
  ADD CONSTRAINT sms_broadcasts_segments CHECK (segments IS NULL OR segments BETWEEN 1 AND 3);

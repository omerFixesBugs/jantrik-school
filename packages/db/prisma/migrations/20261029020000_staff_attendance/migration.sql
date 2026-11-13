-- CreateEnum
CREATE TYPE "staff_day_status" AS ENUM ('PRESENT', 'ABSENT', 'LEAVE');

-- AlterTable
ALTER TABLE "staff_profiles" ADD COLUMN     "attendance_tracked" BOOLEAN;

-- CreateTable
CREATE TABLE "staff_attendance_days" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "status" "staff_day_status" NOT NULL,
    "in_at" TIMESTAMPTZ(3),
    "out_at" TIMESTAMPTZ(3),
    "office_start" TIME(0) NOT NULL,
    "office_end" TIME(0) NOT NULL,
    "late_minutes" SMALLINT NOT NULL DEFAULT 0,
    "early_minutes" SMALLINT NOT NULL DEFAULT 0,
    "source" "attendance_source" NOT NULL,
    "reason" TEXT,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_attendance_days_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "staff_attendance_days_tenant_id_date_idx" ON "staff_attendance_days"("tenant_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "staff_attendance_days_tenant_id_id_key" ON "staff_attendance_days"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_attendance_days_tenant_id_user_id_date_key" ON "staff_attendance_days"("tenant_id", "user_id", "date");

-- AddForeignKey
ALTER TABLE "staff_attendance_days" ADD CONSTRAINT "staff_attendance_days_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "staff_attendance_days" ADD CONSTRAINT "staff_attendance_days_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "staff_profiles"("tenant_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "staff_attendance_days" ADD CONSTRAINT "staff_attendance_days_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ───── Step 11, part E1: staff attendance (hand-written: RLS, grants, CHECKs) ─────
-- staff_profiles.attendance_tracked: NULL is the default rule (tracked unless the person's only
-- staff role here is OWNER), decided in code. No backfill. jantrik_app's table-level grants on
-- staff_profiles (SELECT, INSERT, UPDATE) cover the new column.

ALTER TABLE staff_attendance_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_attendance_days FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_attendance_days
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- History: written by the device job and by admins, never deleted.
GRANT SELECT, INSERT, UPDATE ON staff_attendance_days TO jantrik_app;

-- ─────────────────────────── CHECKs ───────────────────────────
-- Nullable columns are tested with IS NULL first: a CHECK whose expression is NULL passes.
-- The device writes PRESENT days, and ABSENT when a review rejected every punch of an existing
-- device day (rows are never deleted); LEAVE is an admin's. A MANUAL day names who and why.
ALTER TABLE staff_attendance_days
  ADD CONSTRAINT staff_attendance_days_office_hours CHECK (office_end > office_start),
  ADD CONSTRAINT staff_attendance_days_late_range CHECK (late_minutes BETWEEN 0 AND 1440),
  ADD CONSTRAINT staff_attendance_days_early_range CHECK (early_minutes BETWEEN 0 AND 1440),
  ADD CONSTRAINT staff_attendance_days_version_positive CHECK (version >= 1),
  ADD CONSTRAINT staff_attendance_days_out_after_in
    CHECK (out_at IS NULL OR (in_at IS NOT NULL AND out_at >= in_at)),
  ADD CONSTRAINT staff_attendance_days_times_present_only
    CHECK (status = 'PRESENT' OR (in_at IS NULL AND out_at IS NULL)),
  ADD CONSTRAINT staff_attendance_days_present_has_in
    CHECK (status <> 'PRESENT' OR in_at IS NOT NULL),
  ADD CONSTRAINT staff_attendance_days_device_no_leave
    CHECK (source <> 'DEVICE' OR status <> 'LEAVE'),
  ADD CONSTRAINT staff_attendance_days_manual_reason
    CHECK (source <> 'MANUAL' OR (
      reason IS NOT NULL
      AND char_length(btrim(reason)) BETWEEN 3 AND 200
      AND updated_by_id IS NOT NULL
    ));

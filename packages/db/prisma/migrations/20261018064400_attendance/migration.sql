-- CreateEnum
CREATE TYPE "attendance_mode" AS ENUM ('DAILY', 'PER_SESSION');

-- CreateEnum
CREATE TYPE "attendance_status" AS ENUM ('PRESENT', 'ABSENT', 'LATE', 'LEAVE');

-- CreateEnum
CREATE TYPE "sms_purpose" AS ENUM ('ATTENDANCE_ABSENT');

-- CreateEnum
CREATE TYPE "sms_status" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'CANCELLED', 'HELD_OVER_LIMIT');

-- CreateEnum
CREATE TYPE "platform_sms_purpose" AS ENUM ('OTP');

-- CreateEnum
CREATE TYPE "platform_sms_status" AS ENUM ('SENT', 'FAILED');

-- AlterTable
ALTER TABLE "institute_types" ADD COLUMN     "attendance_mode" "attendance_mode" NOT NULL DEFAULT 'DAILY';

-- CreateTable
CREATE TABLE "attendance_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "mode" "attendance_mode" NOT NULL DEFAULT 'DAILY',
    "weekly_off_days" INTEGER[] DEFAULT ARRAY[5]::INTEGER[],
    "edit_window_days" SMALLINT NOT NULL DEFAULT 0,
    "leave_counts_as_absent" BOOLEAN NOT NULL DEFAULT false,
    "absent_sms_enabled" BOOLEAN NOT NULL DEFAULT false,
    "absent_sms_template" TEXT,
    "absent_sms_delay_minutes" SMALLINT NOT NULL DEFAULT 10,
    "daily_sms_cap" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holidays" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "name_bn" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "section_teachers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "is_class_teacher" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "section_teachers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "period_no" SMALLINT NOT NULL DEFAULT 0,
    "subject_id" UUID,
    "taken_by_id" UUID NOT NULL,
    "updated_by_id" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "last_submission_id" UUID NOT NULL,
    "on_non_working_day" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "status" "attendance_status" NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "purpose" "sms_purpose" NOT NULL,
    "status" "sms_status" NOT NULL DEFAULT 'QUEUED',
    "segments" SMALLINT NOT NULL,
    "body" TEXT NOT NULL,
    "local_date" DATE NOT NULL,
    "dedupe_key" TEXT,
    "related_entity" TEXT,
    "related_id" UUID,
    "send_after" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3),
    "provider_message_id" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_sms_logs" (
    "id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "purpose" "platform_sms_purpose" NOT NULL,
    "status" "platform_sms_status" NOT NULL,
    "segments" SMALLINT NOT NULL,
    "provider_message_id" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_sms_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attendance_settings_tenant_id_key" ON "attendance_settings"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_settings_tenant_id_id_key" ON "attendance_settings"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "holidays_tenant_id_start_date_idx" ON "holidays"("tenant_id", "start_date");

-- CreateIndex
CREATE UNIQUE INDEX "holidays_tenant_id_id_key" ON "holidays"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "section_teachers_tenant_id_user_id_idx" ON "section_teachers"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "section_teachers_tenant_id_id_key" ON "section_teachers"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "section_teachers_tenant_id_section_id_user_id_key" ON "section_teachers"("tenant_id", "section_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "section_teachers_one_class_teacher" ON "section_teachers"("tenant_id", "section_id") WHERE (is_class_teacher);

-- CreateIndex
CREATE INDEX "attendance_sessions_tenant_id_date_idx" ON "attendance_sessions"("tenant_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_sessions_tenant_id_id_key" ON "attendance_sessions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_sessions_tenant_id_section_id_date_period_no_key" ON "attendance_sessions"("tenant_id", "section_id", "date", "period_no");

-- CreateIndex
CREATE INDEX "attendance_records_tenant_id_student_id_idx" ON "attendance_records"("tenant_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_records_tenant_id_id_key" ON "attendance_records"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_records_tenant_id_session_id_student_id_key" ON "attendance_records"("tenant_id", "session_id", "student_id");

-- CreateIndex
CREATE INDEX "sms_logs_tenant_id_local_date_idx" ON "sms_logs"("tenant_id", "local_date");

-- CreateIndex
CREATE INDEX "sms_logs_tenant_id_created_at_idx" ON "sms_logs"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "sms_logs_tenant_id_id_key" ON "sms_logs"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sms_logs_dedupe" ON "sms_logs"("tenant_id", "dedupe_key") WHERE (dedupe_key IS NOT NULL);

-- CreateIndex
CREATE INDEX "platform_sms_logs_created_at_idx" ON "platform_sms_logs"("created_at" DESC);

-- AddForeignKey
ALTER TABLE "attendance_settings" ADD CONSTRAINT "attendance_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_teachers" ADD CONSTRAINT "section_teachers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_teachers" ADD CONSTRAINT "section_teachers_tenant_id_section_id_fkey" FOREIGN KEY ("tenant_id", "section_id") REFERENCES "sections"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_teachers" ADD CONSTRAINT "section_teachers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_tenant_id_section_id_fkey" FOREIGN KEY ("tenant_id", "section_id") REFERENCES "sections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_tenant_id_subject_id_fkey" FOREIGN KEY ("tenant_id", "subject_id") REFERENCES "subjects"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_taken_by_id_fkey" FOREIGN KEY ("taken_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_tenant_id_session_id_fkey" FOREIGN KEY ("tenant_id", "session_id") REFERENCES "attendance_sessions"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_tenant_id_student_id_fkey" FOREIGN KEY ("tenant_id", "student_id") REFERENCES "students"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sms_logs" ADD CONSTRAINT "sms_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────────────────────── Hand-written: RLS, grants, checks ─────────────────────────
-- See docs/database.md → "Checklist: adding a tenant-owned table".

-- Institute types decide the default attendance mode (CLAUDE.md rule 2: data, not code).
UPDATE institute_types SET attendance_mode = 'PER_SESSION' WHERE key = 'COACHING';

-- Tenant-owned tables: the standard isolation policy.
ALTER TABLE attendance_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON attendance_settings
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE holidays FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON holidays
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE section_teachers ENABLE ROW LEVEL SECURITY;
ALTER TABLE section_teachers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON section_teachers
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE attendance_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON attendance_sessions
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE attendance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON attendance_records
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE sms_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sms_logs
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON attendance_settings, holidays, section_teachers TO jantrik_app;
-- Attendance history and SMS logs (billing) are never deleted by the app.
GRANT SELECT, INSERT, UPDATE ON attendance_sessions, attendance_records, sms_logs TO jantrik_app;

-- Platform SMS log (global, no tenant): the app may record sends but never read them back, since
-- the table holds phone numbers of every user across tenants. Write it with createMany (plain
-- INSERT): create() uses RETURNING, which needs SELECT.
REVOKE ALL ON platform_sms_logs FROM PUBLIC;
GRANT INSERT ON platform_sms_logs TO jantrik_app;

-- Checks.
ALTER TABLE attendance_settings
  ADD CONSTRAINT attendance_settings_off_days_valid
    CHECK (weekly_off_days IS NOT NULL AND weekly_off_days <@ ARRAY[1, 2, 3, 4, 5, 6, 7]),
  ADD CONSTRAINT attendance_settings_edit_window_range CHECK (edit_window_days BETWEEN 0 AND 30),
  ADD CONSTRAINT attendance_settings_sms_delay_range CHECK (absent_sms_delay_minutes BETWEEN 0 AND 240),
  ADD CONSTRAINT attendance_settings_sms_cap_positive CHECK (daily_sms_cap IS NULL OR daily_sms_cap >= 0),
  ADD CONSTRAINT attendance_settings_template_length
    CHECK (absent_sms_template IS NULL OR char_length(absent_sms_template) BETWEEN 1 AND 500);

ALTER TABLE holidays
  ADD CONSTRAINT holidays_date_order CHECK (end_date >= start_date),
  ADD CONSTRAINT holidays_names_present CHECK (btrim(name_bn) <> '' AND btrim(name_en) <> '');

ALTER TABLE attendance_sessions
  ADD CONSTRAINT attendance_sessions_period_range CHECK (period_no BETWEEN 0 AND 20),
  ADD CONSTRAINT attendance_sessions_version_positive CHECK (version >= 1);

ALTER TABLE attendance_records
  ADD CONSTRAINT attendance_records_note_length CHECK (note IS NULL OR char_length(note) <= 200);

ALTER TABLE sms_logs
  ADD CONSTRAINT sms_logs_phone_bd_format CHECK (phone ~ '^\+8801[3-9][0-9]{8}$'),
  ADD CONSTRAINT sms_logs_segments_positive CHECK (segments >= 1);

ALTER TABLE platform_sms_logs
  ADD CONSTRAINT platform_sms_logs_phone_bd_format CHECK (phone ~ '^\+8801[3-9][0-9]{8}$'),
  ADD CONSTRAINT platform_sms_logs_segments_positive CHECK (segments >= 1);

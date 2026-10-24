-- CreateEnum
CREATE TYPE "device_brand" AS ENUM ('ZKTECO');

-- CreateEnum
CREATE TYPE "device_direction" AS ENUM ('IN', 'OUT', 'BOTH');

-- CreateEnum
CREATE TYPE "punch_direction" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "device_command_kind" AS ENUM ('USER_UPSERT', 'USER_DELETE');

-- CreateEnum
CREATE TYPE "device_command_status" AS ENUM ('PENDING', 'SENT', 'DONE', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "punch_outcome" AS ENUM ('APPLIED', 'UNMAPPED', 'IGNORED', 'STALE', 'HELD');

-- CreateEnum
CREATE TYPE "punch_review" AS ENUM ('OK', 'ACCEPTED', 'REJECTED');

-- AlterTable
ALTER TABLE "attendance_settings" ADD COLUMN     "device_auto_mark" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "device_cutoff_minutes" SMALLINT NOT NULL DEFAULT 60,
ADD COLUMN     "device_default_start" TIME(0) NOT NULL DEFAULT '08:00:00'::time without time zone,
ADD COLUMN     "device_grace_minutes" SMALLINT NOT NULL DEFAULT 10,
ADD COLUMN     "device_hours_end" TIME(0) NOT NULL DEFAULT '20:00:00'::time without time zone,
ADD COLUMN     "device_hours_start" TIME(0) NOT NULL DEFAULT '05:00:00'::time without time zone,
ADD COLUMN     "device_max_punches_per_minute" SMALLINT NOT NULL DEFAULT 60,
ADD COLUMN     "entry_sms_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "exit_sms_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "punch_retention_days" SMALLINT NOT NULL DEFAULT 730,
ADD COLUMN     "staff_device_id_start" INTEGER NOT NULL DEFAULT 9001,
ADD COLUMN     "staff_early_grace_minutes" SMALLINT NOT NULL DEFAULT 10,
ADD COLUMN     "staff_late_grace_minutes" SMALLINT NOT NULL DEFAULT 10,
ADD COLUMN     "staff_office_end" TIME(0) NOT NULL DEFAULT '16:00:00'::time without time zone,
ADD COLUMN     "staff_office_start" TIME(0) NOT NULL DEFAULT '08:00:00'::time without time zone;

-- CreateTable
CREATE TABLE "attendance_devices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "brand" "device_brand" NOT NULL DEFAULT 'ZKTECO',
    "serial_no" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gate" TEXT,
    "direction" "device_direction" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_seen_at" TIMESTAMPTZ(3),
    "last_punch_at" TIMESTAMPTZ(3),
    "last_ip" INET,
    "firmware" TEXT,
    "user_count" INTEGER,
    "push_version" TEXT,
    "attlog_stamp" TEXT,
    "clock_offset_sec" INTEGER,
    "clock_samples" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "last_flood_at" TIMESTAMPTZ(3),
    "last_flood_dropped" INTEGER,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_people" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "device_user_id" TEXT NOT NULL,
    "student_id" UUID,
    "staff_user_id" UUID,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_people_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_commands" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "kind" "device_command_kind" NOT NULL,
    "device_user_id" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" "device_command_status" NOT NULL DEFAULT 'PENDING',
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMPTZ(3),
    "done_at" TIMESTAMPTZ(3),
    "return_code" INTEGER,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_punches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "device_user_id" TEXT NOT NULL,
    "device_time" TIMESTAMP(0) NOT NULL,
    "punched_at" TIMESTAMPTZ(3) NOT NULL,
    "local_date" DATE NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "verify_type" SMALLINT,
    "state" SMALLINT,
    "direction" "punch_direction" NOT NULL,
    "flags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "source_ip" INET,
    "processed_at" TIMESTAMPTZ(3),
    "outcome" "punch_outcome",
    "review" "punch_review",
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_punches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_source_ips" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "ip" INET NOT NULL,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "punch_count" INTEGER NOT NULL DEFAULT 0,
    "trusted_at" TIMESTAMPTZ(3),
    "trusted_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_source_ips_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attendance_devices_tenant_id_id_key" ON "attendance_devices"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_devices_active_serial" ON "attendance_devices"("serial_no") WHERE (is_active);

-- CreateIndex
CREATE UNIQUE INDEX "device_people_tenant_id_id_key" ON "device_people"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "device_people_tenant_id_device_user_id_key" ON "device_people"("tenant_id", "device_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "device_people_one_per_student" ON "device_people"("tenant_id", "student_id") WHERE (student_id IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "device_people_one_per_staff" ON "device_people"("tenant_id", "staff_user_id") WHERE (staff_user_id IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "device_commands_seq_key" ON "device_commands"("seq");

-- CreateIndex
CREATE INDEX "device_commands_tenant_id_device_id_status_idx" ON "device_commands"("tenant_id", "device_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "device_commands_tenant_id_id_key" ON "device_commands"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "device_punches_tenant_id_local_date_device_user_id_idx" ON "device_punches"("tenant_id", "local_date", "device_user_id");

-- CreateIndex
CREATE INDEX "device_punches_tenant_id_received_at_idx" ON "device_punches"("tenant_id", "received_at" DESC);

-- CreateIndex
CREATE INDEX "device_punches_tenant_id_device_id_device_time_idx" ON "device_punches"("tenant_id", "device_id", "device_time");

-- CreateIndex
CREATE INDEX "device_punches_unprocessed" ON "device_punches"("tenant_id", "received_at") WHERE (processed_at IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "device_punches_tenant_id_id_key" ON "device_punches"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "device_punches_tenant_id_device_id_device_user_id_device_ti_key" ON "device_punches"("tenant_id", "device_id", "device_user_id", "device_time");

-- CreateIndex
CREATE UNIQUE INDEX "device_source_ips_tenant_id_id_key" ON "device_source_ips"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "device_source_ips_tenant_id_device_id_ip_key" ON "device_source_ips"("tenant_id", "device_id", "ip");

-- AddForeignKey
ALTER TABLE "attendance_devices" ADD CONSTRAINT "attendance_devices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_devices" ADD CONSTRAINT "attendance_devices_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_devices" ADD CONSTRAINT "attendance_devices_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "device_people" ADD CONSTRAINT "device_people_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "device_people" ADD CONSTRAINT "device_people_tenant_id_student_id_fkey" FOREIGN KEY ("tenant_id", "student_id") REFERENCES "students"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "device_people" ADD CONSTRAINT "device_people_tenant_id_staff_user_id_fkey" FOREIGN KEY ("tenant_id", "staff_user_id") REFERENCES "staff_profiles"("tenant_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "device_people" ADD CONSTRAINT "device_people_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "device_people" ADD CONSTRAINT "device_people_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_tenant_id_device_id_fkey" FOREIGN KEY ("tenant_id", "device_id") REFERENCES "attendance_devices"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "device_punches" ADD CONSTRAINT "device_punches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "device_punches" ADD CONSTRAINT "device_punches_tenant_id_device_id_fkey" FOREIGN KEY ("tenant_id", "device_id") REFERENCES "attendance_devices"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "device_punches" ADD CONSTRAINT "device_punches_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "device_source_ips" ADD CONSTRAINT "device_source_ips_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "device_source_ips" ADD CONSTRAINT "device_source_ips_tenant_id_device_id_fkey" FOREIGN KEY ("tenant_id", "device_id") REFERENCES "attendance_devices"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "device_source_ips" ADD CONSTRAINT "device_source_ips_trusted_by_id_fkey" FOREIGN KEY ("trusted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ───── Step 11, part A1: attendance devices (hand-written: RLS, grants, CHECKs, ingest role) ─────
-- Five tenant tables. The device receiver (login jantrik_ingest_app) has no table grants: it runs
-- the ingest_* functions (next migration), owned by jantrik_ingest, which has no tenant context
-- and sees rows only through the `TO jantrik_ingest` policies at the end.

ALTER TABLE attendance_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_devices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON attendance_devices
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE device_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_people FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON device_people
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE device_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON device_commands
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE device_punches ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_punches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON device_punches
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE device_source_ips ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_source_ips FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON device_source_ips
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ─────────────────────────── jantrik_app ───────────────────────────
-- Devices are deactivated, never deleted (their punches stay); the receiver's columns are not
-- the app's to write.
GRANT SELECT, INSERT ON attendance_devices TO jantrik_app;
GRANT UPDATE (name, gate, direction, is_active, serial_no, updated_at, updated_by_id)
  ON attendance_devices TO jantrik_app;
-- Device IDs: mapped, changed and removed by admins (the service audits them).
GRANT SELECT, INSERT, UPDATE, DELETE ON device_people TO jantrik_app;
-- Commands: queued and cancelled by the app; DELETE only for the retention job.
GRANT SELECT, INSERT, DELETE ON device_commands TO jantrik_app;
GRANT UPDATE (status, updated_at) ON device_commands TO jantrik_app;
GRANT USAGE ON SEQUENCE device_commands_seq_seq TO jantrik_app;
-- Punches are immutable: only the receiver inserts them; the app records processing and review.
GRANT SELECT, DELETE ON device_punches TO jantrik_app;
GRANT UPDATE (processed_at, outcome, review, reviewed_by_id, reviewed_at, updated_at)
  ON device_punches TO jantrik_app;
-- Retention: whatever the job (or a bug) asks, a punch from the last 30 days is never deleted.
CREATE POLICY retention_only ON device_punches AS RESTRICTIVE FOR DELETE TO jantrik_app
  USING (local_date < current_date - 30);
-- Source addresses: the receiver records them; an admin only trusts one.
GRANT SELECT ON device_source_ips TO jantrik_app;
GRANT UPDATE (trusted_at, trusted_by_id, updated_at) ON device_source_ips TO jantrik_app;

-- ─────────────────────────── CHECKs ───────────────────────────
-- Nullable columns are tested with IS NULL first: a CHECK whose expression is NULL passes.
ALTER TABLE attendance_devices
  ADD CONSTRAINT attendance_devices_serial_format CHECK (serial_no ~ '^[A-Z0-9]{6,32}$'),
  ADD CONSTRAINT attendance_devices_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  ADD CONSTRAINT attendance_devices_gate_length CHECK (gate IS NULL OR char_length(gate) <= 60),
  ADD CONSTRAINT attendance_devices_firmware_length
    CHECK (firmware IS NULL OR char_length(firmware) <= 60),
  ADD CONSTRAINT attendance_devices_push_version_length
    CHECK (push_version IS NULL OR char_length(push_version) <= 16),
  ADD CONSTRAINT attendance_devices_attlog_stamp_format
    CHECK (attlog_stamp IS NULL OR attlog_stamp ~ '^[0-9A-Za-z]{1,32}$'),
  ADD CONSTRAINT attendance_devices_user_count_range CHECK (user_count IS NULL OR user_count >= 0),
  ADD CONSTRAINT attendance_devices_clock_samples_size CHECK (cardinality(clock_samples) <= 5),
  ADD CONSTRAINT attendance_devices_flood_dropped_range
    CHECK (last_flood_dropped IS NULL OR last_flood_dropped >= 0);

-- 100 to 999999999 with no leading zero (devices drop leading zeros; below 100 is left to the
-- device's own admin users): DEVICE_USER_ID_RE in packages/shared/src/devices.ts.
ALTER TABLE device_people
  ADD CONSTRAINT device_people_one_person CHECK (num_nonnulls(student_id, staff_user_id) = 1),
  ADD CONSTRAINT device_people_device_user_id_format
    CHECK (device_user_id ~ '^[1-9][0-9]{2,8}$');

ALTER TABLE device_commands
  ADD CONSTRAINT device_commands_device_user_id_format
    CHECK (device_user_id ~ '^[1-9][0-9]{2,8}$'),
  -- Printable ASCII and tabs only: a name can never start a second command on a new line.
  ADD CONSTRAINT device_commands_payload_format CHECK (payload ~ '^[\x20-\x7E\t]{1,200}$'),
  ADD CONSTRAINT device_commands_attempts_range CHECK (attempts BETWEEN 0 AND 5);

ALTER TABLE device_punches
  ADD CONSTRAINT device_punches_device_user_id_format
    CHECK (device_user_id ~ '^[A-Za-z0-9]{1,24}$'),
  ADD CONSTRAINT device_punches_verify_type_range
    CHECK (verify_type IS NULL OR verify_type BETWEEN 0 AND 255),
  ADD CONSTRAINT device_punches_state_range CHECK (state IS NULL OR state BETWEEN 0 AND 255),
  -- PUNCH_FLAGS in packages/shared/src/devices.ts. A NULL element fails `<@`.
  ADD CONSTRAINT device_punches_flags_known CHECK (
    flags <@ ARRAY['CLOCK_CORRECTED', 'CLOCK_FUTURE', 'STALE', 'NEW_IP', 'OUTSIDE_HOURS',
                   'BURST']::text[]
  ),
  ADD CONSTRAINT device_punches_processed_together
    CHECK ((processed_at IS NULL) = (outcome IS NULL)),
  ADD CONSTRAINT device_punches_reviewed_together
    CHECK ((review IS NULL) = (reviewed_at IS NULL));

ALTER TABLE device_source_ips
  ADD CONSTRAINT device_source_ips_punch_count_range CHECK (punch_count >= 0),
  ADD CONSTRAINT device_source_ips_trusted_by_needs_trusted_at
    CHECK (trusted_by_id IS NULL OR trusted_at IS NOT NULL);

-- The new settings columns have DDL defaults that pass these, so existing rows do too.
ALTER TABLE attendance_settings
  ADD CONSTRAINT attendance_settings_device_grace_range
    CHECK (device_grace_minutes BETWEEN 0 AND 120),
  ADD CONSTRAINT attendance_settings_device_cutoff_range
    CHECK (device_cutoff_minutes BETWEEN 15 AND 300),
  ADD CONSTRAINT attendance_settings_staff_office_order
    CHECK (staff_office_end > staff_office_start),
  ADD CONSTRAINT attendance_settings_staff_late_grace_range
    CHECK (staff_late_grace_minutes BETWEEN 0 AND 120),
  ADD CONSTRAINT attendance_settings_staff_early_grace_range
    CHECK (staff_early_grace_minutes BETWEEN 0 AND 120),
  ADD CONSTRAINT attendance_settings_device_hours_order
    CHECK (device_hours_end > device_hours_start),
  ADD CONSTRAINT attendance_settings_device_max_punches_range
    CHECK (device_max_punches_per_minute BETWEEN 10 AND 240),
  ADD CONSTRAINT attendance_settings_staff_device_id_start_range
    CHECK (staff_device_id_start BETWEEN 100 AND 999999999),
  ADD CONSTRAINT attendance_settings_punch_retention_range
    CHECK (punch_retention_days BETWEEN 30 AND 3650);

-- ─────────────────────────── jantrik_ingest ───────────────────────────
-- Owner of the ingest_* functions. CREATE on the schema because a function's new owner needs it
-- (ALTER FUNCTION … OWNER TO), as for jantrik_auth and jantrik_platform. Not inherited by
-- jantrik_owner, so these policies never widen what the owner sees.
GRANT USAGE, CREATE ON SCHEMA public TO jantrik_ingest;
-- The receiver's login gets the schema only, to call the functions (EXECUTE comes with them in
-- the next migration). No table grants, ever.
GRANT USAGE ON SCHEMA public TO jantrik_ingest_app;

-- Which institute a serial number belongs to, and whether it may record attendance.
GRANT SELECT (id, status, timezone) ON tenants TO jantrik_ingest;
CREATE POLICY ingest_read ON tenants FOR SELECT TO jantrik_ingest USING (true);
GRANT SELECT (tenant_id, module_key, enabled) ON tenant_modules TO jantrik_ingest;
CREATE POLICY ingest_read ON tenant_modules FOR SELECT TO jantrik_ingest USING (true);
-- The hours (OUTSIDE_HOURS) and the per-minute cap (BURST), nothing else of the settings.
GRANT SELECT (tenant_id, device_hours_start, device_hours_end, device_max_punches_per_minute)
  ON attendance_settings TO jantrik_ingest;
CREATE POLICY ingest_read ON attendance_settings FOR SELECT TO jantrik_ingest USING (true);

-- Devices: found by serial number; only the receiver's own columns are written.
GRANT SELECT ON attendance_devices TO jantrik_ingest;
GRANT UPDATE (last_seen_at, last_punch_at, last_ip, firmware, user_count, push_version,
              attlog_stamp, clock_offset_sec, clock_samples, last_flood_at, last_flood_dropped)
  ON attendance_devices TO jantrik_ingest;
CREATE POLICY ingest_read ON attendance_devices FOR SELECT TO jantrik_ingest USING (true);
CREATE POLICY ingest_update ON attendance_devices FOR UPDATE TO jantrik_ingest
  USING (true) WITH CHECK (true);

-- Punches: inserted (ON CONFLICT DO NOTHING on the dedupe key); read back only to count a
-- device's punches per minute and to spot duplicates.
GRANT INSERT ON device_punches TO jantrik_ingest;
GRANT SELECT (tenant_id, device_id, device_user_id, device_time, flags)
  ON device_punches TO jantrik_ingest;
CREATE POLICY ingest_read ON device_punches FOR SELECT TO jantrik_ingest USING (true);
CREATE POLICY ingest_insert ON device_punches FOR INSERT TO jantrik_ingest WITH CHECK (true);

-- Commands: handed to the device, then its results recorded.
GRANT SELECT ON device_commands TO jantrik_ingest;
GRANT UPDATE (status, attempts, sent_at, done_at, return_code) ON device_commands TO jantrik_ingest;
CREATE POLICY ingest_read ON device_commands FOR SELECT TO jantrik_ingest USING (true);
CREATE POLICY ingest_update ON device_commands FOR UPDATE TO jantrik_ingest
  USING (true) WITH CHECK (true);

-- Source addresses: recorded and counted (the first one trusted at insert).
GRANT SELECT, INSERT ON device_source_ips TO jantrik_ingest;
GRANT UPDATE (last_seen_at, punch_count) ON device_source_ips TO jantrik_ingest;
CREATE POLICY ingest_read ON device_source_ips FOR SELECT TO jantrik_ingest USING (true);
CREATE POLICY ingest_insert ON device_source_ips FOR INSERT TO jantrik_ingest WITH CHECK (true);
CREATE POLICY ingest_update ON device_source_ips FOR UPDATE TO jantrik_ingest
  USING (true) WITH CHECK (true);

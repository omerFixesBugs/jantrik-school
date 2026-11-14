-- Backlog (step 11 final review), hand-written: hardening only; nothing the app or the receiver
-- writes today changes.
--   * jantrik_ingest may delete a device's untrusted addresses only, whatever other policy
--     applies: a RESTRICTIVE twin of the permissive ingest_delete. Permissive policies are OR'ed,
--     so inside a tenant context tenant_isolation alone would let it delete a trusted row (the
--     ingest functions never set one, and their DELETE filters trusted_at IS NULL).
--   * A DEVICE staff day carries no reason: only an admin's MANUAL day has one.
--   * A punch's reviewer is set only together with its review (review and reviewed_at are paired
--     already; a reviewer may still be missing on a reviewed punch).
--   * attendance_devices.serial_no gets a plain index: the partial unique index covers active
--     devices only, so each unknown or inactive serial the receiver refused scanned the table.
--
-- Prisma does not run a migration in one transaction: a statement that fails leaves the ones
-- before it applied. Every statement here can run again, so after a failure (a row breaking a
-- CHECK) the recovery is: fix the rows, `prisma migrate resolve --rolled-back
-- 20261113000000_devices_hardening`, deploy again. Each CHECK is added NOT VALID (a brief lock,
-- no scan), then validated (a scan that lets reads and writes go on).

-- ─────────────────────────── jantrik_ingest ───────────────────────────
DROP POLICY IF EXISTS ingest_delete_untrusted_only ON device_source_ips;
CREATE POLICY ingest_delete_untrusted_only ON device_source_ips AS RESTRICTIVE FOR DELETE
  TO jantrik_ingest USING (trusted_at IS NULL);

-- ─────────────────────────── CHECKs ───────────────────────────
ALTER TABLE staff_attendance_days
  DROP CONSTRAINT IF EXISTS staff_attendance_days_device_no_reason;
ALTER TABLE staff_attendance_days
  ADD CONSTRAINT staff_attendance_days_device_no_reason
    CHECK (source <> 'DEVICE' OR reason IS NULL) NOT VALID;
ALTER TABLE staff_attendance_days VALIDATE CONSTRAINT staff_attendance_days_device_no_reason;

ALTER TABLE device_punches
  DROP CONSTRAINT IF EXISTS device_punches_reviewer_needs_review;
ALTER TABLE device_punches
  ADD CONSTRAINT device_punches_reviewer_needs_review
    CHECK (reviewed_by_id IS NULL OR review IS NOT NULL) NOT VALID;
ALTER TABLE device_punches VALIDATE CONSTRAINT device_punches_reviewer_needs_review;

-- ─────────────────────────── Indexes ───────────────────────────
CREATE INDEX IF NOT EXISTS "attendance_devices_serial_no_idx" ON "attendance_devices"("serial_no");

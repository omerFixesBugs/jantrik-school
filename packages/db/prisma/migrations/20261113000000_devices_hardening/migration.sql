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

-- ─────────────────────────── jantrik_ingest ───────────────────────────
CREATE POLICY ingest_delete_untrusted_only ON device_source_ips AS RESTRICTIVE FOR DELETE
  TO jantrik_ingest USING (trusted_at IS NULL);

-- ─────────────────────────── CHECKs ───────────────────────────
ALTER TABLE staff_attendance_days
  ADD CONSTRAINT staff_attendance_days_device_no_reason
    CHECK (source <> 'DEVICE' OR reason IS NULL);

ALTER TABLE device_punches
  ADD CONSTRAINT device_punches_reviewer_needs_review
    CHECK (reviewed_by_id IS NULL OR review IS NOT NULL);

-- ─────────────────────────── Indexes ───────────────────────────
CREATE INDEX "attendance_devices_serial_no_idx" ON "attendance_devices"("serial_no");

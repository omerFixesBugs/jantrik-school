-- CreateEnum
CREATE TYPE "attendance_source" AS ENUM ('MANUAL', 'DEVICE');

-- AlterTable
ALTER TABLE "attendance_records" ADD COLUMN     "source" "attendance_source" NOT NULL DEFAULT 'MANUAL';

-- AlterTable
ALTER TABLE "attendance_sessions" ADD COLUMN     "source" "attendance_source" NOT NULL DEFAULT 'MANUAL',
ALTER COLUMN "taken_by_id" DROP NOT NULL,
ALTER COLUMN "updated_by_id" DROP NOT NULL;

-- ───── Step 11, part D1: device-sourced registers (hand-written) ─────
-- A DEVICE register is written by the device job at the cutoff, with no taker; a teacher's or an
-- admin's (MANUAL) always names one. Existing rows are MANUAL with both takers set.
ALTER TABLE attendance_sessions
  ADD CONSTRAINT attendance_sessions_taker CHECK (taken_by_id IS NOT NULL OR source = 'DEVICE'),
  ADD CONSTRAINT attendance_sessions_updater CHECK (updated_by_id IS NOT NULL OR source = 'DEVICE');

-- Grants unchanged: jantrik_app has table-level SELECT, INSERT, UPDATE on attendance_sessions and
-- attendance_records (migration 20261018064400_attendance), which covers the new `source` columns;
-- still no DELETE (history).

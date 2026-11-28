-- Sprint 1 P5 (S14): leaving is a student status, not a deletion. A leaver (GRADUATED,
-- TRANSFERRED, DROPPED_OUT, or INACTIVE without deletion) keeps deleted_at NULL, so the ledger,
-- the counter and history still find them; left_on says when, leave_reason why.
-- The app's table-level grants on students cover the new columns. Existing rows have NULLs, so
-- the CHECKs hold for every row (a new CHECK is checked against every row, RLS or not).

-- AlterTable
ALTER TABLE "students" ADD COLUMN     "leave_reason" TEXT,
ADD COLUMN     "left_on" DATE;

ALTER TABLE students DROP CONSTRAINT IF EXISTS students_left_on_only_when_gone;
ALTER TABLE students
  ADD CONSTRAINT students_left_on_only_when_gone CHECK (left_on IS NULL OR status <> 'ACTIVE');
ALTER TABLE students DROP CONSTRAINT IF EXISTS students_leave_reason_needs_date;
ALTER TABLE students
  ADD CONSTRAINT students_leave_reason_needs_date CHECK (leave_reason IS NULL OR left_on IS NOT NULL);
ALTER TABLE students DROP CONSTRAINT IF EXISTS students_leave_reason_length;
ALTER TABLE students
  ADD CONSTRAINT students_leave_reason_length CHECK (
    leave_reason IS NULL OR char_length(leave_reason) <= 500
  );

-- Decision #22: import rows flagged "possible duplicate" are skipped unless the admin chooses to
-- import them anyway. The chosen row numbers live here (not in results, which a re-check rewrites).
-- student_imports already has RLS (tenant_isolation) and SELECT/INSERT/UPDATE grants.
ALTER TABLE "student_imports"
  ADD COLUMN "duplicate_overrides" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];

ALTER TABLE "student_imports"
  ADD CONSTRAINT student_imports_duplicate_overrides_size
  CHECK (cardinality(duplicate_overrides) <= 5000);

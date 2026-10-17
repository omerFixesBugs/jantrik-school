-- Trigram search for GET /students (ILIKE '%…%' on names, student code, guardian phone).
-- RLS checklist (docs/database.md): no new tables, so no new policies or grants are needed.
-- pg_trgm is a trusted extension, so the database owner (jantrik_owner) may create it.

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateIndex
CREATE INDEX "guardians_phone_trgm_idx" ON "guardians" USING GIN ("phone" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "students_name_bn_trgm_idx" ON "students" USING GIN ("name_bn" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "students_name_en_trgm_idx" ON "students" USING GIN ("name_en" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "students_student_code_trgm_idx" ON "students" USING GIN ("student_code" gin_trgm_ops);

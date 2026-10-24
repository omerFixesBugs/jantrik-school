-- CreateEnum
CREATE TYPE "mark_sheet_status" AS ENUM ('DRAFT', 'SUBMITTED', 'LOCKED');

-- CreateTable
CREATE TABLE "exam_mark_sheets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "exam_id" UUID NOT NULL,
    "exam_subject_id" UUID NOT NULL,
    "class_level_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "status" "mark_sheet_status" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 0,
    "last_submission_id" UUID,
    "return_note" TEXT,
    "updated_by_id" UUID,
    "submitted_by_id" UUID,
    "submitted_at" TIMESTAMPTZ(3),
    "locked_by_id" UUID,
    "locked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_mark_sheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_marks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "exam_id" UUID NOT NULL,
    "exam_subject_id" UUID NOT NULL,
    "component_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "score_h" INTEGER,
    "absent" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_marks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exam_mark_sheets_tenant_id_exam_id_idx" ON "exam_mark_sheets"("tenant_id", "exam_id");

-- CreateIndex
CREATE INDEX "exam_mark_sheets_tenant_id_section_id_idx" ON "exam_mark_sheets"("tenant_id", "section_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_mark_sheets_tenant_id_id_key" ON "exam_mark_sheets"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_mark_sheets_tenant_id_exam_subject_id_section_id_key" ON "exam_mark_sheets"("tenant_id", "exam_subject_id", "section_id");

-- CreateIndex
CREATE INDEX "exam_marks_tenant_id_exam_subject_id_student_id_idx" ON "exam_marks"("tenant_id", "exam_subject_id", "student_id");

-- CreateIndex
CREATE INDEX "exam_marks_tenant_id_exam_id_student_id_idx" ON "exam_marks"("tenant_id", "exam_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_marks_tenant_id_id_key" ON "exam_marks"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_marks_tenant_id_component_id_student_id_key" ON "exam_marks"("tenant_id", "component_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_subjects_tenant_id_id_exam_id_class_level_id_key" ON "exam_subjects"("tenant_id", "id", "exam_id", "class_level_id");

-- AddForeignKey
ALTER TABLE "exam_mark_sheets" ADD CONSTRAINT "exam_mark_sheets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_mark_sheets" ADD CONSTRAINT "exam_mark_sheets_tenant_id_exam_subject_id_exam_id_class_l_fkey" FOREIGN KEY ("tenant_id", "exam_subject_id", "exam_id", "class_level_id") REFERENCES "exam_subjects"("tenant_id", "id", "exam_id", "class_level_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "exam_mark_sheets" ADD CONSTRAINT "exam_mark_sheets_tenant_id_section_id_class_level_id_fkey" FOREIGN KEY ("tenant_id", "section_id", "class_level_id") REFERENCES "sections"("tenant_id", "id", "class_level_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "exam_mark_sheets" ADD CONSTRAINT "exam_mark_sheets_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_mark_sheets" ADD CONSTRAINT "exam_mark_sheets_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_mark_sheets" ADD CONSTRAINT "exam_mark_sheets_locked_by_id_fkey" FOREIGN KEY ("locked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_marks" ADD CONSTRAINT "exam_marks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_marks" ADD CONSTRAINT "exam_marks_tenant_id_exam_subject_id_exam_id_fkey" FOREIGN KEY ("tenant_id", "exam_subject_id", "exam_id") REFERENCES "exam_subjects"("tenant_id", "id", "exam_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "exam_marks" ADD CONSTRAINT "exam_marks_tenant_id_component_id_exam_subject_id_fkey" FOREIGN KEY ("tenant_id", "component_id", "exam_subject_id") REFERENCES "exam_subject_components"("tenant_id", "id", "exam_subject_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "exam_marks" ADD CONSTRAINT "exam_marks_tenant_id_exam_id_student_id_fkey" FOREIGN KEY ("tenant_id", "exam_id", "student_id") REFERENCES "exam_candidates"("tenant_id", "exam_id", "student_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "exam_marks" ADD CONSTRAINT "exam_marks_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ───── Step 10, phase C: marks (hand-written: RLS, column grants, CHECKs, trigger) ─────

ALTER TABLE exam_mark_sheets ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_mark_sheets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON exam_mark_sheets
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE exam_marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_marks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON exam_marks
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- History: never deleted; only the state columns of a sheet and the score of a mark change.
GRANT SELECT, INSERT ON exam_mark_sheets, exam_marks TO jantrik_app;
GRANT UPDATE (
  status, version, last_submission_id, return_note, updated_by_id,
  submitted_by_id, submitted_at, locked_by_id, locked_at, updated_at
) ON exam_mark_sheets TO jantrik_app;
GRANT UPDATE (score_h, absent, updated_by_id, updated_at) ON exam_marks TO jantrik_app;

ALTER TABLE exam_mark_sheets
  ADD CONSTRAINT exam_mark_sheets_status CHECK (
    (status <> 'SUBMITTED' OR submitted_at IS NOT NULL)
    AND (status <> 'LOCKED' OR locked_at IS NOT NULL)
  ),
  ADD CONSTRAINT exam_mark_sheets_version CHECK (version >= 0),
  ADD CONSTRAINT exam_mark_sheets_return_note CHECK (
    return_note IS NULL OR length(btrim(return_note)) BETWEEN 3 AND 500
  );

ALTER TABLE exam_marks
  ADD CONSTRAINT exam_marks_absent CHECK (NOT (absent AND score_h IS NOT NULL)),
  ADD CONSTRAINT exam_marks_score CHECK (score_h IS NULL OR score_h >= 0);

-- A score never exceeds its part's full marks (hundredths). A plain invoker trigger: it reads the
-- part through RLS like the writer itself.
CREATE FUNCTION exam_marks_score_within_full() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  full_marks integer;
BEGIN
  IF NEW.score_h IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT c.full_marks INTO full_marks
    FROM exam_subject_components c
   WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.component_id;
  IF full_marks IS NULL OR NEW.score_h > full_marks * 100 THEN
    RAISE EXCEPTION 'exam_marks_score_within_full: % is above the full marks of the part', NEW.score_h
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION exam_marks_score_within_full() FROM PUBLIC;

CREATE TRIGGER exam_marks_score_within_full
  BEFORE INSERT OR UPDATE OF score_h, component_id ON exam_marks
  FOR EACH ROW EXECUTE FUNCTION exam_marks_score_within_full();

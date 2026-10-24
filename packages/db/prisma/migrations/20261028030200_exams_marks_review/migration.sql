-- CreateIndex
CREATE INDEX "exam_candidates_tenant_id_exam_id_class_level_id_idx" ON "exam_candidates"("tenant_id", "exam_id", "class_level_id");

-- CreateIndex
CREATE INDEX "exam_candidates_tenant_id_section_id_idx" ON "exam_candidates"("tenant_id", "section_id");

-- CreateIndex
CREATE INDEX "exam_candidates_tenant_id_room_id_idx" ON "exam_candidates"("tenant_id", "room_id");

-- CreateIndex
CREATE INDEX "exam_classes_tenant_id_class_level_id_idx" ON "exam_classes"("tenant_id", "class_level_id");

-- CreateIndex
CREATE INDEX "exam_subjects_tenant_id_subject_id_idx" ON "exam_subjects"("tenant_id", "subject_id");


-- ───── Step 10, B1/C1 review (hand-written) ─────

-- A CHECK that evaluates to NULL passes: test the column first.
ALTER TABLE exams DROP CONSTRAINT IF EXISTS exams_merit_order;
ALTER TABLE exams
  ADD CONSTRAINT exams_merit_order CHECK (
    merit_order IS NOT NULL
    AND cardinality(merit_order) BETWEEN 1 AND 8
    AND array_position(merit_order, NULL) IS NULL
  );

-- A candidate's exam and student never change (only the roster columns, seat and remarks).
REVOKE UPDATE ON exam_candidates FROM jantrik_app;
GRANT UPDATE (
  class_level_id, section_id, study_group_id, roll, status, room_id, seat_no,
  remarks, remarks_by_id, remarks_at, updated_at
) ON exam_candidates TO jantrik_app;

-- A part's full marks never drop below a score already given in it (the service refuses any
-- change to a subject with marks; this is the safety net).
CREATE FUNCTION exam_components_full_covers_marks() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.full_marks < OLD.full_marks AND EXISTS (
    SELECT 1 FROM public.exam_marks m
     WHERE m.tenant_id = NEW.tenant_id AND m.component_id = NEW.id
       AND m.score_h > NEW.full_marks * 100
  ) THEN
    RAISE EXCEPTION 'exam_components_full_covers_marks: a score is above the new full marks'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION exam_components_full_covers_marks() FROM PUBLIC;

CREATE TRIGGER exam_components_full_covers_marks
  BEFORE UPDATE OF full_marks ON exam_subject_components
  FOR EACH ROW EXECUTE FUNCTION exam_components_full_covers_marks();

-- A part this row cannot see (another tenant's) is left to RLS and the foreign key, so the writer
-- gets the real reason instead of "above the full marks".
CREATE OR REPLACE FUNCTION exam_marks_score_within_full() RETURNS trigger
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
  IF full_marks IS NOT NULL AND NEW.score_h > full_marks * 100 THEN
    RAISE EXCEPTION 'exam_marks_score_within_full: % is above the full marks of the part', NEW.score_h
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

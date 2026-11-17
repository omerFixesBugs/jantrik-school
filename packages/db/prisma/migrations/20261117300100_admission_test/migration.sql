-- Sprint 1 P4: the admission test and the merit list (docs/admission.md → "The admission test").
-- Columns on P3's tables only: no new table, so RLS is unchanged (the tenant policies cover every
-- column). Two kinds of result columns on an application (decision P4-a1):
--   * the draft of the last build (test_result, merit_position, waitlist_position), rewritten by
--     every build and never shown to the applicant;
--   * the published snapshot (result_*), written only by a publish (and a waitlist move-up), the
--     only result columns the public lookup's role may read.

CREATE TYPE "admission_tie_break" AS ENUM ('OLDER_FIRST', 'YOUNGER_FIRST', 'NONE');
CREATE TYPE "admission_test_result" AS ENUM ('SELECTED', 'WAITLISTED', 'NOT_SELECTED', 'FAILED', 'ABSENT');

-- ─────────────────────────── Cycles ───────────────────────────
ALTER TABLE "admission_cycles"
  ADD COLUMN "merit_tie_break" "admission_tie_break" NOT NULL DEFAULT 'OLDER_FIRST';

-- ─────────────────────────── Classes ───────────────────────────
ALTER TABLE "admission_cycle_classes"
  ADD COLUMN "test_date" DATE,
  ADD COLUMN "test_time" TIME(0),
  ADD COLUMN "test_venue_bn" TEXT,
  ADD COLUMN "test_venue_en" TEXT,
  ADD COLUMN "full_marks" INTEGER,
  ADD COLUMN "pass_marks" INTEGER,
  ADD COLUMN "select_count" INTEGER,
  ADD COLUMN "waitlist_count" INTEGER,
  -- The draft: when it was built and a hash of everything it was built from (P4-a3).
  ADD COLUMN "merit_built_at" TIMESTAMPTZ(3),
  ADD COLUMN "merit_inputs_hash" TEXT,
  -- The latest score change ("changed since publish", P4-J).
  ADD COLUMN "scores_changed_at" TIMESTAMPTZ(3),
  -- The published version, when, and the full marks it was published with.
  ADD COLUMN "results_version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "results_published_at" TIMESTAMPTZ(3),
  ADD COLUMN "results_full_marks" INTEGER,
  ADD CONSTRAINT "admission_cycle_classes_test_venue_bn_len"
    CHECK ("test_venue_bn" IS NULL OR char_length("test_venue_bn") BETWEEN 1 AND 200),
  ADD CONSTRAINT "admission_cycle_classes_test_venue_en_len"
    CHECK ("test_venue_en" IS NULL OR char_length("test_venue_en") BETWEEN 1 AND 200),
  ADD CONSTRAINT "admission_cycle_classes_full_marks_range"
    CHECK ("full_marks" IS NULL OR "full_marks" BETWEEN 1 AND 1000),
  ADD CONSTRAINT "admission_cycle_classes_pass_marks_range"
    CHECK ("pass_marks" IS NULL OR ("full_marks" IS NOT NULL AND "pass_marks" BETWEEN 0 AND "full_marks")),
  ADD CONSTRAINT "admission_cycle_classes_select_count_range"
    CHECK ("select_count" IS NULL OR "select_count" BETWEEN 0 AND 5000),
  ADD CONSTRAINT "admission_cycle_classes_waitlist_count_range"
    CHECK ("waitlist_count" IS NULL OR "waitlist_count" BETWEEN 0 AND 5000),
  ADD CONSTRAINT "admission_cycle_classes_merit_built"
    CHECK (("merit_built_at" IS NULL) = ("merit_inputs_hash" IS NULL)),
  ADD CONSTRAINT "admission_cycle_classes_results_version"
    CHECK ("results_version" >= 0),
  ADD CONSTRAINT "admission_cycle_classes_results_published"
    CHECK (("results_version" = 0) = ("results_published_at" IS NULL)),
  ADD CONSTRAINT "admission_cycle_classes_results_full_marks"
    CHECK (("results_version" = 0) = ("results_full_marks" IS NULL)
           AND ("results_full_marks" IS NULL OR "results_full_marks" BETWEEN 1 AND 1000));

-- ─────────────────────────── Applications ───────────────────────────
ALTER TABLE "admission_applications"
  ADD COLUMN "test_roll" INTEGER,
  ADD COLUMN "test_score_h" INTEGER,
  ADD COLUMN "test_absent" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "test_result" "admission_test_result",
  ADD COLUMN "merit_position" INTEGER,
  ADD COLUMN "waitlist_position" INTEGER,
  ADD COLUMN "result_version" INTEGER,
  ADD COLUMN "result_merit_position" INTEGER,
  ADD COLUMN "result_waitlist_position" INTEGER,
  ADD COLUMN "result_score_h" INTEGER,
  ADD COLUMN "result_absent" BOOLEAN,
  ADD COLUMN "result_flag" TEXT,
  ADD CONSTRAINT "admission_applications_test_roll_range"
    CHECK ("test_roll" IS NULL OR "test_roll" BETWEEN 1 AND 999999),
  ADD CONSTRAINT "admission_applications_test_score_min"
    CHECK ("test_score_h" IS NULL OR "test_score_h" >= 0),
  ADD CONSTRAINT "admission_applications_absent_no_score"
    CHECK (NOT "test_absent" OR "test_score_h" IS NULL),
  ADD CONSTRAINT "admission_applications_merit_position_min"
    CHECK ("merit_position" IS NULL OR "merit_position" >= 1),
  ADD CONSTRAINT "admission_applications_waitlist_position"
    CHECK ("waitlist_position" IS NULL
           OR ("waitlist_position" >= 1 AND "test_result" IS NOT NULL AND "test_result" = 'WAITLISTED')),
  ADD CONSTRAINT "admission_applications_result_version_min"
    CHECK ("result_version" IS NULL OR "result_version" >= 1),
  ADD CONSTRAINT "admission_applications_result_positions"
    CHECK (("result_merit_position" IS NULL OR "result_merit_position" >= 1)
           AND ("result_waitlist_position" IS NULL OR "result_waitlist_position" >= 1)
           AND ("result_score_h" IS NULL OR "result_score_h" >= 0)),
  ADD CONSTRAINT "admission_applications_result_only_published"
    CHECK ("result_version" IS NOT NULL
           OR ("result_merit_position" IS NULL AND "result_waitlist_position" IS NULL
               AND "result_score_h" IS NULL AND "result_absent" IS NULL)),
  ADD CONSTRAINT "admission_applications_result_flag"
    CHECK ("result_flag" IS NULL OR "result_flag" IN ('ADMITTED_NOT_SELECTED'));

-- One roll per class (rolls are issued per class, decision P4-C).
CREATE UNIQUE INDEX "admission_applications_test_roll_key"
  ON "admission_applications" ("tenant_id", "cycle_class_id", "test_roll")
  WHERE "test_roll" IS NOT NULL;
CREATE INDEX "admission_applications_merit_idx"
  ON "admission_applications" ("tenant_id", "cycle_class_id", "merit_position");

-- ─────────────────────────── Scores within the full marks ───────────────────────────
-- As exam marks (exam_marks_score_within_full): a score needs its class's full marks and stays
-- within them; full marks never drop below (or away from) a score already entered. A class this
-- row cannot see (another tenant's) is left to RLS and the composite foreign key.
CREATE FUNCTION test_score_within_full_marks() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_full integer;
BEGIN
  IF NEW.test_score_h IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT cc.full_marks INTO v_full
    FROM public.admission_cycle_classes cc
   WHERE cc.tenant_id = NEW.tenant_id AND cc.id = NEW.cycle_class_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF v_full IS NULL OR NEW.test_score_h > v_full * 100 THEN
    RAISE EXCEPTION 'test_score_within_full_marks: the score is above the full marks of its class'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER test_score_within_full_marks
  BEFORE INSERT OR UPDATE OF test_score_h, cycle_class_id ON admission_applications
  FOR EACH ROW EXECUTE FUNCTION test_score_within_full_marks();

CREATE FUNCTION full_marks_keep_test_scores() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.full_marks IS NOT DISTINCT FROM OLD.full_marks THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.admission_applications a
     WHERE a.tenant_id = NEW.tenant_id AND a.cycle_class_id = NEW.id
       AND a.test_score_h IS NOT NULL
       AND (NEW.full_marks IS NULL OR a.test_score_h > NEW.full_marks * 100)
  ) THEN
    RAISE EXCEPTION 'full_marks_keep_test_scores: a score is above the new full marks'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER full_marks_keep_test_scores
  BEFORE UPDATE OF full_marks ON admission_cycle_classes
  FOR EACH ROW EXECUTE FUNCTION full_marks_keep_test_scores();

-- ─────────────────────────── Privileges ───────────────────────────
-- The API writes the new columns only (by column, as P3's review N2 asked).
GRANT UPDATE (merit_tie_break) ON admission_cycles TO jantrik_app;
GRANT UPDATE (test_date, test_time, test_venue_bn, test_venue_en, full_marks, pass_marks,
              select_count, waitlist_count, merit_built_at, merit_inputs_hash, scores_changed_at,
              results_version, results_published_at, results_full_marks)
  ON admission_cycle_classes TO jantrik_app;
GRANT UPDATE (test_roll, test_score_h, test_absent, test_result, merit_position,
              waitlist_position, result_version, result_merit_position, result_waitlist_position,
              result_score_h, result_absent, result_flag)
  ON admission_applications TO jantrik_app;
-- The public lookup's role reads the roll and the published snapshot only: never the draft of a
-- build, never a score before it is published (review focus 3). Cycles and classes it reads whole
-- already (P3b: SELECT on the table).
GRANT SELECT (test_roll, result_version, result_merit_position, result_waitlist_position,
              result_score_h, result_absent)
  ON admission_applications TO jantrik_admission;

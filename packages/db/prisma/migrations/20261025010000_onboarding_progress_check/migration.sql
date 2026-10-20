-- Step 8, part 5: step values must be the strings 'done' or 'skipped'. The first check compared
-- with jsonpath, where a non-string (true, 1) against a string is "unknown" and slipped through.
ALTER TABLE onboarding_progress DROP CONSTRAINT onboarding_progress_steps;
ALTER TABLE onboarding_progress ADD CONSTRAINT onboarding_progress_steps CHECK (
  CASE WHEN jsonb_typeof(steps) = 'object'
    THEN steps - ARRAY['year', 'classes', 'shifts', 'teachers', 'students', 'attendance'] = '{}'::jsonb
         AND NOT jsonb_path_exists(
           steps, '$.* ? (@.type() != "string" || (@ != "done" && @ != "skipped"))')
    ELSE false
  END
);

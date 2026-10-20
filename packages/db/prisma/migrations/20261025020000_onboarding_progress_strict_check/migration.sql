-- Step 8, part 5: the step-value CHECK in strict jsonpath mode. In the default lax mode a
-- filter unwraps an array, so {"year": ["done"]} and {"year": []} still passed.
ALTER TABLE onboarding_progress DROP CONSTRAINT IF EXISTS onboarding_progress_steps;
ALTER TABLE onboarding_progress ADD CONSTRAINT onboarding_progress_steps CHECK (
  CASE WHEN jsonb_typeof(steps) = 'object'
    THEN steps - ARRAY['year', 'classes', 'shifts', 'teachers', 'students', 'attendance'] = '{}'::jsonb
         AND NOT jsonb_path_exists(
           steps, 'strict $.* ? (@.type() != "string" || (@ != "done" && @ != "skipped"))')
    ELSE false
  END
);

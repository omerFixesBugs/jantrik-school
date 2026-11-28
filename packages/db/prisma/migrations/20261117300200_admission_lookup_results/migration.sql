-- Sprint 1 P4: the status page also shows the admission test's details once a roll is issued
-- (decision P4-M) and the published result (S13). The same signature, so the grants stay
-- (EXECUTE to jantrik_app only).
--
-- Only the owner, jantrik_admission, can replace the function, and P3b revoked its CREATE on the
-- schema; jantrik_owner holds the role WITH INHERIT FALSE, SET TRUE (docs/admission.md →
-- "Changing these functions later"). So: CREATE granted back for the replacement only.
GRANT CREATE ON SCHEMA public TO jantrik_admission;
SET ROLE jantrik_admission;

-- NULL unless the slug resolves and an application with that number has exactly that phone (the
-- phone was proved by a status code first, P3-F and P3-b16). Never the draft of a build and never
-- a score before it is published: `result` comes from the published snapshot only, and only when
-- it belongs to the class's published version (a correction built but not republished still shows
-- the published values; an applicant left out of a later version shows none).
CREATE OR REPLACE FUNCTION public.admission_lookup(p_slug text, p_application_no text, p_phone text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tenant uuid;
  v jsonb;
  r record;
BEGIN
  SELECT tn.id INTO v_tenant FROM public.tenants tn
  WHERE tn.slug = p_slug AND tn.status IN ('ACTIVE', 'TRIAL');
  IF v_tenant IS NULL OR p_application_no IS NULL OR p_phone IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT a.application_no, a.status, a.name_bn, a.name_en, a.submitted_at, a.test_roll,
         a.result_version, a.result_merit_position, a.result_waitlist_position,
         a.result_score_h, a.result_absent,
         cl.name_bn AS class_name_bn, cl.name_en AS class_name_en,
         g.name_bn AS group_name_bn, g.name_en AS group_name_en,
         c.name_bn AS cycle_name_bn, c.name_en AS cycle_name_en,
         cc.test_date, cc.test_time, cc.test_venue_bn, cc.test_venue_en,
         cc.results_version, cc.results_published_at, cc.results_full_marks
    INTO r
  FROM public.admission_applications a
  JOIN public.admission_cycles c ON c.tenant_id = a.tenant_id AND c.id = a.cycle_id
  JOIN public.admission_cycle_classes cc ON cc.tenant_id = a.tenant_id AND cc.id = a.cycle_class_id
  JOIN public.class_levels cl ON cl.tenant_id = cc.tenant_id AND cl.id = cc.class_level_id
  LEFT JOIN public.study_groups g ON g.tenant_id = cc.tenant_id AND g.id = cc.study_group_id
  WHERE a.tenant_id = v_tenant AND a.application_no = p_application_no AND a.phone = p_phone;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v := jsonb_build_object(
         'applicationNo', r.application_no, 'status', r.status,
         'nameBn', r.name_bn, 'nameEn', r.name_en,
         'classNameBn', r.class_name_bn, 'classNameEn', r.class_name_en,
         'groupNameBn', r.group_name_bn, 'groupNameEn', r.group_name_en,
         'cycleNameBn', r.cycle_name_bn, 'cycleNameEn', r.cycle_name_en,
         'submittedAt', r.submitted_at);
  IF r.test_roll IS NOT NULL THEN
    v := v || jsonb_build_object('test', jsonb_build_object(
           'roll', r.test_roll, 'date', r.test_date,
           'time', to_char(r.test_time, 'HH24:MI'),
           'venueBn', r.test_venue_bn, 'venueEn', r.test_venue_en));
  END IF;
  IF r.results_version > 0 AND r.result_version IS NOT NULL
     AND r.result_version = r.results_version THEN
    v := v || jsonb_build_object('result', jsonb_build_object(
           'version', r.result_version,
           'meritPosition', r.result_merit_position,
           'waitlistPosition', r.result_waitlist_position,
           'scoreH', r.result_score_h,
           'fullMarks', r.results_full_marks,
           'absent', COALESCE(r.result_absent, false),
           'publishedAt', r.results_published_at));
  END IF;
  RETURN v;
END $$;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM jantrik_admission;

-- Sprint 1 P3b (docs/admission.md → The public form): the only way the public admission routes
-- reach the database (decision S4). Three SECURITY DEFINER functions owned by jantrik_admission,
-- run by jantrik_app with no request context: each resolves the institute from the slug itself
-- and scopes every statement by it, so a cycle class, application number or phone of another
-- institute is simply not found. Times come from the API's clock (p_now).

-- ─────────────────────────── The form ───────────────────────────
-- NULL for an unknown slug or an institute that is not ACTIVE or TRIAL. Otherwise the institute's
-- id (for the API's own keys and jobs; the API never sends it to the browser), name and language,
-- and the cycles taking applications at p_now (OPEN, inside the window), each with its open
-- classes whose class (and group) is active. No person's data, ever.
CREATE FUNCTION admission_public_form(p_slug text, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  t record;
BEGIN
  SELECT tn.id, tn.name, tn.timezone, tn.default_locale, p.name_bn, p.name_en INTO t
  FROM public.tenants tn
  LEFT JOIN public.institute_profiles p ON p.tenant_id = tn.id
  WHERE tn.slug = p_slug AND tn.status IN ('ACTIVE', 'TRIAL');
  IF t.id IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'tenantId', t.id,
    'timezone', t.timezone,
    'institute', jsonb_build_object(
      'name', t.name, 'nameBn', t.name_bn, 'nameEn', t.name_en, 'locale', t.default_locale),
    'cycles', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'nameBn', c.name_bn, 'nameEn', c.name_en, 'closesAt', c.closes_at,
               'noteBn', c.public_note_bn, 'noteEn', c.public_note_en,
               'collectPhoto', c.collect_photo, 'fields', c.fields,
               'classes', (
                 SELECT jsonb_agg(jsonb_build_object(
                          'cycleClassId', cc.id,
                          'classNameBn', cl.name_bn, 'classNameEn', cl.name_en,
                          'groupNameBn', g.name_bn, 'groupNameEn', g.name_en)
                        ORDER BY cl.sort_order, g.sort_order NULLS FIRST, cc.id)
                 FROM public.admission_cycle_classes cc
                 JOIN public.class_levels cl ON cl.tenant_id = cc.tenant_id AND cl.id = cc.class_level_id
                 LEFT JOIN public.study_groups g ON g.tenant_id = cc.tenant_id AND g.id = cc.study_group_id
                 WHERE cc.tenant_id = t.id AND cc.cycle_id = c.id AND cc.is_open
                   AND cl.is_active AND (cc.study_group_id IS NULL OR g.is_active)))
             ORDER BY c.closes_at, c.id)
      FROM public.admission_cycles c
      WHERE c.tenant_id = t.id AND c.status = 'OPEN' AND c.opens_at <= p_now AND p_now < c.closes_at
        AND EXISTS (
          SELECT 1 FROM public.admission_cycle_classes cc
          JOIN public.class_levels cl ON cl.tenant_id = cc.tenant_id AND cl.id = cc.class_level_id
          LEFT JOIN public.study_groups g ON g.tenant_id = cc.tenant_id AND g.id = cc.study_group_id
          WHERE cc.tenant_id = t.id AND cc.cycle_id = c.id AND cc.is_open
            AND cl.is_active AND (cc.study_group_id IS NULL OR g.is_active))), '[]'::jsonb)
  );
END $$;

-- ─────────────────────────── Submit ───────────────────────────
-- One row, always: outcome CREATED (with the new number), UNKNOWN (slug), CLOSED (the class is
-- not this institute's, not open, or its cycle is not taking applications at p_now: one answer
-- for all, so another institute's class id tells nothing), INVALID (a key outside the list, a
-- required field missing, a hidden field or photo given, a value the table refuses), DUPLICATE
-- (with the earlier number, decision P3-S) or PHONE_CAP (a fourth live application of the phone in
-- the cycle). The rules match the staff entry's (apps/api/src/admission/applications.service.ts).
CREATE FUNCTION admission_submit(
  p_slug text,
  p_cycle_class_id uuid,
  p_phone text,
  p_payload jsonb,
  p_photo bytea,
  p_photo_width integer,
  p_photo_height integer,
  p_now timestamptz
)
RETURNS TABLE (outcome text, application_no text, tenant_id uuid, application_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
-- The result columns (tenant_id, application_no) are also table columns: names in the queries
-- below always mean the columns.
#variable_conflict use_column
DECLARE
  v_tenant uuid;
  v_cycle record;
  v_settings jsonb;
  v_given jsonb;
  v_field text;
  v_setting text;
  v_name_key text;
  v_dob date;
  v_birth_reg text;
  v_dup text;
  v_live integer;
  v_year integer;
  v_no integer;
  v_number text;
  v_id uuid;
  c_keys CONSTANT text[] := ARRAY['nameBn', 'nameEn', 'dateOfBirth', 'gender', 'religion',
    'bloodGroup', 'birthRegistrationNo', 'previousInstitute', 'presentAddress',
    'permanentAddress', 'fatherNameBn', 'fatherNameEn', 'motherNameBn', 'motherNameEn',
    'guardianNameBn', 'guardianNameEn', 'guardianRelation', 'guardianOccupation'];
  c_defaults CONSTANT jsonb := '{"photo": "OPTIONAL", "religion": "OPTIONAL",
    "blood_group": "HIDDEN", "birth_registration_no": "OPTIONAL",
    "previous_institute": "OPTIONAL", "present_address": "OPTIONAL",
    "permanent_address": "OPTIONAL", "father_name": "OPTIONAL", "mother_name": "OPTIONAL",
    "guardian_occupation": "OPTIONAL"}';
  c_null CONSTANT uuid := NULL;
BEGIN
  SELECT tn.id INTO v_tenant FROM public.tenants tn
  WHERE tn.slug = p_slug AND tn.status IN ('ACTIVE', 'TRIAL');
  IF v_tenant IS NULL THEN
    RETURN QUERY SELECT 'UNKNOWN'::text, NULL::text, c_null, c_null;
    RETURN;
  END IF;

  SELECT c.id, c.fields, c.collect_photo, ay.start_date INTO v_cycle
  FROM public.admission_cycle_classes cc
  JOIN public.admission_cycles c ON c.tenant_id = cc.tenant_id AND c.id = cc.cycle_id
  JOIN public.academic_years ay ON ay.tenant_id = c.tenant_id AND ay.id = c.academic_year_id
  JOIN public.class_levels cl ON cl.tenant_id = cc.tenant_id AND cl.id = cc.class_level_id
  LEFT JOIN public.study_groups g ON g.tenant_id = cc.tenant_id AND g.id = cc.study_group_id
  WHERE cc.tenant_id = v_tenant AND cc.id = p_cycle_class_id AND cc.is_open
    AND c.status = 'OPEN' AND c.opens_at <= p_now AND p_now < c.closes_at
    AND cl.is_active AND (cc.study_group_id IS NULL OR g.is_active);
  IF v_cycle.id IS NULL THEN
    RETURN QUERY SELECT 'CLOSED'::text, NULL::text, v_tenant, c_null;
    RETURN;
  END IF;

  -- Shape: an object of known keys only, a valid phone.
  IF p_phone IS NULL OR p_phone !~ '^\+8801[3-9][0-9]{8}$'
     OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k <> ALL (c_keys)) THEN
    RETURN QUERY SELECT 'INVALID'::text, NULL::text, v_tenant, c_null;
    RETURN;
  END IF;

  -- Always required: a name, the date of birth, the gender, the guardian's name and relation.
  IF COALESCE(NULLIF(p_payload->>'nameBn', ''), NULLIF(p_payload->>'nameEn', '')) IS NULL
     OR NULLIF(p_payload->>'dateOfBirth', '') IS NULL
     OR NULLIF(p_payload->>'gender', '') IS NULL
     OR COALESCE(NULLIF(p_payload->>'guardianNameBn', ''), NULLIF(p_payload->>'guardianNameEn', '')) IS NULL
     OR NULLIF(p_payload->>'guardianRelation', '') IS NULL THEN
    RETURN QUERY SELECT 'INVALID'::text, NULL::text, v_tenant, c_null;
    RETURN;
  END IF;

  -- The cycle's optional fields (packages/shared/src/admission.ts → effectiveAdmissionFields):
  -- REQUIRED ones given, HIDDEN ones not; the photo only when the cycle collects photos.
  v_settings := c_defaults || COALESCE(v_cycle.fields, '{}'::jsonb);
  v_settings := jsonb_set(v_settings, '{photo}', to_jsonb(CASE
    WHEN NOT v_cycle.collect_photo THEN 'HIDDEN'
    WHEN v_settings->>'photo' = 'REQUIRED' THEN 'REQUIRED'
    ELSE 'OPTIONAL' END));
  v_given := jsonb_build_object(
    'photo', p_photo IS NOT NULL,
    'religion', NULLIF(p_payload->>'religion', '') IS NOT NULL,
    'blood_group', NULLIF(p_payload->>'bloodGroup', '') IS NOT NULL,
    'birth_registration_no', NULLIF(p_payload->>'birthRegistrationNo', '') IS NOT NULL,
    'previous_institute', NULLIF(p_payload->>'previousInstitute', '') IS NOT NULL,
    'present_address', NULLIF(p_payload->>'presentAddress', '') IS NOT NULL,
    'permanent_address', NULLIF(p_payload->>'permanentAddress', '') IS NOT NULL,
    'father_name', COALESCE(NULLIF(p_payload->>'fatherNameBn', ''), NULLIF(p_payload->>'fatherNameEn', '')) IS NOT NULL,
    'mother_name', COALESCE(NULLIF(p_payload->>'motherNameBn', ''), NULLIF(p_payload->>'motherNameEn', '')) IS NOT NULL,
    'guardian_occupation', NULLIF(p_payload->>'guardianOccupation', '') IS NOT NULL);
  FOR v_field, v_setting IN SELECT key, value FROM jsonb_each_text(v_settings) LOOP
    IF (v_setting = 'REQUIRED' AND NOT (v_given->>v_field)::boolean)
       OR (v_setting = 'HIDDEN' AND (v_given->>v_field)::boolean) THEN
      RETURN QUERY SELECT 'INVALID'::text, NULL::text, v_tenant, c_null;
      RETURN;
    END IF;
  END LOOP;

  BEGIN
    v_dob := (p_payload->>'dateOfBirth')::date;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RETURN QUERY SELECT 'INVALID'::text, NULL::text, v_tenant, c_null;
    RETURN;
  END;
  v_birth_reg := NULLIF(p_payload->>'birthRegistrationNo', '');
  -- The duplicate key: the Bangla name, else the English one; NFC, lower case, no spaces
  -- (nameKey in packages/shared/src/admission.ts).
  v_name_key := regexp_replace(
    lower(normalize(COALESCE(NULLIF(p_payload->>'nameBn', ''), p_payload->>'nameEn'), NFC)),
    '\s+', '', 'g');

  -- One application of this phone at a time in this institute (the duplicate and cap checks).
  PERFORM pg_advisory_xact_lock(hashtextextended('admission:' || v_tenant::text || ':' || p_phone, 0));

  SELECT a.application_no INTO v_dup
  FROM public.admission_applications a
  WHERE a.tenant_id = v_tenant AND a.cycle_id = v_cycle.id AND a.status <> 'WITHDRAWN'
    AND ((v_birth_reg IS NOT NULL AND a.birth_registration_no = v_birth_reg)
         OR (a.phone = p_phone AND a.name_key = v_name_key AND a.date_of_birth = v_dob))
  ORDER BY a.submitted_at, a.id
  LIMIT 1;
  IF v_dup IS NOT NULL THEN
    RETURN QUERY SELECT 'DUPLICATE'::text, v_dup, v_tenant, c_null;
    RETURN;
  END IF;

  SELECT count(*) INTO v_live
  FROM public.admission_applications a
  WHERE a.tenant_id = v_tenant AND a.cycle_id = v_cycle.id AND a.phone = p_phone
    AND a.status NOT IN ('WITHDRAWN', 'REJECTED');
  IF v_live >= 3 THEN
    RETURN QUERY SELECT 'PHONE_CAP'::text, NULL::text, v_tenant, c_null;
    RETURN;
  END IF;

  BEGIN
    v_year := EXTRACT(YEAR FROM v_cycle.start_date)::integer;
    INSERT INTO public.admission_counters AS ac (tenant_id, year, last_no, created_at, updated_at)
    VALUES (v_tenant, v_year, 1, now(), now())
    ON CONFLICT (tenant_id, year)
    DO UPDATE SET last_no = ac.last_no + 1, updated_at = now()
    RETURNING ac.last_no INTO v_no;
    v_number := v_year::text || '-' || lpad(v_no::text, 4, '0');
    v_id := gen_random_uuid();

    INSERT INTO public.admission_applications (
      id, tenant_id, cycle_id, cycle_class_id, application_no, source, name_bn, name_en,
      name_key, date_of_birth, gender, religion, blood_group, birth_registration_no,
      previous_institute, present_address, permanent_address, father_name_bn, father_name_en,
      mother_name_bn, mother_name_en, guardian_name_bn, guardian_name_en, guardian_relation,
      guardian_occupation, phone, submitted_at, created_at, updated_at)
    VALUES (
      v_id, v_tenant, v_cycle.id, p_cycle_class_id, v_number, 'ONLINE',
      NULLIF(p_payload->>'nameBn', ''), NULLIF(p_payload->>'nameEn', ''), v_name_key, v_dob,
      (p_payload->>'gender')::gender, (NULLIF(p_payload->>'religion', ''))::religion,
      (NULLIF(p_payload->>'bloodGroup', ''))::blood_group, v_birth_reg,
      NULLIF(p_payload->>'previousInstitute', ''), NULLIF(p_payload->>'presentAddress', ''),
      NULLIF(p_payload->>'permanentAddress', ''), NULLIF(p_payload->>'fatherNameBn', ''),
      NULLIF(p_payload->>'fatherNameEn', ''), NULLIF(p_payload->>'motherNameBn', ''),
      NULLIF(p_payload->>'motherNameEn', ''), NULLIF(p_payload->>'guardianNameBn', ''),
      NULLIF(p_payload->>'guardianNameEn', ''), (p_payload->>'guardianRelation')::guardian_relation,
      NULLIF(p_payload->>'guardianOccupation', ''), p_phone, p_now, now(), now());

    IF p_photo IS NOT NULL THEN
      INSERT INTO public.admission_application_photos (
        tenant_id, application_id, mime, bytes, sha256, width, height, created_at)
      VALUES (v_tenant, v_id, 'image/jpeg', p_photo, encode(sha256(p_photo), 'hex'),
              p_photo_width, p_photo_height, now());
    END IF;
  EXCEPTION WHEN check_violation OR invalid_text_representation OR not_null_violation
                 OR string_data_right_truncation OR numeric_value_out_of_range THEN
    -- A value the table refuses (the API validated it already; a direct call may not have).
    RETURN QUERY SELECT 'INVALID'::text, NULL::text, v_tenant, c_null;
    RETURN;
  END;

  RETURN QUERY SELECT 'CREATED'::text, v_number, v_tenant, v_id;
END $$;

-- ─────────────────────────── Status ───────────────────────────
-- NULL unless the slug resolves and an application with that number has exactly that phone
-- (the phone was proved by a code first, decision P3-F). jsonb, so P4 adds the published result
-- without changing the signature.
CREATE FUNCTION admission_lookup(p_slug text, p_application_no text, p_phone text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tenant uuid;
  v jsonb;
BEGIN
  SELECT tn.id INTO v_tenant FROM public.tenants tn
  WHERE tn.slug = p_slug AND tn.status IN ('ACTIVE', 'TRIAL');
  IF v_tenant IS NULL OR p_application_no IS NULL OR p_phone IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT jsonb_build_object(
           'applicationNo', a.application_no, 'status', a.status,
           'nameBn', a.name_bn, 'nameEn', a.name_en,
           'classNameBn', cl.name_bn, 'classNameEn', cl.name_en,
           'groupNameBn', g.name_bn, 'groupNameEn', g.name_en,
           'cycleNameBn', c.name_bn, 'cycleNameEn', c.name_en,
           'submittedAt', a.submitted_at)
    INTO v
  FROM public.admission_applications a
  JOIN public.admission_cycles c ON c.tenant_id = a.tenant_id AND c.id = a.cycle_id
  JOIN public.admission_cycle_classes cc ON cc.tenant_id = a.tenant_id AND cc.id = a.cycle_class_id
  JOIN public.class_levels cl ON cl.tenant_id = cc.tenant_id AND cl.id = cc.class_level_id
  LEFT JOIN public.study_groups g ON g.tenant_id = cc.tenant_id AND g.id = cc.study_group_id
  WHERE a.tenant_id = v_tenant AND a.application_no = p_application_no AND a.phone = p_phone;
  RETURN v;
END $$;

-- ─────────────────────────── Privileges ───────────────────────────
-- Before OWNER TO: only a function's owner can change its privileges. jantrik_app (the API's
-- public routes) runs them; nobody else (not PUBLIC, not the platform or receiver logins).
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'admission_public_form(text, timestamptz)',
    'admission_submit(text, uuid, text, jsonb, bytea, integer, integer, timestamptz)',
    'admission_lookup(text, text, text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO jantrik_app', f);
    EXECUTE format('ALTER FUNCTION %s OWNER TO jantrik_admission', f);
  END LOOP;
END $$;

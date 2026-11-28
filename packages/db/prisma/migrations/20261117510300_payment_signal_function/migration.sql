-- Sprint 1 P7a2 (docs/payments.md → Signals, decision P7a-B): the only way the public return and
-- IPN routes reach the database. One SECURITY DEFINER function owned by jantrik_payments, run by
-- jantrik_app with no request context: it resolves the institute from the slug itself, finds the
-- intent by our own tran_id in that institute only, and stores the signal. Nothing in a signal is
-- trusted: the confirm job asks the gateway. Times come from the API's clock (p_now).
--
-- Always one row: INVALID (a kind, outcome, reference or field outside the rules: nothing
-- stored), UNKNOWN (no institute has this slug: nothing stored), NO_INTENT (a payer's return for
-- a tran_id this institute never made: nothing stored, the browser goes to the child list) or
-- RECORDED (the event's id, its institute, and the intent and child when it named one; an IPN
-- naming no intent is stored with none, for the unmatched check).
CREATE FUNCTION payment_signal_record(
  p_slug text,
  p_kind text,
  p_tran_id text,
  p_outcome text,
  p_val_id text,
  p_fields jsonb,
  p_source_listed boolean,
  p_now timestamptz
)
RETURNS TABLE (result text, tenant_id uuid, event_id uuid, intent_id uuid, student_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
-- The result columns (tenant_id, intent_id, student_id) are also table columns: names in the
-- queries below always mean the columns.
#variable_conflict use_column
DECLARE
  v_tenant uuid;
  v_intent uuid;
  v_student uuid;
  v_event uuid;
  c_null CONSTANT uuid := NULL;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('RETURN', 'IPN') OR p_now IS NULL
     OR p_slug IS NULL OR p_source_listed IS NULL
     OR p_tran_id IS NULL OR p_tran_id !~ '^[A-Za-z0-9_.-]{1,50}$'
     OR (p_val_id IS NOT NULL AND p_val_id !~ '^[A-Za-z0-9_.-]{1,50}$')
     -- A return's outcome is the word of its path, and its tran_id is ours; an IPN has none
     -- (its status is in the fields).
     OR (p_kind = 'RETURN' AND (p_outcome IS NULL OR p_outcome NOT IN ('SUCCESS', 'FAIL', 'CANCEL')
                                OR p_tran_id !~ '^JS[0-9A-HJKMNP-TV-Z]{26}$'))
     OR (p_kind = 'IPN' AND p_outcome IS NOT NULL)
     OR NOT public.payment_event_fields_ok(p_fields) THEN
    RETURN QUERY SELECT 'INVALID'::text, c_null, c_null, c_null, c_null;
    RETURN;
  END IF;

  SELECT t.id INTO v_tenant FROM public.tenants t WHERE t.slug = p_slug;
  IF v_tenant IS NULL THEN
    RETURN QUERY SELECT 'UNKNOWN'::text, c_null, c_null, c_null, c_null;
    RETURN;
  END IF;

  -- This institute's intents only: another institute's tran_id is simply not found here.
  SELECT i.id, i.student_id INTO v_intent, v_student
  FROM public.payment_intents i
  WHERE i.tenant_id = v_tenant AND i.tran_id = p_tran_id;
  IF v_intent IS NULL AND p_kind = 'RETURN' THEN
    RETURN QUERY SELECT 'NO_INTENT'::text, c_null, c_null, c_null, c_null;
    RETURN;
  END IF;

  v_event := gen_random_uuid();
  INSERT INTO public.payment_gateway_events
    (id, tenant_id, intent_id, kind, outcome, tran_id, val_id, fields, source_listed,
     received_at, created_at, updated_at)
  VALUES
    (v_event, v_tenant, v_intent, p_kind::public.payment_event_kind, p_outcome, p_tran_id,
     p_val_id, p_fields, p_source_listed, p_now, p_now, p_now);
  RETURN QUERY SELECT 'RECORDED'::text, v_tenant, v_event, v_intent, v_student;
END $$;

-- ─────────────────────────── Privileges ───────────────────────────
-- Before OWNER TO: only a function's owner can change its privileges. jantrik_app (the API's
-- public routes) runs it; nobody else (not PUBLIC, not the platform, receiver or login logins).
REVOKE ALL ON FUNCTION payment_signal_record(text, text, text, text, text, jsonb, boolean, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION payment_signal_record(text, text, text, text, text, jsonb, boolean, timestamptz) TO jantrik_app;
ALTER FUNCTION payment_signal_record(text, text, text, text, text, jsonb, boolean, timestamptz) OWNER TO jantrik_payments;

-- The new owner needed CREATE on the schema only to take the function over.
REVOKE CREATE ON SCHEMA public FROM jantrik_payments;

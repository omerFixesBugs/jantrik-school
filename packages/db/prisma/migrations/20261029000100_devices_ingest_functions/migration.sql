-- Step 11, part A2: the device receiver's four functions. See docs/database.md → Devices.
-- The receiver (login jantrik_ingest_app) has no table grants: everything it does goes through
-- these. They are owned by jantrik_ingest, which has no tenant context and sees every institute's
-- rows through its `TO jantrik_ingest` policies, so each function takes only the device's serial
-- number, resolves it itself, and scopes every query by that device's own (tenant_id, id). No
-- tenant or device id is ever a parameter. Times come from the caller (`p_now`, the receiver's
-- clock), never now().

-- ─────────────────────────── Helpers ───────────────────────────
-- Only the functions below call them (as jantrik_ingest); they run as their caller.

-- A time-ordered id like Prisma's uuid(7): the instant's Unix milliseconds in the first 48 bits,
-- version 7, the RFC 4122 variant, the rest random (from gen_random_uuid()).
CREATE FUNCTION ingest_uuid7(p_at timestamptz) RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  b bytea := uuid_send(gen_random_uuid());
BEGIN
  b := overlay(b PLACING substring(int8send(floor(extract(epoch FROM p_at) * 1000)::bigint) FROM 3)
               FROM 1 FOR 6);
  b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112);  -- version 7
  b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128);  -- variant 10
  RETURN encode(b, 'hex')::uuid;
END $$;

-- The active device a serial number names, or why it is refused: UNKNOWN (no such device, or not
-- a serial at all), INACTIVE (only deactivated copies), INSTITUTE_INACTIVE (not ACTIVE or TRIAL),
-- MODULE_OFF (ATTENDANCE missing or off). Always one row; the ids are NULL when refused.
CREATE FUNCTION ingest_find_device(p_sn text)
RETURNS TABLE (refusal text, device_id uuid, tenant_id uuid)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_sn text := upper(p_sn);
  v_device uuid;
  v_tenant uuid;
BEGIN
  IF v_sn IS NULL OR v_sn !~ '^[A-Z0-9]{6,32}$' THEN
    refusal := 'UNKNOWN';
  ELSE
    -- At most one: the partial unique index on serial_no WHERE is_active.
    SELECT d.id, d.tenant_id INTO v_device, v_tenant
    FROM public.attendance_devices d
    WHERE d.serial_no = v_sn AND d.is_active;
    IF v_device IS NULL THEN
      refusal := CASE WHEN EXISTS (SELECT 1 FROM public.attendance_devices d
                                   WHERE d.serial_no = v_sn)
                      THEN 'INACTIVE' ELSE 'UNKNOWN' END;
    ELSIF NOT EXISTS (SELECT 1 FROM public.tenants t
                      WHERE t.id = v_tenant AND t.status IN ('ACTIVE', 'TRIAL')) THEN
      refusal := 'INSTITUTE_INACTIVE';
    ELSIF NOT EXISTS (SELECT 1 FROM public.tenant_modules m
                      WHERE m.tenant_id = v_tenant AND m.module_key = 'ATTENDANCE'
                        AND m.enabled) THEN
      refusal := 'MODULE_OFF';
    ELSE
      device_id := v_device;
      tenant_id := v_tenant;
    END IF;
  END IF;
  RETURN NEXT;
END $$;

-- ─────────────────────────── The receiver's functions ───────────────────────────

-- Every request starts here. Always one row: refused (`accepted` false, the code, the rest NULL,
-- nothing written) or the device, its institute's zone, hours and per-minute cap (the defaults
-- when the institute has no settings row) and when it was last seen before this call, which this
-- call then records with the address and whatever device info came with it.
CREATE FUNCTION ingest_resolve(p_sn text, p_ip inet, p_now timestamptz, p_firmware text,
                               p_user_count int, p_push_version text)
RETURNS TABLE (accepted boolean, refusal text, device_id uuid, tenant_id uuid, time_zone text,
               direction device_direction, attlog_stamp text, clock_offset_sec int,
               clock_samples int[], registered_on date, hours_start time, hours_end time,
               max_per_minute int, previous_seen_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  f record;
BEGIN
  SELECT * INTO f FROM public.ingest_find_device(p_sn);
  accepted := f.refusal IS NULL;
  refusal := f.refusal;
  IF accepted THEN
    SELECT d.id, d.tenant_id, t.timezone, d.direction, d.attlog_stamp, d.clock_offset_sec,
           d.clock_samples, (d.created_at AT TIME ZONE t.timezone)::date,
           coalesce(s.device_hours_start, '05:00'), coalesce(s.device_hours_end, '20:00'),
           coalesce(s.device_max_punches_per_minute, 60), d.last_seen_at
    INTO device_id, tenant_id, time_zone, direction, attlog_stamp, clock_offset_sec,
         clock_samples, registered_on, hours_start, hours_end, max_per_minute, previous_seen_at
    FROM public.attendance_devices d
    JOIN public.tenants t ON t.id = d.tenant_id
    LEFT JOIN public.attendance_settings s ON s.tenant_id = d.tenant_id
    WHERE d.tenant_id = f.tenant_id AND d.id = f.device_id
    FOR NO KEY UPDATE OF d;
    UPDATE public.attendance_devices d
    SET last_seen_at = p_now,
        last_ip = p_ip,
        firmware = coalesce(p_firmware, d.firmware),
        user_count = coalesce(p_user_count, d.user_count),
        push_version = coalesce(p_push_version, d.push_version)
    WHERE d.tenant_id = f.tenant_id AND d.id = f.device_id;
  END IF;
  RETURN NEXT;
END $$;

-- One ATTLOG upload. `p_rows` (at most 10000, in the device's order) carry what the receiver
-- computed with the shared rules (packages/shared/src/devices.ts); the table's CHECKs validate
-- them. This adds the ids, received_at, the source address (NEW_IP) and the per-minute cap: with N
-- the institute's cap and c this device's punches already stored in the row's minute (this
-- upload's included), c >= 5N drops the row and N <= c < 5N stores it as BURST (held). A punch
-- already stored is a duplicate: counted, not stored again, and not counted against the cap twice.
-- Zero rows when the serial is refused.
CREATE FUNCTION ingest_store_punches(p_sn text, p_ip inet, p_now timestamptz, p_rows jsonb,
                                     p_stamp text, p_clock_samples int[], p_clock_offset int)
RETURNS TABLE (tenant_id uuid, inserted int, duplicates int, held int, dropped int)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  f record;
  r record;
  v_cap int;
  v_ip_known boolean := false;  -- the address has a row
  v_ip_trusted boolean := true; -- no address (p_ip NULL) flags nothing
  v_minute timestamp;
  v_in_minute int;              -- the device's punches stored in v_minute, this upload's included
  v_flags text[];
  v_last timestamptz;
  v_inserted int := 0;
  v_duplicates int := 0;
  v_held int := 0;
  v_dropped int := 0;
BEGIN
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'INGEST_BAD_ROWS';
  END IF;
  IF jsonb_array_length(p_rows) > 10000 THEN
    RAISE EXCEPTION 'INGEST_TOO_MANY_ROWS';
  END IF;
  SELECT * INTO f FROM public.ingest_find_device(p_sn);
  IF f.refusal IS NOT NULL THEN
    RETURN;
  END IF;

  -- One upload per device at a time: the minute counts and "the first address" depend on it.
  PERFORM 1 FROM public.attendance_devices d
  WHERE d.tenant_id = f.tenant_id AND d.id = f.device_id
  FOR NO KEY UPDATE;
  v_cap := coalesce((SELECT s.device_max_punches_per_minute FROM public.attendance_settings s
                     WHERE s.tenant_id = f.tenant_id), 60);

  -- The first address a device ever uploads from is trusted; punches from any address an admin
  -- has not trusted get NEW_IP and the address.
  IF p_ip IS NOT NULL THEN
    SELECT true, i.trusted_at IS NOT NULL INTO v_ip_known, v_ip_trusted
    FROM public.device_source_ips i
    WHERE i.tenant_id = f.tenant_id AND i.device_id = f.device_id AND i.ip = p_ip;
    IF NOT FOUND THEN
      v_ip_known := false;
      v_ip_trusted := NOT EXISTS (SELECT 1 FROM public.device_source_ips i
                                  WHERE i.tenant_id = f.tenant_id AND i.device_id = f.device_id);
    END IF;
  END IF;

  FOR r IN
    SELECT x.*
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS e(value, ord)
    CROSS JOIN LATERAL jsonb_to_record(e.value) AS x(
      device_user_id text, device_time timestamp, punched_at timestamptz, local_date date,
      verify_type smallint, state smallint, direction punch_direction, flags text[])
    ORDER BY e.ord
  LOOP
    IF EXISTS (SELECT 1 FROM public.device_punches p
               WHERE p.tenant_id = f.tenant_id AND p.device_id = f.device_id
                 AND p.device_user_id = r.device_user_id AND p.device_time = r.device_time) THEN
      v_duplicates := v_duplicates + 1;
      CONTINUE;
    END IF;
    -- Uploads come in time order, so each minute is counted once.
    IF v_minute IS DISTINCT FROM date_trunc('minute', r.device_time) THEN
      v_minute := date_trunc('minute', r.device_time);
      SELECT count(*) INTO v_in_minute
      FROM public.device_punches p
      WHERE p.tenant_id = f.tenant_id AND p.device_id = f.device_id
        AND p.device_time >= v_minute AND p.device_time < v_minute + interval '1 minute';
    END IF;
    IF v_in_minute >= 5 * v_cap THEN
      v_dropped := v_dropped + 1;
      CONTINUE;
    END IF;
    v_flags := coalesce(r.flags, '{}');
    IF NOT v_ip_trusted AND array_position(v_flags, 'NEW_IP') IS NULL THEN
      v_flags := v_flags || 'NEW_IP'::text;
    END IF;
    IF v_in_minute >= v_cap AND array_position(v_flags, 'BURST') IS NULL THEN
      v_flags := v_flags || 'BURST'::text;
    END IF;
    INSERT INTO public.device_punches (id, tenant_id, device_id, device_user_id, device_time,
                                       punched_at, local_date, received_at, verify_type, state,
                                       direction, flags, source_ip)
    VALUES (public.ingest_uuid7(p_now), f.tenant_id, f.device_id, r.device_user_id,
            r.device_time, r.punched_at, r.local_date, p_now, r.verify_type, r.state,
            r.direction, v_flags, CASE WHEN NOT v_ip_trusted THEN p_ip END)
    ON CONFLICT (tenant_id, device_id, device_user_id, device_time) DO NOTHING;
    IF FOUND THEN
      v_inserted := v_inserted + 1;
      IF v_in_minute >= v_cap THEN
        v_held := v_held + 1;
      END IF;
      v_in_minute := v_in_minute + 1;
      v_last := greatest(v_last, r.punched_at);
    ELSE
      v_duplicates := v_duplicates + 1;
    END IF;
  END LOOP;

  IF p_ip IS NOT NULL THEN
    IF v_ip_known THEN
      UPDATE public.device_source_ips i
      SET last_seen_at = p_now, punch_count = i.punch_count + v_inserted
      WHERE i.tenant_id = f.tenant_id AND i.device_id = f.device_id AND i.ip = p_ip;
    -- At most 50 untrusted addresses per device; punches from later ones are still flagged.
    ELSIF v_ip_trusted OR (SELECT count(*) FROM public.device_source_ips i
                           WHERE i.tenant_id = f.tenant_id AND i.device_id = f.device_id
                             AND i.trusted_at IS NULL) < 50 THEN
      INSERT INTO public.device_source_ips (id, tenant_id, device_id, ip, first_seen_at,
                                            last_seen_at, punch_count, trusted_at)
      VALUES (public.ingest_uuid7(p_now), f.tenant_id, f.device_id, p_ip, p_now, p_now,
              v_inserted, CASE WHEN v_ip_trusted THEN p_now END);
    END IF;
  END IF;

  -- A stamp of 0 would ask the device for its whole history again.
  UPDATE public.attendance_devices d
  SET attlog_stamp = CASE WHEN p_stamp ~ '^[0-9A-Za-z]{1,32}$' AND p_stamp <> '0' THEN p_stamp
                          ELSE d.attlog_stamp END,
      last_punch_at = greatest(d.last_punch_at, v_last),
      clock_samples = p_clock_samples,
      clock_offset_sec = p_clock_offset,
      last_flood_at = CASE WHEN v_dropped > 0 THEN p_now ELSE d.last_flood_at END,
      last_flood_dropped = CASE WHEN v_dropped > 0 THEN v_dropped ELSE d.last_flood_dropped END
  WHERE d.tenant_id = f.tenant_id AND d.id = f.device_id;

  RETURN QUERY SELECT f.tenant_id, v_inserted, v_duplicates, v_held, v_dropped;
END $$;

-- The device's next commands (at most least(p_max, 50), in seq order): PENDING ones, and SENT
-- ones unanswered for 5 minutes, up to 5 attempts; they become SENT. A command sent 5 times and
-- unanswered for 5 minutes becomes FAILED first. No rows when the serial is refused.
CREATE FUNCTION ingest_take_commands(p_sn text, p_now timestamptz, p_max int)
RETURNS TABLE (seq bigint, payload text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  f record;
BEGIN
  SELECT * INTO f FROM public.ingest_find_device(p_sn);
  IF f.refusal IS NOT NULL THEN
    RETURN;
  END IF;
  UPDATE public.device_commands c
  SET status = 'FAILED'
  WHERE c.tenant_id = f.tenant_id AND c.device_id = f.device_id AND c.status = 'SENT'
    AND c.attempts >= 5 AND c.sent_at < p_now - interval '5 minutes';
  RETURN QUERY
  WITH due AS (
    SELECT c.id
    FROM public.device_commands c
    WHERE c.tenant_id = f.tenant_id AND c.device_id = f.device_id
      AND (c.status = 'PENDING'
           OR (c.status = 'SENT' AND c.sent_at < p_now - interval '5 minutes'
               AND c.attempts < 5))
    ORDER BY c.seq
    LIMIT greatest(least(p_max, 50), 0)
    FOR UPDATE SKIP LOCKED
  ), sent AS (
    UPDATE public.device_commands c
    SET status = 'SENT', attempts = c.attempts + 1, sent_at = p_now
    FROM due
    WHERE c.tenant_id = f.tenant_id AND c.device_id = f.device_id AND c.id = due.id
    RETURNING c.seq, c.payload
  )
  SELECT s.seq, s.payload FROM sent s ORDER BY s.seq;
END $$;

-- The device's answers (`p_results`: at most 200 of {id: seq, return_code}). Only this device's
-- SENT or PENDING commands change: return code 0 is DONE, anything else FAILED. Returns how many
-- changed (0 when the serial is refused).
CREATE FUNCTION ingest_command_results(p_sn text, p_now timestamptz, p_results jsonb)
RETURNS int
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  f record;
  v_count int;
BEGIN
  IF jsonb_typeof(p_results) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'INGEST_BAD_RESULTS';
  END IF;
  IF jsonb_array_length(p_results) > 200 THEN
    RAISE EXCEPTION 'INGEST_TOO_MANY_RESULTS';
  END IF;
  SELECT * INTO f FROM public.ingest_find_device(p_sn);
  IF f.refusal IS NOT NULL THEN
    RETURN 0;
  END IF;
  UPDATE public.device_commands c
  SET status = (CASE WHEN x.return_code = 0 THEN 'DONE' ELSE 'FAILED' END)::device_command_status,
      return_code = x.return_code,
      done_at = p_now
  FROM jsonb_to_recordset(p_results) AS x(id bigint, return_code int)
  WHERE c.tenant_id = f.tenant_id AND c.device_id = f.device_id AND c.seq = x.id
    AND c.status IN ('SENT', 'PENDING');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- ─────────────────────────── Privileges ───────────────────────────
-- Before OWNER TO: only a function's owner can change its privileges. The receiver's login runs
-- the four functions; nobody runs the helpers but jantrik_ingest itself, inside them.
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'ingest_resolve(text, inet, timestamptz, text, integer, text)',
    'ingest_store_punches(text, inet, timestamptz, jsonb, text, integer[], integer)',
    'ingest_take_commands(text, timestamptz, integer)',
    'ingest_command_results(text, timestamptz, jsonb)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO jantrik_ingest_app', f);
    EXECUTE format('ALTER FUNCTION %s OWNER TO jantrik_ingest', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['ingest_uuid7(timestamptz)', 'ingest_find_device(text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('ALTER FUNCTION %s OWNER TO jantrik_ingest', f);
  END LOOP;
END $$;

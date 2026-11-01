-- Step 11, part A2, after review: commands only to trusted addresses, and set-based uploads.
--   * ingest_resolve records the address a request comes from (the device's first address ever is
--     trusted, any later one waits for an admin; at most 50 untrusted per device) and returns
--     `ip_trusted`. Knowing a serial number is not enough to take a device's commands or answer
--     them: ingest_take_commands and ingest_command_results now take the caller's address and do
--     nothing for an address the device has not trusted.
--   * ingest_store_punches records the address the same way (one helper), and decides every row
--     in one statement instead of a loop of per-row queries (one 10 000-row upload took minutes
--     in the receiver's tests; a cached per-row plan does not follow a table growing under it).
--     The rules are unchanged.
--   * ingest_store_punches skips an upload whose device was deactivated while it waited for the
--     device lock.
-- The functions belong to jantrik_ingest: drop and create them as that role. Privileges are set
-- by their owner, so they hold.

SET ROLE jantrik_ingest;

-- New result column (resolve) and new parameter (take, results): drop + create.
DROP FUNCTION ingest_resolve(text, inet, timestamptz, text, integer, text);
DROP FUNCTION ingest_take_commands(text, timestamptz, integer);
DROP FUNCTION ingest_command_results(text, timestamptz, jsonb);

-- ─────────────────────────── Helper ───────────────────────────

-- Records the address a request of the device `p_sn` names came from, and says whether the device
-- trusts it. The caller has resolved and locked the device. The first address a device ever uses
-- is trusted; any other one is recorded untrusted while the device has fewer than 50 of those, and
-- stays untrusted either way until an admin trusts it. No address: nothing recorded, not trusted.
CREATE FUNCTION ingest_note_address(p_sn text, p_ip inet, p_now timestamptz) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  f record;
  v_trusted boolean;
BEGIN
  SELECT * INTO f FROM public.ingest_find_device(p_sn);
  IF f.refusal IS NOT NULL OR p_ip IS NULL THEN
    RETURN false;
  END IF;
  SELECT i.trusted_at IS NOT NULL INTO v_trusted
  FROM public.device_source_ips i
  WHERE i.tenant_id = f.tenant_id AND i.device_id = f.device_id AND i.ip = p_ip;
  IF FOUND THEN
    UPDATE public.device_source_ips i
    SET last_seen_at = p_now
    WHERE i.tenant_id = f.tenant_id AND i.device_id = f.device_id AND i.ip = p_ip;
    RETURN v_trusted;
  END IF;
  v_trusted := NOT EXISTS (SELECT 1 FROM public.device_source_ips i
                           WHERE i.tenant_id = f.tenant_id AND i.device_id = f.device_id);
  IF v_trusted OR (SELECT count(*) FROM public.device_source_ips i
                   WHERE i.tenant_id = f.tenant_id AND i.device_id = f.device_id
                     AND i.trusted_at IS NULL) < 50 THEN
    INSERT INTO public.device_source_ips (id, tenant_id, device_id, ip, first_seen_at,
                                          last_seen_at, punch_count, trusted_at)
    VALUES (public.ingest_uuid7(p_now), f.tenant_id, f.device_id, p_ip, p_now, p_now, 0,
            CASE WHEN v_trusted THEN p_now END);
  END IF;
  RETURN v_trusted;
END $$;

-- ─────────────────────────── The receiver's functions ───────────────────────────

-- Every request starts here. Always one row: refused (`accepted` false, the code, the rest NULL,
-- nothing written) or the device, its institute's zone, hours and per-minute cap (the defaults
-- when the institute has no settings row), when it was last seen before this call, and whether
-- the caller's address is one the device trusts. It then records the visit, the address and
-- whatever device info came with it.
CREATE FUNCTION ingest_resolve(p_sn text, p_ip inet, p_now timestamptz, p_firmware text,
                               p_user_count int, p_push_version text)
RETURNS TABLE (accepted boolean, refusal text, device_id uuid, tenant_id uuid, time_zone text,
               direction device_direction, attlog_stamp text, clock_offset_sec int,
               clock_samples int[], registered_on date, hours_start time, hours_end time,
               max_per_minute int, previous_seen_at timestamptz, ip_trusted boolean)
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
    ip_trusted := public.ingest_note_address(p_sn, p_ip, p_now);
  END IF;
  RETURN NEXT;
END $$;

-- One ATTLOG upload. `p_rows` (at most 10000, in the device's order) carry what the receiver
-- computed with the shared rules (packages/shared/src/devices.ts); the table's CHECKs validate
-- them. This adds the ids, received_at, the source address (NEW_IP) and the per-minute cap: with N
-- the institute's cap and c this device's punches already stored in the row's minute (this
-- upload's earlier rows included), c >= 5N drops the row and N <= c < 5N stores it as BURST
-- (held). A punch already stored is a duplicate: counted, not stored again, and not counted
-- against the cap twice. Zero rows when the serial is refused.
CREATE OR REPLACE FUNCTION ingest_store_punches(p_sn text, p_ip inet, p_now timestamptz,
                                                p_rows jsonb, p_stamp text, p_clock_samples int[],
                                                p_clock_offset int)
RETURNS TABLE (tenant_id uuid, inserted int, duplicates int, held int, dropped int)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  f record;
  v_cap int;
  v_new_ip boolean;
  v_inserted int;
  v_duplicates int;
  v_held int;
  v_dropped int;
  v_last timestamptz;
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

  -- One upload per device at a time (the minute counts and "the first address" depend on it),
  -- and none for a device deactivated meanwhile.
  PERFORM 1 FROM public.attendance_devices d
  WHERE d.tenant_id = f.tenant_id AND d.id = f.device_id AND d.is_active
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  v_cap := coalesce((SELECT s.device_max_punches_per_minute FROM public.attendance_settings s
                     WHERE s.tenant_id = f.tenant_id), 60);
  -- Punches from an address the device does not trust get NEW_IP and the address.
  v_new_ip := p_ip IS NOT NULL AND NOT public.ingest_note_address(p_sn, p_ip, p_now);

  -- Each row's fate, as processing the upload in its order gives it, decided in one statement:
  --   * already stored by an earlier upload: a duplicate;
  --   * the first copy in this upload: c = the device's punches stored in its minute + the first
  --     copies before it in that minute; c >= 5N drops it, N <= c < 5N stores it with BURST;
  --   * a later copy in this upload: a duplicate of the first, or dropped with it.
  -- device_time is read as timestamp(0), as the column stores it, so equal times match.
  WITH r AS (
    SELECT e.ord, x.device_user_id, x.device_time, x.punched_at, x.local_date, x.verify_type,
           x.state, x.direction, coalesce(x.flags, '{}') AS flags,
           date_trunc('minute', x.device_time) AS minute
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS e(value, ord)
    CROSS JOIN LATERAL jsonb_to_record(e.value) AS x(
      device_user_id text, device_time timestamp(0), punched_at timestamptz, local_date date,
      verify_type smallint, state smallint, direction punch_direction, flags text[])
  ), per_minute AS (
    -- One range scan of the device's punches over the upload's minutes.
    SELECT date_trunc('minute', p.device_time) AS minute, count(*) AS stored
    FROM public.device_punches p
    WHERE p.tenant_id = f.tenant_id AND p.device_id = f.device_id
      AND p.device_time >= (SELECT min(r.minute) FROM r)
      AND p.device_time < (SELECT max(r.minute) FROM r) + interval '1 minute'
    GROUP BY 1
  ), seen AS (
    SELECT r.*, coalesce(pm.stored, 0) AS stored,
           p.device_time IS NOT NULL AS stored_before,
           row_number() OVER (PARTITION BY r.device_user_id, r.device_time ORDER BY r.ord) AS copy
    FROM r
    LEFT JOIN per_minute pm ON pm.minute = r.minute
    LEFT JOIN public.device_punches p
      ON p.tenant_id = f.tenant_id AND p.device_id = f.device_id
     AND p.device_user_id = r.device_user_id AND p.device_time = r.device_time
  ), counted AS (
    SELECT s.*,
           CASE WHEN NOT s.stored_before AND s.copy = 1
                THEN s.stored - 1 + count(*) FILTER (WHERE NOT s.stored_before AND s.copy = 1)
                                      OVER (PARTITION BY s.minute ORDER BY s.ord) END AS in_minute
    FROM seen s
  ), fate AS (
    SELECT k.*,
           CASE WHEN k.stored_before THEN 'DUPLICATE'
                WHEN max(k.in_minute) OVER (PARTITION BY k.device_user_id, k.device_time)
                       >= 5 * v_cap THEN 'DROPPED'
                WHEN k.copy > 1 THEN 'DUPLICATE'
                ELSE 'STORE' END AS fate
    FROM counted k
  ), ins AS (
    INSERT INTO public.device_punches (id, tenant_id, device_id, device_user_id, device_time,
                                       punched_at, local_date, received_at, verify_type, state,
                                       direction, flags, source_ip)
    SELECT public.ingest_uuid7(p_now), f.tenant_id, f.device_id, o.device_user_id, o.device_time,
           o.punched_at, o.local_date, p_now, o.verify_type, o.state, o.direction,
           o.flags
             || CASE WHEN v_new_ip AND array_position(o.flags, 'NEW_IP') IS NULL
                     THEN ARRAY['NEW_IP'] ELSE '{}'::text[] END
             || CASE WHEN o.in_minute >= v_cap AND array_position(o.flags, 'BURST') IS NULL
                     THEN ARRAY['BURST'] ELSE '{}'::text[] END,
           CASE WHEN v_new_ip THEN p_ip END
    FROM fate o
    WHERE o.fate = 'STORE'
    ORDER BY o.ord
    ON CONFLICT (tenant_id, device_id, device_user_id, device_time) DO NOTHING
    RETURNING device_user_id, device_time
  )
  -- A row the insert skipped after all (ON CONFLICT) is a duplicate.
  SELECT count(*) FILTER (WHERE i.device_time IS NOT NULL),
         count(*) FILTER (WHERE i.device_time IS NOT NULL AND o.in_minute >= v_cap),
         count(*) FILTER (WHERE o.fate = 'DUPLICATE'
                             OR (o.fate = 'STORE' AND i.device_time IS NULL)),
         count(*) FILTER (WHERE o.fate = 'DROPPED'),
         max(o.punched_at) FILTER (WHERE i.device_time IS NOT NULL)
  INTO v_inserted, v_held, v_duplicates, v_dropped, v_last
  FROM fate o
  LEFT JOIN ins i
    ON o.fate = 'STORE' AND i.device_user_id = o.device_user_id AND i.device_time = o.device_time;

  IF v_inserted > 0 AND p_ip IS NOT NULL THEN
    UPDATE public.device_source_ips i
    SET punch_count = i.punch_count + v_inserted
    WHERE i.tenant_id = f.tenant_id AND i.device_id = f.device_id AND i.ip = p_ip;
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

-- The device's next commands (at most least(p_max, 50), in seq order), only for an address the
-- device trusts: PENDING ones, and SENT ones unanswered for 5 minutes, up to 5 attempts; they
-- become SENT. A command sent 5 times and unanswered for 5 minutes becomes FAILED first. No rows,
-- and nothing changed, for a refused serial or an untrusted (or no) address.
CREATE FUNCTION ingest_take_commands(p_sn text, p_ip inet, p_now timestamptz, p_max int)
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
  IF NOT EXISTS (SELECT 1 FROM public.device_source_ips i
                 WHERE i.tenant_id = f.tenant_id AND i.device_id = f.device_id AND i.ip = p_ip
                   AND i.trusted_at IS NOT NULL) THEN
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

-- The device's answers (`p_results`: at most 200 of {id: seq, return_code}), only from an address
-- the device trusts. Only this device's SENT or PENDING commands change: return code 0 is DONE,
-- anything else FAILED. Returns how many changed (0 for a refused serial or an untrusted address).
CREATE FUNCTION ingest_command_results(p_sn text, p_ip inet, p_now timestamptz, p_results jsonb)
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
  IF NOT EXISTS (SELECT 1 FROM public.device_source_ips i
                 WHERE i.tenant_id = f.tenant_id AND i.device_id = f.device_id AND i.ip = p_ip
                   AND i.trusted_at IS NOT NULL) THEN
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
-- Created by jantrik_ingest, so its own REVOKE and GRANT hold. ingest_store_punches was replaced
-- in place and keeps its privileges.
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'ingest_resolve(text, inet, timestamptz, text, integer, text)',
    'ingest_take_commands(text, inet, timestamptz, integer)',
    'ingest_command_results(text, inet, timestamptz, jsonb)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO jantrik_ingest_app', f);
  END LOOP;
  REVOKE ALL ON FUNCTION ingest_note_address(text, inet, timestamptz) FROM PUBLIC;
END $$;

RESET ROLE;

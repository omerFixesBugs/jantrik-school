-- Step 11, part A2, second review: harder to take over a device's trusted addresses.
--   * A device's first address is trusted automatically only on its first contact, within 24
--     hours of its registration, while it has no trusted address; any other first address waits
--     for an admin like every later one (NEW_IP).
--   * At most 50 untrusted addresses per device, as before, but a new one now makes room by
--     evicting the least recently seen untrusted one: an attacker cannot fill the list so that the
--     school's real new address is never recorded (and so never trusted). Trusted rows are never
--     deleted (jantrik_ingest may delete untrusted rows only).
--   * ingest_find_device locks the device row it finds, so the institute checks, the address and
--     every write of the call are about that one device, which cannot be deactivated (or its
--     serial number given to another device) until the call ends. ingest_find_device_at (replacing
--     ingest_note_address) records the address against the device it locked, without looking the
--     serial number up again.

-- ─────────────────────────── jantrik_ingest ───────────────────────────
-- May delete a device's untrusted addresses (to make room), never a trusted one.
GRANT DELETE ON device_source_ips TO jantrik_ingest;
CREATE POLICY ingest_delete ON device_source_ips FOR DELETE TO jantrik_ingest
  USING (trusted_at IS NULL);

-- The functions belong to jantrik_ingest: replace them as that role (privileges are kept).
SET ROLE jantrik_ingest;

DROP FUNCTION ingest_note_address(text, inet, timestamptz);

-- ─────────────────────────── Helpers ───────────────────────────

-- The active device a serial number names, locked until the call ends, or why it is refused:
-- UNKNOWN (no such device, or not a serial at all), INACTIVE (only deactivated copies),
-- INSTITUTE_INACTIVE (not ACTIVE or TRIAL), MODULE_OFF (ATTENDANCE missing or off). Always one row;
-- the ids are NULL when refused. The lock is taken by the lookup itself, so the serial number and
-- is_active are checked again on the locked row (a deactivation that commits meanwhile refuses
-- the call), and the institute checks come after it.
CREATE OR REPLACE FUNCTION ingest_find_device(p_sn text)
RETURNS TABLE (refusal text, device_id uuid, tenant_id uuid)
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp AS $$
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
    WHERE d.serial_no = v_sn AND d.is_active
    FOR NO KEY UPDATE;
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

-- ingest_find_device, and the address the request came from, recorded against the device it
-- locked; `ip_trusted` says whether the device trusts it (false without an address, NULL when
-- refused). A new address is trusted only on the device's first contact (never seen before this
-- call), within 24 hours of its registration, while it has no trusted address; otherwise it is
-- recorded untrusted until an admin trusts it. At most 50 untrusted addresses per device: a new
-- one evicts the least recently seen untrusted ones. Trusted rows are never deleted.
CREATE FUNCTION ingest_find_device_at(p_sn text, p_ip inet, p_now timestamptz)
RETURNS TABLE (refusal text, device_id uuid, tenant_id uuid, ip_trusted boolean)
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  f record;
  v_trusted boolean;
BEGIN
  SELECT * INTO f FROM public.ingest_find_device(p_sn);
  refusal := f.refusal;
  IF f.refusal IS NOT NULL THEN
    RETURN NEXT;
    RETURN;
  END IF;
  device_id := f.device_id;
  tenant_id := f.tenant_id;
  ip_trusted := false;
  IF p_ip IS NULL THEN
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT i.trusted_at IS NOT NULL INTO v_trusted
  FROM public.device_source_ips i
  WHERE i.tenant_id = f.tenant_id AND i.device_id = f.device_id AND i.ip = p_ip;
  IF FOUND THEN
    UPDATE public.device_source_ips i
    SET last_seen_at = p_now
    WHERE i.tenant_id = f.tenant_id AND i.device_id = f.device_id AND i.ip = p_ip;
    ip_trusted := v_trusted;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT d.last_seen_at IS NULL AND p_now - d.created_at <= interval '24 hours'
         AND NOT EXISTS (SELECT 1 FROM public.device_source_ips i
                         WHERE i.tenant_id = f.tenant_id AND i.device_id = f.device_id
                           AND i.trusted_at IS NOT NULL)
  INTO v_trusted
  FROM public.attendance_devices d
  WHERE d.tenant_id = f.tenant_id AND d.id = f.device_id;
  IF NOT v_trusted THEN
    -- Keep the 49 most recently seen untrusted addresses, so this one makes 50.
    DELETE FROM public.device_source_ips i
    WHERE i.tenant_id = f.tenant_id AND i.device_id = f.device_id AND i.trusted_at IS NULL
      AND i.id IN (SELECT j.id FROM public.device_source_ips j
                   WHERE j.tenant_id = f.tenant_id AND j.device_id = f.device_id
                     AND j.trusted_at IS NULL
                   ORDER BY j.last_seen_at DESC, j.id DESC
                   OFFSET 49);
  END IF;
  INSERT INTO public.device_source_ips (id, tenant_id, device_id, ip, first_seen_at,
                                        last_seen_at, punch_count, trusted_at)
  VALUES (public.ingest_uuid7(p_now), f.tenant_id, f.device_id, p_ip, p_now, p_now, 0,
          CASE WHEN v_trusted THEN p_now END);
  ip_trusted := v_trusted;
  RETURN NEXT;
END $$;

-- ─────────────────────────── The receiver's functions ───────────────────────────

-- Every request starts here. Always one row: refused (`accepted` false, the code, the rest NULL,
-- nothing written) or the device, its institute's zone, hours and per-minute cap (the defaults
-- when the institute has no settings row), when it was last seen before this call, and whether
-- the caller's address is one the device trusts. It then records the visit, the address and
-- whatever device info came with it.
CREATE OR REPLACE FUNCTION ingest_resolve(p_sn text, p_ip inet, p_now timestamptz,
                                          p_firmware text, p_user_count int,
                                          p_push_version text)
RETURNS TABLE (accepted boolean, refusal text, device_id uuid, tenant_id uuid, time_zone text,
               direction device_direction, attlog_stamp text, clock_offset_sec int,
               clock_samples int[], registered_on date, hours_start time, hours_end time,
               max_per_minute int, previous_seen_at timestamptz, ip_trusted boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  f record;
BEGIN
  -- Locks the device; reads its last visit before this one's is written below.
  SELECT * INTO f FROM public.ingest_find_device_at(p_sn, p_ip, p_now);
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
    WHERE d.tenant_id = f.tenant_id AND d.id = f.device_id;
    UPDATE public.attendance_devices d
    SET last_seen_at = p_now,
        last_ip = p_ip,
        firmware = coalesce(p_firmware, d.firmware),
        user_count = coalesce(p_user_count, d.user_count),
        push_version = coalesce(p_push_version, d.push_version)
    WHERE d.tenant_id = f.tenant_id AND d.id = f.device_id;
    ip_trusted := f.ip_trusted;
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
  -- Locks the device: one upload per device at a time (the minute counts depend on it).
  SELECT * INTO f FROM public.ingest_find_device_at(p_sn, p_ip, p_now);
  IF f.refusal IS NOT NULL THEN
    RETURN;
  END IF;
  v_cap := coalesce((SELECT s.device_max_punches_per_minute FROM public.attendance_settings s
                     WHERE s.tenant_id = f.tenant_id), 60);
  -- Punches from an address the device does not trust get NEW_IP and the address.
  v_new_ip := p_ip IS NOT NULL AND NOT f.ip_trusted;

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

-- ingest_take_commands and ingest_command_results are unchanged: they call ingest_find_device,
-- which now locks the device too.

REVOKE ALL ON FUNCTION ingest_find_device_at(text, inet, timestamptz) FROM PUBLIC;

RESET ROLE;

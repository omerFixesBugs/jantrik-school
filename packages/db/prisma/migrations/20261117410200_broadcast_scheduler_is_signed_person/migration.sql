-- ───────────── sms_broadcasts.scheduled_by_id: the signed person, not a colleague (P6-b21) ─────────────
-- The send job signs its context as the broadcast's scheduler, read from this column, and checks
-- that person's roles (docs/notices.md → Broadcasts). jantrik_app may INSERT and UPDATE the column
-- (scheduling sets it, editing back to a draft clears it), so an SQL injection in one person's
-- request could have the worker send a broadcast as another admin of its institute. The same rule
-- as P1-J8k for student_imports.created_by_id: when a request (a signed person) sets the column, it
-- may only set it to itself or clear it; a write that leaves it as it is stays allowed (another
-- admin cancelling or editing). A context with no person (the worker, server code) is not checked,
-- as for imports: only the API's own code signs one.
CREATE OR REPLACE FUNCTION app_sms_broadcast_scheduler() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF (SELECT public.app_current_user_id()) IS NOT NULL
       AND NEW.scheduled_by_id IS NOT NULL
       AND NEW.scheduled_by_id IS DISTINCT FROM (SELECT public.app_current_user_id())
       AND (TG_OP = 'INSERT' OR NEW.scheduled_by_id IS DISTINCT FROM OLD.scheduled_by_id) THEN
      RAISE EXCEPTION 'a broadcast is scheduled by the signed-in person only'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION app_sms_broadcast_scheduler() FROM PUBLIC;
DROP TRIGGER IF EXISTS sms_broadcasts_scheduler ON sms_broadcasts;
CREATE TRIGGER sms_broadcasts_scheduler BEFORE INSERT OR UPDATE OF scheduled_by_id ON sms_broadcasts
  FOR EACH ROW EXECUTE FUNCTION app_sms_broadcast_scheduler();

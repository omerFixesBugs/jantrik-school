-- ───────────── The send job acts only as the person who scheduled the broadcast (P6-b21) ─────────────
-- The send job signs its context as sms_broadcasts.scheduled_by_id, checks that person's roles and
-- sends what the row and its targets say (docs/notices.md → Broadcasts). jantrik_app may write
-- those rows, so an SQL injection in one person's request could have the worker send a broadcast
-- as another admin of its institute: by naming them, or by changing or bringing back a broadcast
-- they scheduled. The rule, as P1-J8k for student_imports.created_by_id, for a request (a signed
-- person): a row it leaves SCHEDULED is scheduled by that person; it may set the scheduler only to
-- itself or clear it; and it may change the targets of a SCHEDULED broadcast only if it is that
-- broadcast's scheduler. The app never does otherwise: scheduling and send now set the scheduler to
-- the caller, editing sets the row back to DRAFT before its targets are replaced, cancelling and the
-- job's outcomes move it out of SCHEDULED. A context with no person (the worker, server code) is not
-- checked, as for imports: only the API's own code signs one.
CREATE OR REPLACE FUNCTION app_sms_broadcast_scheduler() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_user uuid := (SELECT public.app_current_user_id());
  BEGIN
    IF v_user IS NOT NULL
       AND NEW.scheduled_by_id IS DISTINCT FROM v_user
       AND (NEW.status = 'SCHEDULED'
            OR (NEW.scheduled_by_id IS NOT NULL
                AND (TG_OP = 'INSERT' OR NEW.scheduled_by_id IS DISTINCT FROM OLD.scheduled_by_id))) THEN
      RAISE EXCEPTION 'a broadcast is scheduled by the signed-in person only'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION app_sms_broadcast_scheduler() FROM PUBLIC;
DROP TRIGGER IF EXISTS sms_broadcasts_scheduler ON sms_broadcasts;
CREATE TRIGGER sms_broadcasts_scheduler BEFORE INSERT OR UPDATE ON sms_broadcasts
  FOR EACH ROW EXECUTE FUNCTION app_sms_broadcast_scheduler();

-- Targets are inserted and deleted (never updated). The parent is read as the caller, so RLS
-- applies: a broadcast of another institute is not found, and its foreign key fails anyway.
CREATE OR REPLACE FUNCTION app_sms_broadcast_target_scheduler() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_user uuid := (SELECT public.app_current_user_id());
    v_row public.sms_broadcast_targets;
  BEGIN
    IF TG_OP = 'DELETE' THEN v_row := OLD; ELSE v_row := NEW; END IF;
    IF v_user IS NOT NULL AND EXISTS (
         SELECT 1 FROM public.sms_broadcasts b
         WHERE b.id = v_row.broadcast_id
           AND b.status = 'SCHEDULED'
           AND b.scheduled_by_id IS DISTINCT FROM v_user) THEN
      RAISE EXCEPTION 'a broadcast is scheduled by the signed-in person only'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION app_sms_broadcast_target_scheduler() FROM PUBLIC;
DROP TRIGGER IF EXISTS sms_broadcast_targets_scheduler ON sms_broadcast_targets;
CREATE TRIGGER sms_broadcast_targets_scheduler BEFORE INSERT OR DELETE ON sms_broadcast_targets
  FOR EACH ROW EXECUTE FUNCTION app_sms_broadcast_target_scheduler();

-- Sprint 1 P7a2 (docs/payments.md → Signals, decision P7a-B): what the NOLOGIN role
-- jantrik_payments, owner of the one public function payment_signal_record, may see and write.
-- Grants by column and `TO jantrik_payments` policies, as jantrik_admission (P3b): the function
-- scopes every statement by the institute it resolved from the slug itself. jantrik_app is NOT a
-- member of it, so these policies never widen what the API sees.

-- The role is created outside migrations (jantrik_owner cannot create roles):
-- docker/postgres/init/01-roles.sh for new volumes and CI, deploy/postgres/create-roles.sh in
-- production, and docs/database.md → Database roles for an existing volume. Checked first, so a
-- missing role stops here with nothing applied.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'jantrik_payments') THEN
    RAISE EXCEPTION 'The role jantrik_payments does not exist. Create it first (docs/database.md → Database roles): CREATE ROLE jantrik_payments NOLOGIN NOSUPERUSER NOBYPASSRLS; GRANT jantrik_payments TO jantrik_owner WITH INHERIT FALSE, SET TRUE;';
  END IF;
END $$;

-- CREATE: a function's new owner needs it (ALTER FUNCTION … OWNER TO), as for jantrik_admission;
-- the next migration takes it back once the function is handed over.
GRANT USAGE, CREATE ON SCHEMA public TO jantrik_payments;
-- Its queries also meet the tables' tenant_isolation policies; with no context set (the public
-- routes never set one) they read as "no institute", so only the policies below apply.

-- The institute behind a slug (any status: money is recorded even for a suspended institute).
GRANT SELECT (id, slug) ON tenants TO jantrik_payments;
CREATE POLICY payments_read ON tenants FOR SELECT TO jantrik_payments USING (true);

-- The intent a signal names, by our own tran_id, and its child (for the payer's way back).
GRANT SELECT (tenant_id, id, student_id, tran_id) ON payment_intents TO jantrik_payments;
CREATE POLICY payments_read ON payment_intents FOR SELECT TO jantrik_payments USING (true);

-- The signal itself: a RETURN or an IPN, never a review reason (those are the API's).
GRANT INSERT (id, tenant_id, intent_id, kind, outcome, tran_id, val_id, fields, source_listed,
              received_at, created_at, updated_at)
  ON payment_gateway_events TO jantrik_payments;
CREATE POLICY payments_signal ON payment_gateway_events FOR INSERT TO jantrik_payments
  WITH CHECK (kind IN ('RETURN', 'IPN') AND review_reason IS NULL);

-- The events' CHECK on what a signal may store runs as the inserting role.
GRANT EXECUTE ON FUNCTION payment_event_fields_ok(jsonb) TO jantrik_payments;

-- Every table's tenant_isolation policy applies to this role too. A SELECT under `USING (true)`
-- drops it, but an INSERT checks both policies, so the role must be able to run the verified
-- context (P1-J8). It answers with its caller's own verified context: in the function's empty one,
-- no institute, so that policy refuses and only payments_signal lets a signal in. Only the
-- function's owner, jantrik_auth, may grant it.
SET ROLE jantrik_auth;
GRANT EXECUTE ON FUNCTION app_verified_context() TO jantrik_payments;
RESET ROLE;

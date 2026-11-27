-- Online fee payments, part 2 (sprint 1 P7a2, docs/payments.md → Database): payment intents (one
-- per attempt), the dues each pays with what they owed (the snapshot), the append-only gateway
-- events, and a fee payment's link to its intent. Forced RLS on the three new tenant tables; the
-- policies call the context function wrapped in (SELECT …).
-- CreateEnum
CREATE TYPE "payment_intent_status" AS ENUM ('CREATED', 'REDIRECTED', 'PAID', 'FAILED', 'CANCELLED', 'EXPIRED', 'NEEDS_REVIEW', 'REFUNDED_OUTSIDE', 'DISMISSED');

-- CreateEnum
CREATE TYPE "payment_review_reason" AS ENUM ('AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'TRAN_ID_MISMATCH', 'HIGH_RISK', 'DUES_CHANGED', 'LATE_SUCCESS', 'DUPLICATE', 'UNMATCHED', 'VOIDED');

-- CreateEnum
CREATE TYPE "payment_event_kind" AS ENUM ('INIT', 'RETURN', 'IPN', 'VALIDATE', 'QUERY');

-- AlterTable
ALTER TABLE "fee_payments" ADD COLUMN     "payment_intent_id" UUID;

-- CreateTable
CREATE TABLE "payment_intents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "payer_user_id" UUID NOT NULL,
    "amount_paisa" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "priced_on" DATE NOT NULL,
    "tran_id" TEXT NOT NULL,
    "client_request_id" UUID NOT NULL,
    "status" "payment_intent_status" NOT NULL DEFAULT 'CREATED',
    "session_ref" TEXT,
    "checkout_url" TEXT,
    "init_error" TEXT,
    "val_id" TEXT,
    "bank_tran_id" TEXT,
    "instrument" TEXT,
    "method" "fee_payment_method",
    "validated_amount_paisa" INTEGER,
    "store_amount_paisa" INTEGER,
    "validated_currency" TEXT,
    "risk" TEXT,
    "gateway_paid_at" TIMESTAMPTZ(3),
    "fee_payment_id" UUID,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "review_reasons" "payment_review_reason"[] NOT NULL DEFAULT ARRAY[]::"payment_review_reason"[],
    "review_since" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_intent_dues" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "intent_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "due_id" UUID NOT NULL,
    "planned_principal_paisa" INTEGER NOT NULL,
    "planned_fine_paisa" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_intent_dues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_gateway_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "intent_id" UUID,
    "kind" "payment_event_kind" NOT NULL,
    "outcome" TEXT,
    "tran_id" TEXT,
    "val_id" TEXT,
    "fields" JSONB NOT NULL DEFAULT '{}',
    "source_listed" BOOLEAN,
    "review_reason" "payment_review_reason",
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_gateway_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_intents_tenant_id_student_id_status_idx" ON "payment_intents"("tenant_id", "student_id", "status");

-- CreateIndex
CREATE INDEX "payment_intents_tenant_id_status_created_at_idx" ON "payment_intents"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "payment_intents_tenant_id_payer_user_id_created_at_idx" ON "payment_intents"("tenant_id", "payer_user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_tenant_id_id_key" ON "payment_intents"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_tenant_id_id_student_id_key" ON "payment_intents"("tenant_id", "id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_tenant_id_tran_id_key" ON "payment_intents"("tenant_id", "tran_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_tenant_id_client_request_id_key" ON "payment_intents"("tenant_id", "client_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_tenant_id_fee_payment_id_key" ON "payment_intents"("tenant_id", "fee_payment_id");

-- CreateIndex
CREATE INDEX "payment_intent_dues_tenant_id_due_id_idx" ON "payment_intent_dues"("tenant_id", "due_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intent_dues_tenant_id_id_key" ON "payment_intent_dues"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intent_dues_tenant_id_intent_id_due_id_key" ON "payment_intent_dues"("tenant_id", "intent_id", "due_id");

-- CreateIndex
CREATE INDEX "payment_gateway_events_tenant_id_intent_id_received_at_idx" ON "payment_gateway_events"("tenant_id", "intent_id", "received_at");

-- CreateIndex
CREATE INDEX "payment_gateway_events_tenant_id_tran_id_idx" ON "payment_gateway_events"("tenant_id", "tran_id");

-- CreateIndex
CREATE INDEX "payment_gateway_events_review" ON "payment_gateway_events"("tenant_id", "received_at") WHERE (review_reason IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "payment_gateway_events_tenant_id_id_key" ON "payment_gateway_events"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_payments_live_intent" ON "fee_payments"("tenant_id", "payment_intent_id") WHERE (status = 'ACTIVE' AND payment_intent_id IS NOT NULL);

-- AddForeignKey
ALTER TABLE "fee_payments" ADD CONSTRAINT "fee_payments_tenant_id_payment_intent_id_student_id_fkey" FOREIGN KEY ("tenant_id", "payment_intent_id", "student_id") REFERENCES "payment_intents"("tenant_id", "id", "student_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_tenant_id_account_id_fkey" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "payment_gateway_accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_tenant_id_student_id_fkey" FOREIGN KEY ("tenant_id", "student_id") REFERENCES "students"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_payer_user_id_fkey" FOREIGN KEY ("payer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_tenant_id_fee_payment_id_student_id_fkey" FOREIGN KEY ("tenant_id", "fee_payment_id", "student_id") REFERENCES "fee_payments"("tenant_id", "id", "student_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_intent_dues" ADD CONSTRAINT "payment_intent_dues_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_intent_dues" ADD CONSTRAINT "payment_intent_dues_tenant_id_intent_id_student_id_fkey" FOREIGN KEY ("tenant_id", "intent_id", "student_id") REFERENCES "payment_intents"("tenant_id", "id", "student_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_intent_dues" ADD CONSTRAINT "payment_intent_dues_tenant_id_due_id_student_id_fkey" FOREIGN KEY ("tenant_id", "due_id", "student_id") REFERENCES "fee_dues"("tenant_id", "id", "student_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_intent_dues" ADD CONSTRAINT "payment_intent_dues_tenant_id_student_id_fkey" FOREIGN KEY ("tenant_id", "student_id") REFERENCES "students"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_gateway_events" ADD CONSTRAINT "payment_gateway_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_gateway_events" ADD CONSTRAINT "payment_gateway_events_tenant_id_intent_id_fkey" FOREIGN KEY ("tenant_id", "intent_id") REFERENCES "payment_intents"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ───────────────────────── Hand-written: RLS, grants, checks, triggers ─────────────────────────
-- docs/database.md checklist; docs/payments.md → Database. Nullable columns are tested with
-- IS [NOT] NULL first (a CHECK whose expression is NULL passes). Trigger functions are plain
-- SECURITY INVOKER (they read only rows the caller may see under RLS) with a pinned search_path.

ALTER TABLE payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_intents
  USING (tenant_id = (SELECT app_current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant_id()));

ALTER TABLE payment_intent_dues ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_intent_dues FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_intent_dues
  USING (tenant_id = (SELECT app_current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant_id()));

ALTER TABLE payment_gateway_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_gateway_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_gateway_events
  USING (tenant_id = (SELECT app_current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant_id()));

-- ───────────────────────────── Grants ─────────────────────────────
-- No DELETE anywhere. An intent's amount, tran_id, child, payer, account, day, request id and
-- expiry never change; only its state and the facts the gateway reports do (once: trigger).
GRANT SELECT, INSERT ON payment_intents TO jantrik_app;
GRANT UPDATE (status, session_ref, checkout_url, init_error, val_id, bank_tran_id, instrument,
  method, validated_amount_paisa, store_amount_paisa, validated_currency, risk, gateway_paid_at,
  fee_payment_id, review_reasons, review_since, closed_at, updated_at)
  ON payment_intents TO jantrik_app;
-- The snapshot of what each due owed: append-only.
GRANT SELECT, INSERT ON payment_intent_dues TO jantrik_app;
-- Events are append-only for everyone.
GRANT SELECT, INSERT ON payment_gateway_events TO jantrik_app;

-- ───────────────────────────── payment_intents: checks ─────────────────────────────
ALTER TABLE payment_intents
  -- ৳10 to ৳5 lakh: SSLCommerz's documented range for one session (P7a-L).
  ADD CONSTRAINT payment_intents_amount CHECK (amount_paisa BETWEEN 1000 AND 50000000),
  ADD CONSTRAINT payment_intents_currency CHECK (currency = 'BDT'),
  -- Ours: "JS" + 26 Crockford base32 characters (newTranId in @jantrik/shared).
  ADD CONSTRAINT payment_intents_tran_id CHECK (tran_id ~ '^JS[0-9A-HJKMNP-TV-Z]{26}$'),
  ADD CONSTRAINT payment_intents_session_ref CHECK (
    session_ref IS NULL OR char_length(session_ref) BETWEEN 1 AND 100),
  -- The gateway's page: https; plain http only on this machine (the fake SSLCommerz of the tests,
  -- which production refuses: SSLCOMMERZ_BASE_URL). The API also checks the host.
  ADD CONSTRAINT payment_intents_checkout_url CHECK (
    checkout_url IS NULL
    OR (char_length(checkout_url) <= 2000
        AND (checkout_url ~ '^https://' OR checkout_url ~ '^http://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?/'))),
  ADD CONSTRAINT payment_intents_init_error CHECK (
    init_error IS NULL OR init_error ~ '^[A-Z][A-Z_]{0,39}$'),
  ADD CONSTRAINT payment_intents_val_id CHECK (val_id IS NULL OR val_id ~ '^[A-Za-z0-9_.-]{1,50}$'),
  ADD CONSTRAINT payment_intents_facts_format CHECK (
    (bank_tran_id IS NULL OR char_length(bank_tran_id) BETWEEN 1 AND 100)
    AND (instrument IS NULL OR char_length(instrument) BETWEEN 1 AND 50)
    AND (validated_currency IS NULL OR char_length(validated_currency) BETWEEN 1 AND 10)
    AND (risk IS NULL OR risk IN ('LOW', 'HIGH'))
    AND (validated_amount_paisa IS NULL OR validated_amount_paisa >= 0)
    AND (store_amount_paisa IS NULL OR store_amount_paisa >= 0)
    AND (store_amount_paisa IS NULL OR validated_amount_paisa IS NULL
         OR store_amount_paisa <= validated_amount_paisa)),
  -- The money facts come with the validation ID they were validated under, never alone.
  ADD CONSTRAINT payment_intents_facts_with_val_id CHECK (
    val_id IS NOT NULL
    OR (bank_tran_id IS NULL AND instrument IS NULL AND method IS NULL
        AND validated_amount_paisa IS NULL AND store_amount_paisa IS NULL
        AND validated_currency IS NULL AND risk IS NULL AND gateway_paid_at IS NULL)),
  -- PAID exactly when it holds a payment, and only with the validated money.
  ADD CONSTRAINT payment_intents_paid CHECK ((status = 'PAID') = (fee_payment_id IS NOT NULL)),
  ADD CONSTRAINT payment_intents_paid_facts CHECK (
    status <> 'PAID'
    OR (val_id IS NOT NULL AND bank_tran_id IS NOT NULL AND method IS NOT NULL
        AND validated_amount_paisa IS NOT NULL)),
  ADD CONSTRAINT payment_intents_review CHECK (
    status <> 'NEEDS_REVIEW' OR (cardinality(review_reasons) > 0 AND review_since IS NOT NULL)),
  ADD CONSTRAINT payment_intents_redirected CHECK (
    status <> 'REDIRECTED' OR (session_ref IS NOT NULL AND checkout_url IS NOT NULL)),
  ADD CONSTRAINT payment_intents_closed CHECK (
    (status IN ('CREATED', 'REDIRECTED')) = (closed_at IS NULL)),
  ADD CONSTRAINT payment_intents_expires CHECK (expires_at > created_at);

-- How an intent may change (docs/payments.md → States): the state only along the table, the
-- money the gateway reported written once and never changed, the payment set only when it
-- becomes PAID and cleared only when an admin voided it (PAID → NEEDS_REVIEW with VOIDED).
CREATE FUNCTION payment_intents_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'CREATED'
        AND NEW.status IN ('REDIRECTED', 'FAILED', 'CANCELLED', 'PAID', 'NEEDS_REVIEW', 'EXPIRED'))
    OR (OLD.status = 'REDIRECTED'
        AND NEW.status IN ('PAID', 'NEEDS_REVIEW', 'FAILED', 'CANCELLED', 'EXPIRED'))
    OR (OLD.status IN ('FAILED', 'CANCELLED', 'EXPIRED') AND NEW.status = 'NEEDS_REVIEW')
    OR (OLD.status = 'PAID' AND NEW.status = 'NEEDS_REVIEW')
    OR (OLD.status = 'NEEDS_REVIEW' AND NEW.status IN ('PAID', 'REFUNDED_OUTSIDE', 'DISMISSED'))
    OR (OLD.status = 'DISMISSED' AND NEW.status = 'NEEDS_REVIEW')
  ) THEN
    RAISE EXCEPTION 'payment intent % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.val_id IS NOT NULL AND
     ROW(NEW.val_id, NEW.bank_tran_id, NEW.instrument, NEW.method, NEW.validated_amount_paisa,
         NEW.store_amount_paisa, NEW.validated_currency, NEW.risk, NEW.gateway_paid_at)
     IS DISTINCT FROM
     ROW(OLD.val_id, OLD.bank_tran_id, OLD.instrument, OLD.method, OLD.validated_amount_paisa,
         OLD.store_amount_paisa, OLD.validated_currency, OLD.risk, OLD.gateway_paid_at) THEN
    RAISE EXCEPTION 'the money a payment intent stands for never changes'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.fee_payment_id IS DISTINCT FROM OLD.fee_payment_id THEN
    IF OLD.fee_payment_id IS NULL THEN
      IF NOT (NEW.status = 'PAID' AND OLD.status <> 'PAID') THEN
        RAISE EXCEPTION 'a payment intent gets its payment only as it becomes PAID'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NOT (NEW.fee_payment_id IS NULL AND OLD.status = 'PAID'
               AND NEW.status = 'NEEDS_REVIEW' AND 'VOIDED' = ANY (NEW.review_reasons)) THEN
      RAISE EXCEPTION 'a payment intent loses its payment only when it was voided'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION payment_intents_guard() FROM PUBLIC;
CREATE TRIGGER payment_intents_guard
  BEFORE UPDATE ON payment_intents
  FOR EACH ROW EXECUTE FUNCTION payment_intents_guard();

-- A new intent starts at the beginning, with nothing from the gateway yet.
CREATE FUNCTION payment_intents_insert_created() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.status <> 'CREATED' OR NEW.val_id IS NOT NULL OR NEW.fee_payment_id IS NOT NULL
     OR NEW.session_ref IS NOT NULL OR NEW.checkout_url IS NOT NULL
     OR cardinality(NEW.review_reasons) > 0 THEN
    RAISE EXCEPTION 'payment intents are created empty, CREATED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION payment_intents_insert_created() FROM PUBLIC;
CREATE TRIGGER payment_intents_insert_created
  BEFORE INSERT ON payment_intents
  FOR EACH ROW EXECUTE FUNCTION payment_intents_insert_created();

-- At commit: a PAID intent's payment is live, a gateway payment, and names this intent; and a
-- live payment that names this intent is the one it holds as PAID, so an intent never lets go of
-- its payment without the void (P7a2-x25: the guard alone let an update move PAID to review
-- "voided" while the payment stayed ACTIVE). Read again then (a deferred trigger gets the row as
-- it was when it fired).
CREATE FUNCTION payment_intents_paid_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_status text;
  v_payment uuid;
BEGIN
  SELECT status::text, fee_payment_id INTO v_status, v_payment
    FROM payment_intents WHERE tenant_id = NEW.tenant_id AND id = NEW.id;
  IF v_status = 'PAID' AND NOT EXISTS (
    SELECT 1 FROM fee_payments p
    WHERE p.tenant_id = NEW.tenant_id AND p.id = v_payment AND p.status = 'ACTIVE'
      AND p.channel = 'GATEWAY' AND p.payment_intent_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'a PAID payment intent needs its own live gateway payment'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM fee_payments p
    WHERE p.tenant_id = NEW.tenant_id AND p.payment_intent_id = NEW.id AND p.status = 'ACTIVE'
      AND (v_status IS DISTINCT FROM 'PAID' OR v_payment IS DISTINCT FROM p.id)
  ) THEN
    RAISE EXCEPTION 'a live gateway payment keeps its intent PAID with it (void it first)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION payment_intents_paid_check() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER payment_intents_paid_check
  AFTER INSERT OR UPDATE ON payment_intents
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION payment_intents_paid_check();

-- At commit: an intent's dues add up to its amount (both its insert and each due's fire it, so
-- an intent with no dues is refused too).
CREATE FUNCTION payment_intent_dues_sum() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_intent uuid;
  v_amount integer;
  v_planned bigint;
BEGIN
  IF TG_TABLE_NAME = 'payment_intents' THEN
    v_intent := NEW.id;
  ELSE
    v_intent := NEW.intent_id;
  END IF;
  SELECT amount_paisa INTO v_amount
    FROM payment_intents WHERE tenant_id = NEW.tenant_id AND id = v_intent;
  SELECT COALESCE(SUM(planned_principal_paisa + planned_fine_paisa), 0) INTO v_planned
    FROM payment_intent_dues WHERE tenant_id = NEW.tenant_id AND intent_id = v_intent;
  IF v_amount IS DISTINCT FROM v_planned THEN
    RAISE EXCEPTION 'a payment intent''s dues must add up to its amount'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION payment_intent_dues_sum() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER payment_intents_dues_sum
  AFTER INSERT ON payment_intents
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION payment_intent_dues_sum();
CREATE CONSTRAINT TRIGGER payment_intent_dues_sum
  AFTER INSERT ON payment_intent_dues
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION payment_intent_dues_sum();

ALTER TABLE payment_intent_dues
  ADD CONSTRAINT payment_intent_dues_amounts CHECK (
    planned_principal_paisa >= 0 AND planned_fine_paisa >= 0
    AND planned_principal_paisa + planned_fine_paisa > 0);

-- ───────────────────────────── payment_gateway_events ─────────────────────────────
-- What a signal or an answer may store (the same list as signalFields in @jantrik/shared): an
-- object of whitelisted keys, each a string of at most 100 characters, 4000 bytes in all. Never a
-- card number, a signature, the customer or a password. IMMUTABLE plpgsql, so the type test runs
-- before jsonb_each looks inside.
CREATE FUNCTION payment_event_fields_ok(f jsonb) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF f IS NULL OR jsonb_typeof(f) <> 'object' OR octet_length(f::text) > 4000 THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM jsonb_each(f) e
    WHERE e.key <> ALL (ARRAY['status', 'tran_date', 'amount', 'store_amount', 'currency',
                              'currency_type', 'currency_amount', 'bank_tran_id', 'card_type',
                              'card_brand', 'risk_level', 'risk_title', 'error'])
       OR jsonb_typeof(e.value) <> 'string'
       OR char_length(e.value #>> '{}') > 100);
END
$$;
REVOKE ALL ON FUNCTION payment_event_fields_ok(jsonb) FROM PUBLIC;
-- Whoever inserts an event evaluates the CHECK (jantrik_payments gets it with its role).
GRANT EXECUTE ON FUNCTION payment_event_fields_ok(jsonb) TO jantrik_app;

ALTER TABLE payment_gateway_events
  ADD CONSTRAINT payment_gateway_events_fields CHECK (payment_event_fields_ok(fields)),
  ADD CONSTRAINT payment_gateway_events_refs CHECK (
    (tran_id IS NULL OR tran_id ~ '^[A-Za-z0-9_.-]{1,50}$')
    AND (val_id IS NULL OR val_id ~ '^[A-Za-z0-9_.-]{1,50}$')),
  ADD CONSTRAINT payment_gateway_events_outcome CHECK (
    outcome IS NULL OR outcome ~ '^[A-Z][A-Z0-9_,]{0,39}$'),
  ADD CONSTRAINT payment_gateway_events_return CHECK (
    kind <> 'RETURN' OR (intent_id IS NOT NULL AND outcome IN ('SUCCESS', 'FAIL', 'CANCEL'))),
  ADD CONSTRAINT payment_gateway_events_review CHECK (
    review_reason IS NULL OR (kind = 'VALIDATE' AND review_reason IN ('UNMATCHED', 'DUPLICATE'))),
  ADD CONSTRAINT payment_gateway_events_source CHECK (
    source_listed IS NULL OR kind IN ('RETURN', 'IPN'));

-- ───────────────────────────── fee_payments ─────────────────────────────
-- A gateway payment: a gateway method, the gateway's own transaction ID, no sender, and its
-- intent; the counter's and the manual transfer's never name an intent (S21, P7a-I).
ALTER TABLE fee_payments DROP CONSTRAINT IF EXISTS fee_payments_channel;
ALTER TABLE fee_payments ADD CONSTRAINT fee_payments_channel CHECK (
  (channel = 'COUNTER' AND method = 'CASH' AND trx_id IS NULL AND sender_phone IS NULL
   AND payment_intent_id IS NULL)
  OR (channel = 'MOBILE_MANUAL' AND method IN ('BKASH', 'NAGAD')
      AND trx_id IS NOT NULL AND sender_phone IS NOT NULL AND payment_intent_id IS NULL)
  OR (channel = 'GATEWAY' AND method IN ('BKASH', 'NAGAD', 'ROCKET', 'CARD', 'OTHER_ONLINE')
      AND trx_id IS NOT NULL AND sender_phone IS NULL AND payment_intent_id IS NOT NULL));
-- SSLCommerz's bank_tran_id has lower case letters and may be longer than a bKash TrxID (the
-- documentation's sample: 1709162025350IvUOK8nCTb6Uan); the manual rule is unchanged.
ALTER TABLE fee_payments DROP CONSTRAINT IF EXISTS fee_payments_trx_id;
ALTER TABLE fee_payments ADD CONSTRAINT fee_payments_trx_id CHECK (
  trx_id IS NULL
  OR (channel <> 'GATEWAY' AND trx_id ~ '^[A-Z0-9]{6,20}$')
  OR (channel = 'GATEWAY' AND trx_id ~ '^[A-Za-z0-9._-]{6,80}$'));

-- At commit, the mirror of payment_intents_paid_check: a live gateway payment's intent is PAID
-- and holds it; a voided one's intent no longer does (the void moved it to review, P7a-G).
CREATE FUNCTION fee_payments_gateway_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_status text;
  v_intent uuid;
BEGIN
  IF NEW.channel <> 'GATEWAY' THEN
    RETURN NULL;
  END IF;
  SELECT status::text, payment_intent_id INTO v_status, v_intent
    FROM fee_payments WHERE tenant_id = NEW.tenant_id AND id = NEW.id;
  IF v_status = 'ACTIVE' AND NOT EXISTS (
    SELECT 1 FROM payment_intents i
    WHERE i.tenant_id = NEW.tenant_id AND i.id = v_intent AND i.status = 'PAID'
      AND i.fee_payment_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'a gateway payment needs its intent PAID with it'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_status = 'VOID' AND EXISTS (
    SELECT 1 FROM payment_intents i
    WHERE i.tenant_id = NEW.tenant_id AND i.id = v_intent AND i.fee_payment_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'a voided gateway payment cannot stay on its intent'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION fee_payments_gateway_check() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER fee_payments_gateway_check
  AFTER INSERT OR UPDATE ON fee_payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fee_payments_gateway_check();

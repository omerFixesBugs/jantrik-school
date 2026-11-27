-- Online fee payments, part 3 (sprint 1 P7b, docs/payments.md → The review queue): a person's
-- decision on an online payment in review (applied to dues, refunded outside the app, or
-- dismissed), when SSLCommerz was last asked about it, and the one final decision on money no
-- intent holds or that came twice (payment_signal_reviews, decision P7b-C). Money is never
-- dismissed (P7b-E); only a person's decision moves an intent out of review (S23).
-- AlterTable
ALTER TABLE "payment_intents" ADD COLUMN     "applied_paisa" INTEGER,
ADD COLUMN     "last_check_outcome" TEXT,
ADD COLUMN     "last_checked_at" TIMESTAMPTZ(3),
ADD COLUMN     "refund_reference" TEXT,
ADD COLUMN     "refunded_outside_paisa" INTEGER,
ADD COLUMN     "resolution_note" TEXT,
ADD COLUMN     "resolved_at" TIMESTAMPTZ(3),
ADD COLUMN     "resolved_by_id" UUID;

-- CreateTable
CREATE TABLE "payment_signal_reviews" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "outcome" TEXT NOT NULL,
    "amount_paisa" INTEGER,
    "refund_reference" TEXT,
    "note" TEXT NOT NULL,
    "resolved_by_id" UUID NOT NULL,
    "resolved_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_signal_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_signal_reviews_tenant_id_resolved_at_idx" ON "payment_signal_reviews"("tenant_id", "resolved_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_signal_reviews_tenant_id_id_key" ON "payment_signal_reviews"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_signal_reviews_tenant_id_event_id_key" ON "payment_signal_reviews"("tenant_id", "event_id");

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_signal_reviews" ADD CONSTRAINT "payment_signal_reviews_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_signal_reviews" ADD CONSTRAINT "payment_signal_reviews_tenant_id_event_id_fkey" FOREIGN KEY ("tenant_id", "event_id") REFERENCES "payment_gateway_events"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_signal_reviews" ADD CONSTRAINT "payment_signal_reviews_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ───────────────────────── Hand-written: RLS, grants, checks, triggers ─────────────────────────
-- docs/database.md checklist; docs/payments.md → The review queue. Nullable columns are tested
-- with IS [NOT] NULL first. Trigger functions are plain SECURITY INVOKER (they read only rows the
-- caller may see under RLS) with a pinned search_path.

ALTER TABLE payment_signal_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_signal_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_signal_reviews
  USING (tenant_id = (SELECT app_current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant_id()));

-- ───────────────────────────── Grants ─────────────────────────────
-- A decision on a review event is history: written once, never changed or removed.
GRANT SELECT, INSERT ON payment_signal_reviews TO jantrik_app;
-- The decision on an intent (written as it leaves review, trigger below) and the last check.
GRANT UPDATE (resolved_by_id, resolved_at, resolution_note, applied_paisa, refunded_outside_paisa,
  refund_reference, last_checked_at, last_check_outcome)
  ON payment_intents TO jantrik_app;

-- ───────────────────────────── payment_intents: checks ─────────────────────────────
-- PostgreSQL tests CHECKs in the order of their names; each is complete on its own.
ALTER TABLE payment_intents
  -- A decision names who made it, when and why (3 to 500 characters); only a decided intent has
  -- one, and a refunded or dismissed one always does. PAID by a decision (applied) exactly when
  -- it has an applied amount (PAID by settle has neither).
  ADD CONSTRAINT payment_intents_resolution CHECK (
    (resolved_at IS NULL) = (resolved_by_id IS NULL)
    AND (resolved_at IS NULL) = (resolution_note IS NULL)
    AND (resolution_note IS NULL OR char_length(resolution_note) BETWEEN 3 AND 500)
    AND (resolved_at IS NULL OR status IN ('PAID', 'REFUNDED_OUTSIDE', 'DISMISSED'))
    AND (status NOT IN ('REFUNDED_OUTSIDE', 'DISMISSED') OR resolved_at IS NOT NULL)
    AND (status <> 'PAID' OR (resolved_at IS NULL) = (applied_paisa IS NULL))),
  -- Refunded outside: the whole validated money (an amount that was not well-formed stays
  -- unknown: NULL), nothing applied.
  ADD CONSTRAINT payment_intents_refunded_outside CHECK (
    status <> 'REFUNDED_OUTSIDE'
    OR (val_id IS NOT NULL AND applied_paisa IS NULL
        AND refunded_outside_paisa IS NOT DISTINCT FROM validated_amount_paisa)),
  -- Money is never dismissed (P7b-E): only an intent that holds no validated money.
  ADD CONSTRAINT payment_intents_dismissed CHECK (
    status <> 'DISMISSED'
    OR (val_id IS NULL AND applied_paisa IS NULL AND refunded_outside_paisa IS NULL
        AND refund_reference IS NULL)),
  -- Applied: at least 1 paisa, and applied + refunded outside = the validated amount.
  ADD CONSTRAINT payment_intents_applied CHECK (
    applied_paisa IS NULL
    OR (applied_paisa >= 1 AND validated_amount_paisa IS NOT NULL
        AND applied_paisa + COALESCE(refunded_outside_paisa, 0) = validated_amount_paisa)),
  -- Money given back outside the app stays given back (P7b-N): an applied intent voided back
  -- into review keeps its refunded part (review round 1, finding 1), so some money is left to
  -- decide; otherwise only a PAID (applied) or REFUNDED_OUTSIDE intent has one.
  ADD CONSTRAINT payment_intents_refunded_paisa CHECK (
    refunded_outside_paisa IS NULL
    OR (refunded_outside_paisa >= 1
        AND (status IN ('PAID', 'REFUNDED_OUTSIDE')
             OR (status = 'NEEDS_REVIEW' AND validated_amount_paisa IS NOT NULL
                 AND refunded_outside_paisa < validated_amount_paisa)))),
  -- What the institute's own records call the refund: ASCII letters, digits and -_./ only.
  ADD CONSTRAINT payment_intents_refund_reference CHECK (
    refund_reference IS NULL
    OR (refund_reference ~ '^[A-Za-z0-9._/-]{1,100}$'
        AND (refunded_outside_paisa IS NOT NULL OR status = 'REFUNDED_OUTSIDE'))),
  -- The last query by our tran_id: a time and a fixed word or code, together.
  ADD CONSTRAINT payment_intents_last_check CHECK (
    (last_checked_at IS NULL) = (last_check_outcome IS NULL)
    AND (last_check_outcome IS NULL OR last_check_outcome ~ '^[A-Z][A-Z0-9_]{0,39}$'));

-- Only a person's decision moves an intent out of NEEDS_REVIEW (the three P7b actions; S23: no
-- job ever does), and the decision is written exactly then. When the intent comes back to review
-- (a void of the applied payment, a success after a dismissal) the decision is cleared from the
-- row (the audit log keeps it), except the money already given back outside the app: "refunded
-- outside" is final (P7b-N), so a refund recorded with a partial apply stays, with its reference,
-- and it never shrinks or loses its reference (review round 1, finding 1: a void then cleared it,
-- and the whole money could be applied again). A separate trigger from payment_intents_guard
-- (P7a2), which runs first (triggers fire in the order of their names).
CREATE FUNCTION payment_intents_resolution_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.status = 'NEEDS_REVIEW' AND NEW.status IS DISTINCT FROM 'NEEDS_REVIEW' THEN
    IF NEW.resolved_at IS NULL OR NEW.resolved_by_id IS NULL THEN
      RAISE EXCEPTION 'only a person''s decision moves a payment intent out of review'
        USING ERRCODE = 'check_violation';
    END IF;
    -- The decider is the signed person (review round 1, hardening a; as P1-J8k and P6-b21): a
    -- request cannot write someone else's decision. A context with no person is not checked.
    IF (SELECT public.app_current_user_id()) IS NOT NULL
       AND NEW.resolved_by_id IS DISTINCT FROM (SELECT public.app_current_user_id()) THEN
      RAISE EXCEPTION 'a payment is decided by the signed-in person only'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.status = 'PAID' AND NEW.fee_payment_id IS NULL THEN
      RAISE EXCEPTION 'an intent applied from review holds its new payment'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.refunded_outside_paisa IS NOT NULL
       AND (NEW.refunded_outside_paisa IS NULL
            OR NEW.refunded_outside_paisa < OLD.refunded_outside_paisa
            OR (OLD.refund_reference IS NOT NULL AND NEW.refund_reference IS NULL)) THEN
      RAISE EXCEPTION 'money refunded outside the app stays refunded, with its reference (P7b-N)'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'NEEDS_REVIEW' AND OLD.status IS DISTINCT FROM 'NEEDS_REVIEW' THEN
    IF OLD.status = 'PAID' AND NEW.fee_payment_id IS NOT NULL THEN
      RAISE EXCEPTION 'an intent back in review holds no payment: void it first'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.resolved_by_id := NULL;
    NEW.resolved_at := NULL;
    NEW.resolution_note := NULL;
    NEW.applied_paisa := NULL;
    -- Kept: what was given back outside the app (an applied intent's refunded part).
    NEW.refunded_outside_paisa := OLD.refunded_outside_paisa;
    NEW.refund_reference := OLD.refund_reference;
    RETURN NEW;
  END IF;
  IF ROW(NEW.resolved_by_id, NEW.resolved_at, NEW.resolution_note, NEW.applied_paisa,
         NEW.refunded_outside_paisa, NEW.refund_reference)
     IS DISTINCT FROM
     ROW(OLD.resolved_by_id, OLD.resolved_at, OLD.resolution_note, OLD.applied_paisa,
         OLD.refunded_outside_paisa, OLD.refund_reference) THEN
    RAISE EXCEPTION 'a payment intent''s decision is written only as it leaves review'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION payment_intents_resolution_guard() FROM PUBLIC;
CREATE TRIGGER payment_intents_resolution_guard
  BEFORE UPDATE ON payment_intents
  FOR EACH ROW EXECUTE FUNCTION payment_intents_resolution_guard();

-- The same match from the intent's side, at commit: a PAID intent changed under its live payment
-- (whatever the column) is refused, as a payment changed under its intent is (below). Only rows
-- that are PAID after the update are looked at.
CREATE FUNCTION payment_intents_payment_match() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM payment_intents i
    WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.id AND i.status = 'PAID'
  ) AND NOT EXISTS (
    SELECT 1 FROM payment_intents i
    JOIN fee_payments p ON p.tenant_id = i.tenant_id AND p.id = i.fee_payment_id
    WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.id AND p.payment_intent_id = i.id
      AND i.bank_tran_id = p.trx_id
      AND CASE
            WHEN i.applied_paisa IS NULL
              THEN p.amount_paisa = i.amount_paisa AND p.paid_on = i.priced_on
            ELSE p.amount_paisa = i.applied_paisa
              AND p.paid_on BETWEEN i.priced_on AND p.recorded_on
              AND i.validated_currency = 'BDT'
          END
  ) THEN
    RAISE EXCEPTION 'a gateway payment must be its intent''s money: it must match its intent (the amount, the bank transaction ID, the day)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION payment_intents_payment_match() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER payment_intents_payment_match
  AFTER UPDATE ON payment_intents
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.status = 'PAID')
  EXECUTE FUNCTION payment_intents_payment_match();

-- At commit, a live gateway payment matches its intent: the intent is PAID with it (P7a2), the
-- TrxID is the intent's bank_tran_id, and the amount and day are what was decided: posted by
-- settle, the intent's amount on its checkout day (P7a-E, P7a2-x28: exactly P7a2's rule); applied
-- from review (P7b), the applied amount on a day from the checkout day to the day it was recorded
-- (the gateway's day, P7b-F) and only for taka (P7b-G; review round 1, hardening c). A voided
-- one's intent no longer holds it (P7a2). Replaces P7a2's
-- function of the same name (migration 20261117510100, after its review) with the stricter union:
-- every rule of P7a2's, and the applied branch only for an intent a person applied
-- (applied_paisa, written only by that decision). P7a2's other rule, that an intent never lets go
-- of a live payment (payment_intents_paid_check, P7a2-x25), is not redefined here and stands.
CREATE OR REPLACE FUNCTION fee_payments_gateway_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_status text;
  v_intent uuid;
  v_amount integer;
  v_trx text;
  v_paid_on date;
  v_recorded_on date;
BEGIN
  IF NEW.channel <> 'GATEWAY' THEN
    RETURN NULL;
  END IF;
  SELECT status::text, payment_intent_id, amount_paisa, trx_id, paid_on, recorded_on
    INTO v_status, v_intent, v_amount, v_trx, v_paid_on, v_recorded_on
    FROM fee_payments WHERE tenant_id = NEW.tenant_id AND id = NEW.id;
  IF v_status = 'ACTIVE' THEN
    IF NOT EXISTS (
      SELECT 1 FROM payment_intents i
      WHERE i.tenant_id = NEW.tenant_id AND i.id = v_intent AND i.status = 'PAID'
        AND i.fee_payment_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'a gateway payment needs its intent PAID with it'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM payment_intents i
      WHERE i.tenant_id = NEW.tenant_id AND i.id = v_intent AND i.bank_tran_id = v_trx
        AND CASE
              WHEN i.applied_paisa IS NULL
                THEN v_amount = i.amount_paisa AND v_paid_on = i.priced_on
              ELSE v_amount = i.applied_paisa
                AND v_paid_on BETWEEN i.priced_on AND v_recorded_on
                AND i.validated_currency = 'BDT'
            END
    ) THEN
      RAISE EXCEPTION 'a gateway payment must be its intent''s money: it must match its intent (the amount, the bank transaction ID, the day)'
        USING ERRCODE = 'check_violation';
    END IF;
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

-- ───────────────────────────── payment_signal_reviews ─────────────────────────────
-- The decider of a money item is the signed person, as on an intent (review round 1, hardening
-- a); a context with no person is not checked.
CREATE FUNCTION app_payment_signal_review_decider() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF (SELECT public.app_current_user_id()) IS NOT NULL
     AND NEW.resolved_by_id IS DISTINCT FROM (SELECT public.app_current_user_id()) THEN
    RAISE EXCEPTION 'a payment is decided by the signed-in person only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app_payment_signal_review_decider() FROM PUBLIC;
CREATE TRIGGER payment_signal_reviews_decider
  BEFORE INSERT ON payment_signal_reviews
  FOR EACH ROW EXECUTE FUNCTION app_payment_signal_review_decider();

ALTER TABLE payment_signal_reviews
  -- Refunded with the event's validated amount (NULL when it was not a well-formed amount);
  -- a dismissal holds no amount.
  ADD CONSTRAINT payment_signal_reviews_amount CHECK (
    amount_paisa IS NULL OR (amount_paisa >= 1 AND outcome = 'REFUNDED_OUTSIDE')),
  ADD CONSTRAINT payment_signal_reviews_note CHECK (char_length(note) BETWEEN 3 AND 500),
  ADD CONSTRAINT payment_signal_reviews_outcome CHECK (outcome IN ('REFUNDED_OUTSIDE', 'DISMISSED')),
  ADD CONSTRAINT payment_signal_reviews_refund_reference CHECK (
    refund_reference IS NULL
    OR (outcome = 'REFUNDED_OUTSIDE' AND refund_reference ~ '^[A-Za-z0-9._/-]{1,100}$'));

-- At commit: a decision is about a VALIDATE event with a review reason (an item of the queue),
-- money is never dismissed (P7b-E): a dismissal is only of a repeat record of money that an
-- intent holds, or that another review event (not itself dismissed) still records; and money is
-- refunded outside once: not a second record of it, nor money an intent holds. Decisions on
-- the records of one payment (one val_id) are serialised by an advisory lock on it, taken here
-- and by the API before it inserts (P7b-x: two dismissals of the two records of one payment at
-- once could otherwise each see the other standing): the second check waits for the first
-- transaction to end and reads what it committed (READ COMMITTED takes a new snapshot).
CREATE FUNCTION payment_review_event_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_kind text;
  v_reason text;
  v_val text;
  v_reported text;
BEGIN
  SELECT kind::text, review_reason::text, val_id, fields->>'amount'
    INTO v_kind, v_reason, v_val, v_reported
    FROM payment_gateway_events WHERE tenant_id = NEW.tenant_id AND id = NEW.event_id;
  IF v_kind IS DISTINCT FROM 'VALIDATE' OR v_reason IS NULL THEN
    RAISE EXCEPTION 'a signal review needs a VALIDATE event with a review reason'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_val IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('payments-val:' || NEW.tenant_id::text || ':' || v_val, 0));
  END IF;
  -- Money is refunded outside once (review round 1, finding 2): never a second record of money
  -- already refunded, nor money an intent holds (it is applied or refunded on the intent).
  IF NEW.outcome = 'REFUNDED_OUTSIDE' AND v_val IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM payment_intents i
               WHERE i.tenant_id = NEW.tenant_id AND i.val_id = v_val) THEN
      RAISE EXCEPTION 'this money is an online payment''s own: it is decided on that payment'
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM payment_signal_reviews r
      JOIN payment_gateway_events e ON e.tenant_id = r.tenant_id AND e.id = r.event_id
      WHERE r.tenant_id = NEW.tenant_id AND e.val_id = v_val AND r.id <> NEW.id
        AND r.outcome = 'REFUNDED_OUTSIDE'
    ) THEN
      RAISE EXCEPTION 'this money was already refunded outside (another record of it)'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- Refunded: the event's validated amount (review round 1, hardening b), as the API reads it
  -- (parseGatewayAmount: at most 7 digits and 2 decimals), or unknown (NULL) exactly when the
  -- gateway's amount was not well-formed (or nothing).
  IF NEW.outcome = 'REFUNDED_OUTSIDE' AND NEW.amount_paisa IS DISTINCT FROM (
    CASE WHEN v_reported ~ '^[0-9]{1,7}([.][0-9]{1,2})?$'
         THEN NULLIF(round(v_reported::numeric * 100)::integer, 0) END
  ) THEN
    RAISE EXCEPTION 'a refunded item records the event''s validated amount'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.outcome = 'DISMISSED' AND NOT (
    v_val IS NOT NULL AND (
      EXISTS (SELECT 1 FROM payment_intents i
              WHERE i.tenant_id = NEW.tenant_id AND i.val_id = v_val)
      OR EXISTS (
        SELECT 1 FROM payment_gateway_events e
        WHERE e.tenant_id = NEW.tenant_id AND e.val_id = v_val AND e.id <> NEW.event_id
          AND e.kind = 'VALIDATE' AND e.review_reason IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM payment_signal_reviews r
            WHERE r.tenant_id = e.tenant_id AND r.event_id = e.id AND r.outcome = 'DISMISSED')))
  ) THEN
    RAISE EXCEPTION 'money is never dismissed: this is the only record of it'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION payment_review_event_check() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER payment_signal_reviews_check
  AFTER INSERT ON payment_signal_reviews
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION payment_review_event_check();

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
  ADD CONSTRAINT payment_intents_refunded_paisa CHECK (
    refunded_outside_paisa IS NULL
    OR (refunded_outside_paisa >= 1 AND status IN ('PAID', 'REFUNDED_OUTSIDE'))),
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
-- row; the audit log keeps it. A separate trigger from payment_intents_guard (P7a2), which runs
-- first (triggers fire in the order of their names).
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
    RETURN NEW;
  END IF;
  IF NEW.status = 'NEEDS_REVIEW' AND OLD.status IS DISTINCT FROM 'NEEDS_REVIEW' THEN
    NEW.resolved_by_id := NULL;
    NEW.resolved_at := NULL;
    NEW.resolution_note := NULL;
    NEW.applied_paisa := NULL;
    NEW.refunded_outside_paisa := NULL;
    NEW.refund_reference := NULL;
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

-- At commit, a live gateway payment matches its intent: the intent is PAID with it (P7a2), the
-- TrxID is the intent's bank_tran_id, and the amount and day are what was decided: posted by
-- settle, the intent's amount on its checkout day (P7a-E); applied from review (P7b), the
-- applied amount on a day from the checkout day to the day it was recorded (the gateway's day,
-- P7b-F). A voided one's intent no longer holds it (P7a2). Replaces P7a2's function of the same
-- name with the same two rules and the match added (sprint 1 P7a2 review: the database ties a
-- gateway payment to its intent).
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
            END
    ) THEN
      RAISE EXCEPTION 'a gateway payment must match its intent: the amount, the TrxID and the day'
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
-- and money is never dismissed (P7b-E): a dismissal is only of a repeat record of money that an
-- intent holds, or that another review event (not itself dismissed) still records.
CREATE FUNCTION payment_review_event_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_kind text;
  v_reason text;
  v_val text;
BEGIN
  SELECT kind::text, review_reason::text, val_id INTO v_kind, v_reason, v_val
    FROM payment_gateway_events WHERE tenant_id = NEW.tenant_id AND id = NEW.event_id;
  IF v_kind IS DISTINCT FROM 'VALIDATE' OR v_reason IS NULL THEN
    RAISE EXCEPTION 'a signal review needs a VALIDATE event with a review reason'
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

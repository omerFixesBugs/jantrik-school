-- Online fee payments, part 2 (sprint 1 P7a2, docs/payments.md, decision S21): the gateway
-- channel and the three methods SSLCommerz adds (Rocket, card, any other online instrument).
-- Nothing else here: a new enum value cannot be used in the transaction that adds it, and the
-- next migration's CHECKs use them.
ALTER TYPE "fee_payment_channel" ADD VALUE 'GATEWAY';

ALTER TYPE "fee_payment_method" ADD VALUE 'ROCKET';
ALTER TYPE "fee_payment_method" ADD VALUE 'CARD';
ALTER TYPE "fee_payment_method" ADD VALUE 'OTHER_ONLINE';

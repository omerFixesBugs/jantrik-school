-- Sprint 1 P4 (admission test): the result SMS purpose, in its own migration (a new enum value
-- cannot be used in the transaction that adds it).
ALTER TYPE "sms_purpose" ADD VALUE IF NOT EXISTS 'ADMISSION_RESULT';

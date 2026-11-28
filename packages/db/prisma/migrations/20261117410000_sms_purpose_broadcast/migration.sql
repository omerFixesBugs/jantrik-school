-- Sprint 1 P6b: the SMS purpose of a broadcast, alone in its migration (a new enum value cannot be
-- used in the transaction that adds it).
ALTER TYPE "sms_purpose" ADD VALUE 'BROADCAST';

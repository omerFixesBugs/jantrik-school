-- Exam result SMS (separate migration: a new enum value cannot be used in the transaction that adds it).
ALTER TYPE "sms_purpose" ADD VALUE 'EXAM_RESULT';

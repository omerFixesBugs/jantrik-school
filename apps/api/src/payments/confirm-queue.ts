import type { Queue } from 'bullmq';
import {
  CONFIRM_JOB,
  CONFIRM_JOB_OPTS,
  confirmJobId,
  type IntentJobData,
} from './payments.constants.js';

/**
 * Queue an intent's `confirm` (one per intent: `jobId confirm-<intentId>`). When one is already
 * waiting to be retried (the gateway did not answer earlier), it runs now instead of at its next
 * backoff: it reads the intent's signals afresh, so the new one is taken too.
 */
export async function queueConfirm(queue: Queue, data: IntentJobData): Promise<void> {
  const job = await queue.add(CONFIRM_JOB, data, {
    jobId: confirmJobId(data.intentId),
    ...CONFIRM_JOB_OPTS,
  });
  if (await job.isDelayed()) await job.promote().catch(() => undefined);
}

export const PROMOTIONS_QUEUE = 'promotions';
export const PROMOTION_APPLY_JOB = 'promotion-apply';
export const applyJobId = (runId: string) => `promotion-apply-${runId}`;

/** Job states in which a job will still run (so another must not be queued). */
export const LIVE_JOB_STATES = new Set([
  'active',
  'waiting',
  'delayed',
  'prioritized',
  'waiting-children',
]);

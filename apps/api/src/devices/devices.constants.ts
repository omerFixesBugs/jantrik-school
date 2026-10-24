/** The queue the device receiver (src/ingest) feeds and the API's devices worker reads. */
export const DEVICES_QUEUE = 'devices';

/** Processes an institute's new punches. */
export const PROCESS_PUNCHES_JOB = 'process-punches';

/** The whole job: the institute id comes from the database's answer, never from a device. */
export interface ProcessPunchesJob {
  tenantId: string;
}

/**
 * One waiting job per institute, so a burst of uploads is processed once. BullMQ refuses a ':' in
 * custom job ids, hence the dash.
 */
export const processPunchesJobId = (tenantId: string): string => `punches-${tenantId}`;

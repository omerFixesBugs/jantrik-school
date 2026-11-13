/** React Query keys of the devices screens and the dashboard card: [name, institute, ...params]. */
export const deviceKeys = {
  list: (tenantId?: string) => ['attendance-devices', tenantId] as const,
  alerts: (tenantId?: string) => ['attendance-device-alerts', tenantId] as const,
  punches: (tenantId: string | undefined, flagged: boolean) =>
    ['attendance-device-punches', tenantId, flagged ? 'flagged' : 'all'] as const,
  ips: (tenantId: string | undefined, deviceId: string) =>
    ['attendance-device-ips', tenantId, deviceId] as const,
  people: (tenantId?: string) => ['attendance-device-people', tenantId] as const,
  collisions: (tenantId?: string) => ['attendance-device-collisions', tenantId] as const,
  stale: (tenantId?: string) => ['attendance-device-stale', tenantId] as const,
};

/** Alerts are polled this often while the devices screen is visible. */
export const ALERTS_POLL_MS = 30_000;

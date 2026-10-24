'use client';

import { useQuery } from '@tanstack/react-query';
import type { DeviceAlert } from '@jantrik/shared';
import dynamic from 'next/dynamic';
import { useAuth } from '@/lib/auth/auth-provider';
import { deviceKeys } from '@/lib/devices/keys';

// The card and its wording load only when there is something to show.
const DeviceAlertsCard = dynamic(() => import('./dashboard-alerts-card'));

/**
 * The dashboard's device attention card (owners and admins with attendance on): one request for
 * the alerts, made once the first screen's own data is in; nothing when all is well.
 */
export function DeviceAlertsBanner({ ready }: { ready: boolean }) {
  const { client, session } = useAuth();
  const alerts = useQuery({
    queryKey: deviceKeys.alerts(session?.tenant?.id),
    queryFn: () => client.api<DeviceAlert[]>('/attendance/devices/alerts'),
    enabled: ready,
  });
  if (!alerts.data || alerts.data.length === 0) return null;
  return <DeviceAlertsCard alerts={alerts.data} />;
}

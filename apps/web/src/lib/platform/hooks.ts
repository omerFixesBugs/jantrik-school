import type { IsoDate, PlatformAdminInfo } from '@jantrik/shared';
import { useQuery } from '@tanstack/react-query';
import { platformApi } from './platform-api';

/** The signed-in platform admin (GET /platform/auth/me; 401 means signed out). */
export function usePlatformMe() {
  return useQuery({
    queryKey: ['platform-me'],
    queryFn: () => platformApi<PlatformAdminInfo>('/platform/auth/me'),
    retry: false,
    staleTime: 60_000,
  });
}

/**
 * Today in Asia/Dhaka, from the server: the platform pages never use the device's date. The
 * platform shell shows its pages only once the admin (and so this) is loaded.
 */
export function usePlatformToday(): IsoDate {
  const me = usePlatformMe().data;
  if (!me) throw new Error('usePlatformToday() is for pages inside the platform shell');
  return me.today;
}

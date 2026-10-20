import type { PlatformAdminInfo } from '@jantrik/shared';
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

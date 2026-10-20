'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/errors';
import { AuthProvider } from '@/lib/auth/auth-provider';

declare global {
  interface Window {
    /** Set once React has hydrated; read by the boot watchdog (boot-watchdog.ts). */
    __jantrikHydrated?: boolean;
  }
}

export function Providers({ children }: { children: ReactNode }) {
  // The platform area (Jantrik's own admins) has its own login; no institute session there.
  const platform = usePathname()?.startsWith('/platform') ?? false;
  // The page is alive: tell the boot watchdog, and take down its banner if a slow start showed it.
  useEffect(() => {
    window.__jantrikHydrated = true;
    document.querySelector('[data-testid="boot-failure"]')?.remove();
  }, []);

  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            // Retry network hiccups, never 4xx (they won't fix themselves).
            retry: (count, error) =>
              !(error instanceof ApiError && error.status < 500) && count < 2,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider inactive={platform}>{children}</AuthProvider>
      <Toaster position="top-center" />
    </QueryClientProvider>
  );
}

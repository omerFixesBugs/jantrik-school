import { PLATFORM_CLIENT } from '@jantrik/shared';
import { NetworkError, toApiError } from '@/lib/api/errors';
import { API_URL } from '@/lib/auth/auth-client';

/**
 * Platform API calls. The session is an httpOnly cookie on the API (path /platform), so the
 * browser never holds a token; every call sends X-Jantrik-Client: platform (CSRF defence).
 */
export async function platformApi<T>(
  path: string,
  init: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; json?: unknown } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: init.method ?? 'GET',
      credentials: 'include',
      headers: {
        'X-Jantrik-Client': PLATFORM_CLIENT,
        ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    });
  } catch {
    throw new NetworkError();
  }
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

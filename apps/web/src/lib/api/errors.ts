/** A non-2xx API response. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    /** Seconds from the Retry-After header (429). */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The server could not be reached. */
export class NetworkError extends Error {
  constructor() {
    super('Network error');
    this.name = 'NetworkError';
  }
}

/** No valid session (refresh failed). The app redirects to /login. */
export class SignedOutError extends Error {
  constructor() {
    super('Signed out');
    this.name = 'SignedOutError';
  }
}

/** The session now belongs to another institute than this page; the page must reload. */
export class TenantChangedError extends Error {
  constructor() {
    super('Institute changed');
    this.name = 'TenantChangedError';
  }
}

export async function toApiError(res: Response): Promise<ApiError> {
  let code: string | undefined;
  let message = res.statusText;
  try {
    const body = (await res.json()) as { code?: string; message?: unknown };
    code = body.code;
    if (typeof body.message === 'string') message = body.message;
  } catch {
    // not JSON
  }
  const retryAfter = Number(res.headers.get('Retry-After'));
  return new ApiError(
    res.status,
    code,
    message,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  );
}

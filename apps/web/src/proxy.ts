import { NextResponse, type NextRequest } from 'next/server';

// UX only, not security: the API (access token + RLS) is the real boundary. If the readable
// "signed in" hint cookie is missing, send the visitor to /login before rendering an app page,
// so signed-out users don't see a flash of the app shell. A forged hint just shows a skeleton
// that then redirects once the session bootstrap fails.
const HINT = 'jantrik_signed_in';

export function proxy(request: NextRequest) {
  if (request.cookies.get(HINT)?.value === '1') return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search =
    request.nextUrl.pathname === '/' ? '' : `?next=${encodeURIComponent(request.nextUrl.pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    '/',
    '/dashboard/:path*',
    '/students/:path*',
    '/sections/:path*',
    '/setup/:path*',
    '/staff/:path*',
    '/attendance/:path*',
    '/fees/:path*',
    '/children/:path*',
    '/exams/:path*',
    '/select-institute',
  ],
};

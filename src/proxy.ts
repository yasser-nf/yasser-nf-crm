import { NextResponse, type NextRequest } from "next/server";

import {
  DEFAULT_AUTHENTICATED_ROUTE,
  PUBLIC_ROUTES,
  REDIRECT_QUERY_PARAM,
  ROUTES,
} from "@/config/constants";
import { updateSupabaseSession } from "@/lib/supabase/middleware";

/**
 * Route protection.
 *
 * 02_ARCHITECTURE.md: protected routes, session validation, never trust the
 * frontend. Running this at the edge means an unauthenticated request is turned
 * away before any page code or data fetching runs — a client-side guard would
 * render first and redirect afterwards, briefly exposing the shell.
 *
 * Named `proxy` rather than `middleware`: Next.js 16 deprecated the middleware
 * file convention in favour of this one. Same execution model, current name.
 *
 * ADR-003: M01 enforces authenticated-versus-guest only. Role-based route
 * protection arrives once 03_DATABASE.md defines where a role is stored.
 */

/**
 * Carries the refreshed auth cookies onto a redirect.
 *
 * `updateSupabaseSession` may have rotated the session token. Returning a bare
 * redirect would discard it and sign the user out on the next request.
 */
function redirectPreservingSession(
  request: NextRequest,
  pathname: string,
  sessionResponse: NextResponse,
  searchParams?: Readonly<Record<string, string>>,
): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";

  for (const [key, value] of Object.entries(searchParams ?? {})) {
    url.searchParams.set(key, value);
  }

  const redirect = NextResponse.redirect(url);

  for (const cookie of sessionResponse.cookies.getAll()) {
    redirect.cookies.set(cookie);
  }

  return redirect;
}

export default async function proxy(request: NextRequest): Promise<NextResponse> {
  const { response, user } = await updateSupabaseSession(request);
  const { pathname } = request.nextUrl;

  const isAuthenticated = user !== null;
  const isPublicRoute = PUBLIC_ROUTES.includes(pathname);

  // The root path is a signpost, not a page.
  if (pathname === "/") {
    return redirectPreservingSession(
      request,
      isAuthenticated ? DEFAULT_AUTHENTICATED_ROUTE : ROUTES.LOGIN,
      response,
    );
  }

  if (!isAuthenticated && !isPublicRoute) {
    /*
     * Remember where they were headed so signing in returns them there rather
     * than dropping them on the dashboard.
     */
    return redirectPreservingSession(request, ROUTES.LOGIN, response, {
      [REDIRECT_QUERY_PARAM]: pathname,
    });
  }

  if (isAuthenticated && isPublicRoute) {
    return redirectPreservingSession(request, DEFAULT_AUTHENTICATED_ROUTE, response);
  }

  return response;
}

export const config = {
  /*
   * Skips static assets and image optimisation. Running an auth check on every
   * icon request would add a Supabase round trip to each one.
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};

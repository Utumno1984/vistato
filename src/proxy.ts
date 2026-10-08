import { NextResponse, type NextRequest } from "next/server";

import { REQUEST_PATH_HEADER } from "@/lib/auth/next-path";
import { parseSessionToken } from "@/lib/auth/session-token";

/**
 * Optimistic check for pages: no session cookie, no protected page. The authoritative check
 * (does the cookie map to a valid session?) is in the server layout of the protected area.
 * APIs are never matched: they answer 401 JSON by themselves.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (parseSessionToken(request.headers.get("cookie"))) {
    // Lets the server layout rebuild `next` if the cookie turns out not to map to a session.
    const headers = new Headers(request.headers);
    headers.set(REQUEST_PATH_HEADER, pathname + search);
    return NextResponse.next({ request: { headers } });
  }
  // Next requires an absolute URL here; it is built on the origin the request came in on.
  const login = new URL("/login", request.nextUrl);
  login.searchParams.set("next", pathname + search);
  const response = NextResponse.redirect(login);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const config = { matcher: ["/fatture", "/fatture/:path*"] };

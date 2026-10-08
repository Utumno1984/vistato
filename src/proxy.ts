import { NextResponse, type NextRequest } from "next/server";

import { parseSessionToken } from "@/lib/auth/session-token";

/**
 * Optimistic check for pages: no session cookie, no protected page. The authoritative check
 * (does the cookie map to a valid session?) is in the server layout of the protected area.
 * APIs are never matched: they answer 401 JSON by themselves.
 */
export function proxy(request: NextRequest) {
  if (parseSessionToken(request.headers.get("cookie"))) return NextResponse.next();
  const { pathname, search } = request.nextUrl;
  // Next requires an absolute URL here; it is built on the origin the request came in on.
  const login = new URL("/login", request.nextUrl);
  login.searchParams.set("next", pathname + search);
  const response = NextResponse.redirect(login);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const config = { matcher: ["/fatture", "/fatture/:path*"] };

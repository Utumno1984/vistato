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
  // Relative Location: correct also behind a reverse proxy, where request.url is the internal address.
  return new NextResponse(null, {
    status: 307,
    headers: { Location: `/login?next=${encodeURIComponent(pathname + search)}`, "Cache-Control": "no-store" },
  });
}

export const config = { matcher: ["/fatture", "/fatture/:path*"] };

import { deleteSession } from "@/db/auth";
import { getRequestSession, hasForeignOrigin } from "@/lib/auth/session";
import { clearedSessionCookie, readSessionToken } from "@/lib/auth/session-cookie";
import { forbiddenOrigin } from "@/lib/http/errors";

/** Ends the session of the cookie. Without a valid session there is nothing to do: 204 anyway. */
export async function POST(request: Request) {
  const session = await getRequestSession(request);
  // Only an authenticated request can be a cross-site forgery worth refusing.
  if (session && hasForeignOrigin(request)) return forbiddenOrigin();

  const token = readSessionToken(request);
  if (token) await deleteSession(token);
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": clearedSessionCookie(), "Cache-Control": "no-store" },
  });
}

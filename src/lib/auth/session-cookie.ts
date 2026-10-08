/** The session cookie: name, reading from a request, and the Set-Cookie headers. */
import { SESSION_DURATION_MS } from "@/db/auth";

import { parseSessionToken, SESSION_COOKIE_NAME } from "./session-token";

export { SESSION_COOKIE_NAME };

const MAX_AGE_SECONDS = Math.floor(SESSION_DURATION_MS / 1000);

/** Secure unless SESSION_COOKIE_SECURE=false (CI and e2e on http://localhost). */
function secureAttribute(): string {
  return process.env.SESSION_COOKIE_SECURE === "false" ? "" : "; Secure";
}

/** The value of the first `vistato_session` cookie of a request, or null. */
export function readSessionToken(request: Request): string | null {
  return parseSessionToken(request.headers.get("cookie"));
}

/** `Set-Cookie` value that stores the token for 7 days. The token is base64url: no escaping needed. */
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}; Max-Age=${MAX_AGE_SECONDS}; Path=/; HttpOnly; SameSite=Lax${secureAttribute()}`;
}

/** `Set-Cookie` value that clears the cookie. */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secureAttribute()}`;
}

/** The session cookie: name, reading from a request, and the Set-Cookie headers. */
import { SESSION_DURATION_MS } from "@/db/auth";

export const SESSION_COOKIE_NAME = "vistato_session";

const MAX_AGE_SECONDS = Math.floor(SESSION_DURATION_MS / 1000);

/** Secure unless SESSION_COOKIE_SECURE=false (CI and e2e on http://localhost). */
function secureAttribute(): string {
  return process.env.SESSION_COOKIE_SECURE === "false" ? "" : "; Secure";
}

/** The value of the first `vistato_session` cookie of a `Cookie` header, or null. */
export function readSessionToken(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === SESSION_COOKIE_NAME) return part.slice(separator + 1).trim();
  }
  return null;
}

/** `Set-Cookie` value that stores the token for 7 days. The token is base64url: no escaping needed. */
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}; Max-Age=${MAX_AGE_SECONDS}; Path=/; HttpOnly; SameSite=Lax${secureAttribute()}`;
}

/** `Set-Cookie` value that clears the cookie. */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secureAttribute()}`;
}

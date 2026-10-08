/**
 * Reading the session token out of a `Cookie` header. No database import: it is shared by
 * the `proxy` (optimistic check), the API routes and the Server Components, so they all
 * agree on which cookie counts when the header carries `vistato_session` more than once.
 */
export const SESSION_COOKIE_NAME = "vistato_session";

/** The value of the first `vistato_session` cookie of a `Cookie` header, or null. */
export function parseSessionToken(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === SESSION_COOKIE_NAME) return part.slice(separator + 1).trim();
  }
  return null;
}

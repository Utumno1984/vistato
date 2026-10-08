/**
 * Session checks shared by every API route and Server Component: the single place that
 * reads the cookie and resolves it (via `resolveSession`, the database is the only source
 * of the user and the tenant).
 */
import { cookies } from "next/headers";

import { resolveSession, type ResolvedSession } from "@/db/auth";
import { forTenant, type TenantScope } from "@/db/tenant-scope";
import { forbiddenOrigin, unauthenticated } from "@/lib/http/errors";

import { readSessionToken, SESSION_COOKIE_NAME } from "./session-cookie";

export interface AuthContext {
  sessionId: string;
  user: ResolvedSession["user"];
  tenant: ResolvedSession["tenant"];
  /** Bound to the session's tenant: later routes must use it for every tenant query. */
  scope: TenantScope;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function toContext(session: ResolvedSession): AuthContext {
  return { ...session, scope: forTenant(session.tenant.id) };
}

/** The valid session of the request, or null (no cookie, malformed, unknown, expired, user or tenant not active). */
export async function getRequestSession(request: Request): Promise<ResolvedSession | null> {
  const token = readSessionToken(request);
  return token ? resolveSession(token) : null;
}

/**
 * CSRF defence (with SameSite=Lax): a request that changes state and carries an `Origin`
 * header must come from the server's own origin. No header: allowed (non-browser clients).
 */
export function hasForeignOrigin(request: Request): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return false;
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  return origin !== new URL(request.url).origin;
}

/**
 * Guard for API routes: returns the authenticated context, or the `Response` to send back
 * (401 without a valid session, 403 for a state-changing request from another origin).
 * Usage: `const auth = await requireSession(request); if (auth instanceof Response) return auth;`
 */
export async function requireSession(request: Request): Promise<AuthContext | Response> {
  const session = await getRequestSession(request);
  if (!session) return unauthenticated();
  if (hasForeignOrigin(request)) return forbiddenOrigin();
  return toContext(session);
}

/** For Server Components (pages): the session from the request cookies, or null. */
export async function getSessionFromCookies(): Promise<AuthContext | null> {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await resolveSession(token) : null;
  return session ? toContext(session) : null;
}

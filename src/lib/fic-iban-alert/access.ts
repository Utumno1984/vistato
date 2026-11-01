/**
 * Access rule of the "supplier IBAN change alert" add-on (module `fic_iban_alert`).
 *
 * `ficIbanAlertAccess` is the single rule: the add-on endpoints (through
 * `requireFicIbanAlert`) and the HATEOAS links must both use it, so that a link is
 * shown exactly when the endpoint behind it would answer.
 *
 * The tenant is always the one of the session (`caller.scope`, built by `forTenant`
 * from the resolved session): never an ID received from the request.
 */
import type { AuthContext } from "@/lib/auth/session";
import type { ModuleCode, TenantScope } from "@/db/tenant-scope";
import { errorResponse, unauthenticated } from "@/lib/http/errors";

export const FIC_IBAN_ALERT_MODULE = "fic_iban_alert" satisfies ModuleCode;

/** What an add-on endpoint needs: reading (any role) or managing (OWNER and ADMIN). */
export type FicIbanAlertNeed = "read" | "manage";

export interface FicIbanAlertAccess {
  /** The module is active for the session's tenant now (false for a SUSPENDED or CLOSED tenant). */
  moduleActive: boolean;
  canRead: boolean;
  canManage: boolean;
}

/** The part of the session the rule depends on: the role and the scope bound to the session's tenant. */
export interface FicIbanAlertCaller {
  user: { role: string };
  scope: Pick<TenantScope, "hasModule">;
}

function isManagerRole(role: string): boolean {
  return role === "OWNER" || role === "ADMIN";
}

/**
 * Whether the caller may use the add-on now: `canRead` for every role and `canManage`
 * only for OWNER and ADMIN, both only while the module is active for the tenant
 * (`hasModule`: ACTIVE tenant, ACTIVE row, `activated_at <= at < expires_at`).
 * @param at the reference instant, for deterministic boundary tests.
 */
export async function ficIbanAlertAccess(caller: FicIbanAlertCaller, at?: Date): Promise<FicIbanAlertAccess> {
  const moduleActive = await caller.scope.hasModule(FIC_IBAN_ALERT_MODULE, at);
  return {
    moduleActive,
    canRead: moduleActive,
    canManage: moduleActive && isManagerRole(caller.user.role),
  };
}

/**
 * Guard for the add-on API routes, after `requireSession`. Checks, in order:
 * 1. no session: 401 `unauthenticated` (before anything else, no query);
 * 2. module not active for the session's tenant: 403 `module_not_active`;
 * 3. `need` is "manage" (or anything other than "read") and the role is not OWNER/ADMIN: 403 `forbidden`.
 * Returns the session itself when access is granted.
 *
 * Usage:
 * `const auth = await requireSession(request); if (auth instanceof Response) return auth;`
 * `const ok = await requireFicIbanAlert(auth, "manage"); if (ok instanceof Response) return ok;`
 */
export async function requireFicIbanAlert(
  session: AuthContext | null | undefined,
  need: FicIbanAlertNeed,
): Promise<AuthContext | Response> {
  if (!session) return unauthenticated();
  const access = await ficIbanAlertAccess(session);
  if (!access.moduleActive) {
    return errorResponse(403, "module_not_active", "Il modulo Alert cambio IBAN fornitori non è attivo per la tua azienda");
  }
  // Fail closed: only an explicit "read" is satisfied by canRead.
  const allowed = need === "read" ? access.canRead : access.canManage;
  if (!allowed) return errorResponse(403, "forbidden", "Non hai i permessi per gestire l'alert cambio IBAN fornitori");
  return session;
}

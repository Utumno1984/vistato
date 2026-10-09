import { UserNotInTenantError, ValidationError } from "@/db/errors";
import type { InvoiceDecision } from "@/db/tenant-scope";
import { requireSession } from "@/lib/auth/session";
import { errorResponse, invalidRequest, type ApiIssue } from "@/lib/http/errors";

import { canDecideInvoice, isDecisionRole } from "./permissions";
import { loadDeciders, toInvoiceResource } from "./resource";

export const REJECTION_REASON_MAX_LENGTH = 1000;

/**
 * Reads the optional `{ reason }` body of a rejection. An empty body is fine; anything that
 * is not a JSON object, or a `reason` that is not a string or is too long, is a 400.
 */
async function readReason(request: Request): Promise<{ reason: string | null } | { issues: ApiIssue[] }> {
  const text = await request.text();
  if (text.trim() === "") return { reason: null };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { issues: [{ field: "body", message: "Il corpo della richiesta non è un JSON valido" }] };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { issues: [{ field: "body", message: "Il corpo della richiesta deve essere un oggetto JSON" }] };
  }
  const reason = (body as { reason?: unknown }).reason;
  if (reason === undefined) return { reason: null };
  if (typeof reason !== "string") return { issues: [{ field: "reason", message: "Il motivo deve essere una stringa" }] };
  if (reason.length > REJECTION_REASON_MAX_LENGTH) {
    return { issues: [{ field: "reason", message: `Il motivo può avere al massimo ${REJECTION_REASON_MAX_LENGTH} caratteri` }] };
  }
  return { reason };
}

/**
 * Shared by `POST /api/invoices/{id}/approve` and `/reject`. Order of the checks: session (401),
 * origin (403), invoice in the tenant (404), role (403), body (400), transition (409).
 */
export async function decideInvoice(request: Request, id: string, decision: InvoiceDecision): Promise<Response> {
  const auth = await requireSession(request);
  if (auth instanceof Response) return auth;

  const invoice = await auth.scope.invoices.findById(id);
  if (!invoice) return errorResponse(404, "not_found", "Fattura non trovata");

  const caller = { userId: auth.user.id, role: auth.user.role };
  if (!isDecisionRole(caller)) {
    return errorResponse(403, "forbidden", "Non hai i permessi per approvare o rifiutare le fatture");
  }

  // The reason only matters for a rejection: approving ignores the body altogether.
  let reason: string | null = null;
  if (decision === "REJECTED") {
    const parsed = await readReason(request);
    if ("issues" in parsed) return invalidRequest(parsed.issues);
    reason = parsed.reason;
  }

  // Fast path for the common 409; the conditional UPDATE below is what guarantees it under concurrency.
  if (!canDecideInvoice(caller, invoice)) return alreadyDecided();

  try {
    const result = await auth.scope.invoices.decide(id, { decision, userId: auth.user.id, reason });
    if (result.outcome === "not_found") return errorResponse(404, "not_found", "Fattura non trovata");
    if (result.outcome === "already_decided") return alreadyDecided();
    const deciders = await loadDeciders(auth.scope, [result.invoice]);
    return Response.json(toInvoiceResource(result.invoice, caller, deciders), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      return invalidRequest(error.issues.map(({ field, message }) => ({ field, message })));
    }
    if (error instanceof UserNotInTenantError) return errorResponse(403, "forbidden", "Utente non abilitato");
    throw error;
  }
}

function alreadyDecided(): Response {
  return errorResponse(409, "invoice_already_decided", "La fattura è già stata approvata o rifiutata");
}

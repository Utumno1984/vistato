import { UserNotInTenantError, ValidationError } from "@/db/errors";
import type { InvoiceDecision } from "@/db/tenant-scope";
import { requireSession, type AuthContext } from "@/lib/auth/session";
import { errorResponse, invalidRequest, type ApiIssue } from "@/lib/http/errors";

import { noteTextSchema } from "@/lib/validation/text";

import { canDecideInvoice, isDecisionRole } from "./permissions";
import { loadDeciders, toInvoiceResource } from "./resource";

/** Limit on the raw reason text (UTF-16 code units, before trimming), as for the other free-text fields. */
export const REJECTION_REASON_MAX_LENGTH = 1000;

/** Anti-abuse cap on the request body of a rejection (the reason itself is at most 1000 characters). */
export const MAX_REJECT_BODY_BYTES = 8 * 1024;

/**
 * Reads the optional `{ reason }` body of a rejection. An empty body is fine; anything that
 * is not a JSON object, or a `reason` that is not a string or is too long, is a 400.
 */
async function readReason(request: Request): Promise<{ reason: string | null } | { issues: ApiIssue[] } | "too_large"> {
  const text = await readLimitedText(request);
  if (text === null) return "too_large";
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
  return parseReason(reason);
}

/** Validates a reason with the schema of the data layer (the 1000 limit is on the raw text, before trimming). */
export function parseReason(reason: unknown): { reason: string | null } | { issues: ApiIssue[] } {
  const parsed = noteTextSchema(REJECTION_REASON_MAX_LENGTH, "Il motivo deve essere una stringa").safeParse(reason);
  if (!parsed.success) {
    return { issues: parsed.error.issues.map((issue) => ({ field: "reason", message: issue.message })) };
  }
  return { reason: parsed.data || null };
}

/** The body as text, or null as soon as it exceeds `MAX_REJECT_BODY_BYTES`. */
async function readLimitedText(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REJECT_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REJECT_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Shared by `POST /api/invoices/{id}/approve` and `/reject`. Order of the checks: session (401),
 * origin (403), invoice in the tenant (404), role (403), body (400), transition (409).
 */
export async function decideInvoice(request: Request, id: string, decision: InvoiceDecision): Promise<Response> {
  const auth = await requireSession(request);
  if (auth instanceof Response) return auth;
  return decideInvoiceAs(auth, id, decision, () => readReason(request));
}

/**
 * The decision itself, for an already authenticated caller: the endpoints and the detail
 * page's Server Action share it, so permissions, validation and conflicts are identical.
 * `readBody` is called only for a rejection, after the invoice and role checks.
 */
export async function decideInvoiceAs(
  auth: AuthContext,
  id: string,
  decision: InvoiceDecision,
  readBody: () => Promise<{ reason: string | null } | { issues: ApiIssue[] } | "too_large">,
): Promise<Response> {
  const invoice = await auth.scope.invoices.findById(id);
  if (!invoice) return errorResponse(404, "not_found", "Fattura non trovata");

  const caller = { userId: auth.user.id, role: auth.user.role };
  if (!isDecisionRole(caller)) {
    return errorResponse(403, "forbidden", "Non hai i permessi per approvare o rifiutare le fatture");
  }

  // The reason only matters for a rejection: approving ignores the body altogether.
  let reason: string | null = null;
  if (decision === "REJECTED") {
    const parsed = await readBody();
    if (parsed === "too_large") {
      return errorResponse(413, "payload_too_large", "Il corpo della richiesta supera la dimensione massima di 8 KB");
    }
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

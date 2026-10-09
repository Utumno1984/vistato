"use server";

import { getSessionFromCookies } from "@/lib/auth/session";
import { decideInvoiceAs, parseReason } from "@/lib/invoices/decide";

export type DecisionOutcome =
  | { kind: "success" }
  | { kind: "unauthenticated" }
  | { kind: "error"; message: string };

const FALLBACK_MESSAGE = "Operazione non riuscita, riprova.";

/**
 * Server Action of the detail page: runs the same function as `POST /api/invoices/{id}/approve`
 * and `/reject` (same permission, validation and conflict rules; tenant from the session).
 * Always answers normally, so the browser logs nothing on a refused decision.
 */
export async function decideInvoiceAction(
  id: string,
  decision: "APPROVED" | "REJECTED",
  reason?: string,
): Promise<DecisionOutcome> {
  const auth = await getSessionFromCookies();
  if (!auth) return { kind: "unauthenticated" };
  if (typeof id !== "string" || (decision !== "APPROVED" && decision !== "REJECTED")) {
    return { kind: "error", message: FALLBACK_MESSAGE };
  }

  const response = await decideInvoiceAs(auth, id, decision, async () =>
    reason === undefined ? { reason: null } : parseReason(reason),
  );
  if (response.ok) return { kind: "success" };
  const body = (await response.json().catch(() => null)) as {
    message?: string;
    issues?: { message: string }[];
  } | null;
  if (response.status === 400 && body?.issues?.length) {
    return { kind: "error", message: body.issues.map((issue) => issue.message).join(" ") };
  }
  return { kind: "error", message: body?.message ?? FALLBACK_MESSAGE };
}

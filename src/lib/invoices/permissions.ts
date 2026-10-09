/** Roles that may decide on invoices (USER can only upload and read). */
function hasDecisionRole(caller: { role: string }): boolean {
  return caller.role === "OWNER" || caller.role === "ADMIN";
}

/**
 * The single rule deciding whether a caller may approve or reject an invoice, used by the
 * resource links and by the endpoints: OWNER and ADMIN, on a PENDING invoice.
 * When it is false, `isDecisionRole` tells the endpoint whether the reason is the role (403)
 * or the state (409).
 */
export function canDecideInvoice(caller: { role: string }, invoice: { status: string }): boolean {
  return hasDecisionRole(caller) && invoice.status === "PENDING";
}

export const isDecisionRole = hasDecisionRole;

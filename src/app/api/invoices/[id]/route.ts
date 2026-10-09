import { requireSession } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http/errors";
import { loadDeciders, toInvoiceResource } from "@/lib/invoices/resource";

/** An invoice of the caller's tenant. Another tenant's ID, an unknown one and a non-UUID all give the same 404. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSession(request);
  if (auth instanceof Response) return auth;

  const { id } = await params;
  const invoice = await auth.scope.invoices.findById(id);
  if (!invoice) return errorResponse(404, "not_found", "Fattura non trovata");

  const deciders = await loadDeciders(auth.scope, [invoice]);
  return Response.json(toInvoiceResource(invoice, { userId: auth.user.id, role: auth.user.role }, deciders), {
    headers: { "Cache-Control": "no-store" },
  });
}

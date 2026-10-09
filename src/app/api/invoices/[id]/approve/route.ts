import { decideInvoice } from "@/lib/invoices/decide";

/** Approves a PENDING invoice of the caller's tenant (OWNER or ADMIN). The decision is final. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return decideInvoice(request, (await params).id, "APPROVED");
}

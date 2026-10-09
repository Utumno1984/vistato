import { decideInvoice } from "@/lib/invoices/decide";

/** Rejects a PENDING invoice of the caller's tenant (OWNER or ADMIN), with an optional `{ reason }`. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return decideInvoice(request, (await params).id, "REJECTED");
}

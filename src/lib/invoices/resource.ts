import type { Invoice } from "@/db/tenant-scope";
import { buildLinks, resource, type Link } from "@/lib/hateoas";

/** Link to the upload action, shared by `/api` and `/api/me` (any active user may upload). */
export const UPLOAD_INVOICE_LINK: Link = { href: "/api/invoices", method: "POST", title: "Carica fattura" };

/** Link to the collection of the tenant's invoices (GET). */
export const INVOICES_COLLECTION_LINK: Link = { href: "/api/invoices", title: "Elenco fatture" };

/** Who is asking: reserved for the links that depend on permissions (approve, reject, ...). */
export interface InvoiceCaller {
  userId: string;
  role: string;
}

/**
 * The single source of the invoice API resource and of its links (API and pages).
 * Today only `self`; the approval and listing tickets add their links here.
 */
export function toInvoiceResource(invoice: Invoice, caller: InvoiceCaller) {
  void caller;
  return resource(
    {
      id: invoice.id,
      documentType: invoice.documentType,
      supplier: {
        name: invoice.supplierName,
        vatCountry: invoice.supplierVatCountry,
        vatCode: invoice.supplierVatCode,
      },
      number: invoice.invoiceNumber,
      date: invoice.invoiceDate,
      total: { amountCents: invoice.totalAmountCents, currency: invoice.currency },
      status: invoice.status,
      uploadedAt: invoice.createdAt.toISOString(),
      decidedAt: invoice.decidedAt ? invoice.decidedAt.toISOString() : null,
      rejectionReason: invoice.rejectionReason,
    },
    buildLinks([
      { rel: "self", link: { href: `/api/invoices/${invoice.id}` }, allowed: true },
      { rel: "collection", link: { href: "/api/invoices" }, allowed: true },
    ]),
  );
}

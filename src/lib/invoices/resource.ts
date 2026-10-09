import type { Invoice, TenantScope } from "@/db/tenant-scope";
import { buildLinks, resource, type Link } from "@/lib/hateoas";

import { canDecideInvoice } from "./permissions";

/** Link to the upload action, shared by `/api` and `/api/me` (any active user may upload). */
export const UPLOAD_INVOICE_LINK: Link = { href: "/api/invoices", method: "POST", title: "Carica fattura" };

/** Link to the collection of the tenant's invoices (GET). */
export const INVOICES_COLLECTION_LINK: Link = { href: "/api/invoices", title: "Elenco fatture" };

/** Who is asking: the links that depend on permissions (approve, reject) are built from it. */
export interface InvoiceCaller {
  userId: string;
  role: string;
}

/** The user who decided on an invoice, as exposed by the API. */
export interface InvoiceDecider {
  id: string;
  firstName: string;
  lastName: string;
}

export type InvoiceDeciders = ReadonlyMap<string, InvoiceDecider>;

/** Reads, inside the tenant, the users who decided on these invoices (one query per distinct user). */
export async function loadDeciders(scope: TenantScope, invoices: readonly Invoice[]): Promise<InvoiceDeciders> {
  const ids = [...new Set(invoices.flatMap((invoice) => (invoice.decidedByUserId ? [invoice.decidedByUserId] : [])))];
  const users = await Promise.all(ids.map((id) => scope.users.findById(id)));
  const deciders = new Map<string, InvoiceDecider>();
  for (const user of users) {
    if (user) deciders.set(user.id, { id: user.id, firstName: user.firstName, lastName: user.lastName });
  }
  return deciders;
}

/**
 * The single source of the invoice API resource and of its links (API and pages).
 * `approve` and `reject` follow `canDecideInvoice`, the rule the endpoints enforce.
 * `decidedBy` is present only for a decided invoice whose decider is in `deciders`.
 */
export function toInvoiceResource(invoice: Invoice, caller: InvoiceCaller, deciders?: InvoiceDeciders) {
  const decidedBy = invoice.decidedByUserId ? deciders?.get(invoice.decidedByUserId) : undefined;
  const canDecide = canDecideInvoice(caller, invoice);
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
      decidedBy,
      rejectionReason: invoice.rejectionReason,
    },
    buildLinks([
      { rel: "self", link: { href: `/api/invoices/${invoice.id}` }, allowed: true },
      { rel: "collection", link: { href: "/api/invoices" }, allowed: true },
      {
        rel: "approve",
        link: { href: `/api/invoices/${invoice.id}/approve`, method: "POST", title: "Approva" },
        allowed: canDecide,
      },
      {
        rel: "reject",
        link: { href: `/api/invoices/${invoice.id}/reject`, method: "POST", title: "Rifiuta" },
        allowed: canDecide,
      },
    ]),
  );
}

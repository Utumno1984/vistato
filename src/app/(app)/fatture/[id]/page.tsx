import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requirePageSession } from "@/lib/auth/page-session";
import { formatAmount } from "@/lib/format/amount";
import { formatDate, formatDateTime } from "@/lib/format/date";
import { hasLink } from "@/lib/hateoas";
import { STATUS_LABELS } from "@/lib/invoices/list-view";
import { loadDeciders, toInvoiceResource } from "@/lib/invoices/resource";

import { DecisionPanel } from "./decision-panel";

export const metadata: Metadata = { title: "Fattura · Vistato" };

/** One invoice of the tenant. Approve / reject are shown only when the resource has those links. */
export default async function InvoiceDetailPage({ params }: PageProps<"/fatture/[id]">) {
  const auth = await requirePageSession();
  const { id } = await params;
  // Another tenant's ID, an unknown one and a non-UUID all end here: the same 404.
  const invoice = await auth.scope.invoices.findById(id);
  if (!invoice) notFound();

  const deciders = await loadDeciders(auth.scope, [invoice]);
  const resource = toInvoiceResource(invoice, { userId: auth.user.id, role: auth.user.role }, deciders);
  const decidedBy = resource.decidedBy;
  const decider = decidedBy ? `${decidedBy.firstName} ${decidedBy.lastName}` : null;

  const rows: Array<[string, string]> = [
    ["Fornitore", resource.supplier.name],
    ["Partita IVA", `${resource.supplier.vatCountry} ${resource.supplier.vatCode}`],
    ["Tipo documento", resource.documentType],
    ["Numero", resource.number],
    ["Data", formatDate(resource.date)],
    ["Importo", formatAmount(resource.total.amountCents, resource.total.currency)],
    ["Stato", STATUS_LABELS[resource.status]],
    ["Caricata il", formatDateTime(resource.uploadedAt)],
  ];

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">
      <p>
        <Link href="/fatture" className="text-sm underline">
          Torna all&apos;elenco
        </Link>
      </p>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight">Fattura</h1>

      <dl className="mt-6 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="font-medium">{label}</dt>
            <dd className="break-words">{value}</dd>
          </div>
        ))}
      </dl>

      {resource.status !== "PENDING" && resource.decidedAt ? (
        <section aria-label="Esito" className="mt-6 text-sm">
          <p>
            {`${resource.status === "APPROVED" ? "Approvata" : "Rifiutata"}${decider ? ` da ${decider}` : ""} il ${formatDateTime(resource.decidedAt)}`}
          </p>
          {resource.status === "REJECTED" && resource.rejectionReason ? (
            <p className="mt-2">
              <span className="font-medium">Motivo: </span>
              <span className="whitespace-pre-wrap break-words">{resource.rejectionReason}</span>
            </p>
          ) : null}
        </section>
      ) : null}

      <DecisionPanel
        invoiceId={resource.id}
        canApprove={hasLink(resource, "approve")}
        canReject={hasLink(resource, "reject")}
      />
    </main>
  );
}

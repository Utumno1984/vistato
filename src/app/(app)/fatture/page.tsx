import type { Metadata } from "next";
import Link from "next/link";

import { requirePageSession } from "@/lib/auth/page-session";
import { formatAmount } from "@/lib/format/amount";
import { formatDate } from "@/lib/format/date";
import { hasLink } from "@/lib/hateoas";
import { toInvoiceCollection } from "@/lib/invoices/collection";
import {
  LIST_PAGE_SIZE,
  listPageHref,
  pageHrefFromCollectionLink,
  parseListPageParams,
  STATUS_FILTERS,
  STATUS_LABELS,
} from "@/lib/invoices/list-view";

import { UploadForm } from "./upload-form";

export const metadata: Metadata = { title: "Fatture · Vistato" };

/** The tenant's invoices: table, status filter and paging, all built from the HAL collection. */
export default async function InvoicesPage({ searchParams }: PageProps<"/fatture">) {
  const auth = await requirePageSession();
  const { status, page } = parseListPageParams(await searchParams);
  const query = { status, page, pageSize: LIST_PAGE_SIZE };
  const result = await auth.scope.invoices.list(query);
  const collection = toInvoiceCollection(result, query, { userId: auth.user.id, role: auth.user.role });
  const invoices = collection._embedded.invoices;
  const links = collection._links;
  const linkClass = "rounded border border-zinc-300 px-3 py-1 text-sm dark:border-zinc-700";

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
      <h1 className="text-3xl font-semibold tracking-tight">Fatture</h1>

      {hasLink(collection, "upload-invoice") ? <UploadForm /> : null}

      <nav aria-label="Filtro per stato" className="mt-6 flex flex-wrap gap-2">
        {STATUS_FILTERS.map((filter) => {
          const active = filter.status === status;
          return (
            <Link
              key={filter.label}
              href={listPageHref(filter.status, 1)}
              aria-current={active ? "page" : undefined}
              className={`${linkClass} ${active ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : ""}`}
            >
              {filter.label}
            </Link>
          );
        })}
      </nav>

      {invoices.length === 0 ? (
        <p className="mt-8 text-zinc-600 dark:text-zinc-400">Nessuna fattura</p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-300 dark:border-zinc-700">
                <th className="py-2 pr-4 font-medium">Fornitore</th>
                <th className="py-2 pr-4 font-medium">Numero</th>
                <th className="py-2 pr-4 font-medium">Data</th>
                <th className="py-2 pr-4 text-right font-medium">Importo</th>
                <th className="py-2 font-medium">Stato</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => (
                <tr key={invoice.id} className="border-b border-zinc-200 dark:border-zinc-800">
                  <td className="max-w-xs break-words py-2 pr-4">{invoice.supplier.name}</td>
                  <td className="max-w-xs break-words py-2 pr-4">
                    <Link href={`/fatture/${invoice.id}`} className="underline">
                      {invoice.number}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap py-2 pr-4">{formatDate(invoice.date)}</td>
                  <td className="whitespace-nowrap py-2 pr-4 text-right">
                    {formatAmount(invoice.total.amountCents, invoice.total.currency)}
                  </td>
                  <td className="whitespace-nowrap py-2">{STATUS_LABELS[invoice.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {collection.totalPages > 0 || hasLink(collection, "prev") ? (
        <nav aria-label="Paginazione" className="mt-6 flex items-center gap-4">
          {hasLink(collection, "prev") ? (
            <Link href={pageHrefFromCollectionLink(links.prev.href)} rel="prev" className={linkClass}>
              Precedente
            </Link>
          ) : null}
          {collection.page <= collection.totalPages ? (
            <span className="text-sm">{`Pagina ${collection.page} di ${collection.totalPages}`}</span>
          ) : null}
          {hasLink(collection, "next") ? (
            <Link href={pageHrefFromCollectionLink(links.next.href)} rel="next" className={linkClass}>
              Successiva
            </Link>
          ) : null}
        </nav>
      ) : null}
    </main>
  );
}

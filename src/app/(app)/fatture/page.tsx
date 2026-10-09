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
  statusBadgeVariant,
} from "@/lib/invoices/list-view";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

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
  const pagerClass = buttonVariants({ variant: "outline" });

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
              className={buttonVariants({ variant: active ? "default" : "outline" })}
            >
              {filter.label}
            </Link>
          );
        })}
      </nav>

      {invoices.length === 0 ? (
        <p className="mt-8 text-zinc-600 dark:text-zinc-400">Nessuna fattura</p>
      ) : (
        <div className="mt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fornitore</TableHead>
                <TableHead>Numero</TableHead>
                <TableHead>Data</TableHead>
                <TableHead className="text-right">Importo</TableHead>
                <TableHead>Stato</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((invoice) => (
                <TableRow key={invoice.id}>
                  <TableCell className="max-w-xs break-words whitespace-normal">{invoice.supplier.name}</TableCell>
                  <TableCell className="max-w-xs break-words whitespace-normal">
                    <Link href={`/fatture/${invoice.id}`} className="underline">
                      {invoice.number}
                    </Link>
                  </TableCell>
                  <TableCell>{formatDate(invoice.date)}</TableCell>
                  <TableCell className="text-right">
                    {formatAmount(invoice.total.amountCents, invoice.total.currency)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusBadgeVariant(invoice.status)}>{STATUS_LABELS[invoice.status]}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {collection.totalPages > 0 || hasLink(collection, "prev") ? (
        <nav aria-label="Paginazione" className="mt-6 flex items-center gap-4">
          {hasLink(collection, "prev") ? (
            <Link href={pageHrefFromCollectionLink(links.prev.href)} rel="prev" className={pagerClass}>
              Precedente
            </Link>
          ) : null}
          {collection.page <= collection.totalPages ? (
            <span className="text-sm">{`Pagina ${collection.page} di ${collection.totalPages}`}</span>
          ) : null}
          {hasLink(collection, "next") ? (
            <Link href={pageHrefFromCollectionLink(links.next.href)} rel="next" className={pagerClass}>
              Successiva
            </Link>
          ) : null}
        </nav>
      ) : null}
    </main>
  );
}

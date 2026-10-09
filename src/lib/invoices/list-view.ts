import type { InvoiceStatus } from "@/db/tenant-scope";

import { parseInvoiceListQuery } from "./collection";

export const STATUS_LABELS: Readonly<Record<InvoiceStatus, string>> = {
  PENDING: "Da approvare",
  APPROVED: "Approvata",
  REJECTED: "Rifiutata",
};

export type StatusBadgeVariant = "secondary" | "success" | "destructive";

/** Badge variant of a status; the text always comes from STATUS_LABELS (colour is never the only cue). */
export function statusBadgeVariant(status: InvoiceStatus): StatusBadgeVariant {
  switch (status) {
    case "PENDING":
      return "secondary";
    case "APPROVED":
      return "success";
    case "REJECTED":
      return "destructive";
  }
}

export const STATUS_FILTERS: ReadonlyArray<{ status?: InvoiceStatus; label: string }> = [
  { label: "Tutte" },
  { status: "PENDING", label: "Da approvare" },
  { status: "APPROVED", label: "Approvate" },
  { status: "REJECTED", label: "Rifiutate" },
];

/** The fixed page size of the page (the API's default). */
export const LIST_PAGE_SIZE = 20;

type RawParams = Record<string, string | string[] | undefined>;

/**
 * `status` and `page` of the page URL. Each invalid value (unknown status, wrong case,
 * non-numeric or repeated page, ...) falls back to its default on its own: the page never fails.
 */
export function parseListPageParams(raw: RawParams): { status?: InvoiceStatus; page: number } {
  const only = (name: string) => {
    const value = raw[name];
    const params = new URLSearchParams();
    if (Array.isArray(value)) for (const v of value) params.append(name, v);
    else if (value !== undefined) params.set(name, value);
    const parsed = parseInvoiceListQuery(params);
    return parsed.ok ? parsed.query : undefined;
  };
  return { status: only("status")?.status, page: only("page")?.page ?? 1 };
}

/** The URL of the page for a filter and a page: defaults (all, page 1) are left out. */
export function listPageHref(status: InvoiceStatus | undefined, page: number): string {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/fatture?${query}` : "/fatture";
}

/** Turns a collection link (`/api/invoices?...`) into the matching page URL. */
export function pageHrefFromCollectionLink(href: string): string {
  const params = new URL(href, "http://localhost").searchParams;
  const parsed = parseInvoiceListQuery(params);
  if (!parsed.ok) return "/fatture";
  return listPageHref(parsed.query.status, parsed.query.page);
}

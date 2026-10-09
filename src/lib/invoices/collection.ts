import { z } from "zod";

import type { InvoicePage, InvoiceStatus } from "@/db/tenant-scope";
import type { ApiIssue } from "@/lib/http/errors";
import { buildLinks, type Link, type Links } from "@/lib/hateoas";

import { UPLOAD_INVOICE_LINK, toInvoiceResource, type InvoiceCaller, type InvoiceDeciders } from "./resource";

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
const STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const satisfies readonly InvoiceStatus[];

export interface InvoiceListQuery {
  status?: InvoiceStatus;
  page: number;
  pageSize: number;
}

/** A single query parameter: absent or empty means "not given"; repeated is an error. */
function single(params: URLSearchParams, name: string): { value?: string; issue?: ApiIssue } {
  const values = params.getAll(name);
  if (values.length > 1) return { issue: { field: name, message: "Il parametro non può essere ripetuto" } };
  return { value: values[0] === "" ? undefined : values[0] };
}

const integerText = /^[0-9]+$/;

function integerParam(
  raw: string | undefined,
  field: string,
  fallback: number,
  min: number,
  max: number,
  issues: ApiIssue[],
): number {
  if (raw === undefined) return fallback;
  const value = integerText.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    issues.push({
      field,
      message:
        max === Number.MAX_SAFE_INTEGER
          ? `Il parametro ${field} deve essere un numero intero maggiore o uguale a ${min}`
          : `Il parametro ${field} deve essere un numero intero tra ${min} e ${max}`,
    });
    return fallback;
  }
  return value;
}

/** Validates `status`, `page` and `pageSize` of the query string. All the problems are reported together. */
export function parseInvoiceListQuery(
  params: URLSearchParams,
): { ok: true; query: InvoiceListQuery } | { ok: false; issues: ApiIssue[] } {
  const issues: ApiIssue[] = [];
  const status = single(params, "status");
  const page = single(params, "page");
  const pageSize = single(params, "pageSize");
  for (const part of [status, page, pageSize]) if (part.issue) issues.push(part.issue);

  let statusValue: InvoiceStatus | undefined;
  if (status.value !== undefined) {
    const parsed = z.enum(STATUSES).safeParse(status.value);
    if (parsed.success) statusValue = parsed.data;
    else issues.push({ field: "status", message: `Lo stato deve essere uno tra ${STATUSES.join(", ")}` });
  }
  const pageValue = page.issue ? 1 : integerParam(page.value, "page", 1, 1, Number.MAX_SAFE_INTEGER, issues);
  const pageSizeValue = pageSize.issue
    ? DEFAULT_PAGE_SIZE
    : integerParam(pageSize.value, "pageSize", DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE, issues);

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, query: { status: statusValue, page: pageValue, pageSize: pageSizeValue } };
}

function pageHref({ status, pageSize }: Pick<InvoiceListQuery, "status" | "pageSize">, page: number): string {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  params.set("page", String(page));
  params.set("pageSize", String(pageSize));
  return `/api/invoices?${params.toString()}`;
}

/**
 * The HAL collection of one page of invoices, shared by the API and the pages.
 * `prev` exists only after the first page (past the last page it points to the last one),
 * `next` only before the last.
 */
export function toInvoiceCollection(
  result: InvoicePage,
  query: InvoiceListQuery,
  caller: InvoiceCaller,
  deciders?: InvoiceDeciders,
) {
  const { items, totalItems } = result;
  const { page, pageSize } = query;
  const totalPages = Math.ceil(totalItems / pageSize);
  const lastPage = Math.max(totalPages, 1);
  const link = (target: number): Link => ({ href: pageHref(query, target) });
  const links: Links = buildLinks([
    { rel: "self", link: link(page), allowed: true },
    { rel: "first", link: link(1), allowed: true },
    { rel: "prev", link: link(Math.min(page - 1, lastPage)), allowed: page > 1 },
    { rel: "next", link: link(page + 1), allowed: page < totalPages },
    { rel: "last", link: link(lastPage), allowed: true },
    { rel: "upload-invoice", link: UPLOAD_INVOICE_LINK, allowed: true },
  ]);
  return {
    page,
    pageSize,
    totalItems,
    totalPages,
    _embedded: { invoices: items.map((invoice) => toInvoiceResource(invoice, caller, deciders)) },
    _links: links,
  };
}

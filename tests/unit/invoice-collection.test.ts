import { describe, expect, it } from "vitest";

import { parseInvoiceListQuery, toInvoiceCollection } from "@/lib/invoices/collection";

const caller = { userId: "u", role: "USER" };
const empty = (totalItems: number) => ({ items: [], totalItems });

describe("parseInvoiceListQuery", () => {
  it("uses page 1 and pageSize 20 by default and treats an empty status as absent", () => {
    expect(parseInvoiceListQuery(new URLSearchParams("status="))).toEqual({
      ok: true,
      query: { status: undefined, page: 1, pageSize: 20 },
    });
  });

  it("refuses a repeated page", () => {
    const res = parseInvoiceListQuery(new URLSearchParams("page=1&page=2"));
    expect(res).toMatchObject({ ok: false, issues: [{ field: "page" }] });
  });
});

describe("toInvoiceCollection", () => {
  it("builds first, prev, next and last keeping status and pageSize", () => {
    const res = toInvoiceCollection(empty(45), { status: "APPROVED", page: 2, pageSize: 10 }, caller);
    expect(res.totalPages).toBe(5);
    expect(res._links.prev.href).toBe("/api/invoices?status=APPROVED&page=1&pageSize=10");
    expect(res._links.next.href).toBe("/api/invoices?status=APPROVED&page=3&pageSize=10");
    expect(res._links.last.href).toBe("/api/invoices?status=APPROVED&page=5&pageSize=10");
  });

  it("has no prev on page 1 and no next on the last page", () => {
    const one = toInvoiceCollection(empty(20), { page: 1, pageSize: 20 }, caller);
    expect(one._links).not.toHaveProperty("prev");
    expect(one._links).not.toHaveProperty("next");
    expect(one.totalPages).toBe(1);
  });
});

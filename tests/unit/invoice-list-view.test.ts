import { describe, expect, it } from "vitest";

import { listPageHref, pageHrefFromCollectionLink, parseListPageParams } from "@/lib/invoices/list-view";

describe("parseListPageParams", () => {
  it("reads a valid status and page", () => {
    expect(parseListPageParams({ status: "APPROVED", page: "3" })).toEqual({ status: "APPROVED", page: 3 });
  });

  it("uses the defaults when absent or empty", () => {
    expect(parseListPageParams({})).toEqual({ status: undefined, page: 1 });
    expect(parseListPageParams({ status: "", page: "" })).toEqual({ status: undefined, page: 1 });
  });

  it("falls back per parameter when a value is invalid", () => {
    expect(parseListPageParams({ status: "pending", page: "2" })).toEqual({ status: undefined, page: 2 });
    expect(parseListPageParams({ status: "PENDING", page: "abc" })).toEqual({ status: "PENDING", page: 1 });
    for (const page of ["0", "-1", "1.5", "99999999999999999999", " 2"]) {
      expect(parseListPageParams({ page }).page, page).toBe(1);
    }
  });

  it("treats repeated parameters as invalid", () => {
    expect(parseListPageParams({ status: ["PENDING", "APPROVED"], page: ["1", "2"] })).toEqual({
      status: undefined,
      page: 1,
    });
  });
});

describe("page links", () => {
  it("leaves out the defaults", () => {
    expect(listPageHref(undefined, 1)).toBe("/fatture");
    expect(listPageHref("APPROVED", 1)).toBe("/fatture?status=APPROVED");
    expect(listPageHref(undefined, 2)).toBe("/fatture?page=2");
    expect(listPageHref("REJECTED", 3)).toBe("/fatture?status=REJECTED&page=3");
  });

  it("converts a collection link, dropping pageSize and keeping the status", () => {
    expect(pageHrefFromCollectionLink("/api/invoices?page=2&pageSize=20")).toBe("/fatture?page=2");
    expect(pageHrefFromCollectionLink("/api/invoices?status=PENDING&page=1&pageSize=20")).toBe("/fatture?status=PENDING");
    expect(pageHrefFromCollectionLink("/api/invoices?status=PENDING&page=4&pageSize=20")).toBe(
      "/fatture?status=PENDING&page=4",
    );
  });
});

import { describe, expect, it } from "vitest";

import type { Invoice } from "@/db/tenant-scope";
import { canDecideInvoice, isDecisionRole } from "@/lib/invoices/permissions";
import { toInvoiceResource } from "@/lib/invoices/resource";

const ROLES = ["OWNER", "ADMIN", "USER"];
const STATUSES = ["PENDING", "APPROVED", "REJECTED"];

describe("canDecideInvoice", () => {
  it("is true only for OWNER and ADMIN on a PENDING invoice (role x status table)", () => {
    for (const role of ROLES) {
      for (const status of STATUSES) {
        const expected = (role === "OWNER" || role === "ADMIN") && status === "PENDING";
        expect(canDecideInvoice({ role }, { status }), `${role} ${status}`).toBe(expected);
      }
    }
  });

  it("refuses an unknown role", () => {
    expect(canDecideInvoice({ role: "SUPERUSER" }, { status: "PENDING" })).toBe(false);
    expect(isDecisionRole({ role: "" })).toBe(false);
  });
});

const base: Invoice = {
  id: "11111111-1111-4111-8111-111111111111",
  createdAt: new Date("2025-03-01T10:00:00.000Z"),
  updatedAt: new Date("2025-03-01T10:00:00.000Z"),
  tenantId: "22222222-2222-4222-8222-222222222222",
  documentType: "TD01",
  supplierName: "Acme",
  supplierVatCountry: "IT",
  supplierVatCode: "01234567890",
  invoiceNumber: "7",
  invoiceDate: "2025-02-28",
  totalAmountCents: 0,
  currency: "EUR",
  status: "PENDING",
  uploadedByUserId: "33333333-3333-4333-8333-333333333333",
  decidedByUserId: null,
  decidedAt: null,
  rejectionReason: null,
};

describe("toInvoiceResource approval links", () => {
  it("exposes approve and reject as POST links, following the same rule as the endpoints", () => {
    for (const role of ROLES) {
      for (const status of STATUSES) {
        const invoice = { ...base, status } as Invoice;
        const links = toInvoiceResource(invoice, { userId: "u", role })._links;
        const allowed = canDecideInvoice({ role }, invoice);
        expect("approve" in links, `${role} ${status} approve`).toBe(allowed);
        expect("reject" in links, `${role} ${status} reject`).toBe(allowed);
      }
    }
    const links = toInvoiceResource(base, { userId: "u", role: "ADMIN" })._links;
    expect(links.approve).toMatchObject({ method: "POST", href: `/api/invoices/${base.id}/approve` });
    expect(links.reject).toMatchObject({ method: "POST", href: `/api/invoices/${base.id}/reject` });
  });

  it("shows the decider name and the UTC decision instant of a decided invoice", () => {
    const decided = {
      ...base,
      status: "APPROVED",
      decidedByUserId: "44444444-4444-4444-8444-444444444444",
      decidedAt: new Date("2025-03-02T08:30:00.000Z"),
    } as Invoice;
    const decider = { id: decided.decidedByUserId!, firstName: "Anna", lastName: "Rossi" };
    const res = toInvoiceResource(decided, { userId: "u", role: "ADMIN" }, new Map([[decider.id, decider]]));
    expect(res).toMatchObject({ status: "APPROVED", decidedAt: "2025-03-02T08:30:00.000Z", decidedBy: decider });
    expect(res._links).not.toHaveProperty("approve");
  });
});

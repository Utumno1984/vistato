import { describe, expect, it } from "vitest";

import type { Invoice } from "@/db/tenant-scope";
import { parseFatturaPA } from "@/lib/fatturapa/parse";
import { toInvoiceResource } from "@/lib/invoices/resource";

import { buildFatturaPA } from "../fixtures/fatturapa/build";

const invoice: Invoice = {
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
  totalAmountCents: -100,
  currency: "EUR",
  status: "PENDING",
  uploadedByUserId: "33333333-3333-4333-8333-333333333333",
  decidedByUserId: null,
  decidedAt: null,
  rejectionReason: null,
};

describe("toInvoiceResource", () => {
  it("exposes the public fields and only the self link, without tenant or user IDs", () => {
    const res = toInvoiceResource(invoice, { userId: "u", role: "USER" });
    expect(res).toEqual({
      id: invoice.id,
      documentType: "TD01",
      supplier: { name: "Acme", vatCountry: "IT", vatCode: "01234567890" },
      number: "7",
      date: "2025-02-28",
      total: { amountCents: -100, currency: "EUR" },
      status: "PENDING",
      uploadedAt: "2025-03-01T10:00:00.000Z",
      decidedAt: null,
      decidedBy: null,
      rejectionReason: null,
      _links: { self: { href: `/api/invoices/${invoice.id}` }, collection: { href: "/api/invoices" } },
    });
  });
});

describe("parseFatturaPA normalizeVatCase", () => {
  it("refuses a lowercase country by default and uppercases it when asked", () => {
    const xml = buildFatturaPA({ vatCountry: "fr", vatCode: "ab123" });
    expect(parseFatturaPA(xml).ok).toBe(false);
    const result = parseFatturaPA(xml, { normalizeVatCase: true });
    expect(result.ok && result.data.supplierVatCountry).toBe("FR");
    expect(result.ok && result.data.supplierVatCode).toBe("AB123");
  });

  it("still refuses a wrong country when normalising", () => {
    expect(parseFatturaPA(buildFatturaPA({ vatCountry: "ita" }), { normalizeVatCase: true }).ok).toBe(false);
    expect(parseFatturaPA(buildFatturaPA({ vatCountry: "1t" }), { normalizeVatCase: true }).ok).toBe(false);
  });

  it("converts ASCII letters only: ligatures and the dotless i are refused, not folded to FF or IT", () => {
    const options = { normalizeVatCase: true };
    expect(parseFatturaPA(buildFatturaPA({ vatCountry: "ﬀ" }), options).ok).toBe(false);
    expect(parseFatturaPA(buildFatturaPA({ vatCountry: "ıt", vatCode: "01234567890" }), options).ok).toBe(false);
    expect(parseFatturaPA(buildFatturaPA({ vatCountry: "FR", vatCode: "ﬀ123" }), options).ok).toBe(false);
    expect(parseFatturaPA(buildFatturaPA({ vatCountry: "FR", vatCode: "ıb123" }), options).ok).toBe(false);
  });
});

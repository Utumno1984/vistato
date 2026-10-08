import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@/db/client";
import { DuplicateInvoiceError, TenantNotFoundError, UserNotInTenantError, ValidationError } from "@/db/errors";
import { requireTestDatabaseUrl } from "@/db/migrate";
import { createTenant } from "@/db/platform/tenants";
import * as schema from "@/db/schema";
import { forTenant, type CreateInvoiceInput } from "@/db/tenant-scope";

import { testDb, testSql } from "../helpers/db";

const UNKNOWN_UUID = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

async function expectError<T extends Error>(action: Promise<unknown>, type: new (...args: never[]) => T): Promise<T> {
  const error = await action.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(type);
  return error as T;
}

const invoice: CreateInvoiceInput = {
  documentType: "TD01",
  supplierName: "Forniture Rossi S.r.l.",
  supplierVatCountry: "IT",
  supplierVatCode: "01234567890",
  invoiceNumber: "2026/0042",
  invoiceDate: "2026-03-15",
  totalAmountCents: 122000,
  currency: "EUR",
};

let tenantA: string;
let tenantB: string;
let userA: string;
let userB: string;

beforeEach(async () => {
  tenantA = (await createTenant({ businessName: "Acme S.r.l.", vatNumber: "12345678903" }, testDb())).id;
  tenantB = (await createTenant({ businessName: "Beta S.r.l.", taxCode: "RSSMRA80A01H501U" }, testDb())).id;
  userA = (await scope(tenantA).users.create({ email: "a@acme.it", firstName: "A", lastName: "A", role: "USER" })).id;
  userB = (await scope(tenantB).users.create({ email: "b@beta.it", firstName: "B", lastName: "B", role: "USER" })).id;
});

const scope = (tenantId: string) => forTenant(tenantId, testDb());

async function countInvoices(tenantId?: string): Promise<number> {
  const [{ count }] = tenantId
    ? await testSql()`select count(*)::int as count from invoices where tenant_id = ${tenantId}`
    : await testSql()`select count(*)::int as count from invoices`;
  return count;
}

describe("invoices.create", () => {
  it("saves a PENDING invoice in the tenant, uploaded by the user, with empty decision fields", async () => {
    const created = await scope(tenantA).invoices.create(invoice, userA);
    expect(created).toMatchObject({
      ...invoice,
      tenantId: tenantA,
      status: "PENDING",
      uploadedByUserId: userA,
      decidedByUserId: null,
      decidedAt: null,
      rejectionReason: null,
    });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await scope(tenantA).invoices.findById(created.id)).toEqual(created);
    expect(await countInvoices(tenantA)).toBe(1);
  });

  it("ignores tenantId, status, id and decision fields in the input", async () => {
    const forged = {
      ...invoice,
      tenantId: tenantB,
      tenant_id: tenantB,
      id: UNKNOWN_UUID,
      status: "APPROVED",
      decidedAt: new Date().toISOString(),
      decidedByUserId: userA,
      rejectionReason: "no",
      uploadedByUserId: userB,
    };
    const created = await scope(tenantA).invoices.create(forged as CreateInvoiceInput, userA);
    expect(created.tenantId).toBe(tenantA);
    expect(created.id).not.toBe(UNKNOWN_UUID);
    expect(created.status).toBe("PENDING");
    expect(created.uploadedByUserId).toBe(userA);
    expect(created.decidedAt).toBeNull();
    expect(created.decidedByUserId).toBeNull();
    expect(created.rejectionReason).toBeNull();
    expect(await countInvoices(tenantB)).toBe(0);
  });

  it("rejects an uploader of another tenant with UserNotInTenantError and creates no row", async () => {
    const error = await expectError(scope(tenantA).invoices.create(invoice, userB), UserNotInTenantError);
    expect(error.userId).toBe(userB);
    expect(await countInvoices()).toBe(0);
  });

  it.each([UNKNOWN_UUID, "not-a-uuid", ""])("rejects the unknown uploader %j with UserNotInTenantError", async (id) => {
    await expectError(scope(tenantA).invoices.create(invoice, id), UserNotInTenantError);
    expect(await countInvoices()).toBe(0);
  });

  it("throws DuplicateInvoiceError for the same supplier, number and date; tenant B can create it", async () => {
    await scope(tenantA).invoices.create(invoice, userA);
    await expectError(scope(tenantA).invoices.create({ ...invoice, totalAmountCents: 1 }, userA), DuplicateInvoiceError);
    expect(await countInvoices(tenantA)).toBe(1);
    await scope(tenantB).invoices.create(invoice, userB);
    expect(await countInvoices(tenantB)).toBe(1);
  });

  it("treats a different supplier code, country or date as a different invoice", async () => {
    await scope(tenantA).invoices.create(invoice, userA);
    await scope(tenantA).invoices.create({ ...invoice, supplierVatCode: "99999999999" }, userA);
    await scope(tenantA).invoices.create({ ...invoice, supplierVatCountry: "FR" }, userA);
    await scope(tenantA).invoices.create({ ...invoice, invoiceDate: "2026-03-16" }, userA);
    expect(await countInvoices(tenantA)).toBe(4);
  });

  it("only trims the invoice number: a different case is a different invoice, surrounding spaces are not", async () => {
    await scope(tenantA).invoices.create(invoice, userA);
    // Documented behaviour: the comparison is exact, so "ab/1" and "AB/1" do not collide.
    await scope(tenantA).invoices.create({ ...invoice, invoiceNumber: "ab/1" }, userA);
    await scope(tenantA).invoices.create({ ...invoice, invoiceNumber: "AB/1" }, userA);
    await expectError(
      scope(tenantA).invoices.create({ ...invoice, invoiceNumber: "  2026/0042  " }, userA),
      DuplicateInvoiceError,
    );
    expect(await countInvoices(tenantA)).toBe(3);
  });

  it("lets exactly one of two concurrent creates of the same invoice succeed", async () => {
    const client = postgres(requireTestDatabaseUrl(), { max: 4, onnotice: () => {} });
    try {
      const db = drizzle(client, { schema }) as unknown as Database;
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () => forTenant(tenantA, db).invoices.create(invoice, userA)),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results) {
        if (r.status === "rejected") expect(r.reason).toBeInstanceOf(DuplicateInvoiceError);
      }
      expect(await countInvoices(tenantA)).toBe(1);
    } finally {
      await client.end();
    }
  });

  it("trims text fields", async () => {
    const created = await scope(tenantA).invoices.create(
      { ...invoice, supplierName: "  Rossi  ", supplierVatCode: " 123 ", currency: " EUR ", documentType: " TD04 " },
      userA,
    );
    expect(created).toMatchObject({ supplierName: "Rossi", supplierVatCode: "123", currency: "EUR", documentType: "TD04" });
  });

  it.each([
    ["supplierName", ""],
    ["supplierName", "   "],
    ["supplierVatCountry", "  "],
    ["supplierVatCode", ""],
    ["invoiceNumber", " \t "],
    ["documentType", ""],
    ["currency", ""],
    ["invoiceDate", " "],
    ["currency", "eur"],
    ["currency", "EU"],
    ["currency", "EURO"],
    ["supplierVatCountry", "it"],
    ["supplierVatCountry", "ITA"],
    ["supplierVatCountry", "I"],
    ["documentType", "TD1"],
    ["documentType", "td01"],
    ["documentType", "TD001"],
    ["documentType", "XX01"],
    ["supplierVatCode", "IT 123"],
    ["supplierVatCode", "A".repeat(29)],
    ["totalAmountCents", 10.5],
    ["totalAmountCents", Number.MAX_SAFE_INTEGER + 1],
    ["totalAmountCents", -(2 ** 63)],
    ["totalAmountCents", Number.NaN],
    ["totalAmountCents", Infinity],
    ["totalAmountCents", "100"],
    ["totalAmountCents", null],
    ["invoiceDate", "2026-02-30"],
    ["invoiceDate", "2025-02-29"],
    ["invoiceDate", "2026-13-01"],
    ["invoiceDate", "2026-00-10"],
    ["invoiceDate", "15/03/2026"],
    ["invoiceDate", "2026-03-15T10:00:00Z"],
    ["invoiceDate", "0000-01-01"],
    ["invoiceDate", 20260315],
  ])("rejects %s = %j with ValidationError and inserts nothing", async (field, value) => {
    const error = await expectError(
      scope(tenantA).invoices.create({ ...invoice, [field]: value } as CreateInvoiceInput, userA),
      ValidationError,
    );
    expect(error.fields).toEqual([field]);
    expect(await countInvoices()).toBe(0);
  });

  it("rejects missing required fields, reporting each of them", async () => {
    const error = await expectError(scope(tenantA).invoices.create({} as CreateInvoiceInput, userA), ValidationError);
    expect(error.fields.sort()).toEqual(
      [
        "currency",
        "documentType",
        "invoiceDate",
        "invoiceNumber",
        "supplierName",
        "supplierVatCode",
        "supplierVatCountry",
        "totalAmountCents",
      ].sort(),
    );
    expect(await countInvoices()).toBe(0);
  });

  it.each([0, -50000, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER])("saves the amount %d as it is", async (amount) => {
    const created = await scope(tenantA).invoices.create(
      { ...invoice, invoiceNumber: `N${amount}`, totalAmountCents: amount },
      userA,
    );
    expect(created.totalAmountCents).toBe(amount);
    expect((await scope(tenantA).invoices.findById(created.id))?.totalAmountCents).toBe(amount);
  });

  it("accepts 29 February in a leap year and not in a common year", async () => {
    const created = await scope(tenantA).invoices.create({ ...invoice, invoiceDate: "2028-02-29" }, userA);
    expect(created.invoiceDate).toBe("2028-02-29");
    await expectError(scope(tenantA).invoices.create({ ...invoice, invoiceDate: "2026-02-29" }, userA), ValidationError);
    // 1900 is not a leap year, 2000 is.
    await expectError(scope(tenantA).invoices.create({ ...invoice, invoiceDate: "1900-02-29" }, userA), ValidationError);
    await scope(tenantA).invoices.create({ ...invoice, invoiceDate: "2000-02-29" }, userA);
  });

  it("stores the invoice date as a calendar date, unaffected by the time zone", async () => {
    const created = await scope(tenantA).invoices.create({ ...invoice, invoiceDate: "2026-12-31" }, userA);
    expect(created.invoiceDate).toBe("2026-12-31");
  });

  it("throws TenantNotFoundError for a tenant that does not exist", async () => {
    await expectError(scope(UNKNOWN_UUID).invoices.create(invoice, userA), TenantNotFoundError);
    expect(await countInvoices()).toBe(0);
  });
});

describe("invoices.findById", () => {
  it("returns null for an invoice of another tenant", async () => {
    const created = await scope(tenantB).invoices.create(invoice, userB);
    expect(await scope(tenantA).invoices.findById(created.id)).toBeNull();
    expect(await scope(tenantB).invoices.findById(created.id)).toEqual(created);
  });

  it.each(["not-a-uuid", "", UNKNOWN_UUID, "' or 1=1 --", `${UNKNOWN_UUID}\u0000`])(
    "returns null, without driver errors, for %j",
    async (id) => {
      await scope(tenantA).invoices.create(invoice, userA);
      expect(await scope(tenantA).invoices.findById(id)).toBeNull();
    },
  );
});

describe("users and invoices", () => {
  it("does not let a user who uploaded an invoice be deleted (RESTRICT)", async () => {
    await scope(tenantA).invoices.create(invoice, userA);
    await expect(scope(tenantA).users.delete(userA)).rejects.toThrow();
    expect(await scope(tenantA).users.findById(userA)).not.toBeNull();
  });
});

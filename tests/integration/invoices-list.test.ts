import { beforeEach, describe, expect, it } from "vitest";

import { GET as getApi } from "@/app/api/route";
import { GET as listInvoices } from "@/app/api/invoices/route";
import { createSession } from "@/db/auth";
import { ValidationError } from "@/db/errors";
import { createTenant } from "@/db/platform/tenants";
import { invoices } from "@/db/schema";
import { forTenant, type ListInvoicesInput } from "@/db/tenant-scope";

import { randomVatNumber } from "../../e2e/helpers/create-test-tenant";
import { testDb } from "../helpers/db";

const BASE = "http://localhost:3100";

interface Ctx {
  tenantId: string;
  userId: string;
  token: string;
}

async function makeTenant(): Promise<Ctx> {
  const vatNumber = randomVatNumber();
  const tenant = await createTenant({ businessName: `T ${vatNumber}`, vatNumber }, testDb());
  const user = await forTenant(tenant.id, testDb()).users.create({
    email: `u-${vatNumber}@example.com`,
    firstName: "U",
    lastName: "U",
    role: "USER",
    status: "ACTIVE",
  });
  return { tenantId: tenant.id, userId: user.id, token: await createSession(user.id, tenant.id, testDb()) };
}

/** Inserts `count` invoices directly (fast, and allows fixed `created_at` and non-PENDING statuses). */
async function seed(
  ctx: Ctx,
  count: number,
  options: { status?: "PENDING" | "APPROVED" | "REJECTED"; createdAt?: Date } = {},
) {
  const status = options.status ?? "PENDING";
  const decided =
    status === "PENDING"
      ? {}
      : {
          decidedByUserId: ctx.userId,
          decidedAt: new Date(),
          ...(status === "REJECTED" ? { rejectionReason: "no" } : {}),
        };
  await testDb()
    .insert(invoices)
    .values(
      Array.from({ length: count }, (_, i) => ({
        tenantId: ctx.tenantId,
        documentType: "TD01",
        supplierName: "S",
        supplierVatCountry: "IT",
        supplierVatCode: "01234567890",
        invoiceNumber: `${status}-${i}`,
        invoiceDate: "2025-01-01",
        totalAmountCents: 100 + i,
        currency: "EUR",
        status,
        uploadedByUserId: ctx.userId,
        ...(options.createdAt ? { createdAt: options.createdAt } : {}),
        ...decided,
      })),
    );
}

let a: Ctx;
let b: Ctx;

beforeEach(async () => {
  a = await makeTenant();
  b = await makeTenant();
});

const list = (token: string | undefined, query = "") =>
  listInvoices(
    new Request(`${BASE}/api/invoices${query}`, { headers: token ? { cookie: `vistato_session=${token}` } : {} }),
  );

describe("invoices.list", () => {
  it("returns the page and the total of the tenant only, newest first", async () => {
    await seed(a, 25);
    await seed(b, 5);
    const scope = forTenant(a.tenantId, testDb());
    const first = await scope.invoices.list({ page: 1, pageSize: 20 });
    expect(first.totalItems).toBe(25);
    expect(first.items).toHaveLength(20);
    expect(first.items.every((i) => i.tenantId === a.tenantId)).toBe(true);
    const second = await scope.invoices.list({ page: 2, pageSize: 20 });
    expect(second.items).toHaveLength(5);
    const dates = [...first.items, ...second.items].map((i) => i.createdAt.getTime());
    expect(dates).toEqual([...dates].sort((x, y) => y - x));
  });

  it("orders by id descending when created_at is equal, the same way every time", async () => {
    await seed(a, 12, { createdAt: new Date("2025-05-05T10:00:00.000Z") });
    const scope = forTenant(a.tenantId, testDb());
    const once = (await scope.invoices.list({ page: 1, pageSize: 100 })).items.map((i) => i.id);
    const twice = (await scope.invoices.list({ page: 1, pageSize: 100 })).items.map((i) => i.id);
    expect(once).toEqual(twice);
    expect(once).toEqual([...once].sort().reverse());
    // Pages never overlap or skip items.
    const p1 = (await scope.invoices.list({ page: 1, pageSize: 5 })).items.map((i) => i.id);
    const p2 = (await scope.invoices.list({ page: 2, pageSize: 5 })).items.map((i) => i.id);
    const p3 = (await scope.invoices.list({ page: 3, pageSize: 5 })).items.map((i) => i.id);
    expect([...p1, ...p2, ...p3]).toEqual(once);
  });

  it("filters by status and counts only the matching invoices", async () => {
    await seed(a, 3, { status: "PENDING" });
    await seed(a, 2, { status: "APPROVED" });
    await seed(a, 4, { status: "REJECTED" });
    await seed(b, 6, { status: "APPROVED" });
    const scope = forTenant(a.tenantId, testDb());
    for (const [status, n] of [
      ["PENDING", 3],
      ["APPROVED", 2],
      ["REJECTED", 4],
    ] as const) {
      const res = await scope.invoices.list({ status, page: 1, pageSize: 20 });
      expect(res.totalItems).toBe(n);
      expect(res.items).toHaveLength(n);
      expect(res.items.every((i) => i.status === status)).toBe(true);
    }
    expect((await scope.invoices.list({ page: 1, pageSize: 20 })).totalItems).toBe(9);
  });

  it("returns an empty page past the end and for a tenant without invoices", async () => {
    await seed(a, 3);
    expect(await forTenant(a.tenantId, testDb()).invoices.list({ page: 5, pageSize: 20 })).toEqual({
      items: [],
      totalItems: 3,
    });
    expect(await forTenant(b.tenantId, testDb()).invoices.list({ page: 1, pageSize: 20 })).toEqual({
      items: [],
      totalItems: 0,
    });
  });

  it.each([
    { page: 0, pageSize: 20 },
    { page: -1, pageSize: 20 },
    { page: 1.5, pageSize: 20 },
    { page: 1, pageSize: 0 },
    { page: 1, pageSize: 101 },
    { page: 1, pageSize: 2.5 },
    { page: 1, pageSize: 20, status: "pending" },
  ])("rejects %j with ValidationError", async (input) => {
    await expect(forTenant(a.tenantId, testDb()).invoices.list(input as ListInvoicesInput)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe("GET /api/invoices", () => {
  it("answers 200 with the first page of 20 of 25, no invoice of another tenant, and the links", async () => {
    await seed(a, 25);
    await seed(b, 5);
    const res = await list(a.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ page: 1, pageSize: 20, totalItems: 25, totalPages: 2 });
    expect(body._embedded.invoices).toHaveLength(20);
    expect(body._links).toEqual({
      self: { href: "/api/invoices?page=1&pageSize=20" },
      first: { href: "/api/invoices?page=1&pageSize=20" },
      next: { href: "/api/invoices?page=2&pageSize=20" },
      last: { href: "/api/invoices?page=2&pageSize=20" },
      "upload-invoice": { href: "/api/invoices", method: "POST", title: "Carica fattura" },
    });
    for (const inv of body._embedded.invoices) {
      expect(inv._links.self.href).toBe(`/api/invoices/${inv.id}`);
      expect(inv._links.collection).toEqual({ href: "/api/invoices" });
    }
  });

  it("has prev and no next on the last page; links keep status and pageSize", async () => {
    await seed(a, 7, { status: "PENDING" });
    await seed(a, 2, { status: "APPROVED" });
    const body = await (await list(a.token, "?status=PENDING&page=2&pageSize=3")).json();
    expect(body).toMatchObject({ page: 2, pageSize: 3, totalItems: 7, totalPages: 3 });
    expect(body._embedded.invoices).toHaveLength(3);
    expect(body._links.prev.href).toBe("/api/invoices?status=PENDING&page=1&pageSize=3");
    expect(body._links.next.href).toBe("/api/invoices?status=PENDING&page=3&pageSize=3");
    const last = await (await list(a.token, "?status=PENDING&page=3&pageSize=3")).json();
    expect(last._links).not.toHaveProperty("next");
    expect(last._links.last.href).toBe("/api/invoices?status=PENDING&page=3&pageSize=3");
    expect(last._links.self.href).toBe(last._links.last.href);
  });

  it("filters by each status", async () => {
    await seed(a, 3, { status: "PENDING" });
    await seed(a, 2, { status: "APPROVED" });
    await seed(a, 1, { status: "REJECTED" });
    for (const [status, n] of [
      ["PENDING", 3],
      ["APPROVED", 2],
      ["REJECTED", 1],
    ] as const) {
      const body = await (await list(a.token, `?status=${status}`)).json();
      expect(body.totalItems).toBe(n);
      expect(body._embedded.invoices.map((i: { status: string }) => i.status)).toEqual(Array(n).fill(status));
    }
    // An empty status is no filter.
    expect((await (await list(a.token, "?status=")).json()).totalItems).toBe(6);
  });

  it("past the last page answers 200, empty, with prev to the last page and no next", async () => {
    await seed(a, 25);
    const res = await list(a.token, "?page=9");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body._embedded.invoices).toEqual([]);
    expect(body).toMatchObject({ page: 9, totalItems: 25, totalPages: 2 });
    expect(body._links.prev.href).toBe("/api/invoices?page=2&pageSize=20");
    expect(body._links).not.toHaveProperty("next");
  });

  it("answers 200 with zero totals and first/last on page 1 for a tenant without invoices", async () => {
    await seed(b, 3);
    const body = await (await list(a.token)).json();
    expect(body).toMatchObject({ totalItems: 0, totalPages: 0, _embedded: { invoices: [] } });
    expect(body._links.first.href).toBe("/api/invoices?page=1&pageSize=20");
    expect(body._links.last.href).toBe("/api/invoices?page=1&pageSize=20");
    expect(body._links).not.toHaveProperty("prev");
    expect(body._links).not.toHaveProperty("next");
    const far = await (await list(a.token, "?page=3")).json();
    expect(far._links.prev.href).toBe("/api/invoices?page=1&pageSize=20");
  });

  it("accepts pageSize 100 and page 1", async () => {
    expect((await list(a.token, "?page=1&pageSize=100")).status).toBe(200);
  });

  it.each([
    ["status=pending", "status"],
    ["status=DELETED", "status"],
    ["page=0", "page"],
    ["page=-1", "page"],
    ["page=1.5", "page"],
    ["page=abc", "page"],
    ["page=1&page=2", "page"],
    ["pageSize=0", "pageSize"],
    ["pageSize=101", "pageSize"],
    ["pageSize=2.5", "pageSize"],
    ["pageSize=abc", "pageSize"],
    ["page=99999999999999999999", "page"],
  ])("answers 400 invalid_request for %s, naming %s", async (query, field) => {
    const res = await list(a.token, `?${query}`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_request");
    expect(body.issues.map((i: { field: string }) => i.field)).toContain(field);
  });

  it("reports every invalid parameter together", async () => {
    const body = await (await list(a.token, "?status=x&page=0&pageSize=0")).json();
    expect(body.issues.map((i: { field: string }) => i.field)).toEqual(["status", "page", "pageSize"]);
  });

  it("answers 401 without a session", async () => {
    expect((await list(undefined)).status).toBe(401);
  });

  it("is listed in /api only for an authenticated caller", async () => {
    const authed = await (
      await getApi(new Request(`${BASE}/api`, { headers: { cookie: `vistato_session=${a.token}` } }))
    ).json();
    expect(authed._links.invoices).toEqual({ href: "/api/invoices", title: "Elenco fatture" });
    const anon = await (await getApi(new Request(`${BASE}/api`))).json();
    expect(anon._links).not.toHaveProperty("invoices");
  });
});

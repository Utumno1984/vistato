import { expect, test, type APIRequestContext } from "@playwright/test";

import { createTestTenant, type TestUser } from "./helpers/create-test-tenant";
import { buildInvoiceXml } from "./helpers/fatturapa";

async function loggedIn(
  playwright: { request: { newContext: (o: { baseURL: string }) => Promise<APIRequestContext> } },
  baseURL: string,
  user: TestUser,
) {
  const client = await playwright.request.newContext({ baseURL });
  const res = await client.post("/api/auth/login", { data: { email: user.email, password: user.password } });
  expect(res.status()).toBe(200);
  return client;
}

async function upload(client: APIRequestContext, count: number) {
  for (let i = 0; i < count; i++) {
    const res = await client.post("/api/invoices", {
      multipart: { file: { name: `f${i}.xml`, mimeType: "text/xml", buffer: Buffer.from(buildInvoiceXml({ number: `N-${i}` })) } },
    });
    expect(res.status()).toBe(201);
  }
}

test("25 invoices are paginated: pages 1 and 2 with first/prev/next/last, and tenant B never shows up", async ({
  playwright,
  baseURL,
}) => {
  const [a, b] = [await createTestTenant({ users: [{ role: "USER" }] }), await createTestTenant({ users: [{ role: "USER" }] })];
  const clientA = await loggedIn(playwright, baseURL!, a.users[0]);
  const clientB = await loggedIn(playwright, baseURL!, b.users[0]);
  await upload(clientA, 25);
  await upload(clientB, 5);

  const res = await clientA.get("/api/invoices");
  expect(res.status()).toBe(200);
  const page1 = await res.json();
  expect(page1).toMatchObject({ page: 1, pageSize: 20, totalItems: 25, totalPages: 2 });
  expect(page1._embedded.invoices).toHaveLength(20);
  expect(page1._links).not.toHaveProperty("prev");
  expect(page1._links["upload-invoice"]).toMatchObject({ href: "/api/invoices", method: "POST" });
  // Newest first.
  const uploaded = page1._embedded.invoices.map((i: { uploadedAt: string }) => i.uploadedAt);
  expect(uploaded).toEqual([...uploaded].sort().reverse());

  const page2 = await (await clientA.get(page1._links.next.href)).json();
  expect(page2.page).toBe(2);
  expect(page2._embedded.invoices).toHaveLength(5);
  expect(page2._links).not.toHaveProperty("next");
  expect(page2._links.first.href).toBe(page1._links.first.href);
  expect(page2._links.last.href).toBe(page2._links.self.href);
  const back = await (await clientA.get(page2._links.prev.href)).json();
  expect(back).toEqual(page1);

  // Pages hold 25 distinct invoices, each with the same links as the detail.
  const all = [...page1._embedded.invoices, ...page2._embedded.invoices];
  expect(new Set(all.map((i: { id: string }) => i.id)).size).toBe(25);
  const detail = await (await clientA.get(all[0]._links.self.href)).json();
  expect(all[0]).toEqual(detail);
  expect(detail._links.collection.href).toBe("/api/invoices");

  const forB = await (await clientB.get("/api/invoices")).json();
  expect(forB.totalItems).toBe(5);
  const idsA = new Set(all.map((i: { id: string }) => i.id));
  for (const inv of forB._embedded.invoices) expect(idsA.has(inv.id)).toBe(false);
});

test("the status filter keeps the filter and pageSize in the links", async ({ playwright, baseURL }) => {
  const tenant = await createTestTenant({ users: [{ role: "USER" }] });
  const client = await loggedIn(playwright, baseURL!, tenant.users[0]);
  await upload(client, 3);
  const pending = await (await client.get("/api/invoices?status=PENDING&pageSize=2")).json();
  expect(pending).toMatchObject({ totalItems: 3, totalPages: 2 });
  expect(pending._embedded.invoices).toHaveLength(2);
  expect(pending._links.next.href).toBe("/api/invoices?status=PENDING&page=2&pageSize=2");
  // No invoice can be approved or rejected yet through the API: these states are empty.
  for (const status of ["APPROVED", "REJECTED"]) {
    const body = await (await client.get(`/api/invoices?status=${status}`)).json();
    expect(body).toMatchObject({ totalItems: 0, totalPages: 0, _embedded: { invoices: [] } });
  }
  expect((await (await client.get("/api/invoices?status=")).json()).totalItems).toBe(3);
});

test("invalid parameters answer 400 invalid_request with the fields in issues", async ({ playwright, baseURL }) => {
  const tenant = await createTestTenant({ users: [{ role: "USER" }] });
  const client = await loggedIn(playwright, baseURL!, tenant.users[0]);
  const cases: Array<[string, string]> = [
    ["status=pending", "status"],
    ["status=UNKNOWN", "status"],
    ["page=0", "page"],
    ["page=-1", "page"],
    ["page=1.5", "page"],
    ["page=abc", "page"],
    ["page=1&page=2", "page"],
    ["pageSize=0", "pageSize"],
    ["pageSize=101", "pageSize"],
    ["pageSize=1.5", "pageSize"],
  ];
  for (const [query, field] of cases) {
    const res = await client.get(`/api/invoices?${query}`);
    expect(res.status(), query).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_request");
    expect(body.issues.map((i: { field: string }) => i.field), query).toContain(field);
  }
  expect((await client.get("/api/invoices?page=1&pageSize=100")).status()).toBe(200);
});

test("a page past the last is empty with prev to the last page; an empty tenant has totals at zero", async ({
  playwright,
  baseURL,
}) => {
  const tenant = await createTestTenant({ users: [{ role: "USER" }] });
  const client = await loggedIn(playwright, baseURL!, tenant.users[0]);
  const empty = await (await client.get("/api/invoices")).json();
  expect(empty).toMatchObject({ page: 1, pageSize: 20, totalItems: 0, totalPages: 0, _embedded: { invoices: [] } });
  expect(empty._links.first.href).toBe("/api/invoices?page=1&pageSize=20");
  expect(empty._links.last.href).toBe("/api/invoices?page=1&pageSize=20");
  expect(empty._links).not.toHaveProperty("prev");
  expect(empty._links).not.toHaveProperty("next");

  await upload(client, 3);
  const far = await (await client.get("/api/invoices?page=7&pageSize=2")).json();
  expect(far._embedded.invoices).toEqual([]);
  expect(far.totalPages).toBe(2);
  expect(far._links.prev.href).toBe("/api/invoices?page=2&pageSize=2");
  expect(far._links).not.toHaveProperty("next");
});

test("without a session the list answers 401", async ({ playwright, baseURL }) => {
  const anon = await playwright.request.newContext({ baseURL: baseURL! });
  expect((await anon.get("/api/invoices")).status()).toBe(401);
});

test("GET /api links to the invoices collection only when authenticated", async ({ playwright, baseURL }) => {
  const anon = await playwright.request.newContext({ baseURL: baseURL! });
  expect((await (await anon.get("/api")).json())._links).not.toHaveProperty("invoices");
  const tenant = await createTestTenant({ users: [{ role: "USER" }] });
  const client = await loggedIn(playwright, baseURL!, tenant.users[0]);
  const root = await (await client.get("/api")).json();
  expect(root._links.invoices.href).toBe("/api/invoices");
  const res = await client.get(root._links.invoices.href);
  expect(res.status()).toBe(200);
  expect((await res.json())._links.self.href).toBe("/api/invoices?page=1&pageSize=20");
});

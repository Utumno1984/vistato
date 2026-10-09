import { expect, test, type APIRequestContext } from "@playwright/test";

import { createTestTenant, type TestUser } from "./helpers/create-test-tenant";
import { buildInvoiceXml as buildFatturaPA } from "./helpers/fatturapa";

const MB = 1024 * 1024;

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

const xml = (name: string, content: string | Buffer = buildFatturaPA()) => ({
  file: { name, mimeType: "text/xml", buffer: Buffer.from(content) },
});

test("a valid XML is created (201, Location, resource) and GET self returns the same", async ({ playwright, baseURL }) => {
  const tenant = await createTestTenant({ users: [{ role: "USER" }] });
  const client = await loggedIn(playwright, baseURL!, tenant.users[0]);
  const res = await client.post("/api/invoices", { multipart: xml("fattura.xml") });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(res.headers()["location"]).toBe(`/api/invoices/${body.id}`);
  expect(body).toMatchObject({
    documentType: "TD01",
    supplier: { name: "Caffè & Co. S.r.l.", vatCountry: "IT", vatCode: "01234567890" },
    number: "FT/2024/001",
    date: "2024-02-29",
    total: { amountCents: 123450, currency: "EUR" },
    status: "PENDING",
    decidedAt: null,
    rejectionReason: null,
    _links: { self: { href: `/api/invoices/${body.id}` } },
  });
  expect(body.uploadedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  const again = await client.get(body._links.self.href);
  expect(again.status()).toBe(200);
  expect(await again.json()).toEqual(body);
});

test("an invoice of tenant A is a 404 for a user of tenant B, identical to an unknown ID", async ({ playwright, baseURL }) => {
  const [a, b] = [await createTestTenant({ users: [{ role: "OWNER" }] }), await createTestTenant({ users: [{ role: "OWNER" }] })];
  const clientA = await loggedIn(playwright, baseURL!, a.users[0]);
  const clientB = await loggedIn(playwright, baseURL!, b.users[0]);
  const { id } = await (await clientA.post("/api/invoices", { multipart: xml("a.xml") })).json();
  const other = await clientB.get(`/api/invoices/${id}`);
  const unknown = await clientB.get("/api/invoices/00000000-0000-4000-8000-000000000000");
  expect(other.status()).toBe(404);
  expect(unknown.status()).toBe(404);
  expect(await other.json()).toEqual({ error: "not_found", message: expect.any(String) });
  expect(await other.json()).toEqual(await unknown.json());
  expect((await clientB.get("/api/invoices/not-a-uuid")).status()).toBe(404);
});

test("without a session POST and GET answer 401", async ({ playwright, baseURL }) => {
  const anon = await playwright.request.newContext({ baseURL: baseURL! });
  expect((await anon.post("/api/invoices", { multipart: xml("a.xml") })).status()).toBe(401);
  expect((await anon.get("/api/invoices/00000000-0000-4000-8000-000000000000")).status()).toBe(401);
});

test("an invalid XML answers 422 invalid_invoice with Italian issues", async ({ playwright, baseURL }) => {
  const tenant = await createTestTenant({ users: [{ role: "USER" }] });
  const client = await loggedIn(playwright, baseURL!, tenant.users[0]);
  const bad = await client.post("/api/invoices", { multipart: xml("a.xml", buildFatturaPA({ date: "2025-02-30" })) });
  expect(bad.status()).toBe(422);
  const body = await bad.json();
  expect(body.error).toBe("invalid_invoice");
  expect(body.issues).toEqual([{ field: "invoiceDate", message: "La data della fattura non è valida (formato AAAA-MM-GG)" }]);
  const batch = await client.post("/api/invoices", { multipart: xml("a.xml", buildFatturaPA({ bodies: 2 })) });
  expect(batch.status()).toBe(422);
  const xxe = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><FatturaElettronica>&a;</FatturaElettronica>`;
  const xxeRes = await client.post("/api/invoices", { multipart: xml("a.xml", xxe) });
  expect(xxeRes.status()).toBe(422);
  expect(await xxeRes.text()).not.toContain("root:");
});

test("a request without a file, with several files or an empty file answers 400", async ({ playwright, baseURL }) => {
  const tenant = await createTestTenant({ users: [{ role: "USER" }] });
  const client = await loggedIn(playwright, baseURL!, tenant.users[0]);
  expect((await client.post("/api/invoices", { multipart: { other: "x" } })).status()).toBe(400);
  expect((await client.post("/api/invoices", { data: { file: "x" } })).status()).toBe(400);
  expect((await client.post("/api/invoices", { multipart: xml("a.xml", "") })).status()).toBe(400);
});

test("a file over 5 MB answers 413", async ({ playwright, baseURL }) => {
  const tenant = await createTestTenant({ users: [{ role: "USER" }] });
  const client = await loggedIn(playwright, baseURL!, tenant.users[0]);
  const res = await client.post("/api/invoices", { multipart: xml("big.xml", Buffer.alloc(5 * MB + 1, 0x20)) });
  expect(res.status()).toBe(413);
  expect((await res.json()).error).toBe("payload_too_large");
});

test("a .p7m or non-.xml file answers 415 in Italian; .XML in capitals is accepted", async ({ playwright, baseURL }) => {
  const tenant = await createTestTenant({ users: [{ role: "USER" }] });
  const client = await loggedIn(playwright, baseURL!, tenant.users[0]);
  for (const name of ["fattura.xml.p7m", "fattura.pdf"]) {
    const res = await client.post("/api/invoices", { multipart: xml(name) });
    expect(res.status(), name).toBe(415);
    expect((await res.json()).message).toMatch(/solo file XML/);
  }
  expect((await client.post("/api/invoices", { multipart: xml("FATTURA.XML") })).status()).toBe(201);
});

test("a duplicate answers 409 with the link to the existing invoice; another tenant can upload the same invoice", async ({ playwright, baseURL }) => {
  const [a, b] = [await createTestTenant({ users: [{ role: "USER" }] }), await createTestTenant({ users: [{ role: "USER" }] })];
  const clientA = await loggedIn(playwright, baseURL!, a.users[0]);
  const clientB = await loggedIn(playwright, baseURL!, b.users[0]);
  const first = await (await clientA.post("/api/invoices", { multipart: xml("a.xml") })).json();
  const dup = await clientA.post("/api/invoices", { multipart: xml("a.xml") });
  expect(dup.status()).toBe(409);
  const body = await dup.json();
  expect(body.error).toBe("duplicate_invoice");
  expect(body._links.self.href).toBe(first._links.self.href);
  expect((await clientB.post("/api/invoices", { multipart: xml("a.xml") })).status()).toBe(201);
  // The same supplier with the country in lower case is the same supplier.
  const lower = await clientA.post("/api/invoices", { multipart: xml("a.xml", buildFatturaPA({ vatCountry: "it" })) });
  expect(lower.status()).toBe(409);
});

test("tenantId and status fields in the form are ignored", async ({ playwright, baseURL }) => {
  const [a, b] = [await createTestTenant({ users: [{ role: "USER" }] }), await createTestTenant({ users: [{ role: "USER" }] })];
  const clientA = await loggedIn(playwright, baseURL!, a.users[0]);
  const clientB = await loggedIn(playwright, baseURL!, b.users[0]);
  const res = await clientA.post("/api/invoices", { multipart: { ...xml("a.xml"), tenantId: b.tenantId, status: "APPROVED" } });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body.status).toBe("PENDING");
  expect((await clientA.get(`/api/invoices/${body.id}`)).status()).toBe(200);
  expect((await clientB.get(`/api/invoices/${body.id}`)).status()).toBe(404);
});

test("an authenticated POST from a foreign Origin answers 403 and creates nothing", async ({ playwright, baseURL }) => {
  const tenant = await createTestTenant({ users: [{ role: "USER" }] });
  const client = await loggedIn(playwright, baseURL!, tenant.users[0]);
  const res = await client.post("/api/invoices", { multipart: xml("a.xml"), headers: { origin: "https://evil.example" } });
  expect(res.status()).toBe(403);
  expect((await client.post("/api/invoices", { multipart: xml("a.xml") })).status()).toBe(201);
});

test("the upload-invoice link is in /api and /api/me only for an authenticated caller", async ({ playwright, baseURL }) => {
  const tenant = await createTestTenant({ users: [{ role: "USER" }] });
  const client = await loggedIn(playwright, baseURL!, tenant.users[0]);
  const anon = await playwright.request.newContext({ baseURL: baseURL! });
  expect((await (await anon.get("/api")).json())._links).not.toHaveProperty("upload-invoice");
  const root = await (await client.get("/api")).json();
  expect(root._links["upload-invoice"]).toMatchObject({ href: "/api/invoices", method: "POST" });
  const me = await (await client.get("/api/me")).json();
  expect(me._links["upload-invoice"]).toMatchObject({ href: "/api/invoices", method: "POST" });
});

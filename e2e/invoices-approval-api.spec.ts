import { expect, test, type APIRequestContext } from "@playwright/test";

import { createTestTenant, type TestTenant, type TestUser } from "./helpers/create-test-tenant";
import { buildInvoiceXml } from "./helpers/fatturapa";

type Playwright = { request: { newContext: (o: { baseURL: string }) => Promise<APIRequestContext> } };

async function loggedIn(playwright: Playwright, baseURL: string, user: TestUser) {
  const client = await playwright.request.newContext({ baseURL });
  const res = await client.post("/api/auth/login", { data: { email: user.email, password: user.password } });
  expect(res.status()).toBe(200);
  return client;
}

let counter = 0;
async function upload(client: APIRequestContext): Promise<{ id: string }> {
  const number = `A-${Date.now()}-${counter++}`;
  const res = await client.post("/api/invoices", {
    multipart: { file: { name: "f.xml", mimeType: "text/xml", buffer: Buffer.from(buildInvoiceXml({ number })) } },
  });
  expect(res.status()).toBe(201);
  return res.json();
}

async function setup(playwright: Playwright, baseURL: string) {
  const tenant = await createTestTenant({ users: [{ role: "ADMIN" }, { role: "OWNER" }, { role: "USER" }] });
  const [admin, owner, user] = await Promise.all(tenant.users.map((u) => loggedIn(playwright, baseURL, u)));
  return { tenant, admin, owner, user };
}

const names = (tenant: TestTenant, role: string) => tenant.users.find((u) => u.role === role)!;

test("ADMIN and OWNER approve a PENDING invoice: APPROVED, decider, UTC instant, no approve/reject links", async ({
  playwright,
  baseURL,
}) => {
  const { tenant, admin, owner, user } = await setup(playwright, baseURL!);
  for (const [client, role] of [
    [admin, "ADMIN"],
    [owner, "OWNER"],
  ] as const) {
    const { id } = await upload(user);
    const res = await client.post(`/api/invoices/${id}/approve`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id, status: "APPROVED", rejectionReason: null });
    expect(body.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(body.decidedBy.id).toBe(names(tenant, role).id);
    expect(Object.keys(body.decidedBy).sort()).toEqual(["firstName", "id", "lastName"]);
    expect(body._links).not.toHaveProperty("approve");
    expect(body._links).not.toHaveProperty("reject");
    expect(await (await client.get(`/api/invoices/${id}`)).json()).toEqual(body);
  }
});

test("reject keeps the reason; no body, blank reason and a reason sent to approve are handled", async ({
  playwright,
  baseURL,
}) => {
  const { admin, owner, user } = await setup(playwright, baseURL!);
  const withReason = await upload(user);
  const r1 = await admin.post(`/api/invoices/${withReason.id}/reject`, { data: { reason: "Importo errato" } });
  expect(r1.status()).toBe(200);
  expect(await r1.json()).toMatchObject({ status: "REJECTED", rejectionReason: "Importo errato" });

  const noBody = await upload(user);
  const r2 = await owner.post(`/api/invoices/${noBody.id}/reject`);
  expect(r2.status()).toBe(200);
  expect(await r2.json()).toMatchObject({ status: "REJECTED", rejectionReason: null });

  const blank = await upload(user);
  const r3 = await admin.post(`/api/invoices/${blank.id}/reject`, { data: { reason: "   " } });
  expect(await r3.json()).toMatchObject({ status: "REJECTED", rejectionReason: null });

  const approved = await upload(user);
  const r4 = await admin.post(`/api/invoices/${approved.id}/approve`, { data: { reason: "ignorato" } });
  expect(r4.status()).toBe(200);
  expect(await r4.json()).toMatchObject({ status: "APPROVED", rejectionReason: null });
});

test("a reason over 1000 characters, a non-string or a non-JSON body answer 400 and the invoice stays PENDING", async ({
  playwright,
  baseURL,
}) => {
  const { admin, user } = await setup(playwright, baseURL!);
  const { id } = await upload(user);
  for (const options of [
    { data: { reason: "x".repeat(1001) } },
    { data: { reason: 5 } },
    { headers: { "content-type": "application/json" }, data: "not json" },
  ]) {
    const res = await admin.post(`/api/invoices/${id}/reject`, options);
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe("invalid_request");
  }
  expect((await (await admin.get(`/api/invoices/${id}`)).json()).status).toBe("PENDING");
  expect((await admin.post(`/api/invoices/${id}/reject`, { data: { reason: "x".repeat(1000) } })).status()).toBe(200);
});

test("a reason with a NUL or other control characters answers 400 (not 500) and the invoice stays PENDING", async ({
  playwright,
  baseURL,
}) => {
  const { admin, user } = await setup(playwright, baseURL!);
  const { id } = await upload(user);
  for (const reason of ["a\u0000b", "a‮b", "a\uD800b"]) {
    const res = await admin.post(`/api/invoices/${id}/reject`, {
      headers: { "content-type": "application/json" },
      data: JSON.stringify({ reason }),
    });
    expect(res.status(), JSON.stringify(reason)).toBe(400);
    expect((await res.json()).error).toBe("invalid_request");
  }
  const big = await admin.post(`/api/invoices/${id}/reject`, { data: { reason: "ok", padding: "x".repeat(9000) } });
  expect(big.status()).toBe(413);
  const current = await (await admin.get(`/api/invoices/${id}`)).json();
  expect(current).toMatchObject({ status: "PENDING", decidedBy: null });
});

test("a USER sees no approve/reject links, gets 403 forbidden and the invoice stays PENDING", async ({
  playwright,
  baseURL,
}) => {
  const { admin, user } = await setup(playwright, baseURL!);
  const { id } = await upload(user);
  const asUser = await (await user.get(`/api/invoices/${id}`)).json();
  expect(asUser._links).not.toHaveProperty("approve");
  expect(asUser._links).not.toHaveProperty("reject");
  for (const action of ["approve", "reject"]) {
    const res = await user.post(`/api/invoices/${id}/${action}`);
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toBe("forbidden");
  }
  const asAdmin = await (await admin.get(`/api/invoices/${id}`)).json();
  expect(asAdmin.status).toBe("PENDING");
  expect(asAdmin._links.approve).toEqual({ href: `/api/invoices/${id}/approve`, method: "POST", title: "Approva" });
  expect(asAdmin._links.reject).toMatchObject({ href: `/api/invoices/${id}/reject`, method: "POST" });
});

test("an already decided invoice answers 409 invoice_already_decided and keeps its decision", async ({
  playwright,
  baseURL,
}) => {
  const { admin, owner, user } = await setup(playwright, baseURL!);
  const { id } = await upload(user);
  const decided = await (await admin.post(`/api/invoices/${id}/reject`, { data: { reason: "No" } })).json();
  for (const action of ["approve", "reject"]) {
    const res = await owner.post(`/api/invoices/${id}/${action}`);
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toBe("invoice_already_decided");
  }
  expect(await (await owner.get(`/api/invoices/${id}`)).json()).toEqual(decided);
});

test("another tenant's invoice and an unknown or non-UUID ID are all the same 404", async ({ playwright, baseURL }) => {
  const a = await setup(playwright, baseURL!);
  const b = await setup(playwright, baseURL!);
  const foreign = await upload(b.user);
  const ids = [foreign.id, "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b", "not-a-uuid"];
  const bodies = [];
  for (const id of ids) {
    for (const action of ["approve", "reject"]) {
      const res = await a.admin.post(`/api/invoices/${id}/${action}`);
      expect(res.status()).toBe(404);
      bodies.push(await res.json());
    }
  }
  expect(new Set(bodies.map((x) => JSON.stringify(x))).size).toBe(1);
  expect((await (await b.admin.get(`/api/invoices/${foreign.id}`)).json()).status).toBe("PENDING");
});

test("without a session 401, with a foreign Origin 403 forbidden_origin, GET answers 405", async ({
  playwright,
  baseURL,
}) => {
  const { admin, user } = await setup(playwright, baseURL!);
  const { id } = await upload(user);
  const anon = await playwright.request.newContext({ baseURL: baseURL! });
  for (const action of ["approve", "reject"]) {
    expect((await anon.post(`/api/invoices/${id}/${action}`)).status()).toBe(401);
    const foreign = await admin.post(`/api/invoices/${id}/${action}`, { headers: { origin: "https://evil.example" } });
    expect(foreign.status()).toBe(403);
    expect((await foreign.json()).error).toBe("forbidden_origin");
    expect((await admin.get(`/api/invoices/${id}/${action}`)).status()).toBe(405);
  }
  expect((await (await admin.get(`/api/invoices/${id}`)).json()).status).toBe("PENDING");
});

test("two parallel decisions on one invoice: exactly one 200 and one 409", async ({ playwright, baseURL }) => {
  const { admin, owner, user } = await setup(playwright, baseURL!);
  for (const [first, second] of [
    ["approve", "approve"],
    ["approve", "reject"],
  ]) {
    const { id } = await upload(user);
    const results = await Promise.all([admin.post(`/api/invoices/${id}/${first}`), owner.post(`/api/invoices/${id}/${second}`)]);
    expect(results.map((r) => r.status()).sort()).toEqual([200, 409]);
  }
});

test("collection links follow the same rules: ADMIN sees them on PENDING only, USER never", async ({
  playwright,
  baseURL,
}) => {
  const { admin, user } = await setup(playwright, baseURL!);
  const first = await upload(user);
  const second = await upload(user);
  await admin.post(`/api/invoices/${first.id}/approve`);

  const asAdmin = await (await admin.get("/api/invoices")).json();
  const byId = new Map<string, { _links: Record<string, unknown> }>(asAdmin._embedded.invoices.map((i: { id: string }) => [i.id, i]));
  expect(byId.get(first.id)!._links).not.toHaveProperty("approve");
  expect(byId.get(second.id)!._links).toHaveProperty("approve");
  expect(byId.get(second.id)!._links).toHaveProperty("reject");
  const asUser = await (await user.get("/api/invoices")).json();
  for (const invoice of asUser._embedded.invoices) expect(invoice._links).not.toHaveProperty("approve");
  const filtered = await (await admin.get("/api/invoices?status=APPROVED")).json();
  expect(filtered._embedded.invoices[0].decidedBy).toMatchObject({ firstName: expect.any(String) });
});

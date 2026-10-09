import { expect, request as pwRequest, test } from "@playwright/test";

import { createTestTenant } from "./helpers/create-test-tenant";
import { buildInvoiceXml } from "./helpers/fatturapa";

// QA: the proxy lets Server Action POSTs through without a cookie. An anonymous replay of a
// real action call must not create invoices nor expose data.
test("an anonymous replay of the upload Server Action creates nothing and exposes nothing", async ({
  page,
  baseURL,
}) => {
  const tenant = await createTestTenant({ users: [{ role: "USER" }] });
  const login = await page.request.post("/api/auth/login", {
    data: { email: tenant.users[0].email, password: tenant.users[0].password },
  });
  expect(login.status()).toBe(200);
  await page.goto("/fatture");

  // Capture a genuine action call (header, content type and multipart body).
  const captured = page.waitForRequest((r) => r.method() === "POST" && r.headers()["next-action"] !== undefined);
  await page.getByLabel("File XML").setInputFiles({
    name: "a.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(buildInvoiceXml({ number: "ANON-REAL" }), "utf8"),
  });
  await page.getByRole("button", { name: "Carica" }).click();
  const original = await captured;
  await expect(page.getByText("Fattura caricata")).toBeVisible();
  const headers = original.headers();

  // Anonymous replay of the same action id with a different invoice (React FormData encoding).
  const anon = await pwRequest.newContext({ baseURL });
  const res = await anon.post("/fatture", {
    headers: { "next-action": headers["next-action"], accept: "text/x-component" },
    multipart: {
      "0": '["$K1"]',
      "1_file": {
        name: "f.xml",
        mimeType: "application/xml",
        buffer: Buffer.from(buildInvoiceXml({ number: "ANON-FAKE" }), "utf8"),
      },
    },
  });
  const text = await res.text();
  // The action answers normally with the "unauthenticated" outcome and does nothing else.
  expect(text).toContain('"kind":"unauthenticated"');
  expect(text).not.toContain("ANON-FAKE");
  expect(text).not.toContain(tenant.businessName);

  // Bogus action id and a GET with the header: still no data.
  const bogus = await anon.post("/fatture", {
    headers: { "next-action": "00deadbeef", "content-type": "text/plain" },
    data: "[]",
  });
  expect(await bogus.text()).not.toContain(tenant.businessName);
  const get = await anon.get("/fatture", { headers: { "next-action": headers["next-action"] }, maxRedirects: 0 });
  expect(get.status()).toBeGreaterThanOrEqual(300);
  expect(get.status()).toBeLessThan(400);
  expect(get.headers()["location"]).toContain("/login");

  // Only the legitimate invoice exists for the tenant.
  const list = await page.request.get("/api/invoices");
  const json = await list.json();
  const numbers = JSON.stringify(json);
  expect(numbers).toContain("ANON-REAL");
  expect(numbers).not.toContain("ANON-FAKE");
  await anon.dispose();
});

test("smoke: /api links lead to the invoices collection, which advertises upload-invoice", async ({ page }) => {
  const tenant = await createTestTenant({ users: [{ role: "USER" }] });
  await page.request.post("/api/auth/login", {
    data: { email: tenant.users[0].email, password: tenant.users[0].password },
  });
  const root = await (await page.request.get("/api")).json();
  const href = root._links.invoices?.href ?? root._links["invoices"]?.href;
  expect(href).toBeTruthy();
  const coll = await page.request.get(href);
  expect(coll.status()).toBe(200);
  const body = await coll.json();
  expect(body._links["upload-invoice"]).toBeTruthy();
});

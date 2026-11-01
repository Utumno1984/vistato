import { randomInt } from "node:crypto";

import { expect, test, type APIRequestContext } from "@playwright/test";

import { forTenant } from "@/db/tenant-scope";

import { createTestTenant, type TestUser } from "./helpers/create-test-tenant";
import { configureFakeFic, fakeFicTokenCalls, stateOf } from "./helpers/fake-fic/control";
import type { FakeFicScenario } from "./helpers/fake-fic/server";

/*
 * DELETE /api/integrations/fic (unlink) and the `disconnect` link, against the fake FiC.
 * The renewal of the token (getFicAccessToken: margin, concurrency, rotation, invalid_grant
 * → reauthorization_required) has no HTTP trigger yet: it is covered in
 * tests/integration/fic-token-refresh.test.ts.
 */

type Playwright = { request: { newContext: (o: { baseURL: string }) => Promise<APIRequestContext> } };

const PAST = new Date("2026-01-01T00:00:00.000Z");
const SELF = { href: "/api/integrations/fic", title: "Fatture in Cloud" };
const CONNECT = { href: "/api/integrations/fic/connect", method: "POST", title: "Collega Fatture in Cloud" };
const DISCONNECT = { href: "/api/integrations/fic", method: "DELETE", title: "Scollega Fatture in Cloud" };
const NOT_CONNECTED = {
  status: "not_connected",
  companyId: null,
  companyName: null,
  connectedAt: null,
  connectedBy: null,
  companies: null,
};

async function loggedIn(playwright: Playwright, baseURL: string, user: TestUser) {
  const client = await playwright.request.newContext({ baseURL });
  const res = await client.post("/api/auth/login", { data: { email: user.email, password: user.password } });
  expect(res.status()).toBe(200);
  return client;
}

/** A tenant with OWNER, ADMIN and USER logged in; the module `fic_iban_alert` active unless `module: false`. */
async function setup(playwright: Playwright, baseURL: string, { module = true } = {}) {
  const tenant = await createTestTenant({ users: [{ role: "OWNER" }, { role: "ADMIN" }, { role: "USER" }] });
  if (module) await forTenant(tenant.tenantId).modules.activate("fic_iban_alert", { activatedAt: PAST });
  const [owner, admin, user] = await Promise.all(tenant.users.map((u) => loggedIn(playwright, baseURL, u)));
  return { tenant, owner, admin, user };
}

/** A FiC company id no other test uses. */
const company = (name = "Azienda") => ({ id: randomInt(1, 2 ** 31), name: `${name} ${randomInt(1e6)}` });

/** connect → scenario on the fake → authorize → callback: the `state` and the `esito`. */
async function link(client: APIRequestContext, scenario: FakeFicScenario = {}) {
  const res = await client.post("/api/integrations/fic/connect");
  expect(res.status()).toBe(200);
  const authorizationUrl: string = (await res.json()).authorizationUrl;
  const state = stateOf(authorizationUrl);
  await configureFakeFic(state, { companies: [company()], ...scenario });
  const authorized = await client.get(authorizationUrl, { maxRedirects: 0 });
  expect(authorized.status()).toBe(302);
  const callback = await client.get(authorized.headers().location, { maxRedirects: 0 });
  expect(callback.status()).toBe(303);
  return { state, esito: new URL(callback.headers().location, "http://localhost").searchParams.get("esito") };
}

async function resourceOf(client: APIRequestContext) {
  const res = await client.get("/api/integrations/fic");
  expect(res.status()).toBe(200);
  return res.json();
}

test("connected: the disconnect link (DELETE) for OWNER and ADMIN, not for a USER", async ({ playwright, baseURL }) => {
  const { owner, admin, user } = await setup(playwright, baseURL!);
  expect((await link(owner)).esito).toBe("connected");
  for (const manager of [owner, admin]) {
    const body = await resourceOf(manager);
    expect(body.status).toBe("connected");
    expect(body._links).toEqual({ self: SELF, disconnect: DISCONNECT });
  }
  const forUser = await resourceOf(user);
  expect(forUser.status).toBe("connected");
  expect(forUser._links).toEqual({ self: SELF });
});

test("DELETE by the OWNER: 200 not_connected with connect again, tokens revoked on FiC, a second DELETE is 409 not_connected", async ({
  playwright,
  baseURL,
}) => {
  const { owner, user } = await setup(playwright, baseURL!);
  const { state } = await link(owner);

  const res = await owner.delete("/api/integrations/fic");
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toBe("no-store");
  expect(await res.json()).toEqual({ ...NOT_CONNECTED, _links: { self: SELF, connect: CONNECT } });
  expect(await resourceOf(owner)).toEqual({ ...NOT_CONNECTED, _links: { self: SELF, connect: CONNECT } });
  expect(await resourceOf(user)).toEqual({ ...NOT_CONNECTED, _links: { self: SELF } });
  // Access and refresh token revoked (best effort, the fake has the endpoint).
  expect((await fakeFicTokenCalls(state)).revoke).toBe(2);

  const again = await owner.delete("/api/integrations/fic");
  expect(again.status()).toBe(409);
  expect((await again.json()).error).toBe("not_connected");

  // The account can be linked again.
  expect((await link(owner)).esito).toBe("connected");
});

test("DELETE by the ADMIN works too", async ({ playwright, baseURL }) => {
  const { owner, admin } = await setup(playwright, baseURL!);
  await link(owner);
  const res = await admin.delete("/api/integrations/fic");
  expect(res.status()).toBe(200);
  expect((await res.json()).status).toBe("not_connected");
});

test("DELETE by a USER is 403 forbidden, from another Origin 403 forbidden_origin: the link stays", async ({
  playwright,
  baseURL,
}) => {
  const { owner, user } = await setup(playwright, baseURL!);
  await link(owner);
  const before = await resourceOf(owner);

  const forbidden = await user.delete("/api/integrations/fic");
  expect(forbidden.status()).toBe(403);
  expect((await forbidden.json()).error).toBe("forbidden");
  const foreign = await owner.delete("/api/integrations/fic", { headers: { Origin: "https://evil.example" } });
  expect(foreign.status()).toBe(403);
  expect((await foreign.json()).error).toBe("forbidden_origin");

  expect(await resourceOf(owner)).toEqual(before);
});

test("without the module DELETE is 403 module_not_active for every role; without a session 401", async ({
  playwright,
  baseURL,
  request,
}) => {
  const { owner, admin, user } = await setup(playwright, baseURL!, { module: false });
  for (const client of [owner, admin, user]) {
    const res = await client.delete("/api/integrations/fic");
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toBe("module_not_active");
  }
  const anonymous = await request.delete("/api/integrations/fic");
  expect(anonymous.status()).toBe(401);
  expect((await anonymous.json()).error).toBe("unauthenticated");
});

test("not connected: no disconnect link and DELETE is 409 not_connected", async ({ playwright, baseURL }) => {
  const { owner } = await setup(playwright, baseURL!);
  expect((await resourceOf(owner))._links).not.toHaveProperty("disconnect");
  const res = await owner.delete("/api/integrations/fic");
  expect(res.status()).toBe(409);
  expect((await res.json()).error).toBe("not_connected");
});

test("a link waiting for the choice of the company can be unlinked", async ({ playwright, baseURL }) => {
  const { owner, admin } = await setup(playwright, baseURL!);
  expect((await link(owner, { companies: [company("Prima"), company("Seconda")] })).esito).toBe("pending_company_selection");
  const pending = await resourceOf(admin);
  expect(pending._links.disconnect).toEqual(DISCONNECT);
  const res = await admin.delete("/api/integrations/fic");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ...NOT_CONNECTED, _links: { self: SELF, connect: CONNECT } });
});

test("tenant A unlinking leaves tenant B connected; then tenant C can link A's former company", async ({
  playwright,
  baseURL,
}) => {
  const a = await setup(playwright, baseURL!);
  const b = await setup(playwright, baseURL!);
  const c = await setup(playwright, baseURL!);
  const shared = company("Condivisa");
  expect((await link(a.owner, { companies: [shared] })).esito).toBe("connected");
  const linkedB = await link(b.owner);
  expect(linkedB.esito).toBe("connected");
  const resourceB = await resourceOf(b.owner);
  // While A holds it, the company cannot be linked elsewhere.
  expect((await link(c.owner, { companies: [shared] })).esito).toBe("company_already_linked");

  expect((await a.owner.delete("/api/integrations/fic")).status()).toBe(200);
  expect(await resourceOf(b.owner)).toEqual(resourceB);
  expect((await fakeFicTokenCalls(linkedB.state)).revoke).toBe(0);

  // The company is free again: C links it.
  expect((await link(c.owner, { companies: [shared] })).esito).toBe("connected");
  expect(await resourceOf(c.owner)).toMatchObject({ status: "connected", companyId: shared.id });
});

import { randomInt } from "node:crypto";

import { expect, test, type APIRequestContext } from "@playwright/test";

import { forTenant } from "@/db/tenant-scope";

import { createTestTenant, type TestTenant, type TestUser } from "./helpers/create-test-tenant";
import { configureFakeFic, fakeFicCalls, FAKE_FIC_URL, stateOf } from "./helpers/fake-fic/control";
import type { FakeFicScenario } from "./helpers/fake-fic/server";

type Playwright = { request: { newContext: (o: { baseURL: string }) => Promise<APIRequestContext> } };

const SETTINGS = "/impostazioni/fatture-in-cloud";
const PAST = new Date("2026-01-01T00:00:00.000Z");

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

const userOf = (tenant: TestTenant, role: string) => tenant.users.find((u) => u.role === role)!;
/** A FiC company id no other test uses. */
const company = (name = "Azienda") => ({ id: randomInt(1, 2 ** 31), name: `${name} ${randomInt(1e6)}` });

async function startConnect(client: APIRequestContext): Promise<string> {
  const res = await client.post("/api/integrations/fic/connect");
  expect(res.status()).toBe(200);
  return (await res.json()).authorizationUrl;
}

/** Follows the fake FiC authorization page, which redirects at once: the callback URL Vistato receives. */
async function authorize(client: APIRequestContext, authorizationUrl: string): Promise<string> {
  const res = await client.get(authorizationUrl, { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  const callback = res.headers().location;
  expect(callback.startsWith("http://localhost:3100/api/integrations/fic/callback?")).toBe(true);
  return callback;
}

/** Calls the callback and returns the `esito` of the 303 to the settings page. */
async function callback(client: APIRequestContext, callbackUrl: string): Promise<string | null> {
  const res = await client.get(callbackUrl, { maxRedirects: 0 });
  expect(res.status()).toBe(303);
  expect(res.headers()["cache-control"]).toBe("no-store");
  expect(res.headers()["referrer-policy"]).toBe("no-referrer");
  const location = new URL(res.headers().location, "http://localhost:3100");
  expect(location.pathname).toBe(SETTINGS);
  return location.searchParams.get("esito");
}

/** connect → (scenario) → authorize on the fake → callback: the esito. */
async function connectWith(client: APIRequestContext, scenario: FakeFicScenario) {
  const authorizationUrl = await startConnect(client);
  const state = stateOf(authorizationUrl);
  await configureFakeFic(state, scenario);
  const callbackUrl = await authorize(client, authorizationUrl);
  return { state, callbackUrl, esito: await callback(client, callbackUrl) };
}

async function resourceOf(client: APIRequestContext) {
  const res = await client.get("/api/integrations/fic");
  expect(res.status()).toBe(200);
  return res.json();
}

test("without a session every endpoint answers 401 and the callback redirects to the login", async ({ request }) => {
  const get = await request.get("/api/integrations/fic");
  expect(get.status()).toBe(401);
  expect((await get.json()).error).toBe("unauthenticated");
  for (const path of ["/api/integrations/fic/connect", "/api/integrations/fic/company"]) {
    const res = await request.post(path, { data: { companyId: 1 } });
    expect(res.status(), path).toBe(401);
    expect((await res.json()).error).toBe("unauthenticated");
  }
  const cb = await request.get("/api/integrations/fic/callback?code=x&state=y", { maxRedirects: 0 });
  expect(cb.status()).toBe(303);
  expect(new URL(cb.headers().location, "http://localhost").pathname).toBe("/login");
});

test("on a tenant without the module every endpoint answers 403 module_not_active to every role", async ({
  playwright,
  baseURL,
}) => {
  const { owner, admin, user } = await setup(playwright, baseURL!, { module: false });
  for (const client of [owner, admin, user]) {
    const responses = [
      await client.get("/api/integrations/fic"),
      await client.post("/api/integrations/fic/connect"),
      await client.post("/api/integrations/fic/company", { data: { companyId: 1 } }),
      await client.get("/api/integrations/fic/callback?code=x&state=y", { maxRedirects: 0 }),
    ];
    for (const res of responses) {
      expect(res.status(), res.url()).toBe(403);
      expect((await res.json()).error).toBe("module_not_active");
    }
    const api = await (await client.get("/api")).json();
    expect(api._links).not.toHaveProperty("fic-integration");
  }
});

test("not connected: OWNER and ADMIN get the connect link, a USER the same resource without it and 403 on the actions", async ({
  playwright,
  baseURL,
}) => {
  const { owner, admin, user } = await setup(playwright, baseURL!);
  const expected = {
    status: "not_connected",
    companyId: null,
    companyName: null,
    connectedAt: null,
    connectedBy: null,
    companies: null,
  };
  for (const client of [owner, admin]) {
    const body = await resourceOf(client);
    expect(body).toEqual({
      ...expected,
      _links: {
        self: { href: "/api/integrations/fic", title: "Fatture in Cloud" },
        connect: { href: "/api/integrations/fic/connect", method: "POST", title: "Collega Fatture in Cloud" },
      },
    });
  }
  const forUser = await resourceOf(user);
  expect(forUser).toEqual({ ...expected, _links: { self: { href: "/api/integrations/fic", title: "Fatture in Cloud" } } });

  for (const res of [
    await user.post("/api/integrations/fic/connect"),
    await user.post("/api/integrations/fic/company", { data: { companyId: 1 } }),
  ]) {
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toBe("forbidden");
  }
  for (const client of [owner, admin, user]) {
    const api = await (await client.get("/api")).json();
    expect(api._links["fic-integration"]).toEqual({ href: "/api/integrations/fic", title: "Fatture in Cloud" });
  }
});

test("connect answers an authorization URL with code, client, redirect, scope, a random state and an S256 challenge", async ({
  playwright,
  baseURL,
}) => {
  const { owner, admin } = await setup(playwright, baseURL!);
  const first = new URL(await startConnect(owner));
  const second = new URL(await startConnect(admin));
  expect(`${first.origin}${first.pathname}`).toBe(`${FAKE_FIC_URL}/oauth/authorize`);
  const p = first.searchParams;
  expect(p.get("response_type")).toBe("code");
  expect(p.get("client_id")).toBe("vistato-e2e-client");
  expect(p.get("redirect_uri")).toBe("http://localhost:3100/api/integrations/fic/callback");
  expect(p.get("scope")).toBe("received_documents:r");
  // 43 base64url characters = 256 random bits (at least 128 required).
  expect(p.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(p.get("code_challenge_method")).toBe("S256");
  expect(second.searchParams.get("state")).not.toBe(p.get("state"));
  expect(second.searchParams.get("code_challenge")).not.toBe(p.get("code_challenge"));
  expect(p.has("code_verifier")).toBe(false);
});

test("connect from another Origin answers 403 forbidden_origin", async ({ playwright, baseURL }) => {
  const { owner } = await setup(playwright, baseURL!);
  const res = await owner.post("/api/integrations/fic/connect", { headers: { Origin: "https://evil.example" } });
  expect(res.status()).toBe(403);
  expect((await res.json()).error).toBe("forbidden_origin");
});

test("full flow with one company in the browser: connected, no secret in the resource, connect again is 409", async ({
  page,
  baseURL,
  playwright,
}) => {
  const { tenant, owner, user } = await setup(playwright, baseURL!);
  const ownerUser = userOf(tenant, "OWNER");
  const login = await page.request.post("/api/auth/login", {
    data: { email: ownerUser.email, password: ownerUser.password },
  });
  expect(login.status()).toBe(200);
  const authorizationUrl = await startConnect(page.request);
  const state = stateOf(authorizationUrl);
  const only = company("Unica");
  await configureFakeFic(state, { companies: [only] });

  // FiC redirects the browser to the callback, which redirects to the settings page.
  await page.goto(authorizationUrl);
  const landed = new URL(page.url());
  expect(landed.pathname).toBe(SETTINGS);
  expect(landed.searchParams.get("esito")).toBe("connected");
  expect(await fakeFicCalls(state)).toEqual({ authorize: 1, token: 1, companies: 1 });

  const res = await owner.get("/api/integrations/fic");
  const text = await res.text();
  const body = JSON.parse(text);
  expect(body).toMatchObject({ status: "connected", companyId: only.id, companyName: only.name, companies: null });
  expect(body.connectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(body.connectedBy).toEqual({ id: ownerUser.id, firstName: "E2E", lastName: "OWNER" });
  expect(Object.keys(body._links)).toEqual(["self"]);
  for (const secret of ["a/fake-", "r/fake-", "access", "refresh", "token", "verifier", state]) {
    expect(text.toLowerCase(), secret).not.toContain(secret.toLowerCase());
  }
  expect(await resourceOf(user)).toEqual(body);

  const again = await owner.post("/api/integrations/fic/connect");
  expect(again.status()).toBe(409);
  expect((await again.json()).error).toBe("already_connected");
});

test("two companies: pending with the list and select-company; an unknown id is 400, a listed one connects", async ({
  playwright,
  baseURL,
}) => {
  const { tenant, owner, admin, user } = await setup(playwright, baseURL!);
  const [first, second] = [company("Prima"), company("Seconda")];
  const { esito } = await connectWith(owner, { companies: [first, second] });
  expect(esito).toBe("pending_company_selection");

  const pending = await resourceOf(admin);
  expect(pending).toMatchObject({ status: "pending_company_selection", companyId: null, connectedAt: null });
  expect(pending.companies).toEqual([first, second]);
  expect(pending._links["select-company"]).toEqual({
    href: "/api/integrations/fic/company",
    method: "POST",
    title: "Scegli l'azienda da collegare",
  });
  expect(pending._links).not.toHaveProperty("connect");
  const forUser = await resourceOf(user);
  expect(forUser.companies).toEqual([first, second]);
  expect(Object.keys(forUser._links)).toEqual(["self"]);
  expect((await owner.post("/api/integrations/fic/connect")).status()).toBe(409);

  const unknown = await admin.post("/api/integrations/fic/company", { data: { companyId: first.id + 1 } });
  expect(unknown.status()).toBe(400);
  expect((await unknown.json()).error).toBe("unknown_company");
  for (const data of [{ companyId: "x" }, { companyId: -1 }, {}]) {
    expect((await admin.post("/api/integrations/fic/company", { data })).status()).toBe(400);
  }
  expect(await resourceOf(owner)).toEqual(pending);

  const chosen = await admin.post("/api/integrations/fic/company", { data: { companyId: second.id } });
  expect(chosen.status()).toBe(200);
  const connected = await chosen.json();
  expect(connected).toMatchObject({ status: "connected", companyId: second.id, companyName: second.name, companies: null });
  expect(connected.connectedBy.id).toBe(userOf(tenant, "OWNER").id);
  expect(await resourceOf(user)).toEqual(connected);

  const twice = await owner.post("/api/integrations/fic/company", { data: { companyId: first.id } });
  expect(twice.status()).toBe(409);
  expect((await resourceOf(owner)).companyId).toBe(second.id);
});

test("a reused state and the state of another user or tenant are refused with invalid_state, without calling FiC", async ({
  playwright,
  baseURL,
}) => {
  const a = await setup(playwright, baseURL!);
  const b = await setup(playwright, baseURL!);

  // Another tenant cannot use (nor spend) the state: the owner still completes afterwards.
  const authorizationUrl = await startConnect(a.owner);
  const state = stateOf(authorizationUrl);
  const callbackUrl = await authorize(a.owner, authorizationUrl);
  expect(await callback(b.owner, callbackUrl)).toBe("invalid_state");
  expect((await fakeFicCalls(state)).token).toBe(0);
  expect((await resourceOf(b.owner)).status).toBe("not_connected");
  expect(await callback(a.owner, callbackUrl)).toBe("connected");
  expect((await fakeFicCalls(state)).token).toBe(1);

  // Reused: refused before FiC is called again.
  expect(await callback(a.owner, callbackUrl)).toBe("invalid_state");
  expect(await fakeFicCalls(state)).toEqual({ authorize: 1, token: 1, companies: 1 });

  // An ADMIN of the same tenant using the OWNER's link: refused, and the state is spent.
  const c = await setup(playwright, baseURL!);
  const ownerUrl = await startConnect(c.owner);
  const ownerState = stateOf(ownerUrl);
  const ownerCallback = await authorize(c.owner, ownerUrl);
  expect(await callback(c.admin, ownerCallback)).toBe("invalid_state");
  expect(await callback(c.owner, ownerCallback)).toBe("invalid_state");
  expect((await fakeFicCalls(ownerState)).token).toBe(0);
  expect((await resourceOf(c.owner)).status).toBe("not_connected");

  // Missing, malformed or unknown state.
  for (const query of ["code=abc", "code=abc&state=", "code=abc&state=%00%3Cscript%3E", `code=abc&state=${"A".repeat(43)}`]) {
    expect(await callback(c.owner, `/api/integrations/fic/callback?${query}`), query).toBe("invalid_state");
  }
  expect(await callback(c.owner, `/api/integrations/fic/callback?code=${"x".repeat(5000)}&state=${"s".repeat(5000)}`)).toBe(
    "invalid_state",
  );
});

test("the user refuses on FiC: Collegamento annullato (access_denied), still not connected", async ({ playwright, baseURL }) => {
  const { owner } = await setup(playwright, baseURL!);
  const { state, esito } = await connectWith(owner, { authorize: "deny" });
  expect(esito).toBe("access_denied");
  expect((await fakeFicCalls(state)).token).toBe(0);
  const body = await resourceOf(owner);
  expect(body.status).toBe("not_connected");
  expect(body._links).toHaveProperty("connect");
});

test("a failed code exchange (400, 500, invalid JSON) saves nothing and reports token_exchange_failed", async ({
  playwright,
  baseURL,
}) => {
  const { owner } = await setup(playwright, baseURL!);
  for (const token of [
    { status: 400, body: JSON.stringify({ error: "invalid_grant" }) },
    { status: 503 },
    { status: 200, body: JSON.stringify({ token_type: "bearer", access_token: "a/x" }) },
    { status: 200, body: "not json" },
  ]) {
    const { state, esito } = await connectWith(owner, { token });
    expect(esito, JSON.stringify(token)).toBe("token_exchange_failed");
    expect((await fakeFicCalls(state)).companies).toBe(0);
    expect((await resourceOf(owner)).status).toBe("not_connected");
  }
});

test("an account without companies reports no_company and saves nothing", async ({ playwright, baseURL }) => {
  const { owner } = await setup(playwright, baseURL!);
  const { esito } = await connectWith(owner, { companies: [] });
  expect(esito).toBe("no_company");
  expect((await resourceOf(owner)).status).toBe("not_connected");
});

test("a company already linked to another tenant: company_already_linked on the callback and 409 on the choice", async ({
  playwright,
  baseURL,
}) => {
  const a = await setup(playwright, baseURL!);
  const b = await setup(playwright, baseURL!);
  const shared = company("Condivisa");
  expect((await connectWith(a.owner, { companies: [shared] })).esito).toBe("connected");
  const linkedToA = await resourceOf(a.owner);

  // Callback with that company as the only one: refused, B's tokens discarded.
  expect((await connectWith(b.owner, { companies: [shared] })).esito).toBe("company_already_linked");
  expect((await resourceOf(b.owner)).status).toBe("not_connected");

  // Explicit choice among two: 409, B is back to not connected and can start again.
  const other = company("Altra");
  expect((await connectWith(b.admin, { companies: [shared, other] })).esito).toBe("pending_company_selection");
  const res = await b.admin.post("/api/integrations/fic/company", { data: { companyId: shared.id } });
  expect(res.status()).toBe(409);
  expect((await res.json()).error).toBe("company_already_linked");
  const afterwards = await resourceOf(b.owner);
  expect(afterwards.status).toBe("not_connected");
  expect(afterwards._links).toHaveProperty("connect");

  expect(await resourceOf(a.owner)).toEqual(linkedToA);
  expect((await connectWith(b.owner, { companies: [other] })).esito).toBe("connected");
});

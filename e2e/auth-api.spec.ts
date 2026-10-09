import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";

import { setTenantStatus } from "@/db/platform/tenants";
import { forTenant } from "@/db/tenant-scope";

import { createTestTenant } from "./helpers/create-test-tenant";

const DEMO_EMAIL = "demo@example.com";

function demoPassword(): string {
  const password = process.env.DEMO_USER_PASSWORD;
  if (!password) throw new Error("DEMO_USER_PASSWORD is not set: the e2e seed needs it (see .env.example)");
  return password;
}

const tokenOf = (res: APIResponse) => /vistato_session=([^;]*)/.exec(res.headers()["set-cookie"] ?? "")?.[1] ?? "";

/** A client with its own empty cookie jar, so each test controls exactly which cookie is sent. */
async function freshClient(playwright: { request: { newContext: (o: { baseURL: string }) => Promise<APIRequestContext> } }, baseURL: string) {
  return playwright.request.newContext({ baseURL });
}

const credentials = (user: { email: string; password: string }) => ({ data: { email: user.email, password: user.password } });

test("login with the demo user answers 200 with an httpOnly cookie and the user resource, then GET /api/me works", async ({ playwright, baseURL }) => {
  const client = await freshClient(playwright, baseURL!);
  const res = await client.post("/api/auth/login", { data: { email: DEMO_EMAIL, password: demoPassword() } });
  expect(res.status()).toBe(200);
  const cookie = res.headers()["set-cookie"];
  expect(cookie).toMatch(/^vistato_session=[A-Za-z0-9_-]{43}; /);
  expect(cookie).toContain("Max-Age=604800");
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Lax");
  expect(cookie).toContain("Path=/");
  const body = await res.json();
  expect(body).toMatchObject({
    email: DEMO_EMAIL,
    role: "OWNER",
    tenant: { id: expect.any(String), businessName: expect.any(String) },
    _links: { self: { href: "/api/me" }, "upload-invoice": { href: "/api/invoices", method: "POST" }, logout: { href: "/api/auth/logout", method: "POST" } },
  });
  expect(JSON.stringify(body)).not.toMatch(/hash|argon2/i);

  const me = await client.get("/api/me");
  expect(me.status()).toBe(200);
  expect(await me.json()).toEqual(body);
  await client.dispose();
});

test("login with a wrong password and with an unknown email answers the same 401 and no cookie", async ({ request }) => {
  const { users } = await createTestTenant({ users: [{ role: "OWNER" }] });
  const wrong = await request.post("/api/auth/login", { data: { email: users[0].email, password: `${users[0].password}x` } });
  const unknown = await request.post("/api/auth/login", { data: { email: "nobody-e2e@example.com", password: users[0].password } });
  for (const res of [wrong, unknown]) {
    expect(res.status()).toBe(401);
    expect(res.headers()["set-cookie"]).toBeUndefined();
  }
  const expected = { error: "invalid_credentials", message: "Email o password non validi" };
  expect(await wrong.json()).toEqual(expected);
  expect(await unknown.json()).toEqual(expected);
});

test("login answers 401 for a DISABLED user and for a user of a SUSPENDED tenant, with the same body", async ({ request }) => {
  const disabledTenant = await createTestTenant({ users: [{ role: "USER" }] });
  await forTenant(disabledTenant.tenantId).users.update(disabledTenant.users[0].id, { status: "DISABLED" });
  const suspendedTenant = await createTestTenant({ users: [{ role: "OWNER" }] });
  await setTenantStatus(suspendedTenant.tenantId, "SUSPENDED");

  for (const user of [disabledTenant.users[0], suspendedTenant.users[0]]) {
    const res = await request.post("/api/auth/login", credentials(user));
    expect(res.status()).toBe(401);
    expect(res.headers()["set-cookie"]).toBeUndefined();
    expect(await res.json()).toEqual({ error: "invalid_credentials", message: "Email o password non validi" });
  }
});

test("login with a malformed body answers 400 invalid_request with the issues", async ({ request }) => {
  const notJson = await request.post("/api/auth/login", { headers: { "content-type": "application/json" }, data: "not json{" });
  expect(notJson.status()).toBe(400);
  expect((await notJson.json()).error).toBe("invalid_request");

  const cases = [{}, { email: "a@example.com" }, { email: 1, password: "x" }, { email: "a@example.com", password: "x".repeat(1025) }];
  for (const data of cases) {
    const res = await request.post("/api/auth/login", { data });
    expect(res.status(), JSON.stringify(data).slice(0, 50)).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_request");
    expect(body.issues.length).toBeGreaterThan(0);
    expect(body.issues[0]).toEqual({ field: expect.any(String), message: expect.any(String) });
  }
});

test("GET /api/me without cookie and with an invented cookie answers 401 unauthenticated", async ({ playwright, baseURL }) => {
  const anonymous = await freshClient(playwright, baseURL!);
  const none = await anonymous.get("/api/me");
  expect(none.status()).toBe(401);
  expect((await none.json()).error).toBe("unauthenticated");

  const invented = await anonymous.get("/api/me", { headers: { cookie: `vistato_session=${"A".repeat(43)}` } });
  expect(invented.status()).toBe(401);
  expect((await invented.json()).error).toBe("unauthenticated");
  const garbage = await anonymous.get("/api/me", { headers: { cookie: "vistato_session=" } });
  expect(garbage.status()).toBe(401);
  await anonymous.dispose();
});

test("logout answers 204 and clears the cookie; the old cookie no longer works; logout without session is 204", async ({ playwright, baseURL }) => {
  const { users } = await createTestTenant({ users: [{ role: "OWNER" }] });
  const client = await freshClient(playwright, baseURL!);
  const token = tokenOf(await client.post("/api/auth/login", credentials(users[0])));
  expect(token).not.toBe("");
  const cookie = `vistato_session=${token}`;

  const out = await client.post("/api/auth/logout", { headers: { cookie } });
  expect(out.status()).toBe(204);
  expect(out.headers()["set-cookie"]).toContain("Max-Age=0");

  const after = await client.get("/api/me", { headers: { cookie } });
  expect(after.status()).toBe(401);

  const anonymous = await freshClient(playwright, baseURL!);
  expect((await anonymous.post("/api/auth/logout")).status()).toBe(204);
  await client.dispose();
  await anonymous.dispose();
});

test("an authenticated POST /api/auth/logout from another Origin answers 403 and keeps the session", async ({ playwright, baseURL }) => {
  const { users } = await createTestTenant({ users: [{ role: "OWNER" }] });
  const client = await freshClient(playwright, baseURL!);
  const token = tokenOf(await client.post("/api/auth/login", credentials(users[0])));
  const cookie = `vistato_session=${token}`;

  const evil = await client.post("/api/auth/logout", { headers: { cookie, origin: "https://evil.example" } });
  expect(evil.status()).toBe(403);
  expect((await evil.json()).error).toBe("forbidden_origin");
  expect((await client.get("/api/me", { headers: { cookie } })).status()).toBe(200);

  const own = await client.post("/api/auth/logout", { headers: { cookie, origin: baseURL! } });
  expect(own.status()).toBe(204);
  await client.dispose();
});

test("two logins give independent sessions", async ({ playwright, baseURL }) => {
  const { users } = await createTestTenant({ users: [{ role: "OWNER" }] });
  const client = await freshClient(playwright, baseURL!);
  const first = `vistato_session=${tokenOf(await client.post("/api/auth/login", credentials(users[0])))}`;
  const second = `vistato_session=${tokenOf(await client.post("/api/auth/login", credentials(users[0])))}`;
  expect(first).not.toBe(second);
  await client.post("/api/auth/logout", { headers: { cookie: first } });
  expect((await client.get("/api/me", { headers: { cookie: first } })).status()).toBe(401);
  expect((await client.get("/api/me", { headers: { cookie: second } })).status()).toBe(200);
  await client.dispose();
});

test("a user disabled after login gets 401 on the next GET /api/me", async ({ playwright, baseURL }) => {
  const { tenantId, users } = await createTestTenant({ users: [{ role: "USER" }] });
  const client = await freshClient(playwright, baseURL!);
  const cookie = `vistato_session=${tokenOf(await client.post("/api/auth/login", credentials(users[0])))}`;
  expect((await client.get("/api/me", { headers: { cookie } })).status()).toBe(200);
  await forTenant(tenantId).users.update(users[0].id, { status: "DISABLED" });
  expect((await client.get("/api/me", { headers: { cookie } })).status()).toBe(401);
  await client.dispose();
});

test("GET /api links login for anonymous callers and me and logout for authenticated ones", async ({ playwright, baseURL }) => {
  const { users } = await createTestTenant({ users: [{ role: "OWNER" }] });
  const client = await freshClient(playwright, baseURL!);

  const anonymous = await (await client.get("/api")).json();
  expect(anonymous._links.login).toMatchObject({ href: "/api/auth/login", method: "POST" });
  expect(anonymous._links).not.toHaveProperty("me");
  expect(anonymous._links).not.toHaveProperty("logout");

  const cookie = `vistato_session=${tokenOf(await client.post("/api/auth/login", credentials(users[0])))}`;
  const authenticated = await (await client.get("/api", { headers: { cookie } })).json();
  expect(authenticated._links.me.href).toBe("/api/me");
  expect(authenticated._links.logout).toMatchObject({ href: "/api/auth/logout", method: "POST" });
  expect(authenticated._links).not.toHaveProperty("login");
  await client.dispose();
});

test("unsupported methods answer 405", async ({ request }) => {
  expect((await request.get("/api/auth/login")).status()).toBe(405);
  expect((await request.get("/api/auth/logout")).status()).toBe(405);
  expect((await request.post("/api/me")).status()).toBe(405);
});

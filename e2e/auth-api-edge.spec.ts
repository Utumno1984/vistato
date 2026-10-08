import { expect, test } from "@playwright/test";

import { createTestTenant } from "./helpers/create-test-tenant";

const tokenOf = (set: string | undefined) => /vistato_session=([^;]*)/.exec(set ?? "")?.[1] ?? "";

test("login with a helper user sets an httpOnly, SameSite=Lax, Path=/ cookie lasting 7 days and /api/me matches the login body", async ({ playwright, baseURL }) => {
  const { users, businessName } = await createTestTenant({ users: [{ role: "OWNER" }] });
  const client = await playwright.request.newContext({ baseURL: baseURL! });
  const res = await client.post("/api/auth/login", { data: { email: users[0].email, password: users[0].password } });
  expect(res.status()).toBe(200);
  const set = res.headers()["set-cookie"];
  expect(set).toMatch(/^vistato_session=[A-Za-z0-9_-]{43};/);
  expect(set).toContain("HttpOnly");
  expect(set).toContain("SameSite=Lax");
  expect(set).toContain("Path=/");
  expect(set).toContain("Max-Age=604800");
  const body = await res.json();
  expect(body.tenant.businessName).toBe(businessName);
  expect(Object.keys(body).sort()).toEqual(["_links", "email", "firstName", "id", "lastName", "role", "tenant"]);
  expect(JSON.stringify(body)).not.toContain(tokenOf(set));
  const me = await client.get("/api/me");
  expect(await me.json()).toEqual(body);
  await client.dispose();
});

test("login normalises email case and spaces and ignores extra body fields such as tenantId", async ({ request }) => {
  const a = await createTestTenant({ users: [{ role: "OWNER" }] });
  const b = await createTestTenant({ users: [{ role: "OWNER" }] });
  const res = await request.post("/api/auth/login", {
    data: { email: `  ${a.users[0].email.toUpperCase()}  `, password: a.users[0].password, tenantId: b.tenantId },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.id).toBe(a.users[0].id);
  expect(body.tenant.id).toBe(a.tenantId);
});

test("login with a wrong content-type or a JSON non-object body answers 400 invalid_request", async ({ request }) => {
  const { users } = await createTestTenant({ users: [{ role: "OWNER" }] });
  const form = await request.post("/api/auth/login", { form: { email: users[0].email, password: users[0].password } });
  expect(form.status()).toBe(400);
  expect((await form.json()).error).toBe("invalid_request");
  expect(form.headers()["set-cookie"]).toBeUndefined();

  const text = await request.post("/api/auth/login", {
    headers: { "content-type": "text/plain" },
    data: JSON.stringify({ email: users[0].email, password: users[0].password }),
  });
  expect([200, 400]).toContain(text.status());
  if (text.status() === 400) expect((await text.json()).error).toBe("invalid_request");

  for (const raw of ["null", "[]", '"x"', "42", ""]) {
    const res = await request.post("/api/auth/login", { headers: { "content-type": "application/json" }, data: raw });
    expect(res.status(), `body ${JSON.stringify(raw)}`).toBe(400);
    expect((await res.json()).error).toBe("invalid_request");
  }
});

test("a password of exactly 1024 characters is a 401, one of 1025 is a 400", async ({ request }) => {
  const ok = await request.post("/api/auth/login", { data: { email: "nobody-edge@example.com", password: "x".repeat(1024) } });
  expect(ok.status()).toBe(401);
  const tooLong = await request.post("/api/auth/login", { data: { email: "nobody-edge@example.com", password: "x".repeat(1025) } });
  expect(tooLong.status()).toBe(400);
});

test("malformed, empty, huge and non-base64url cookies on GET /api/me answer 401 with the uniform error body", async ({ request }) => {
  const cookies = ["vistato_session=", `vistato_session=${"A".repeat(5000)}`, "vistato_session=!!!***%%%", "vistato_session=a b", "other=1"];
  for (const cookie of cookies) {
    const res = await request.get("/api/me", { headers: { cookie } });
    expect(res.status(), cookie.slice(0, 40)).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthenticated");
    expect(typeof body.message).toBe("string");
    expect(res.headers()["content-type"]).toContain("application/json");
  }
});

test("401 body is identical with and without a cookie, and unsupported methods answer 405 on every auth route", async ({ request }) => {
  const none = await request.get("/api/me");
  const fake = await request.get("/api/me", { headers: { cookie: `vistato_session=${"B".repeat(43)}` } });
  expect(await none.json()).toEqual(await fake.json());

  for (const method of ["PUT", "PATCH", "DELETE"] as const) {
    for (const path of ["/api/auth/login", "/api/auth/logout", "/api/me"]) {
      const res = await request.fetch(path, { method });
      expect(res.status(), `${method} ${path}`).toBe(405);
    }
  }
  expect((await request.put("/api/me")).status()).toBe(405);
});

test("an authenticated POST from another Origin is rejected on logout even with a lookalike origin; without Origin it is allowed", async ({ playwright, baseURL }) => {
  const { users } = await createTestTenant({ users: [{ role: "OWNER" }] });
  const client = await playwright.request.newContext({ baseURL: baseURL! });
  const cookie = `vistato_session=${tokenOf((await client.post("/api/auth/login", { data: { email: users[0].email, password: users[0].password } })).headers()["set-cookie"])}`;
  for (const origin of ["https://evil.example", `${baseURL}.evil.example`, "null"]) {
    const res = await client.post("/api/auth/logout", { headers: { cookie, origin } });
    expect(res.status(), origin).toBe(403);
    expect((await res.json()).error).toBe("forbidden_origin");
  }
  expect((await client.get("/api/me", { headers: { cookie } })).status()).toBe(200);
  expect((await client.post("/api/auth/logout", { headers: { cookie } })).status()).toBe(204);
  await client.dispose();
});

test("the logout response clears the cookie with the same attributes and the link navigation from /api works", async ({ playwright, baseURL }) => {
  const { users } = await createTestTenant({ users: [{ role: "OWNER" }] });
  const client = await playwright.request.newContext({ baseURL: baseURL! });
  const login = await client.post("/api/auth/login", { data: { email: users[0].email, password: users[0].password } });
  const cookie = `vistato_session=${tokenOf(login.headers()["set-cookie"])}`;

  // Follow the HATEOAS links from /api instead of building URLs by hand.
  const root = await (await client.get("/api", { headers: { cookie } })).json();
  expect((await client.get(root._links.me.href, { headers: { cookie } })).status()).toBe(200);
  const out = await client.fetch(root._links.logout.href, { method: root._links.logout.method, headers: { cookie } });
  expect(out.status()).toBe(204);
  const cleared = out.headers()["set-cookie"];
  expect(cleared).toMatch(/^vistato_session=;/);
  expect(cleared).toContain("Max-Age=0");
  expect(cleared).toContain("HttpOnly");
  expect(cleared).toContain("Path=/");
  expect(await out.text()).toBe("");
  await client.dispose();
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getApi } from "@/app/api/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as getMe } from "@/app/api/me/route";
import { createSession } from "@/db/auth";
import { createTenant, setTenantStatus } from "@/db/platform/tenants";
import { forTenant } from "@/db/tenant-scope";
import { requireSession } from "@/lib/auth/session";
import { sessions } from "@/db/schema";

import { testDb } from "../helpers/db";

const cookieStore = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "vistato_session" && cookieStore.value ? { name, value: cookieStore.value } : undefined),
  }),
  headers: async () => new Headers(cookieStore.value ? { cookie: `vistato_session=${cookieStore.value}` } : {}),
}));

const BASE = "http://localhost:3100";
const PASSWORD = "correct-horse-battery";

let tenantId: string;
let userId: string;

beforeEach(async () => {
  cookieStore.value = undefined;
  tenantId = (await createTenant({ businessName: "Acme S.r.l.", vatNumber: "12345678903" }, testDb())).id;
  const user = await forTenant(tenantId, testDb()).users.create({
    email: "Mario@Acme.it",
    firstName: "Mario",
    lastName: "Rossi",
    role: "OWNER",
    status: "ACTIVE",
  });
  userId = user.id;
  await forTenant(tenantId, testDb()).users.setPassword(userId, PASSWORD);
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const doLogin = (body: unknown = { email: "mario@acme.it", password: PASSWORD }) => login(post("/api/auth/login", body));
const withCookie = (path: string, token: string | undefined, init: RequestInit = {}) =>
  new Request(`${BASE}${path}`, { ...init, headers: { ...(token === undefined ? {} : { cookie: `vistato_session=${token}` }), ...(init.headers as object) } });
const tokenOf = (res: Response) => /vistato_session=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";

describe("POST /api/auth/login CSRF, media type, size and re-login", () => {
  const creds = { email: "mario@acme.it", password: PASSWORD };

  it("answers 415 unsupported_media_type, with no session, for a non-JSON Content-Type or none", async () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      const res = await login(post("/api/auth/login", creds, { "content-type": type }));
      expect(res.status, type).toBe(415);
      expect((await res.json()).error).toBe("unsupported_media_type");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    const none = await login(new Request(`${BASE}/api/auth/login`, { method: "POST", body: JSON.stringify(creds) }));
    expect(none.status).toBe(415);
    expect((await login(post("/api/auth/login", creds, { "content-type": "Application/JSON; charset=utf-8" }))).status).toBe(200);
  });

  it("answers 403 forbidden_origin for a foreign Origin without a session; own Origin and no Origin are accepted", async () => {
    for (const origin of ["https://evil.example", "null"]) {
      const res = await login(post("/api/auth/login", creds, { origin }));
      expect(res.status, origin).toBe(403);
      expect((await res.json()).error).toBe("forbidden_origin");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect((await login(post("/api/auth/login", creds, { origin: BASE }))).status).toBe(200);
    expect((await doLogin()).status).toBe(200);
  });

  it("behind a proxy (APP_ORIGIN set, request.url internal) accepts the public Origin and refuses the others, on login and logout", async () => {
    vi.stubEnv("APP_ORIGIN", "https://app.vistato.it");
    try {
      const internal = (path: string, headers: Record<string, string>) =>
        new Request(`http://localhost:3000${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", host: "app.vistato.it", ...headers },
          body: JSON.stringify(creds),
        });
      const ok = await login(internal("/api/auth/login", { origin: "https://app.vistato.it" }));
      expect(ok.status).toBe(200);
      expect((await login(internal("/api/auth/login", { origin: "https://evil.example" }))).status).toBe(403);
      expect((await login(internal("/api/auth/login", { origin: "http://localhost:3000" }))).status).toBe(403);
      const token = tokenOf(ok);
      const out = await logout(withCookie("/api/auth/logout", token, { method: "POST", headers: { origin: "https://app.vistato.it" } }));
      expect(out.status).toBe(204);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects a body over 8 KB, declared or streamed without Content-Length, and accepts one just under", async () => {
    const big = JSON.stringify({ ...creds, password: "x".repeat(9000) });
    const declared = await login(post("/api/auth/login", big));
    expect(declared.status).toBe(400);
    expect((await declared.json()).issues[0].message).toBe("Richiesta troppo grande");

    const bytes = new TextEncoder().encode(JSON.stringify({ ...creds, password: "x".repeat(200_000) }));
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= bytes.length) return controller.close();
        controller.enqueue(bytes.slice(pulled, pulled + 1024));
        pulled += 1024;
      },
    });
    const streamed = await login(
      new Request(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit),
    );
    expect(streamed.status).toBe(400);
    expect((await streamed.json()).issues[0].message).toBe("Richiesta troppo grande");
    expect(pulled).toBeLessThan(bytes.length);

    expect((await doLogin({ ...creds, password: "x".repeat(1024) })).status).toBe(401);
  });

  it("ends the session of the previous cookie at re-login and ignores an invalid previous cookie", async () => {
    const first = tokenOf(await doLogin());
    const second = await login(withCookie("/api/auth/login", first, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(creds) }));
    expect(second.status).toBe(200);
    expect((await getMe(withCookie("/api/me", first))).status).toBe(401);
    expect((await getMe(withCookie("/api/me", tokenOf(second)))).status).toBe(200);
    const bad = await login(withCookie("/api/auth/login", "invented", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(creds) }));
    expect(bad.status).toBe(200);
  });
});

describe("POST /api/auth/login", () => {
  it("answers 200 with the user resource and a 7-day httpOnly SameSite=Lax cookie", async () => {
    vi.stubEnv("SESSION_COOKIE_SECURE", ""); // anything but "false": Secure stays on
    const res = await doLogin();
    vi.unstubAllEnvs();
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^vistato_session=[A-Za-z0-9_-]{43}; /);
    expect(cookie).toContain("Max-Age=604800");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Secure");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({
      id: userId,
      email: "Mario@Acme.it",
      firstName: "Mario",
      lastName: "Rossi",
      role: "OWNER",
      tenant: { id: tenantId, businessName: "Acme S.r.l." },
      _links: { self: { href: "/api/me" }, "upload-invoice": { href: "/api/invoices", method: "POST", title: "Carica fattura" }, logout: { href: "/api/auth/logout", method: "POST", title: "Esci" } },
    });
    const me = await (await getMe(withCookie("/api/me", tokenOf(res)))).json();
    expect(me).toEqual(body);
  });

  it("accepts an email with other case and surrounding spaces", async () => {
    const res = await doLogin({ email: "  MARIO@acme.IT ", password: PASSWORD });
    expect(res.status).toBe(200);
  });

  it("ignores extra fields such as tenantId", async () => {
    const other = (await createTenant({ businessName: "Beta S.r.l.", taxCode: "RSSMRA80A01H501U" }, testDb())).id;
    const res = await doLogin({ email: "mario@acme.it", password: PASSWORD, tenantId: other });
    expect(res.status).toBe(200);
    expect((await res.json()).tenant.id).toBe(tenantId);
  });

  it("two logins create two independent sessions; logging one out keeps the other", async () => {
    const first = tokenOf(await doLogin());
    const second = tokenOf(await doLogin());
    expect(first).not.toBe(second);
    await logout(withCookie("/api/auth/logout", first, { method: "POST" }));
    expect((await getMe(withCookie("/api/me", first))).status).toBe(401);
    expect((await getMe(withCookie("/api/me", second))).status).toBe(200);
  });

  it("answers the same 401 and sets no cookie for every kind of refusal", async () => {
    const forTenantA = forTenant(tenantId, testDb());
    const invited = await forTenantA.users.create({ email: "inv@acme.it", firstName: "I", lastName: "I", role: "USER", status: "INVITED" });
    await forTenantA.users.setPassword(invited.id, PASSWORD);
    const disabled = await forTenantA.users.create({ email: "dis@acme.it", firstName: "D", lastName: "D", role: "USER", status: "DISABLED" });
    await forTenantA.users.setPassword(disabled.id, PASSWORD);
    const suspended = (await createTenant({ businessName: "Sospesa", taxCode: "RSSMRA80A01H501U" }, testDb())).id;
    const suspendedUser = await forTenant(suspended, testDb()).users.create({ email: "sus@acme.it", firstName: "S", lastName: "S", role: "OWNER", status: "ACTIVE" });
    await forTenant(suspended, testDb()).users.setPassword(suspendedUser.id, PASSWORD);
    await setTenantStatus(suspended, "SUSPENDED", testDb());

    const attempts = [
      { email: "nobody@acme.it", password: PASSWORD },
      { email: "mario@acme.it", password: "wrong-password-123" },
      { email: "inv@acme.it", password: PASSWORD },
      { email: "dis@acme.it", password: PASSWORD },
      { email: "sus@acme.it", password: PASSWORD },
    ];
    for (const attempt of attempts) {
      const res = await doLogin(attempt);
      expect(res.status, attempt.email).toBe(401);
      expect(res.headers.get("set-cookie"), attempt.email).toBeNull();
      expect(await res.json(), attempt.email).toEqual({
        error: "invalid_credentials",
        message: "Email o password non validi",
      });
    }
  });

  it("answers 400 invalid_request with the issues for malformed bodies", async () => {
    const bad: unknown[] = [
      "not json",
      "",
      "null",
      "[]",
      {},
      { email: "mario@acme.it" },
      { password: PASSWORD },
      { email: 42, password: PASSWORD },
      { email: "mario@acme.it", password: 12345 },
      { email: "mario@acme.it", password: "" },
      { email: ["mario@acme.it"], password: PASSWORD },
      { email: "not-an-email", password: PASSWORD },
      { email: "mario@acme.it", password: "x".repeat(1025) },
      { email: "a".repeat(2000) + "@acme.it", password: PASSWORD },
      { email: "mario@acme.it", password: "x".repeat(9000) },
    ];
    for (const body of bad) {
      const res = await doLogin(body);
      const label = JSON.stringify(body)?.slice(0, 60);
      expect(res.status, label).toBe(400);
      expect(res.headers.get("set-cookie"), label).toBeNull();
      const json = await res.json();
      expect(json.error, label).toBe("invalid_request");
      expect(json.message, label).toBeTruthy();
      expect(json.issues.length, label).toBeGreaterThan(0);
      for (const issue of json.issues) expect(issue, label).toEqual({ field: expect.any(String), message: expect.any(String) });
    }
  });

  it("reports which field is wrong", async () => {
    const json = await (await doLogin({ email: "mario@acme.it", password: "x".repeat(1025) })).json();
    expect(json.issues.map((i: { field: string }) => i.field)).toEqual(["password"]);
    const missing = await (await doLogin({})).json();
    expect(missing.issues.map((i: { field: string }) => i.field).sort()).toEqual(["email", "password"]);
  });

  it("accepts a password of exactly 1024 characters as a normal (wrong) credential", async () => {
    expect((await doLogin({ email: "mario@acme.it", password: "x".repeat(1024) })).status).toBe(401);
  });
});

describe("GET /api/me", () => {
  it("answers 401 unauthenticated without cookie, with an empty, invented, malformed or very long one", async () => {
    for (const token of [undefined, "", "invented", "A".repeat(43), "x".repeat(100_000), "../etc/passwd"]) {
      const res = await getMe(withCookie("/api/me", token));
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await res.json()).toEqual({ error: "unauthenticated", message: "Autenticazione richiesta" });
    }
  });

  it("answers 401 for an expired session, valid one millisecond before the expiry", async () => {
    const day = 24 * 60 * 60 * 1000;
    const expired = await createSession(userId, tenantId, testDb(), new Date(Date.now() - 7 * day - 1000));
    expect((await getMe(withCookie("/api/me", expired))).status).toBe(401);
    const valid = await createSession(userId, tenantId, testDb(), new Date(Date.now() - 7 * day + 60_000));
    expect((await getMe(withCookie("/api/me", valid))).status).toBe(200);
  });

  it("answers 401 once the user is disabled or the tenant suspended", async () => {
    const token = tokenOf(await doLogin());
    await forTenant(tenantId, testDb()).users.update(userId, { status: "DISABLED" });
    expect((await getMe(withCookie("/api/me", token))).status).toBe(401);
    await forTenant(tenantId, testDb()).users.update(userId, { status: "ACTIVE" });
    const again = tokenOf(await doLogin());
    await setTenantStatus(tenantId, "SUSPENDED", testDb());
    expect((await getMe(withCookie("/api/me", again))).status).toBe(401);
  });

  it("never exposes the password hash or the token", async () => {
    const res = await doLogin();
    const token = tokenOf(res);
    const text = JSON.stringify(await (await getMe(withCookie("/api/me", token))).json());
    expect(text).not.toMatch(/hash|argon2|password|token/i);
    expect(text).not.toContain(token);
  });
});

describe("POST /api/auth/logout", () => {
  it("answers 204, clears the cookie, deletes the session row and invalidates the old cookie", async () => {
    const token = tokenOf(await doLogin());
    expect(await testDb().select().from(sessions)).toHaveLength(1);
    const res = await logout(withCookie("/api/auth/logout", token, { method: "POST" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toMatch(/^vistato_session=; Max-Age=0; Path=\/; HttpOnly; SameSite=Lax/);
    expect(await res.text()).toBe("");
    expect(await testDb().select().from(sessions)).toHaveLength(0);
    expect((await getMe(withCookie("/api/me", token))).status).toBe(401);
  });

  it("answers 204 without session, with an invented cookie or an empty one", async () => {
    for (const token of [undefined, "", "invented"]) {
      const res = await logout(withCookie("/api/auth/logout", token, { method: "POST" }));
      expect(res.status).toBe(204);
      expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    }
  });

  it("answers 403 forbidden_origin for an authenticated request from another origin and keeps the session", async () => {
    const token = tokenOf(await doLogin());
    const res = await logout(withCookie("/api/auth/logout", token, { method: "POST", headers: { origin: "https://evil.example" } }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("forbidden_origin");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect((await getMe(withCookie("/api/me", token))).status).toBe(200);
  });

  it("accepts the server's own Origin", async () => {
    const token = tokenOf(await doLogin());
    const res = await logout(withCookie("/api/auth/logout", token, { method: "POST", headers: { origin: BASE } }));
    expect(res.status).toBe(204);
  });
});

describe("requireSession", () => {
  it("returns the user, tenant and a scope bound to the session's tenant", async () => {
    const token = tokenOf(await doLogin());
    const auth = await requireSession(withCookie("/api/x", token));
    if (auth instanceof Response) throw new Error("expected a context");
    expect(auth.user.id).toBe(userId);
    expect(auth.tenant).toEqual({ id: tenantId, businessName: "Acme S.r.l." });
    expect(auth.scope.tenantId).toBe(tenantId);
    expect((await auth.scope.users.list()).map((u) => u.id)).toEqual([userId]);
  });

  it("answers 401 without session and 403 for POST from another origin, but allows POST without Origin", async () => {
    const token = tokenOf(await doLogin());
    const none = await requireSession(withCookie("/api/x", undefined, { method: "POST" }));
    expect(none instanceof Response && none.status).toBe(401);
    const evil = await requireSession(withCookie("/api/x", token, { method: "POST", headers: { origin: "https://evil.example" } }));
    expect(evil instanceof Response && evil.status).toBe(403);
    expect(evil instanceof Response && (await evil.json()).error).toBe("forbidden_origin");
    const noOrigin = await requireSession(withCookie("/api/x", token, { method: "POST" }));
    expect(noOrigin instanceof Response).toBe(false);
    const get = await requireSession(withCookie("/api/x", token, { headers: { origin: "https://evil.example" } }));
    expect(get instanceof Response).toBe(false);
  });

  it("answers 401 (not 403) to an unauthenticated request from another origin", async () => {
    const res = await requireSession(withCookie("/api/x", undefined, { method: "POST", headers: { origin: "https://evil.example" } }));
    expect(res instanceof Response && res.status).toBe(401);
  });
});

describe("getSessionFromCookies", () => {
  it("reads the session from the Next cookies and returns null when missing or invalid", async () => {
    const { getSessionFromCookies } = await import("@/lib/auth/session");
    expect(await getSessionFromCookies()).toBeNull();
    cookieStore.value = "invented";
    expect(await getSessionFromCookies()).toBeNull();
    cookieStore.value = tokenOf(await doLogin());
    const auth = await getSessionFromCookies();
    expect(auth?.user.id).toBe(userId);
    expect(auth?.scope.tenantId).toBe(tenantId);
  });
});

describe("GET /api", () => {
  it("has login and no me or logout for an anonymous caller", async () => {
    const body = await (await getApi(withCookie("/api", undefined))).json();
    expect(body._links.login).toEqual({ href: "/api/auth/login", method: "POST", title: "Accedi" });
    expect(body._links).not.toHaveProperty("me");
    expect(body._links).not.toHaveProperty("logout");
    expect(body._links.self.href).toBe("/api");
    expect(body._links.health.href).toBe("/api/health");
  });

  it("has me and logout and no login for an authenticated caller; an invalid cookie counts as anonymous", async () => {
    const token = tokenOf(await doLogin());
    const body = await (await getApi(withCookie("/api", token))).json();
    expect(body._links.me.href).toBe("/api/me");
    expect(body._links.logout).toMatchObject({ href: "/api/auth/logout", method: "POST" });
    expect(body._links).not.toHaveProperty("login");
    const anon = await (await getApi(withCookie("/api", "invented"))).json();
    expect(anon._links).toHaveProperty("login");
  });
});

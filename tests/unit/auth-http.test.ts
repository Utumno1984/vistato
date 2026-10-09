import { afterEach, describe, expect, it, vi } from "vitest";

import { hasForeignOrigin } from "@/lib/auth/session";
import { clearedSessionCookie, readSessionToken, sessionCookie } from "@/lib/auth/session-cookie";
import { userResource } from "@/lib/auth/user-resource";
import { errorResponse, forbiddenOrigin, invalidRequest, unauthenticated, zodIssues } from "@/lib/http/errors";
import { z } from "zod";

const withCookie = (cookie?: string) =>
  new Request("http://localhost:3100/api/me", { headers: cookie === undefined ? {} : { cookie } });

describe("session cookie", () => {
  const originalSecure = process.env.SESSION_COOKIE_SECURE;
  afterEach(() => {
    if (originalSecure === undefined) delete process.env.SESSION_COOKIE_SECURE;
    else process.env.SESSION_COOKIE_SECURE = originalSecure;
  });

  it("is httpOnly, SameSite=Lax, Path=/, 7 days and Secure by default", () => {
    delete process.env.SESSION_COOKIE_SECURE;
    expect(sessionCookie("abc")).toBe(
      "vistato_session=abc; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax; Secure",
    );
  });

  it("drops Secure only when SESSION_COOKIE_SECURE is exactly false", () => {
    process.env.SESSION_COOKIE_SECURE = "false";
    expect(sessionCookie("abc")).not.toContain("Secure");
    process.env.SESSION_COOKIE_SECURE = "no";
    expect(sessionCookie("abc")).toContain("; Secure");
    process.env.SESSION_COOKIE_SECURE = "";
    expect(sessionCookie("abc")).toContain("; Secure");
  });

  it("is cleared with Max-Age=0 and the same attributes", () => {
    delete process.env.SESSION_COOKIE_SECURE;
    expect(clearedSessionCookie()).toBe("vistato_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure");
  });

  it("reads the token among other cookies, and returns null when absent, empty or malformed", () => {
    expect(readSessionToken(withCookie("a=1; vistato_session=tok_en-1; b=2"))).toBe("tok_en-1");
    expect(readSessionToken(withCookie("vistato_session=first; vistato_session=second"))).toBe("first");
    expect(readSessionToken(withCookie())).toBeNull();
    expect(readSessionToken(withCookie("other=1"))).toBeNull();
    expect(readSessionToken(withCookie("not-a-cookie"))).toBeNull();
    expect(readSessionToken(withCookie("xvistato_session=nope"))).toBeNull();
    expect(readSessionToken(withCookie("vistato_session="))).toBe("");
  });
});

describe("hasForeignOrigin", () => {
  const request = (method: string, origin?: string) =>
    new Request("http://localhost:3100/api/x", { method, headers: origin === undefined ? {} : { origin } });

  it("refuses a state-changing request from another origin, including the opaque null origin", () => {
    expect(hasForeignOrigin(request("POST", "https://evil.example"))).toBe(true);
    expect(hasForeignOrigin(request("DELETE", "http://localhost:3101"))).toBe(true);
    expect(hasForeignOrigin(request("PATCH", "https://localhost:3100"))).toBe(true);
    expect(hasForeignOrigin(request("POST", "null"))).toBe(true);
  });

  it("allows the same origin, a missing Origin header and safe methods", () => {
    expect(hasForeignOrigin(request("POST", "http://localhost:3100"))).toBe(false);
    expect(hasForeignOrigin(request("POST"))).toBe(false);
    expect(hasForeignOrigin(request("GET", "https://evil.example"))).toBe(false);
  });
});

describe("hasForeignOrigin with APP_ORIGIN", () => {
  // Behind a proxy request.url is the internal address while the browser sends the public Origin.
  const proxied = (origin?: string) =>
    new Request("http://localhost:3000/api/x", {
      method: "POST",
      headers: origin === undefined ? {} : { origin, host: "app.vistato.it" },
    });

  afterEach(() => vi.unstubAllEnvs());

  it("accepts the configured public origin (also in a list) although request.url is localhost, and refuses the others", () => {
    vi.stubEnv("APP_ORIGIN", "https://app.vistato.it");
    expect(hasForeignOrigin(proxied("https://app.vistato.it"))).toBe(false);
    expect(hasForeignOrigin(proxied("https://evil.example"))).toBe(true);
    expect(hasForeignOrigin(proxied("https://app.vistato.it.evil.example"))).toBe(true);
    expect(hasForeignOrigin(proxied("http://localhost:3000"))).toBe(true);
    expect(hasForeignOrigin(proxied())).toBe(false);
    vi.stubEnv("APP_ORIGIN", " https://a.example/ , https://app.vistato.it ");
    expect(hasForeignOrigin(proxied("https://app.vistato.it"))).toBe(false);
    expect(hasForeignOrigin(proxied("https://a.example"))).toBe(false);
  });

  it("falls back to the origin of request.url when APP_ORIGIN is unset, empty or unparsable", () => {
    for (const value of ["", "  ", "not a url"]) {
      vi.stubEnv("APP_ORIGIN", value);
      expect(hasForeignOrigin(proxied("http://localhost:3000"))).toBe(false);
      expect(hasForeignOrigin(proxied("https://app.vistato.it"))).toBe(true);
    }
  });
});

describe("API errors", () => {
  it("have the uniform body and are never cached", async () => {
    const res = unauthenticated();
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "unauthenticated", message: "Autenticazione richiesta" });
    expect(forbiddenOrigin().status).toBe(403);
    expect(await errorResponse(418, "teapot", "Sono una teiera").json()).toEqual({
      error: "teapot",
      message: "Sono una teiera",
    });
  });

  it("lists the issues with a dotted field path, and body for the root", async () => {
    const schema = z.object({ a: z.object({ b: z.string() }) });
    const nested = schema.safeParse({ a: {} });
    const root = schema.safeParse(null);
    if (nested.success || root.success) throw new Error("expected failures");
    expect(zodIssues(nested.error).map((i) => i.field)).toEqual(["a.b"]);
    expect(zodIssues(root.error).map((i) => i.field)).toEqual(["body"]);
    const res = invalidRequest(zodIssues(nested.error));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_request");
  });
});

describe("userResource", () => {
  it("exposes the user and tenant with self and logout links, and nothing else", () => {
    const res = userResource({
      user: { id: "u", email: "a@b.it", firstName: "A", lastName: "B", role: "OWNER" },
      tenant: { id: "t", businessName: "Acme" },
    });
    expect(res).toEqual({
      id: "u",
      email: "a@b.it",
      firstName: "A",
      lastName: "B",
      role: "OWNER",
      tenant: { id: "t", businessName: "Acme" },
      _links: {
        self: { href: "/api/me" },
        "upload-invoice": { href: "/api/invoices", method: "POST", title: "Carica fattura" },
        logout: { href: "/api/auth/logout", method: "POST", title: "Esci" },
      },
    });
  });
});

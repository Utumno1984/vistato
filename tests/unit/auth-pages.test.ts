import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { DEFAULT_NEXT_PATH, safeNextPath } from "@/lib/auth/next-path";
import { readSessionToken } from "@/lib/auth/session-cookie";
import { parseSessionToken } from "@/lib/auth/session-token";
import { config, proxy } from "@/proxy";

describe("safeNextPath", () => {
  it("keeps an internal path, with its query string", () => {
    expect(safeNextPath("/fatture")).toBe("/fatture");
    expect(safeNextPath("/fatture?status=PENDING")).toBe("/fatture?status=PENDING");
    expect(safeNextPath("/fatture/123?a=1&b=%2Fx#top")).toBe("/fatture/123?a=1&b=%2Fx#top");
  });

  it("falls back to /fatture for absolute, protocol-relative and backslash URLs", () => {
    for (const value of ["https://evil.example", "http://evil.example/fatture", "//evil.example", "///evil.example", "/\\evil.example", "/fatture\\..\\x", "javascript:alert(1)"]) {
      expect(safeNextPath(value), value).toBe(DEFAULT_NEXT_PATH);
    }
  });

  it("falls back to /fatture when the value does not start with a slash", () => {
    for (const value of ["fatture", "evil.example", " /fatture", "", "?x=1"]) {
      expect(safeNextPath(value), JSON.stringify(value)).toBe(DEFAULT_NEXT_PATH);
    }
  });

  it("falls back to /fatture for control characters, non-strings and very long values", () => {
    for (const value of ["/\t/evil.example", "/fatture\nSet-Cookie: x", "/a\u0000b", undefined, null, 42, ["/fatture"], { a: 1 }, `/${"a".repeat(3000)}`]) {
      expect(safeNextPath(value), String(value)).toBe(DEFAULT_NEXT_PATH);
    }
  });
});

describe("parseSessionToken", () => {
  it("takes the first vistato_session when the header carries it twice, like readSessionToken", () => {
    const header = "vistato_session=first; other=1; vistato_session=second";
    expect(parseSessionToken(header)).toBe("first");
    expect(readSessionToken(new Request("http://localhost/x", { headers: { cookie: header } }))).toBe("first");
  });

  it("returns null for a missing header or cookie, and does not match a longer name", () => {
    expect(parseSessionToken(null)).toBeNull();
    expect(parseSessionToken(undefined)).toBeNull();
    expect(parseSessionToken("a=1")).toBeNull();
    expect(parseSessionToken("xvistato_session=nope")).toBeNull();
  });
});

describe("proxy", () => {
  const request = (path: string, cookie?: string) =>
    new NextRequest(`http://localhost:3100${path}`, { headers: cookie === undefined ? {} : { cookie } });

  it("redirects a page without the session cookie to /login with the original path and query", () => {
    const res = proxy(request("/fatture?status=PENDING"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3100/login?next=%2Ffatture%3Fstatus%3DPENDING");
    expect(proxy(request("/fatture")).headers.get("location")).toBe("http://localhost:3100/login?next=%2Ffatture");
  });

  it("redirects when the cookie is present but empty", () => {
    expect(proxy(request("/fatture", "vistato_session=")).status).toBe(307);
  });

  it("lets a request with a session cookie through (the real check is on the server)", () => {
    const res = proxy(request("/fatture", "vistato_session=whatever"));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("matches only /fatture and below: not /, /login, /api", () => {
    expect(config.matcher).toEqual(["/fatture", "/fatture/:path*"]);
  });
});

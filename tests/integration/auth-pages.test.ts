import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST as login } from "@/app/api/auth/login/route";
import { GET as getMe } from "@/app/api/me/route";
import { createSession } from "@/db/auth";
import { createTenant } from "@/db/platform/tenants";
import { forTenant } from "@/db/tenant-scope";

import { testDb } from "../helpers/db";

const cookieHeader = vi.hoisted(() => ({ value: undefined as string | undefined }));
const pathHeader = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  headers: async () => {
    const h = new Headers(cookieHeader.value ? { cookie: cookieHeader.value } : {});
    if (pathHeader.value) h.set("x-vistato-path", pathHeader.value);
    return h;
  },
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));

const PASSWORD = "correct-horse-battery";
let tenantId: string;
let userId: string;

beforeEach(async () => {
  cookieHeader.value = undefined;
  tenantId = (await createTenant({ businessName: "Acme S.r.l.", vatNumber: "12345678903" }, testDb())).id;
  const user = await forTenant(tenantId, testDb()).users.create({
    email: "mario@acme.it",
    firstName: "Mario",
    lastName: "Rossi",
    role: "OWNER",
    status: "ACTIVE",
  });
  userId = user.id;
  await forTenant(tenantId, testDb()).users.setPassword(userId, PASSWORD);
});

describe("requirePageSession", () => {
  it("returns the user and the tenant of the cookie, and redirects to /login without a valid one", async () => {
    const { requirePageSession } = await import("@/lib/auth/page-session");
    await expect(requirePageSession()).rejects.toThrow("REDIRECT /login");
    cookieHeader.value = "vistato_session=invented";
    await expect(requirePageSession()).rejects.toThrow("REDIRECT /login");
    cookieHeader.value = `vistato_session=${await createSession(userId, tenantId)}`;
    const auth = await requirePageSession();
    expect(auth.user.firstName).toBe("Mario");
    expect(auth.tenant.businessName).toBe("Acme S.r.l.");
  });

  it("rebuilds next from the path set by the proxy, and ignores an unsafe one", async () => {
    const { requirePageSession } = await import("@/lib/auth/page-session");
    cookieHeader.value = "vistato_session=invented";
    pathHeader.value = "/fatture?page=2";
    await expect(requirePageSession()).rejects.toThrow("REDIRECT /login?next=%2Ffatture%3Fpage%3D2");
    pathHeader.value = "//evil.example";
    await expect(requirePageSession()).rejects.toThrow("REDIRECT /login?next=%2Ffatture");
    pathHeader.value = undefined;
  });

  it("redirects once the user is disabled", async () => {
    const { requirePageSession } = await import("@/lib/auth/page-session");
    cookieHeader.value = `vistato_session=${await createSession(userId, tenantId)}`;
    await expect(requirePageSession()).resolves.toBeDefined();
    await forTenant(tenantId, testDb()).users.update(userId, { status: "DISABLED" });
    await expect(requirePageSession()).rejects.toThrow("REDIRECT /login");
  });
});

describe("duplicate vistato_session cookies", () => {
  it("pages and API routes both use the first cookie of the header", async () => {
    const { getSessionFromCookies } = await import("@/lib/auth/session");
    const valid = await createSession(userId, tenantId);
    const header = `vistato_session=${valid}; vistato_session=invented`;
    cookieHeader.value = header;
    expect((await getSessionFromCookies())?.user.id).toBe(userId);
    const me = await getMe(new Request("http://localhost:3100/api/me", { headers: { cookie: header } }));
    expect(me.status).toBe(200);

    const reversed = `vistato_session=invented; vistato_session=${valid}`;
    cookieHeader.value = reversed;
    expect(await getSessionFromCookies()).toBeNull();
    const meReversed = await getMe(new Request("http://localhost:3100/api/me", { headers: { cookie: reversed } }));
    expect(meReversed.status).toBe(401);
  });
});

describe("login used by the page", () => {
  it("answers 401 with the message shown on the page, for a JSON POST with the same Origin", async () => {
    const res = await login(
      new Request("http://localhost:3100/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3100" },
        body: JSON.stringify({ email: "mario@acme.it", password: "wrong" }),
      }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).message).toBe("Email o password non validi");
  });
});

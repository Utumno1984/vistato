import { beforeEach, describe, expect, it } from "vitest";

import { createSession } from "@/db/auth";
import { createTenant, setTenantStatus } from "@/db/platform/tenants";
import { forTenant, type UserRole } from "@/db/tenant-scope";
import { requireSession, type AuthContext } from "@/lib/auth/session";
import { ficIbanAlertAccess, requireFicIbanAlert, type FicIbanAlertNeed } from "@/lib/fic-iban-alert/access";

import { testDb } from "../helpers/db";

const BASE = "http://localhost:3100";
const PAST = new Date("2026-01-01T00:00:00.000Z");
const FUTURE = new Date("2099-01-01T00:00:00.000Z");
const ROLES: UserRole[] = ["OWNER", "ADMIN", "USER"];
const NEEDS: FicIbanAlertNeed[] = ["read", "manage"];
const ms = (d: Date, delta: number) => new Date(d.getTime() + delta);

let tenantA: string;
let tenantB: string;

beforeEach(async () => {
  tenantA = (await createTenant({ businessName: "Acme S.r.l.", vatNumber: "12345678903" }, testDb())).id;
  tenantB = (await createTenant({ businessName: "Beta S.r.l.", taxCode: "RSSMRA80A01H501U" }, testDb())).id;
});

const scope = (tenantId: string) => forTenant(tenantId, testDb());
const activate = (tenantId: string, activatedAt: Date = PAST, expiresAt?: Date | null) =>
  scope(tenantId).modules.activate("fic_iban_alert", { activatedAt, expiresAt });

let counter = 0;
/** A user of the tenant with a session; returns the user id and the session token. */
async function userWithSession(tenantId: string, role: UserRole) {
  counter += 1;
  const user = await scope(tenantId).users.create({
    email: `user${counter}@example.com`,
    firstName: "Mario",
    lastName: "Rossi",
    role,
    status: "ACTIVE",
  });
  return { userId: user.id, token: await createSession(user.id, tenantId, testDb()) };
}

/** The session as the API routes resolve it (`requireSession`), or null when it answers 401. */
async function authOf(token: string): Promise<AuthContext | null> {
  const auth = await requireSession(new Request(`${BASE}/api/x`, { headers: { cookie: `vistato_session=${token}` } }));
  if (auth instanceof Response) {
    expect(auth.status).toBe(401);
    return null;
  }
  return auth;
}

async function callerOf(tenantId: string, role: UserRole): Promise<AuthContext> {
  const auth = await authOf((await userWithSession(tenantId, role)).token);
  if (!auth) throw new Error("expected a valid session");
  return auth;
}

async function expectError(result: AuthContext | Response, status: number, error: string) {
  expect(result).toBeInstanceOf(Response);
  const res = result as Response;
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = await res.json();
  expect(body.error).toBe(error);
  expect(typeof body.message).toBe("string");
}

describe("ficIbanAlertAccess", () => {
  it("with the module active gives canRead to every role and canManage only to OWNER and ADMIN", async () => {
    await activate(tenantA);
    for (const role of ROLES) {
      const access = await ficIbanAlertAccess(await callerOf(tenantA, role));
      expect(access, role).toEqual({ moduleActive: true, canRead: true, canManage: role !== "USER" });
    }
  });

  it("without the module gives false to every role", async () => {
    for (const role of ROLES) {
      expect(await ficIbanAlertAccess(await callerOf(tenantA, role)), role).toEqual({
        moduleActive: false,
        canRead: false,
        canManage: false,
      });
    }
  });

  it("gives false after the module is cancelled", async () => {
    await activate(tenantA);
    const owner = await callerOf(tenantA, "OWNER");
    expect((await ficIbanAlertAccess(owner)).canManage).toBe(true);
    await scope(tenantA).modules.cancel("fic_iban_alert");
    expect(await ficIbanAlertAccess(owner)).toEqual({ moduleActive: false, canRead: false, canManage: false });
  });

  it.each(["SUSPENDED", "CLOSED"] as const)("gives false for a %s tenant with the module active", async (status) => {
    await activate(tenantA);
    // Session resolved while the tenant was ACTIVE (e.g. a request in flight when it gets suspended).
    const owner = await callerOf(tenantA, "OWNER");
    await setTenantStatus(tenantA, status, testDb());
    expect(await ficIbanAlertAccess(owner)).toEqual({ moduleActive: false, canRead: false, canManage: false });
  });

  it("follows expires_at: active before it (exclusive), inactive from it on", async () => {
    const expiresAt = new Date("2026-06-15T12:00:00.000Z");
    await activate(tenantA, PAST, expiresAt);
    const owner = await callerOf(tenantA, "OWNER");
    expect((await ficIbanAlertAccess(owner, ms(expiresAt, -1))).canManage).toBe(true);
    expect((await ficIbanAlertAccess(owner, expiresAt)).moduleActive).toBe(false);
    expect((await ficIbanAlertAccess(owner, ms(expiresAt, 1))).canRead).toBe(false);
  });

  it("follows activated_at: inactive before it, active from it on (inclusive)", async () => {
    const activatedAt = new Date("2026-06-15T12:00:00.000Z");
    await activate(tenantA, activatedAt);
    const owner = await callerOf(tenantA, "OWNER");
    expect((await ficIbanAlertAccess(owner, ms(activatedAt, -1))).moduleActive).toBe(false);
    expect((await ficIbanAlertAccess(owner, activatedAt)).canManage).toBe(true);
  });

  it("uses the session's tenant: the module active on tenant A gives nothing to users of tenant B", async () => {
    await activate(tenantA);
    for (const role of ROLES) {
      expect(await ficIbanAlertAccess(await callerOf(tenantB, role)), role).toEqual({
        moduleActive: false,
        canRead: false,
        canManage: false,
      });
    }
    expect((await ficIbanAlertAccess(await callerOf(tenantA, "USER"))).canRead).toBe(true);
  });
});

describe("requireFicIbanAlert", () => {
  it("answers 401 unauthenticated without a session, before any other check", async () => {
    // Module not active anywhere: the 401 must still win over 403 module_not_active.
    for (const need of NEEDS) {
      await expectError(await requireFicIbanAlert(null, need), 401, "unauthenticated");
      await expectError(await requireFicIbanAlert(undefined, need), 401, "unauthenticated");
    }
  });

  it("answers 403 module_not_active to every role when the module is not active", async () => {
    for (const role of ROLES) {
      const caller = await callerOf(tenantA, role);
      for (const need of NEEDS) await expectError(await requireFicIbanAlert(caller, need), 403, "module_not_active");
    }
  });

  it("answers 403 forbidden to a USER that needs manage, and lets USER read", async () => {
    await activate(tenantA);
    const user = await callerOf(tenantA, "USER");
    await expectError(await requireFicIbanAlert(user, "manage"), 403, "forbidden");
    expect(await requireFicIbanAlert(user, "read")).toBe(user);
  });

  it("lets OWNER and ADMIN read and manage when the module is active", async () => {
    await activate(tenantA);
    for (const role of ["OWNER", "ADMIN"] as const) {
      const caller = await callerOf(tenantA, role);
      for (const need of NEEDS) expect(await requireFicIbanAlert(caller, need), `${role} ${need}`).toBe(caller);
    }
  });

  it("matches ficIbanAlertAccess exactly, for every role, need and module state", async () => {
    for (const active of [false, true]) {
      if (active) await activate(tenantA);
      for (const role of ROLES) {
        const caller = await callerOf(tenantA, role);
        const access = await ficIbanAlertAccess(caller);
        for (const need of NEEDS) {
          const granted = !((await requireFicIbanAlert(caller, need)) instanceof Response);
          expect(granted, `${active} ${role} ${need}`).toBe(need === "read" ? access.canRead : access.canManage);
        }
      }
    }
  });

  it("fails closed on an unknown need: treated as manage", async () => {
    await activate(tenantA);
    const user = await callerOf(tenantA, "USER");
    await expectError(await requireFicIbanAlert(user, "admin" as FicIbanAlertNeed), 403, "forbidden");
  });

  it("answers 403 module_not_active with an expired module and grants access with a future expiry", async () => {
    await activate(tenantA, PAST, ms(new Date(), -1000));
    await activate(tenantB, PAST, FUTURE);
    await expectError(await requireFicIbanAlert(await callerOf(tenantA, "OWNER"), "read"), 403, "module_not_active");
    const ownerB = await callerOf(tenantB, "OWNER");
    expect(await requireFicIbanAlert(ownerB, "manage")).toBe(ownerB);
  });

  it("answers 403 module_not_active with an activation in the future", async () => {
    await activate(tenantA, FUTURE);
    await expectError(await requireFicIbanAlert(await callerOf(tenantA, "OWNER"), "read"), 403, "module_not_active");
  });

  it("answers 403 module_not_active to tenant B when only tenant A has the module", async () => {
    await activate(tenantA);
    for (const role of ROLES) {
      const callerB = await callerOf(tenantB, role);
      await expectError(await requireFicIbanAlert(callerB, "read"), 403, "module_not_active");
    }
  });

  it("denies a SUSPENDED tenant with the module active: 401 for a new request, 403 for a session already resolved", async () => {
    await activate(tenantA);
    const { token } = await userWithSession(tenantA, "OWNER");
    const resolved = await authOf(token);
    await setTenantStatus(tenantA, "SUSPENDED", testDb());

    const fresh = await authOf(token);
    expect(fresh).toBeNull();
    await expectError(await requireFicIbanAlert(fresh, "read"), 401, "unauthenticated");
    await expectError(await requireFicIbanAlert(resolved, "read"), 403, "module_not_active");
  });

  it("answers 401 for a DISABLED user, already at session resolution", async () => {
    await activate(tenantA);
    const { userId, token } = await userWithSession(tenantA, "OWNER");
    expect(await authOf(token)).not.toBeNull();
    await scope(tenantA).users.update(userId, { status: "DISABLED" });

    const auth = await authOf(token);
    expect(auth).toBeNull();
    for (const need of NEEDS) await expectError(await requireFicIbanAlert(auth, need), 401, "unauthenticated");
  });
});

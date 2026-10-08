import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { beforeEach, describe, expect, it } from "vitest";

import type { ModuleCode } from "@/db/catalog/modules";
import { hasModule } from "@/db/entitlements";
import { TenantNotFoundError, ValidationError } from "@/db/errors";
import { requireTestDatabaseUrl } from "@/db/migrate";
import * as schema from "@/db/schema";
import { getModuleByCode, listModuleCatalog } from "@/db/platform/modules";
import { createTenant, setTenantStatus } from "@/db/platform/tenants";
import { forTenant } from "@/db/tenant-scope";

import { testDb, testSql } from "../helpers/db";

const UNKNOWN_UUID = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const NOW = new Date("2026-06-15T12:00:00.000Z");
const PAST = new Date("2026-01-01T00:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");
const ms = (d: Date, delta: number) => new Date(d.getTime() + delta);

let tenantA: string;
let tenantB: string;

beforeEach(async () => {
  tenantA = (await createTenant({ businessName: "Acme S.r.l.", vatNumber: "12345678903" }, testDb())).id;
  tenantB = (await createTenant({ businessName: "Beta S.r.l.", taxCode: "RSSMRA80A01H501U" }, testDb())).id;
});

const scope = (tenantId: string) => forTenant(tenantId, testDb());
const has = (tenantId: string, code: ModuleCode, at: Date = NOW) => hasModule(tenantId, code, at, testDb());
const activate = (tenantId: string, code: ModuleCode, activatedAt: Date, expiresAt?: Date | null) =>
  scope(tenantId).modules.activate(code, { activatedAt, expiresAt });

async function rows(tenantId?: string) {
  return tenantId
    ? testSql()`select * from tenant_modules where tenant_id = ${tenantId} order by id`
    : testSql()`select * from tenant_modules order by id`;
}

describe("hasModule", () => {
  it("is true for the base module of an ACTIVE tenant without purchases", async () => {
    expect(await has(tenantA, "approvals")).toBe(true);
  });

  it("is false for a paid module that was never purchased", async () => {
    expect(await has(tenantA, "cost_centers")).toBe(false);
  });

  it("is true for a purchased module without expiry", async () => {
    await activate(tenantA, "cost_centers", PAST);
    expect(await has(tenantA, "cost_centers")).toBe(true);
  });

  it("is true for a purchased module with a future expiry", async () => {
    await activate(tenantA, "cost_centers", PAST, FUTURE);
    expect(await has(tenantA, "cost_centers")).toBe(true);
  });

  it("is false for a CANCELLED module with valid dates", async () => {
    await activate(tenantA, "cost_centers", PAST, FUTURE);
    await scope(tenantA).modules.cancel("cost_centers");
    expect(await has(tenantA, "cost_centers")).toBe(false);
  });

  it("is false for an expired module", async () => {
    await activate(tenantA, "cost_centers", PAST, ms(NOW, -1000));
    expect(await has(tenantA, "cost_centers")).toBe(false);
  });

  it("treats the expiry as exclusive", async () => {
    await activate(tenantA, "cost_centers", PAST, FUTURE);
    expect(await has(tenantA, "cost_centers", ms(FUTURE, -1))).toBe(true);
    expect(await has(tenantA, "cost_centers", FUTURE)).toBe(false);
    expect(await has(tenantA, "cost_centers", ms(FUTURE, 1))).toBe(false);
  });

  it("treats the activation as inclusive", async () => {
    await activate(tenantA, "cost_centers", FUTURE);
    expect(await has(tenantA, "cost_centers", ms(FUTURE, -1))).toBe(false);
    expect(await has(tenantA, "cost_centers", FUTURE)).toBe(true);
    expect(await has(tenantA, "cost_centers", ms(FUTURE, 1))).toBe(true);
  });

  it("defaults the reference instant to now", async () => {
    await activate(tenantA, "cost_centers", ms(new Date(), -60_000), ms(new Date(), 60_000));
    expect(await hasModule(tenantA, "cost_centers", undefined, testDb())).toBe(true);
    await activate(tenantA, "payment_schedule", ms(new Date(), 60_000));
    expect(await hasModule(tenantA, "payment_schedule", undefined, testDb())).toBe(false);
  });

  it.each(["SUSPENDED", "CLOSED"] as const)("is false for every module of a %s tenant", async (status) => {
    await activate(tenantA, "cost_centers", PAST);
    expect(await has(tenantA, "cost_centers")).toBe(true);
    await setTenantStatus(tenantA, status, testDb());
    expect(await has(tenantA, "cost_centers")).toBe(false);
    expect(await has(tenantA, "approvals")).toBe(false);
    await setTenantStatus(tenantA, "ACTIVE", testDb());
    expect(await has(tenantA, "cost_centers")).toBe(true);
  });

  it("does not leak a module from tenant A to tenant B", async () => {
    await activate(tenantA, "cost_centers", PAST);
    expect(await has(tenantA, "cost_centers")).toBe(true);
    expect(await has(tenantB, "cost_centers")).toBe(false);
    expect(await has(tenantB, "approvals")).toBe(true);
  });

  it("is not affected by a tenant_modules row of a base module, whatever its state", async () => {
    await activate(tenantA, "approvals", PAST, ms(PAST, 1000));
    await scope(tenantA).modules.cancel("approvals");
    expect(await has(tenantA, "approvals")).toBe(true);
    await setTenantStatus(tenantA, "SUSPENDED", testDb());
    expect(await has(tenantA, "approvals")).toBe(false);
  });

  it.each([UNKNOWN_UUID, "not-a-uuid", "", "' or 1=1 --", `${tenantA}\u0000`])(
    "is false, without errors, for the tenant id %j",
    async (tenantId) => {
      expect(await has(tenantId, "approvals")).toBe(false);
      expect(await has(tenantId, "cost_centers")).toBe(false);
    },
  );

  it("is false for a code outside the catalogue", async () => {
    expect(await has(tenantA, "nonexistent" as ModuleCode)).toBe(false);
  });

  it("is false for an invalid reference instant", async () => {
    expect(await has(tenantA, "approvals", new Date("invalid"))).toBe(false);
  });

  it("is also available as forTenant(t).hasModule", async () => {
    await activate(tenantA, "cost_centers", PAST, FUTURE);
    expect(await scope(tenantA).hasModule("cost_centers", NOW)).toBe(true);
    expect(await scope(tenantA).hasModule("cost_centers", FUTURE)).toBe(false);
    expect(await scope(tenantB).hasModule("cost_centers", NOW)).toBe(false);
    expect(await scope(tenantB).hasModule("approvals", NOW)).toBe(true);
  });

  it("compares instants in UTC whatever the time zone of the session", async () => {
    await activate(tenantA, "cost_centers", new Date("2026-03-29T00:30:00.000Z"), new Date("2026-03-29T01:30:00.000Z"));
    // 2026-03-29 is the Europe/Rome DST change: 02:00 local jumps to 03:00.
    // The queries below run on a dedicated single-connection client whose session time zone
    // is UTC+14, so the SET cannot be lost in a pool nor leak into other tests.
    const zoned = postgres(requireTestDatabaseUrl(), {
      max: 1,
      onnotice: () => {},
      connection: { TimeZone: "Pacific/Kiritimati" },
    });
    try {
      const [{ TimeZone: sessionZone }] = await zoned`show time zone`;
      expect(sessionZone).toBe("Pacific/Kiritimati");
      const zonedDb = drizzle(zoned, { schema });
      const hasZoned = (at: Date) => hasModule(tenantA, "cost_centers", at, zonedDb);
      expect(await hasZoned(new Date("2026-03-29T01:29:59.999Z"))).toBe(true);
      expect(await hasZoned(new Date("2026-03-29T01:30:00.000Z"))).toBe(false);
      expect(await hasZoned(new Date("2026-03-29T00:30:00.000Z"))).toBe(true);
      expect(await hasZoned(new Date("2026-03-29T00:29:59.999Z"))).toBe(false);
    } finally {
      await zoned.end();
    }
    expect(await has(tenantA, "cost_centers", new Date("2026-03-29T01:29:59.999Z"))).toBe(true);
    expect(await has(tenantA, "cost_centers", new Date("2026-03-29T01:30:00.000Z"))).toBe(false);
    expect(await has(tenantA, "cost_centers", new Date("2026-03-29T00:29:59.999Z"))).toBe(false);
    const [{ expires }] = await testSql()`select to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') as expires from tenant_modules`;
    expect(expires).toBe("2026-03-29T01:30:00");
  });
});

describe("forTenant(t).modules", () => {
  it("activates a module with the given dates", async () => {
    const row = await activate(tenantA, "purchase_orders", PAST, FUTURE);
    expect(row).toMatchObject({ tenantId: tenantA, status: "ACTIVE", activatedAt: PAST, expiresAt: FUTURE });
    expect(await rows(tenantA)).toHaveLength(1);
  });

  it("stores no expiry when expiresAt is omitted or null", async () => {
    expect((await activate(tenantA, "purchase_orders", PAST)).expiresAt).toBeNull();
    expect((await activate(tenantA, "purchase_orders", PAST, null)).expiresAt).toBeNull();
  });

  it("reactivates a CANCELLED module on the same row with the new dates", async () => {
    const first = await activate(tenantA, "purchase_orders", PAST, FUTURE);
    await scope(tenantA).modules.cancel("purchase_orders");
    const newExpiry = new Date("2028-01-01T00:00:00.000Z");
    const again = await activate(tenantA, "purchase_orders", NOW, newExpiry);
    expect(again).toMatchObject({ id: first.id, status: "ACTIVE", activatedAt: NOW, expiresAt: newExpiry });
    // JS dates have millisecond precision: the strict increase is guaranteed in SQL (greatest(...)).
    expect(again.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
    expect(await rows(tenantA)).toHaveLength(1);
    expect(await has(tenantA, "purchase_orders")).toBe(true);
  });

  it("ends up with a single row after concurrent activations", async () => {
    await Promise.all([
      activate(tenantA, "payment_schedule", PAST, FUTURE),
      activate(tenantA, "payment_schedule", NOW, null),
      activate(tenantA, "payment_schedule", PAST),
    ]);
    const finalRows = await rows(tenantA);
    expect(finalRows).toHaveLength(1);
    // The surviving row is one of the submitted combinations, never a mix of them.
    const [row] = finalRows;
    expect(row.status).toBe("ACTIVE");
    const state = [row.activated_at.toISOString(), row.expires_at?.toISOString() ?? null];
    expect([
      [PAST.toISOString(), FUTURE.toISOString()],
      [NOW.toISOString(), null],
      [PAST.toISOString(), null],
    ]).toContainEqual(state);
  });

  it("does not let options override the module code", async () => {
    const options = { activatedAt: PAST, code: "approvals" } as unknown as { activatedAt: Date };
    const row = await scope(tenantA).modules.activate("cost_centers", options);
    const [costCenters] = await testSql()`select id from modules where code = 'cost_centers'`;
    expect(row.moduleId).toBe(costCenters.id);
    const list = await scope(tenantA).modules.list();
    expect(list.map((r) => r.code)).toEqual(["cost_centers"]);
  });

  it("cancels a module, keeping its dates, without touching tenant B", async () => {
    await activate(tenantA, "purchase_orders", PAST, FUTURE);
    await activate(tenantB, "purchase_orders", PAST, FUTURE);
    const [beforeB] = await rows(tenantB);

    const cancelled = await scope(tenantA).modules.cancel("purchase_orders");
    expect(cancelled).toMatchObject({ status: "CANCELLED", activatedAt: PAST, expiresAt: FUTURE });
    expect(await has(tenantA, "purchase_orders")).toBe(false);
    expect(await has(tenantB, "purchase_orders")).toBe(true);
    expect(await rows(tenantB)).toEqual([beforeB]);
  });

  it("reports 'not found' when cancelling a module the tenant never purchased, even if another did", async () => {
    await activate(tenantB, "purchase_orders", PAST);
    const before = await rows();
    expect(await scope(tenantA).modules.cancel("purchase_orders")).toBeNull();
    expect(await scope(tenantA).modules.cancel("cost_centers")).toBeNull();
    expect(await scope(tenantA).modules.cancel("nonexistent" as ModuleCode)).toBeNull();
    expect(await rows()).toEqual(before);
  });

  it.each<[string, Date, Date | null | undefined]>([
    ["equal to activatedAt", PAST, PAST],
    ["before activatedAt", PAST, ms(PAST, -1)],
  ])("rejects an expiry %s and changes nothing", async (_label, activatedAt, expiresAt) => {
    await activate(tenantA, "cost_centers", PAST, FUTURE);
    const before = await rows();
    const error = await activate(tenantA, "cost_centers", activatedAt, expiresAt).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).fields).toEqual(["expiresAt"]);
    expect(await rows()).toEqual(before);
  });

  it("rejects an unknown code and invalid dates, and changes nothing", async () => {
    await expect(activate(tenantA, "nonexistent" as ModuleCode, PAST)).rejects.toBeInstanceOf(ValidationError);
    await expect(activate(tenantA, "cost_centers", new Date("invalid"))).rejects.toBeInstanceOf(ValidationError);
    await expect(
      activate(tenantA, "cost_centers", "2026-01-01" as unknown as Date),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await rows()).toHaveLength(0);
  });

  it("allows activating a base module explicitly", async () => {
    const row = await activate(tenantA, "approvals", PAST);
    expect(row.status).toBe("ACTIVE");
  });

  it("throws TenantNotFoundError for a tenant that does not exist", async () => {
    await expect(activate(UNKNOWN_UUID, "cost_centers", PAST)).rejects.toBeInstanceOf(TenantNotFoundError);
  });

  it("lists only the rows of the tenant, with the module code", async () => {
    await activate(tenantA, "purchase_orders", PAST);
    await activate(tenantA, "cost_centers", PAST, FUTURE);
    await activate(tenantB, "payment_schedule", PAST);
    await scope(tenantA).modules.cancel("purchase_orders");

    const listA = await scope(tenantA).modules.list();
    expect(listA.map((r) => [r.code, r.status, r.tenantId])).toEqual([
      ["cost_centers", "ACTIVE", tenantA],
      ["purchase_orders", "CANCELLED", tenantA],
    ]);
    expect((await scope(tenantB).modules.list()).map((r) => r.code)).toEqual(["payment_schedule"]);
    expect(await scope(UNKNOWN_UUID).modules.list()).toEqual([]);
  });
});

describe("module catalogue (cross-tenant)", () => {
  it("lists the 4 modules with code, name, description and isBase", async () => {
    const catalog = await listModuleCatalog(testDb());
    expect(catalog.map((m) => m.code)).toEqual(["approvals", "cost_centers", "payment_schedule", "purchase_orders"]);
    for (const m of catalog) {
      expect(Object.keys(m).sort()).toEqual(["code", "description", "isBase", "name"]);
    }
    expect(catalog.filter((m) => m.isBase).map((m) => m.code)).toEqual(["approvals"]);
  });

  it("finds a module by code, or null", async () => {
    expect(await getModuleByCode("cost_centers", testDb())).toMatchObject({
      code: "cost_centers",
      name: "Centri di costo e budget",
      isBase: false,
    });
    expect(await getModuleByCode("nonexistent" as ModuleCode, testDb())).toBeNull();
  });
});

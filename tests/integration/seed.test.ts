import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { MODULE_CATALOG } from "@/db/catalog/modules";
import { verifyCredentials } from "@/db/auth";
import { requireTestDatabaseUrl, seedDatabase } from "@/db/migrate";
import { createTenant, setTenantStatus } from "@/db/platform/tenants";
import { modules, tenants, users } from "@/db/schema";
import { seedModules } from "@/db/seed";
import { DEMO_USER_EMAIL, DEMO_VAT_NUMBER } from "@/db/seed-demo";
import { forTenant } from "@/db/tenant-scope";
import { isValidVatNumber } from "@/lib/validation/italian-tax-ids";

import { testDb } from "../helpers/db";

async function catalogRows() {
  return testDb()
    .select({
      code: modules.code,
      name: modules.name,
      description: modules.description,
      isBase: modules.isBase,
    })
    .from(modules)
    .orderBy(modules.code);
}

describe("module catalogue seed", () => {
  // The catalogue is shared by every integration test: always leave it as in code.
  afterEach(async () => {
    await testDb().delete(modules).where(eq(modules.code, "legacy_module"));
    await seedModules(testDb());
  });

  it("is idempotent: two runs leave exactly the 4 catalogue modules", async () => {
    await seedModules(testDb());
    await seedModules(testDb());

    const rows = await catalogRows();
    expect(rows.map((r) => r.code).sort()).toEqual(
      ["approvals", "cost_centers", "payment_schedule", "purchase_orders"].sort(),
    );
    expect(rows.filter((r) => r.isBase).map((r) => r.code)).toEqual(["approvals"]);
  });

  it("resets name, description and is_base edited by hand to the values in code", async () => {
    await testDb()
      .update(modules)
      .set({ name: "Modificato a mano", description: "x", isBase: true })
      .where(eq(modules.code, "cost_centers"));
    await testDb().update(modules).set({ isBase: false }).where(eq(modules.code, "approvals"));

    await seedModules(testDb());

    const expected = MODULE_CATALOG.map(({ code, name, description, isBase }) => ({
      code,
      name,
      description,
      isBase,
    })).sort((a, b) => a.code.localeCompare(b.code));
    expect(await catalogRows()).toEqual(expected);
  });

  it("keeps the id of existing modules (upsert, not delete and insert)", async () => {
    const [before] = await testDb().select().from(modules).where(eq(modules.code, "approvals"));
    await seedModules(testDb());
    const [after] = await testDb().select().from(modules).where(eq(modules.code, "approvals"));
    expect(after.id).toBe(before.id);
  });

  it("does not delete modules that are no longer in the catalogue", async () => {
    await testDb()
      .insert(modules)
      .values({ code: "legacy_module", name: "Vecchio", description: "Rimosso dal catalogo" });

    await seedModules(testDb());

    const rows = await catalogRows();
    expect(rows.map((r) => r.code)).toContain("legacy_module");
  });
});

describe("demo tenant and user seed", () => {
  const PASSWORD = "demo-password-123";
  const OTHER_VAT = "12345678903";
  const seed = (demoPassword?: string) =>
    seedDatabase(requireTestDatabaseUrl(), { testOnly: true, demoPassword });
  const demoTenants = () => testDb().select().from(tenants).where(eq(tenants.vatNumber, DEMO_VAT_NUMBER));
  const demoUsers = () => testDb().select().from(users).where(eq(users.email, DEMO_USER_EMAIL));

  it("creates the active demo tenant and the owner who can log in", async () => {
    await expect(seed(PASSWORD)).resolves.toEqual({ demoSeeded: true });

    const [tenant] = await demoTenants();
    expect(tenant).toMatchObject({ businessName: "Vistato Demo S.r.l.", status: "ACTIVE" });
    expect(isValidVatNumber(tenant.vatNumber!)).toBe(true);
    const [user] = await demoUsers();
    expect(user).toMatchObject({ role: "OWNER", status: "ACTIVE", tenantId: tenant.id });
    expect(await verifyCredentials(DEMO_USER_EMAIL, PASSWORD, testDb())).not.toBeNull();
  });

  it("is idempotent: one tenant, one user, same catalogue, password of the last run", async () => {
    await seed(PASSWORD);
    const before = await catalogRows();
    await seed("another-password-456");

    expect(await demoTenants()).toHaveLength(1);
    expect(await demoUsers()).toHaveLength(1);
    expect(await catalogRows()).toEqual(before);
    expect(await verifyCredentials(DEMO_USER_EMAIL, PASSWORD, testDb())).toBeNull();
    expect(await verifyCredentials(DEMO_USER_EMAIL, "another-password-456", testDb())).not.toBeNull();
  });

  it("makes a suspended tenant and a disabled non-owner user active again", async () => {
    await seed(PASSWORD);
    const [tenant] = await demoTenants();
    await setTenantStatus(tenant.id, "SUSPENDED", testDb());
    await testDb().update(users).set({ status: "DISABLED", role: "USER" }).where(eq(users.email, DEMO_USER_EMAIL));

    await seed(PASSWORD);

    expect((await demoTenants())[0].status).toBe("ACTIVE");
    expect((await demoUsers())[0]).toMatchObject({ status: "ACTIVE", role: "OWNER" });
    expect(await verifyCredentials(DEMO_USER_EMAIL, PASSWORD, testDb())).not.toBeNull();
  });

  it("writes only the catalogue when the password is missing, empty or only whitespace", async () => {
    for (const password of [undefined, "", "   \t "]) {
      await testDb().delete(modules);

      await expect(seed(password)).resolves.toEqual({ demoSeeded: false });

      expect(await catalogRows()).toHaveLength(MODULE_CATALOG.length);
      expect(await demoTenants()).toHaveLength(0);
      expect(await demoUsers()).toHaveLength(0);
    }
  });

  it("fails with a clear message and writes no demo data when the password is shorter than 12", async () => {
    await expect(seed("short-pw-11")).rejects.toThrow(/DEMO_USER_PASSWORD must be at least 12/);

    expect(await demoTenants()).toHaveLength(0);
    expect(await demoUsers()).toHaveLength(0);
  });

  it("leaves another tenant and its users untouched", async () => {
    const other = await createTenant({ businessName: "Altra Srl", vatNumber: OTHER_VAT }, testDb());
    const otherScope = forTenant(other.id, testDb());
    const user = await otherScope.users.create({
      email: "owner@altra.example.com",
      firstName: "A",
      lastName: "B",
      role: "ADMIN",
      status: "ACTIVE",
    });
    await otherScope.users.setPassword(user.id, "other-password-123");
    const snapshot = async () => ({
      tenants: await testDb().select().from(tenants).where(eq(tenants.id, other.id)),
      users: await testDb().select().from(users).where(eq(users.tenantId, other.id)),
    });
    const before = await snapshot();

    await seed(PASSWORD);
    await seed(PASSWORD);

    expect(await snapshot()).toEqual(before);
  });

  it("fails clearly and rolls back when the demo email already logs in from another tenant", async () => {
    const other = await createTenant({ businessName: "Altra Srl", vatNumber: OTHER_VAT }, testDb());
    const otherScope = forTenant(other.id, testDb());
    const user = await otherScope.users.create({
      email: DEMO_USER_EMAIL,
      firstName: "A",
      lastName: "B",
      role: "USER",
      status: "ACTIVE",
    });
    await otherScope.users.setPassword(user.id, "other-password-123");

    await expect(seed(PASSWORD)).rejects.toThrow(/already logs in with a password in another tenant/);

    expect(await demoTenants()).toHaveLength(0);
    expect(await demoUsers()).toHaveLength(1);
  });
});

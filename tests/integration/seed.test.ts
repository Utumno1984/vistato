import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { MODULE_CATALOG } from "@/db/catalog/modules";
import { modules } from "@/db/schema";
import { seedModules } from "@/db/seed";

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

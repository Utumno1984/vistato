import { describe, expect, expectTypeOf, it } from "vitest";

import { MODULE_CATALOG, MODULE_CODES, type ModuleCode } from "@/db/catalog/modules";

describe("module catalogue", () => {
  it("contains the 4 modules, with approvals as the only base module", () => {
    expect(MODULE_CODES).toEqual(["approvals", "cost_centers", "purchase_orders", "payment_schedule"]);
    expect(MODULE_CATALOG.filter((m) => m.isBase).map((m) => m.code)).toEqual(["approvals"]);
  });

  it("has Italian names and non-empty descriptions", () => {
    const names = Object.fromEntries(MODULE_CATALOG.map((m) => [m.code, m.name]));
    expect(names).toEqual({
      approvals: "Approvazione fatture",
      cost_centers: "Centri di costo e budget",
      purchase_orders: "Ordini d'acquisto e abbinamento ordine-fattura",
      payment_schedule: "Scadenzario pagamenti",
    });
    for (const m of MODULE_CATALOG) expect(m.description.trim()).not.toBe("");
  });

  it("exports ModuleCode as the union of the codes", () => {
    expectTypeOf<ModuleCode>().toEqualTypeOf<
      "approvals" | "cost_centers" | "purchase_orders" | "payment_schedule"
    >();
  });
});

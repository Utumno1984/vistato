import { describe, expect, expectTypeOf, it } from "vitest";

import { MODULE_CATALOG, MODULE_CODES, type ModuleCode } from "@/db/catalog/modules";

describe("module catalogue", () => {
  // Name kept for the test guard: since ticket #56 the catalogue has 5 modules (fic_iban_alert added).
  it("contains the 4 modules, with approvals as the only base module", () => {
    expect(MODULE_CODES).toEqual(["approvals", "cost_centers", "purchase_orders", "payment_schedule", "fic_iban_alert"]);
    expect(MODULE_CATALOG.filter((m) => m.isBase).map((m) => m.code)).toEqual(["approvals"]);
  });

  it("contains the 5 modules: the 4 original ones unchanged, then fic_iban_alert", () => {
    expect(MODULE_CATALOG).toHaveLength(5);
    expect(MODULE_CATALOG.slice(0, 4)).toEqual([
      {
        code: "approvals",
        name: "Approvazione fatture",
        description: "Iter di approvazione configurabile delle fatture dei fornitori.",
        isBase: true,
      },
      {
        code: "cost_centers",
        name: "Centri di costo e budget",
        description: "Assegnazione delle fatture ai centri di costo e controllo del budget.",
        isBase: false,
      },
      {
        code: "purchase_orders",
        name: "Ordini d'acquisto e abbinamento ordine-fattura",
        description: "Gestione degli ordini d'acquisto e abbinamento con le fatture ricevute.",
        isBase: false,
      },
      {
        code: "payment_schedule",
        name: "Scadenzario pagamenti",
        description: "Scadenzario dei pagamenti delle fatture approvate.",
        isBase: false,
      },
    ]);
  });

  it("has fic_iban_alert as a paid module with its Italian name and description", () => {
    const entry = MODULE_CATALOG.find((m) => m.code === "fic_iban_alert");
    expect(entry).toMatchObject({ name: "Alert cambio IBAN fornitori (Fatture in Cloud)", isBase: false });
    expect(entry?.description).toMatch(/IBAN.*fornitore/);
  });

  it("has Italian names and non-empty descriptions", () => {
    const names = Object.fromEntries(MODULE_CATALOG.map((m) => [m.code, m.name]));
    expect(names).toEqual({
      approvals: "Approvazione fatture",
      cost_centers: "Centri di costo e budget",
      purchase_orders: "Ordini d'acquisto e abbinamento ordine-fattura",
      payment_schedule: "Scadenzario pagamenti",
      fic_iban_alert: "Alert cambio IBAN fornitori (Fatture in Cloud)",
    });
    for (const m of MODULE_CATALOG) expect(m.description.trim()).not.toBe("");
  });

  it("exports ModuleCode as the union of the codes", () => {
    expectTypeOf<ModuleCode>().toEqualTypeOf<
      "approvals" | "cost_centers" | "purchase_orders" | "payment_schedule" | "fic_iban_alert"
    >();
  });
});

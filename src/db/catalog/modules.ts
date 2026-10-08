/**
 * Module catalogue, defined in code and written to the `modules` table by the seed
 * (`npm run db:seed`). The seed upserts on `code`: edit names and descriptions here,
 * never by hand in the database. Modules removed from this list are NOT deleted.
 */
export const MODULE_CATALOG = [
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
] as const;

export type ModuleCode = (typeof MODULE_CATALOG)[number]["code"];

export const MODULE_CODES: readonly ModuleCode[] = MODULE_CATALOG.map((m) => m.code);

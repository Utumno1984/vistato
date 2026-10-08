import { boolean, pgTable, text } from "drizzle-orm/pg-core";

import { baseColumns } from "./columns";

/**
 * Catalogo moduli: global, no tenant_id. Its content is defined in code
 * (`src/db/catalog/modules.ts`) and written by the seed.
 */
export const modules = pgTable("modules", {
  ...baseColumns(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  // Modulo base: included for every tenant
  isBase: boolean("is_base").notNull().default(false),
});

export type Module = typeof modules.$inferSelect;
export type NewModule = typeof modules.$inferInsert;

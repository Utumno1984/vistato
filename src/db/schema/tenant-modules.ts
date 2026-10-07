import { sql } from "drizzle-orm";
import { check, index, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { baseColumns } from "./columns";
import { tenantModuleStatus } from "./enums";
import { modules } from "./modules";
import { tenants } from "./tenants";

/** Moduli acquistati da un tenant (entitlement): at most one row per tenant/module pair. */
export const tenantModules = pgTable(
  "tenant_modules",
  {
    ...baseColumns(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    moduleId: uuid("module_id")
      .notNull()
      .references(() => modules.id, { onDelete: "restrict" }),
    status: tenantModuleStatus("status").notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    // Also serves lookups by tenant (leading column).
    unique("tenant_modules_tenant_id_module_id_unique").on(table.tenantId, table.moduleId),
    // Lookups by module and the RESTRICT check when a module is deleted.
    index("tenant_modules_module_id_idx").on(table.moduleId),
    check(
      "tenant_modules_expires_after_activation",
      sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.activatedAt}`,
    ),
  ],
);

export type TenantModule = typeof tenantModules.$inferSelect;
export type NewTenantModule = typeof tenantModules.$inferInsert;

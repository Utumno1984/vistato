import { sql } from "drizzle-orm";
import { pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { baseColumns } from "./columns";
import { userRole, userStatus } from "./enums";
import { tenants } from "./tenants";

/** Utente di un tenant. The email is unique per tenant, case-insensitively. */
export const users = pgTable(
  "users",
  {
    ...baseColumns(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    email: text("email").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    role: userRole("role").notNull(),
    status: userStatus("status").notNull().default("INVITED"),
  },
  (table) => [
    uniqueIndex("users_tenant_id_lower_email_unique").on(table.tenantId, sql`lower(${table.email})`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

import { sql } from "drizzle-orm";
import { pgTable, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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
    // argon2id hash (PHC string); NULL = the user cannot log in. Never returned by forTenant.
    passwordHash: text("password_hash"),
  },
  (table) => [
    // Target of the composite foreign keys of sessions (and, later, invoices).
    unique("users_id_tenant_id_unique").on(table.id, table.tenantId),
    // Login identity is global: an email with a password belongs to one user in the whole system.
    uniqueIndex("users_lower_email_with_password_unique")
      .on(sql`lower(${table.email})`)
      .where(sql`${table.passwordHash} IS NOT NULL`),
    uniqueIndex("users_tenant_id_lower_email_unique").on(table.tenantId, sql`lower(${table.email})`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

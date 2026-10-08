import { foreignKey, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { baseColumns } from "./columns";
import { tenants } from "./tenants";
import { users } from "./users";

/**
 * Login session. Only the SHA-256 of the token is stored. The composite foreign key
 * guarantees that the session's tenant is the user's own tenant.
 */
export const sessions = pgTable(
  "sessions",
  {
    ...baseColumns(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    userId: uuid("user_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      name: "sessions_user_id_tenant_id_users_fk",
      columns: [table.userId, table.tenantId],
      foreignColumns: [users.id, users.tenantId],
    }).onDelete("cascade"),
    index("sessions_user_id_index").on(table.userId),
  ],
);

export type Session = typeof sessions.$inferSelect;

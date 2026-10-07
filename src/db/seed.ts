import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { MODULE_CATALOG } from "./catalog/modules";
import { modules } from "./schema";

/**
 * Idempotent seed of the module catalogue: inserts missing modules and resets
 * `name`, `description` and `is_base` of existing ones to the values in code
 * (upsert on `code`). Modules no longer in the catalogue are left untouched.
 */
export async function seedModules<TSchema extends Record<string, unknown>>(
  db: PostgresJsDatabase<TSchema>,
): Promise<void> {
  await db
    .insert(modules)
    .values(MODULE_CATALOG.map((m) => ({ ...m })))
    .onConflictDoUpdate({
      target: modules.code,
      set: {
        name: sql`excluded.name`,
        description: sql`excluded.description`,
        isBase: sql`excluded.is_base`,
        updatedAt: sql`now()`,
      },
    });
}

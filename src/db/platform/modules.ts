/**
 * PLATFORM OPERATIONS — NOT FILTERED BY TENANT.
 *
 * Reads of the global module catalogue (`modules` has no `tenant_id`). This module
 * touches only the `modules` table; no table with a `tenant_id` column may be
 * accessed from here.
 */
import { asc, eq } from "drizzle-orm";

import { MODULE_CODES, type ModuleCode } from "@/db/catalog/modules";
import { getDb, type Database } from "@/db/client";
import { modules } from "@/db/schema";

// Application code cannot import `@/db/schema`: the type comes from here.
export type { ModuleCode };

/** A module of the catalogue. */
export interface ModuleDefinition {
  code: ModuleCode;
  name: string;
  description: string;
  isBase: boolean;
}

const columns = {
  code: modules.code,
  name: modules.name,
  description: modules.description,
  isBase: modules.isBase,
};

/** The catalogue modules, in a stable order (by code). */
export async function listModuleCatalog(db: Database = getDb()): Promise<ModuleDefinition[]> {
  const rows = await db.select(columns).from(modules).orderBy(asc(modules.code));
  return rows as ModuleDefinition[];
}

/** The module with this code, or null (also for a code outside the catalogue). */
export async function getModuleByCode(code: ModuleCode, db: Database = getDb()): Promise<ModuleDefinition | null> {
  if (!(MODULE_CODES as readonly string[]).includes(code)) return null;
  const [row] = await db.select(columns).from(modules).where(eq(modules.code, code)).limit(1);
  return (row as ModuleDefinition | undefined) ?? null;
}

/**
 * Module entitlement: the single source of truth for "is this module active for
 * this tenant right now". Server-side checks and future HATEOAS links must both use it.
 */
import { and, eq, gt, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";

import { MODULE_CODES, type ModuleCode } from "@/db/catalog/modules";
import { getDb, type Database } from "@/db/client";
import { modules, tenantModules, tenants } from "@/db/schema";

const tenantIdSchema = z.uuid();

/**
 * True only when the tenant is ACTIVE and the module is either a base module or has
 * an ACTIVE `tenant_modules` row of this tenant with `activated_at <= at` and
 * (`expires_at` null or `expires_at > at`): activation is inclusive, expiry exclusive.
 *
 * Fail-closed: a missing or non-UUID tenant, an unknown module code or an invalid
 * `at` give `false`, never an error. A SUSPENDED or CLOSED tenant has no module,
 * not even the base one.
 *
 * @param at the reference instant, passed in so that boundary tests are deterministic.
 */
export async function hasModule(
  tenantId: string,
  code: ModuleCode,
  at: Date = new Date(),
  db?: Database,
): Promise<boolean> {
  if (!tenantIdSchema.safeParse(tenantId).success) return false;
  if (!(MODULE_CODES as readonly string[]).includes(code)) return false;
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return false;

  const rows = await (db ?? getDb())
    .select({ code: modules.code })
    .from(tenants)
    .innerJoin(modules, eq(modules.code, code))
    .leftJoin(
      tenantModules,
      // The tenant filter is part of the join: another tenant's row can never match.
      and(eq(tenantModules.moduleId, modules.id), eq(tenantModules.tenantId, tenantId)),
    )
    .where(
      and(
        eq(tenants.id, tenantId),
        eq(tenants.status, "ACTIVE"),
        or(
          eq(modules.isBase, true),
          and(
            eq(tenantModules.status, "ACTIVE"),
            lte(tenantModules.activatedAt, at),
            or(isNull(tenantModules.expiresAt), gt(tenantModules.expiresAt, at)),
          ),
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

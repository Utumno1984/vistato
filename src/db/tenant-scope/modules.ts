import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { MODULE_CODES, type ModuleCode } from "@/db/catalog/modules";
import type { Database } from "@/db/client";
import { isForeignKeyViolation, TenantNotFoundError, ValidationError } from "@/db/errors";
import { modules, tenantModules, type TenantModule } from "@/db/schema";

import type { TenantId } from "./tenant-id";

const TENANT_FOREIGN_KEY = "tenant_modules_tenant_id_tenants_id_fk";

const validDate = (message: string) => z.date({ error: message }).refine((d) => !Number.isNaN(d.getTime()), message);

/**
 * Input of `modules.activate`. Unknown keys are stripped. Dates are instants
 * (`Date`), stored in UTC; `expiresAt` must be strictly after `activatedAt`.
 */
export const activateModuleInputSchema = z
  .object({
    code: z.enum(MODULE_CODES as [ModuleCode, ...ModuleCode[]], { error: "Modulo sconosciuto" }),
    activatedAt: validDate("Data di attivazione non valida"),
    expiresAt: validDate("Data di scadenza non valida").nullish(),
  })
  .refine((input) => input.expiresAt == null || input.expiresAt > input.activatedAt, {
    path: ["expiresAt"],
    message: "La scadenza deve essere successiva all'attivazione",
  });

export interface ActivateModuleOptions {
  activatedAt: Date;
  /** Exclusive end of the entitlement; omitted or null = no expiry. */
  expiresAt?: Date | null;
}

/** A `tenant_modules` row of the tenant, with the code of its module. */
export type TenantModuleEntry = TenantModule & { code: ModuleCode };

// Application code cannot import `@/db/schema`: the type comes from here.
export type { TenantModule };

/** Operations on the purchased modules of one tenant. Every statement filters on (or sets) `tenant_id`. */
export interface TenantModules {
  /** The tenant's `tenant_modules` rows (any status), by module code. */
  list(): Promise<TenantModuleEntry[]>;
  /**
   * Activates a module for the tenant: upsert on (tenant, module), so a CANCELLED
   * row becomes ACTIVE again with the new dates (no history is kept).
   * @throws ValidationError for an unknown code, invalid dates or `expiresAt <= activatedAt` (nothing changes).
   * @throws TenantNotFoundError when the tenant does not exist.
   */
  activate(code: ModuleCode, options: ActivateModuleOptions): Promise<TenantModule>;
  /**
   * Sets the tenant's row of this module to CANCELLED, leaving the dates unchanged.
   * @returns the updated row, or null when the tenant never purchased the module
   *   (also if another tenant did, or the code is unknown).
   */
  cancel(code: ModuleCode): Promise<TenantModule | null>;
}

const touch = sql`greatest(now(), ${tenantModules.updatedAt} + interval '1 microsecond')`;

export function tenantModuleOperations(db: Database, tenantId: TenantId): TenantModules {
  const moduleIdOf = (code: string) => db.select({ id: modules.id }).from(modules).where(eq(modules.code, code));

  return {
    async list() {
      const rows = await db
        .select({ row: tenantModules, code: modules.code })
        .from(tenantModules)
        .innerJoin(modules, eq(modules.id, tenantModules.moduleId))
        .where(eq(tenantModules.tenantId, tenantId))
        .orderBy(asc(modules.code));
      return rows.map(({ row, code }) => ({ ...row, code: code as ModuleCode }));
    },

    async activate(code, options) {
      const parsed = activateModuleInputSchema.safeParse({ ...options, code });
      if (!parsed.success) throw ValidationError.fromZod(parsed.error);
      const { activatedAt, expiresAt } = parsed.data;

      const [module] = await moduleIdOf(parsed.data.code).limit(1);
      if (!module) throw new ValidationError([{ field: "code", message: "Modulo sconosciuto" }]);

      try {
        const [row] = await db
          .insert(tenantModules)
          .values({ tenantId, moduleId: module.id, status: "ACTIVE", activatedAt, expiresAt: expiresAt ?? null })
          .onConflictDoUpdate({
            target: [tenantModules.tenantId, tenantModules.moduleId],
            set: { status: "ACTIVE", activatedAt, expiresAt: expiresAt ?? null, updatedAt: touch },
          })
          .returning();
        return row;
      } catch (error) {
        if (isForeignKeyViolation(error, TENANT_FOREIGN_KEY)) throw new TenantNotFoundError(tenantId);
        throw error;
      }
    },

    async cancel(code) {
      if (!(MODULE_CODES as readonly string[]).includes(code)) return null;
      const [module] = await moduleIdOf(code).limit(1);
      if (!module) return null;
      const [row] = await db
        .update(tenantModules)
        .set({ status: "CANCELLED", updatedAt: touch })
        .where(and(eq(tenantModules.tenantId, tenantId), eq(tenantModules.moduleId, module.id)))
        .returning();
      return row ?? null;
    },
  };
}

/**
 * PLATFORM OPERATIONS — NOT FILTERED BY TENANT.
 *
 * Creating a tenant and changing its status are cross-tenant by nature, so they live
 * here, away from tenant-scoped data access. Reserved for platform use (seed, tests,
 * future back office): never call these with IDs coming from a customer request.
 * This module touches only the `tenants` table; no table with a `tenant_id` column
 * may be accessed from here.
 */
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb, type Database } from "@/db/client";
import { DuplicateVatNumberError, isUniqueViolation, TenantNotFoundError, ValidationError } from "@/db/errors";
import { tenants, tenantStatus, type Tenant } from "@/db/schema";
import { taxCodeSchema, unicodeTrim, vatNumberSchema } from "@/lib/validation/italian-tax-ids";

const VAT_NUMBER_UNIQUE_CONSTRAINT = "tenants_vat_number_unique";

/**
 * Input of `createTenant`. Unknown keys (e.g. `id`, `status`, `createdAt`) are
 * stripped: a new tenant is always ACTIVE, with ID and timestamps from the database.
 * `vatNumber` and `taxCode` are optional (null/undefined = absent) but at least one
 * is required; an empty string is invalid, not absent.
 */
export const createTenantInputSchema = z
  .object({
    businessName: z.string().overwrite(unicodeTrim).min(1, "La ragione sociale è obbligatoria"),
    vatNumber: vatNumberSchema.nullish(),
    taxCode: taxCodeSchema.nullish(),
  })
  .superRefine((input, ctx) => {
    if (input.vatNumber == null && input.taxCode == null) {
      const message = "Indicare la partita IVA o il codice fiscale";
      ctx.addIssue({ code: "custom", path: ["vatNumber"], message });
      ctx.addIssue({ code: "custom", path: ["taxCode"], message });
    }
  });

export type CreateTenantInput = z.input<typeof createTenantInputSchema>;

const tenantStatusSchema = z.enum(tenantStatus.enumValues);
export type TenantStatus = z.infer<typeof tenantStatusSchema>;

const setTenantStatusArgsSchema = z.object({
  tenantId: z.uuid("ID del tenant non valido"),
  status: tenantStatusSchema,
});

/**
 * Creates an ACTIVE tenant.
 * @throws ValidationError when the input is invalid (nothing is inserted).
 * @throws DuplicateVatNumberError when another tenant has the same VAT number
 *   (detected from the database unique constraint, so it is race-free).
 */
export async function createTenant(input: CreateTenantInput, db: Database = getDb()): Promise<Tenant> {
  const parsed = createTenantInputSchema.safeParse(input);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  const { businessName, vatNumber, taxCode } = parsed.data;

  try {
    const [tenant] = await db
      .insert(tenants)
      .values({ businessName, vatNumber: vatNumber ?? null, taxCode: taxCode ?? null })
      .returning();
    return tenant;
  } catch (error) {
    if (vatNumber && isUniqueViolation(error, VAT_NUMBER_UNIQUE_CONSTRAINT)) {
      throw new DuplicateVatNumberError(vatNumber);
    }
    throw error;
  }
}

/**
 * Sets the status of a tenant (any status to any status: no transition rules).
 * `updated_at` always moves forward, even for two updates within the same instant.
 * @throws ValidationError when the ID is not a UUID or the status is unknown.
 * @throws TenantNotFoundError when no tenant has this ID.
 */
export async function setTenantStatus(
  tenantId: string,
  status: TenantStatus,
  db: Database = getDb(),
): Promise<Tenant> {
  const parsed = setTenantStatusArgsSchema.safeParse({ tenantId, status });
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);

  const [tenant] = await db
    .update(tenants)
    .set({
      status: parsed.data.status,
      updatedAt: sql`greatest(now(), ${tenants.updatedAt} + interval '1 microsecond')`,
    })
    .where(eq(tenants.id, parsed.data.tenantId))
    .returning();
  if (!tenant) throw new TenantNotFoundError(parsed.data.tenantId);
  return tenant;
}

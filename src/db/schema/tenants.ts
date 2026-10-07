import { sql } from "drizzle-orm";
import { check, pgTable, text } from "drizzle-orm/pg-core";

import { baseColumns } from "./columns";
import { tenantStatus } from "./enums";

/**
 * Azienda cliente (tenant). Every customer-owned row references a tenant.
 *
 * The database checks only the *format* of the tax identifiers; normalisation
 * (trimming, upper-casing the codice fiscale) and the VAT check digit are handled by
 * the application layer (`src/lib/validation/italian-tax-ids.ts`). An "IT" prefix
 * is rejected, not removed.
 */
export const tenants = pgTable(
  "tenants",
  {
    ...baseColumns(),
    // Ragione sociale
    businessName: text("business_name").notNull(),
    // Partita IVA: exactly 11 digits, unique across tenants (several NULLs allowed)
    vatNumber: text("vat_number").unique(),
    // Codice fiscale: 11 digits (companies) or 16 upper-case alphanumerics (people, omocodia)
    taxCode: text("tax_code"),
    status: tenantStatus("status").notNull().default("ACTIVE"),
  },
  (table) => [
    check("tenants_business_name_not_blank", sql`length(btrim(${table.businessName})) > 0`),
    check("tenants_vat_number_format", sql`${table.vatNumber} ~ '^[0-9]{11}$'`),
    check("tenants_tax_code_format", sql`${table.taxCode} ~ '^([0-9]{11}|[A-Z0-9]{16})$'`),
    check(
      "tenants_vat_number_or_tax_code",
      sql`${table.vatNumber} IS NOT NULL OR ${table.taxCode} IS NOT NULL`,
    ),
  ],
);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;

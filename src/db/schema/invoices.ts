import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { baseColumns } from "./columns";
import { invoiceStatus } from "./enums";
import { tenants } from "./tenants";
import { users } from "./users";

/**
 * Supplier invoice of a tenant. Amounts are signed integer cents (credit notes are
 * negative, zero is allowed). `invoice_date` is a calendar date (no time zone);
 * `created_at` and `decided_at` are UTC instants. The composite foreign keys
 * guarantee that uploader and decider belong to the invoice's own tenant.
 */
export const invoices = pgTable(
  "invoices",
  {
    ...baseColumns(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    documentType: text("document_type").notNull(),
    supplierName: text("supplier_name").notNull(),
    supplierVatCountry: text("supplier_vat_country").notNull(),
    supplierVatCode: text("supplier_vat_code").notNull(),
    invoiceNumber: text("invoice_number").notNull(),
    invoiceDate: date("invoice_date", { mode: "string" }).notNull(),
    totalAmountCents: bigint("total_amount_cents", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    status: invoiceStatus("status").notNull().default("PENDING"),
    uploadedByUserId: uuid("uploaded_by_user_id").notNull(),
    decidedByUserId: uuid("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
  },
  (table) => [
    foreignKey({
      name: "invoices_uploaded_by_user_id_tenant_id_users_fk",
      columns: [table.uploadedByUserId, table.tenantId],
      foreignColumns: [users.id, users.tenantId],
    }).onDelete("restrict"),
    foreignKey({
      name: "invoices_decided_by_user_id_tenant_id_users_fk",
      columns: [table.decidedByUserId, table.tenantId],
      foreignColumns: [users.id, users.tenantId],
    }).onDelete("restrict"),
    unique("invoices_tenant_supplier_number_date_unique").on(
      table.tenantId,
      table.supplierVatCountry,
      table.supplierVatCode,
      table.invoiceNumber,
      table.invoiceDate,
    ),
    index("invoices_tenant_status_created_index").on(
      table.tenantId,
      table.status,
      sql`${table.createdAt} DESC`,
      sql`${table.id} DESC`,
    ),
    check("invoices_document_type_format", sql`${table.documentType} ~ '^TD[0-9]{2}$'`),
    check("invoices_supplier_name_not_blank", sql`length(btrim(${table.supplierName})) > 0`),
    check("invoices_supplier_vat_country_format", sql`${table.supplierVatCountry} ~ '^[A-Z]{2}$'`),
    check("invoices_supplier_vat_code_format", sql`${table.supplierVatCode} ~ '^[A-Za-z0-9]{1,28}$'`),
    check("invoices_invoice_number_not_blank", sql`length(btrim(${table.invoiceNumber})) > 0`),
    check("invoices_currency_format", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check(
      "invoices_pending_not_decided",
      sql`${table.status} <> 'PENDING' OR (${table.decidedAt} IS NULL AND ${table.decidedByUserId} IS NULL)`,
    ),
    check(
      "invoices_decided_has_decision",
      sql`${table.status} = 'PENDING' OR (${table.decidedAt} IS NOT NULL AND ${table.decidedByUserId} IS NOT NULL)`,
    ),
    check(
      "invoices_rejection_reason_only_if_rejected",
      sql`${table.rejectionReason} IS NULL OR ${table.status} = 'REJECTED'`,
    ),
  ],
);

export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;

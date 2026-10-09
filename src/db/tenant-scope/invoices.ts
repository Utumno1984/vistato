import { and, count, desc, eq, getTableColumns } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "@/db/client";
import {
  DuplicateInvoiceError,
  isForeignKeyViolation,
  isUniqueViolation,
  TenantNotFoundError,
  UserNotInTenantError,
  ValidationError,
} from "@/db/errors";
import { invoices, invoiceStatus, type Invoice as InvoiceRow } from "@/db/schema";
import { requiredTextSchema, tooLongMessage, unicodeTrim } from "@/lib/validation/text";

import type { TenantId } from "./tenant-id";

const DUPLICATE_UNIQUE_CONSTRAINT = "invoices_tenant_supplier_number_date_unique";
const UPLOADER_FOREIGN_KEY = "invoices_uploaded_by_user_id_tenant_id_users_fk";
const TENANT_FOREIGN_KEY = "invoices_tenant_id_tenants_id_fk";

/** Technical anti-abuse cap on raw free-text fields (before trimming), not a domain rule. */
export const INVOICE_TEXT_MAX_RAW_LENGTH = 1000;

/** Trimmed fixed-format code (country, VAT code, currency, document type). */
function codeSchema(pattern: RegExp, message: string, requiredMessage: string) {
  return z
    .string({ message: requiredMessage })
    .max(INVOICE_TEXT_MAX_RAW_LENGTH, { message: tooLongMessage(INVOICE_TEXT_MAX_RAW_LENGTH), abort: true })
    .overwrite((value) => unicodeTrim(value))
    .min(1, { message: requiredMessage, abort: true })
    .regex(pattern, message);
}

/** A real calendar date `YYYY-MM-DD` (29 February only in leap years). */
const calendarDateSchema = z
  .string({ message: "La data della fattura è obbligatoria" })
  .overwrite((value) => value.trim())
  .refine(
    (value) => {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      if (!match) return false;
      const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
      const date = new Date(Date.UTC(year, month - 1, day));
      // Years 0000-0099 are remapped by Date.UTC: reject them rather than guess.
      return (
        year >= 100 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
      );
    },
    { message: "La data della fattura non è valida (formato AAAA-MM-GG)" },
  );

/**
 * Input of `invoices.create`. Only these fields are read: any other key (`tenantId`,
 * `id`, `status`, decision fields, ...) is stripped. The tenant comes from `forTenant`,
 * the uploader from the second argument, the status is always PENDING.
 * The amount is in signed integer cents (credit notes are negative, zero is allowed).
 * The invoice number is only trimmed: the duplicate check compares it exactly.
 */
export const createInvoiceInputSchema = z.object({
  documentType: codeSchema(
    /^TD[0-9]{2}$/,
    "Il tipo documento deve essere nel formato TDnn",
    "Il tipo documento è obbligatorio",
  ),
  supplierName: requiredTextSchema({
    requiredMessage: "Il nome del fornitore è obbligatorio",
    maxLength: INVOICE_TEXT_MAX_RAW_LENGTH,
  }),
  supplierVatCountry: codeSchema(
    /^[A-Z]{2}$/,
    "Il paese deve essere di 2 lettere maiuscole",
    "Il paese del fornitore è obbligatorio",
  ),
  supplierVatCode: codeSchema(
    /^[A-Za-z0-9]{1,28}$/,
    "Il codice IVA del fornitore deve avere da 1 a 28 caratteri alfanumerici",
    "Il codice IVA del fornitore è obbligatorio",
  ),
  invoiceNumber: requiredTextSchema({
    requiredMessage: "Il numero della fattura è obbligatorio",
    maxLength: INVOICE_TEXT_MAX_RAW_LENGTH,
  }),
  invoiceDate: calendarDateSchema,
  totalAmountCents: z
    .number({ message: "L'importo deve essere un numero intero di centesimi" })
    .refine((value) => Number.isSafeInteger(value), {
      message: "L'importo deve essere un numero intero di centesimi",
    }),
  currency: codeSchema(/^[A-Z]{3}$/, "La valuta deve essere di 3 lettere maiuscole", "La valuta è obbligatoria"),
});

export type Invoice = InvoiceRow;
export type InvoiceStatus = (typeof invoiceStatus.enumValues)[number];
export type CreateInvoiceInput = z.input<typeof createInvoiceInputSchema>;

const idSchema = z.uuid();

/** Input of `invoices.list`: an optional status filter and a 1-based page. */
export const listInvoicesInputSchema = z.object({
  status: z.enum(invoiceStatus.enumValues).optional(),
  page: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  pageSize: z.number().int().min(1).max(100),
});

export type ListInvoicesInput = z.input<typeof listInvoicesInputSchema>;

export interface InvoicePage {
  items: Invoice[];
  /** All the invoices of the tenant matching the filter, not only this page. */
  totalItems: number;
}

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  return parsed.data;
}

/** Operations on the invoices of one tenant. Every statement filters on (or sets) `tenant_id`. */
export interface TenantInvoices {
  /**
   * Creates a PENDING invoice in the tenant, uploaded by `uploadedByUserId`.
   * @throws ValidationError when the input is invalid (nothing is inserted).
   * @throws DuplicateInvoiceError when the tenant already has this supplier + number + date.
   * @throws UserNotInTenantError when the uploader does not exist in the tenant.
   * @throws TenantNotFoundError when the tenant does not exist.
   */
  create(input: CreateInvoiceInput, uploadedByUserId: string): Promise<Invoice>;
  /** The invoice with this ID in the tenant, or null (also for another tenant's ID or a non-UUID). */
  findById(id: string): Promise<Invoice | null>;
  /** The invoice of the tenant with this supplier + number + date (the duplicate key), or null. */
  findByBusinessKey(
    key: Pick<CreateInvoiceInput, "supplierVatCountry" | "supplierVatCode" | "invoiceNumber" | "invoiceDate">,
  ): Promise<Invoice | null>;
  /**
   * One page of the tenant's invoices (newest upload first, ties broken by `id`) and the total
   * count for the same filter. Offset pagination: an invoice uploaded between two reads can shift items.
   * @throws ValidationError when `page` or `pageSize` is out of range or `status` is unknown.
   */
  list(input: ListInvoicesInput): Promise<InvoicePage>;
}

export function tenantInvoices(db: Database, tenantId: TenantId): TenantInvoices {
  return {
    async create(input, uploadedByUserId) {
      const fields = parse(createInvoiceInputSchema, input);
      // A non-UUID uploader cannot exist in the tenant: same outcome as an unknown user.
      if (!idSchema.safeParse(uploadedByUserId).success) throw new UserNotInTenantError(String(uploadedByUserId));
      try {
        const [invoice] = await db
          .insert(invoices)
          // Listed one by one: tenant, status, ID and decision fields are never taken from the input.
          .values({
            documentType: fields.documentType,
            supplierName: fields.supplierName,
            supplierVatCountry: fields.supplierVatCountry,
            supplierVatCode: fields.supplierVatCode,
            invoiceNumber: fields.invoiceNumber,
            invoiceDate: fields.invoiceDate,
            totalAmountCents: fields.totalAmountCents,
            currency: fields.currency,
            tenantId,
            status: "PENDING",
            uploadedByUserId,
          })
          .returning(getTableColumns(invoices));
        return invoice;
      } catch (error) {
        if (isUniqueViolation(error, DUPLICATE_UNIQUE_CONSTRAINT)) throw new DuplicateInvoiceError();
        if (isForeignKeyViolation(error, UPLOADER_FOREIGN_KEY)) throw new UserNotInTenantError(uploadedByUserId);
        if (isForeignKeyViolation(error, TENANT_FOREIGN_KEY)) throw new TenantNotFoundError(tenantId);
        throw error;
      }
    },

    async findById(id) {
      if (!idSchema.safeParse(id).success) return null;
      const [invoice] = await db
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, id), eq(invoices.tenantId, tenantId)))
        .limit(1);
      return invoice ?? null;
    },

    async findByBusinessKey(key) {
      const [invoice] = await db
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.tenantId, tenantId),
            eq(invoices.supplierVatCountry, key.supplierVatCountry),
            eq(invoices.supplierVatCode, key.supplierVatCode),
            eq(invoices.invoiceNumber, key.invoiceNumber),
            eq(invoices.invoiceDate, key.invoiceDate),
          ),
        )
        .limit(1);
      return invoice ?? null;
    },

    async list(input) {
      const { status, page, pageSize } = parse(listInvoicesInputSchema, input);
      const where = and(eq(invoices.tenantId, tenantId), status ? eq(invoices.status, status) : undefined);
      const items = await db
        .select()
        .from(invoices)
        .where(where)
        .orderBy(desc(invoices.createdAt), desc(invoices.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const [{ total }] = await db.select({ total: count() }).from(invoices).where(where);
      return { items, totalItems: total };
    },
  };
}

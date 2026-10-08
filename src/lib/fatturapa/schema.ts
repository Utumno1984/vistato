import { z } from "zod";

import { requiredTextSchema, unicodeTrim } from "@/lib/validation/text";

/** Max length of `Numero` in FatturaPA. */
export const INVOICE_NUMBER_MAX_LENGTH = 20;

/** Anti-abuse cap on the raw supplier name ("Nome Cognome" is at most 121 characters in FatturaPA). */
const SUPPLIER_NAME_MAX_RAW_LENGTH = 200;

function codeSchema(pattern: RegExp, message: string, requiredMessage: string) {
  return z
    .string({ message: requiredMessage })
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
      return (
        year >= 100 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
      );
    },
    { message: "La data della fattura non è valida (formato AAAA-MM-GG)" },
  );

/**
 * Data extracted from a FatturaPA file. The formats are the same as the input of the
 * invoices data layer (`createInvoiceInputSchema`, ticket #25): country `^[A-Z]{2}$`,
 * currency `^[A-Z]{3}$`, document type `TDnn`, amount in signed integer cents.
 * It is deliberately not imported from there, to keep the parser a pure function.
 * Stricter than the data layer on purpose: the VAT code of an Italian supplier has 11
 * digits and the invoice number at most 20 characters (FatturaPA limits).
 */
export const fatturaPaDataSchema = z
  .object({
    documentType: codeSchema(
      /^TD[0-9]{2}$/,
      "Il tipo documento deve essere nel formato TDnn",
      "Il tipo documento è obbligatorio",
    ),
    supplierName: requiredTextSchema({
      requiredMessage: "Il nome del fornitore è obbligatorio (Denominazione oppure Nome e Cognome)",
      maxLength: SUPPLIER_NAME_MAX_RAW_LENGTH,
    }),
    supplierVatCountry: codeSchema(
      /^[A-Z]{2}$/,
      "Il paese del fornitore deve essere di 2 lettere maiuscole",
      "Il paese del fornitore è obbligatorio",
    ),
    supplierVatCode: codeSchema(
      /^[A-Za-z0-9]{1,28}$/,
      "Il codice IVA del fornitore deve avere da 1 a 28 caratteri alfanumerici",
      "Il codice IVA del fornitore è obbligatorio",
    ),
    invoiceNumber: requiredTextSchema({
      requiredMessage: "Il numero della fattura è obbligatorio",
      maxLength: 1000,
    }).refine((value) => value.length <= INVOICE_NUMBER_MAX_LENGTH, {
      message: `Il numero della fattura non può superare ${INVOICE_NUMBER_MAX_LENGTH} caratteri`,
    }),
    invoiceDate: calendarDateSchema,
    totalAmountCents: z
      .number({ message: "L'importo deve essere un numero intero di centesimi" })
      .refine((value) => Number.isSafeInteger(value), {
        message: "L'importo deve essere un numero intero di centesimi",
      }),
    currency: codeSchema(/^[A-Z]{3}$/, "La valuta deve essere di 3 lettere maiuscole", "La valuta è obbligatoria"),
  })
  .refine((data) => data.supplierVatCountry !== "IT" || /^[0-9]{11}$/.test(data.supplierVatCode), {
    path: ["supplierVatCode"],
    message: "La partita IVA italiana deve essere di 11 cifre",
  });

export type FatturaPaData = z.output<typeof fatturaPaDataSchema>;

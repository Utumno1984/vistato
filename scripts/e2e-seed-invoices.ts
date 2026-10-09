/**
 * Used by the e2e tests (`e2e/helpers/seed-invoices.ts`): inserts invoices with any status,
 * amount, currency and date into a tenant of the database at DATABASE_URL. The upload API
 * only creates PENDING invoices and e2e code may not use the database client, so the rows
 * are written here. Input: one JSON argument `{ tenantId, userId, invoices: [...] }`.
 */
import "dotenv/config";

import { getDb } from "../src/db/client";
import { invoices } from "../src/db/schema";
import { reportError } from "./report-error";

interface SeedInvoice {
  supplierName: string;
  number: string;
  /** `YYYY-MM-DD`. */
  date: string;
  amountCents: number;
  currency?: string;
  status?: "PENDING" | "APPROVED" | "REJECTED";
}

interface SeedInput {
  tenantId: string;
  /** Uploader (and decider of the non-PENDING invoices): a user of the tenant. */
  userId: string;
  invoices: SeedInvoice[];
}

async function main() {
  const input = JSON.parse(process.argv[2] ?? "") as SeedInput;
  const base = Date.now();
  await getDb()
    .insert(invoices)
    .values(
      input.invoices.map((invoice, index) => {
        const status = invoice.status ?? "PENDING";
        return {
          tenantId: input.tenantId,
          documentType: "TD01",
          supplierName: invoice.supplierName,
          supplierVatCountry: "IT",
          supplierVatCode: "01234567890",
          invoiceNumber: invoice.number,
          invoiceDate: invoice.date,
          totalAmountCents: invoice.amountCents,
          currency: invoice.currency ?? "EUR",
          status,
          uploadedByUserId: input.userId,
          // Distinct, increasing upload instants: a stable order for the tests.
          createdAt: new Date(base + index * 1000),
          ...(status === "PENDING"
            ? {}
            : {
                decidedByUserId: input.userId,
                decidedAt: new Date(base),
                ...(status === "REJECTED" ? { rejectionReason: "e2e" } : {}),
              }),
        };
      }),
    );
  process.exit(0);
}

main().catch((error: unknown) => {
  reportError(error);
  process.exit(1);
});

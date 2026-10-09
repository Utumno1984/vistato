import { execFileSync } from "node:child_process";

import type { TestTenant } from "./create-test-tenant";

export interface SeedInvoice {
  supplierName: string;
  number: string;
  /** `YYYY-MM-DD`. */
  date: string;
  amountCents: number;
  currency?: string;
  status?: "PENDING" | "APPROVED" | "REJECTED";
}

/**
 * Inserts invoices (any status, amount, currency) into the tenant, uploaded by its first user.
 * Later entries are "uploaded" later, so they are listed first. Runs `scripts/e2e-seed-invoices.ts`
 * because e2e code may not use the database client.
 */
export function seedInvoices(tenant: TestTenant, invoices: SeedInvoice[]): void {
  const input = JSON.stringify({ tenantId: tenant.tenantId, userId: tenant.users[0].id, invoices });
  execFileSync("npx", ["tsx", "scripts/e2e-seed-invoices.ts", input], { stdio: "inherit", env: process.env });
}

/** `count` PENDING invoices with distinct numbers. */
export function manyInvoices(count: number, prefix = "N"): SeedInvoice[] {
  return Array.from({ length: count }, (_, i) => ({
    supplierName: `Fornitore ${i}`,
    number: `${prefix}-${i}`,
    date: "2026-03-05",
    amountCents: 1000 + i,
  }));
}

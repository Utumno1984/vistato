import { describe, expect, it } from "vitest";

import type { InvoiceStatus } from "@/db/tenant-scope";
import { STATUS_LABELS, statusBadgeVariant } from "@/lib/invoices/list-view";

describe("statusBadgeVariant", () => {
  const statuses = Object.keys(STATUS_LABELS) as InvoiceStatus[];

  it("maps every status to a defined variant", () => {
    expect(statuses).toHaveLength(3);
    for (const status of statuses) expect(statusBadgeVariant(status)).toBeDefined();
  });

  it("uses a distinct variant per status", () => {
    expect(statusBadgeVariant("PENDING")).toBe("secondary");
    expect(statusBadgeVariant("APPROVED")).toBe("success");
    expect(statusBadgeVariant("REJECTED")).toBe("destructive");
  });
});

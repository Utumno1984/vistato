import { describe, expect, it } from "vitest";

import { verifyCredentials } from "@/db/auth";
import { tenants } from "@/db/schema";
import { isValidVatNumber } from "@/lib/validation/italian-tax-ids";

import { createTestTenant } from "../../e2e/helpers/create-test-tenant";
import { testDb } from "../helpers/db";

describe("e2e helper createTestTenant", () => {
  it("creates an active E2E tenant with a valid VAT number and active users who can log in", async () => {
    const created = await createTestTenant({ users: [{ role: "OWNER" }, { role: "USER" }] }, testDb());

    expect(created.businessName).toMatch(/^E2E /);
    expect(isValidVatNumber(created.vatNumber)).toBe(true);
    const [row] = await testDb().select().from(tenants);
    expect(row).toMatchObject({ id: created.tenantId, status: "ACTIVE", vatNumber: created.vatNumber });
    expect(created.users.map((u) => u.role)).toEqual(["OWNER", "USER"]);
    for (const user of created.users) {
      const auth = await verifyCredentials(user.email, user.password, testDb());
      expect(auth).toMatchObject({ tenantId: created.tenantId, user: { id: user.id, role: user.role } });
    }
  });

  it("can be called many times in parallel without collisions", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => createTestTenant({ users: [{ role: "OWNER" }, { role: "ADMIN" }] }, testDb())),
    );

    expect(new Set(results.map((r) => r.tenantId)).size).toBe(12);
    expect(new Set(results.map((r) => r.vatNumber)).size).toBe(12);
    expect(new Set(results.flatMap((r) => r.users.map((u) => u.email))).size).toBe(24);
  });
});

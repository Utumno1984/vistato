import { expect, test } from "@playwright/test";

import { verifyCredentials } from "@/db/auth/credentials";
import { isValidVatNumber } from "@/lib/validation/italian-tax-ids";

import { createTestTenant } from "./helpers/create-test-tenant";

// Exercises the helper inside a real Playwright worker (TS loaded as CommonJS, writes to DATABASE_URL).
test("createTestTenant creates isolated tenants with users that can authenticate", async () => {
  const [a, b] = await Promise.all([
    createTestTenant({ users: [{ role: "OWNER" }, { role: "USER" }] }),
    createTestTenant({ users: [{ role: "OWNER" }] }),
  ]);

  expect(a.tenantId).not.toBe(b.tenantId);
  expect(a.vatNumber).not.toBe(b.vatNumber);
  expect(isValidVatNumber(a.vatNumber)).toBe(true);
  expect(a.businessName.startsWith("E2E ")).toBe(true);
  expect(a.users).toHaveLength(2);

  for (const [tenant, user] of [...a.users.map((u) => [a, u] as const), ...b.users.map((u) => [b, u] as const)]) {
    const authenticated = await verifyCredentials(user.email, user.password);
    expect(authenticated?.user.id).toBe(user.id);
    expect(authenticated?.user.role).toBe(user.role);
    expect(authenticated?.tenantId).toBe(tenant.tenantId);
    expect(await verifyCredentials(user.email, `${user.password}x`)).toBeNull();
  }
});

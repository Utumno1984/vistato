import { randomBytes, randomInt, randomUUID } from "node:crypto";

import { DuplicateVatNumberError } from "@/db/errors";
import { createTenant } from "@/db/platform/tenants";
import { forTenant, type UserRole } from "@/db/tenant-scope";
import { isValidVatNumber } from "@/lib/validation/italian-tax-ids";

// e2e files cannot import the Drizzle client (ESLint tenant isolation): derive the type.
type Database = NonNullable<Parameters<typeof createTenant>[1]>;

export interface TestUser {
  id: string;
  email: string;
  /** Known password: log in with it. */
  password: string;
  role: UserRole;
}

export interface TestTenant {
  tenantId: string;
  businessName: string;
  vatNumber: string;
  users: TestUser[];
}

/** A random 11-digit VAT number with a correct check digit (found with the app's own validator). */
export function randomVatNumber(): string {
  const base = Array.from({ length: 10 }, () => randomInt(0, 10)).join("");
  for (let check = 0; check < 10; check++) {
    const candidate = `${base}${check}`;
    if (isValidVatNumber(candidate)) return candidate;
  }
  throw new Error("unreachable: exactly one check digit is valid");
}

/**
 * Creates a new ACTIVE tenant ("E2E ..." business name, random valid VAT number) with one
 * ACTIVE user per entry of `users`, each with a random email and a known password.
 * Every call creates fresh data, so tests running in parallel never share or collide.
 * Writes to the database at DATABASE_URL unless `db` is given.
 */
export async function createTestTenant(
  options: { users: { role: UserRole }[] },
  db?: Database,
): Promise<TestTenant> {
  const suffix = randomBytes(4).toString("hex");
  let tenant;
  let vatNumber = randomVatNumber();
  for (let attempt = 0; ; attempt++) {
    try {
      tenant = await createTenant({ businessName: `E2E ${suffix}`, vatNumber }, db);
      break;
    } catch (error) {
      // 10^9 possible numbers: a collision is very unlikely, but cheap to survive.
      if (!(error instanceof DuplicateVatNumberError) || attempt >= 5) throw error;
      vatNumber = randomVatNumber();
    }
  }

  const scope = forTenant(tenant.id, db);
  const created: TestUser[] = [];
  for (const { role } of options.users) {
    const email = `e2e-${randomUUID()}@example.com`;
    const password = `E2e-${randomBytes(12).toString("hex")}`;
    const user = await scope.users.create({
      email,
      firstName: "E2E",
      lastName: role,
      role,
      status: "ACTIVE",
    });
    await scope.users.setPassword(user.id, password);
    created.push({ id: user.id, email, password, role });
  }
  return { tenantId: tenant.id, businessName: tenant.businessName, vatNumber, users: created };
}

/**
 * Seed of the demo tenant and user. Kept apart from `seed.ts` and loaded on demand by
 * `seedDatabase`: it needs the tenant data layer (`@/` imports), which the catalogue-only
 * tooling (e.g. `db:migrate:test`, run from any folder) must not depend on.
 */
import { eq } from "drizzle-orm";

import { PASSWORD_MIN_LENGTH } from "@/lib/auth/password";

import type { Database } from "./client";
import { DuplicateLoginEmailError } from "./errors";
import { createTenant, setTenantStatus } from "./platform/tenants";
import { tenants } from "./schema";
import { forTenant } from "./tenant-scope";

export const DEMO_TENANT_NAME = "Vistato Demo S.r.l.";
/**
 * Fixed demo VAT number (the tenant is found again by it): 0123456789 plus its check digit 7.
 * It cannot belong to a real company (not an assignable number), so no real tenant can
 * collide with the demo one.
 */
export const DEMO_VAT_NUMBER = "01234567897";
/** Reserved domain (RFC 2606): the demo user can never be a real mailbox. */
export const DEMO_USER_EMAIL = "demo@example.com";

/** @throws Error when the password is shorter than the minimum, before anything is written. */
export function assertDemoPassword(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`DEMO_USER_PASSWORD must be at least ${PASSWORD_MIN_LENGTH} characters long.`);
  }
}

/**
 * Idempotent seed of the demo tenant and user, in a single transaction (all or nothing).
 * The tenant is found by its fixed VAT number; the user by email inside that tenant.
 * Every run puts tenant and user back to ACTIVE (user as OWNER) and sets the password
 * to the given one. Other tenants are never touched.
 */
export async function seedDemo(db: Database, password: string): Promise<void> {
  assertDemoPassword(password);
  await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(tenants).where(eq(tenants.vatNumber, DEMO_VAT_NUMBER)).limit(1);
    let tenantId: string;
    if (existing) {
      tenantId = existing.id;
      if (existing.status !== "ACTIVE") await setTenantStatus(tenantId, "ACTIVE", tx);
    } else {
      tenantId = (await createTenant({ businessName: DEMO_TENANT_NAME, vatNumber: DEMO_VAT_NUMBER }, tx)).id;
    }

    const scope = forTenant(tenantId, tx);
    const user = (await scope.users.list()).find((u) => u.email.toLowerCase() === DEMO_USER_EMAIL);
    let userId: string;
    if (user) {
      userId = user.id;
      if (user.role !== "OWNER" || user.status !== "ACTIVE") {
        await scope.users.update(userId, { role: "OWNER", status: "ACTIVE" });
      }
    } else {
      userId = (
        await scope.users.create({
          email: DEMO_USER_EMAIL,
          firstName: "Demo",
          lastName: "Vistato",
          role: "OWNER",
          status: "ACTIVE",
        })
      ).id;
    }

    try {
      await scope.users.setPassword(userId, password);
    } catch (error) {
      if (error instanceof DuplicateLoginEmailError) {
        throw new Error(
          `Cannot seed the demo user: ${DEMO_USER_EMAIL} already logs in with a password in another tenant.`,
          { cause: error },
        );
      }
      throw error;
    }
  });
}

/**
 * AUTHENTICATION — CROSS-TENANT BY NATURE, NOT FILTERED BY TENANT.
 *
 * Login starts from an email and a password, with no tenant known yet, so this module
 * looks users up across all tenants (like `src/db/platform/`). It always returns the
 * `tenantId` read from the database: application code must use that value, never one
 * from the request, with `forTenant`. Reserved for the authentication layer.
 */
import { and, eq, sql } from "drizzle-orm";

import { getDb, type Database } from "@/db/client";
import { tenants, users, type User } from "@/db/schema";
import { hashPassword, PASSWORD_MAX_LENGTH, verifyPassword } from "@/lib/auth/password";

export interface AuthenticatedUser {
  user: Pick<User, "id" | "email" | "firstName" | "lastName" | "role">;
  /** The user's tenant, as stored in the database. */
  tenantId: string;
}

/** Hash verified when the email is unknown, so response times do not reveal which emails exist. */
let dummyHash: Promise<string> | undefined;

/**
 * Checks an email and a password. The email is compared trimmed and case-insensitively.
 * @returns the user and tenant when the credentials are right, the user is ACTIVE and the
 *   tenant is ACTIVE; otherwise null, whatever the reason (the cases are not distinguishable).
 */
export async function verifyCredentials(
  email: string,
  password: string,
  db: Database = getDb(),
): Promise<AuthenticatedUser | null> {
  if (typeof email !== "string" || typeof password !== "string") return null;
  if (password.length > PASSWORD_MAX_LENGTH) return null;

  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      role: users.role,
      status: users.status,
      passwordHash: users.passwordHash,
      tenantId: users.tenantId,
      tenantStatus: tenants.status,
    })
    .from(users)
    .innerJoin(tenants, eq(tenants.id, users.tenantId))
    .where(and(sql`lower(${users.email}) = lower(${email.trim()})`, sql`${users.passwordHash} IS NOT NULL`))
    .limit(1);

  if (!row?.passwordHash) {
    dummyHash ??= hashPassword("dummy-password-for-constant-time");
    await verifyPassword(await dummyHash, password);
    return null;
  }

  // The password is verified before the statuses, so every case costs the same.
  const matches = await verifyPassword(row.passwordHash, password);
  if (!matches || row.status !== "ACTIVE" || row.tenantStatus !== "ACTIVE") return null;

  const { id, firstName, lastName, role, tenantId } = row;
  return { user: { id, email: row.email, firstName, lastName, role }, tenantId };
}

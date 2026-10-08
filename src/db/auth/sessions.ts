/**
 * SESSIONS — CROSS-TENANT BY NATURE, NOT FILTERED BY TENANT.
 *
 * A session is resolved from its token alone, before the tenant is known, so this
 * module reads `sessions` without a tenant filter (like `src/db/platform/`). The tenant
 * is always the one stored in the database; application code uses it with `forTenant`.
 * The composite foreign key (user_id, tenant_id) guarantees that it is the user's own.
 * Only the SHA-256 of the token is stored.
 */
import { createHash, randomBytes } from "node:crypto";

import { and, eq, gt } from "drizzle-orm";

import { getDb, type Database } from "@/db/client";
import { sessions, tenants, users, type User } from "@/db/schema";

/** Sessions last 7 days from creation (absolute expiry, no sliding renewal). */
export const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

const TOKEN_BYTES = 32;
/** 32 bytes in base64url, without padding. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface ResolvedSession {
  sessionId: string;
  user: Pick<User, "id" | "email" | "firstName" | "lastName" | "role">;
  tenant: { id: string; businessName: string };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Creates a session and returns its token (random, 32 bytes, base64url). The token is
 * not stored: only its hash is.
 * @param now reference instant, for tests; defaults to the current time.
 * @throws when the user does not belong to the tenant (composite foreign key).
 */
export async function createSession(
  userId: string,
  tenantId: string,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<string> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  await db.insert(sessions).values({
    userId,
    tenantId,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + SESSION_DURATION_MS),
  });
  return token;
}

/**
 * The user and tenant of a session, or null when the token is malformed or unknown, the
 * session has expired (`expires_at` <= now), or the user or the tenant is no longer ACTIVE.
 * @param now reference instant, for tests; defaults to the current time.
 */
export async function resolveSession(
  token: string,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<ResolvedSession | null> {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;

  const [row] = await db
    .select({
      sessionId: sessions.id,
      userId: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      role: users.role,
      userStatus: users.status,
      tenantId: tenants.id,
      businessName: tenants.businessName,
      tenantStatus: tenants.status,
    })
    .from(sessions)
    .innerJoin(users, and(eq(users.id, sessions.userId), eq(users.tenantId, sessions.tenantId)))
    .innerJoin(tenants, eq(tenants.id, sessions.tenantId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, now)))
    .limit(1);

  if (!row || row.userStatus !== "ACTIVE" || row.tenantStatus !== "ACTIVE") return null;
  return {
    sessionId: row.sessionId,
    user: {
      id: row.userId,
      email: row.email,
      firstName: row.firstName,
      lastName: row.lastName,
      role: row.role,
    },
    tenant: { id: row.tenantId, businessName: row.businessName },
  };
}

/**
 * Deletes every session of a user (matching both user and tenant). Used when the password
 * changes or the user stops being ACTIVE. Accepts a transaction as `db`.
 */
export async function deleteUserSessions(
  userId: string,
  tenantId: string,
  db: Pick<Database, "delete"> = getDb(),
): Promise<void> {
  await db.delete(sessions).where(and(eq(sessions.userId, userId), eq(sessions.tenantId, tenantId)));
}

/** Deletes the session of this token. Idempotent: an unknown or malformed token is fine. */
export async function deleteSession(token: string, db: Database = getDb()): Promise<void> {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return;
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

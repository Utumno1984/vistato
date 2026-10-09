import { and, asc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "@/db/client";
import {
  DuplicateEmailError,
  DuplicateLoginEmailError,
  isForeignKeyViolation,
  isUniqueViolation,
  TenantNotFoundError,
  ValidationError,
} from "@/db/errors";
import { deleteUserSessions } from "@/db/auth/sessions";
import { users, userRole, userStatus, type User as UserRow } from "@/db/schema";
import { hashPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/auth/password";
import { emailSchema } from "@/lib/validation/email";
import { requiredTextSchema } from "@/lib/validation/text";

import type { TenantId } from "./tenant-id";

const EMAIL_UNIQUE_INDEX = "users_tenant_id_lower_email_unique";
const TENANT_FOREIGN_KEY = "users_tenant_id_tenants_id_fk";
const LOGIN_EMAIL_UNIQUE_INDEX = "users_lower_email_with_password_unique";

const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `La password deve avere almeno ${PASSWORD_MIN_LENGTH} caratteri`)
  .max(PASSWORD_MAX_LENGTH, `La password può avere al massimo ${PASSWORD_MAX_LENGTH} caratteri`);

/**
 * Technical anti-abuse cap on raw first and last names (before trimming), not a
 * domain rule: no business length limit has been decided yet.
 */
export const PERSON_NAME_MAX_RAW_LENGTH = 1000;

const userFields = {
  email: emailSchema,
  firstName: requiredTextSchema({ requiredMessage: "Il nome è obbligatorio", maxLength: PERSON_NAME_MAX_RAW_LENGTH }),
  lastName: requiredTextSchema({
    requiredMessage: "Il cognome è obbligatorio",
    maxLength: PERSON_NAME_MAX_RAW_LENGTH,
  }),
  role: z.enum(userRole.enumValues),
  status: z.enum(userStatus.enumValues),
};

/**
 * Input of `users.create`. Only these fields are read: any other key (`tenantId`,
 * `tenant_id`, `id`, `createdAt`, `updatedAt`, ...) is stripped. The tenant always
 * comes from `forTenant`, ID and timestamps from the database; `status` defaults
 * to INVITED.
 */
export const createUserInputSchema = z.object({
  email: userFields.email,
  firstName: userFields.firstName,
  lastName: userFields.lastName,
  role: userFields.role,
  status: userFields.status.optional(),
});

/**
 * Input of `users.update`: a non-empty subset of the `create` fields. Unknown keys
 * are stripped like in `create`; a patch with nothing left to change (e.g. `{}` or
 * `{ tenantId: ... }`) is rejected rather than silently ignored.
 */
export const updateUserInputSchema = createUserInputSchema
  .partial()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "Nessun campo da modificare",
  });

/** A user as exposed by the data layer: the password hash never leaves the database layer. */
export type User = Omit<UserRow, "passwordHash">;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- omitted on purpose
const { passwordHash: _passwordHash, ...userColumns } = getTableColumns(users);
export type UserRole = z.infer<typeof userFields.role>;
export type UserStatus = z.infer<typeof userFields.status>;
export type CreateUserInput = z.input<typeof createUserInputSchema>;
export type UpdateUserInput = z.input<typeof updateUserInputSchema>;

/** User IDs that are not UUIDs cannot exist: they are "not found", never a driver error. */
const userIdSchema = z.uuid();

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  return parsed.data;
}

function rethrowAsDomainError(error: unknown, email: string | undefined, tenantId: TenantId): never {
  if (email !== undefined && isUniqueViolation(error, EMAIL_UNIQUE_INDEX)) throw new DuplicateEmailError(email);
  if (email !== undefined && isUniqueViolation(error, LOGIN_EMAIL_UNIQUE_INDEX)) {
    throw new DuplicateLoginEmailError(email);
  }
  if (isForeignKeyViolation(error, TENANT_FOREIGN_KEY)) throw new TenantNotFoundError(tenantId);
  throw error;
}

/** Operations on the users of one tenant. Every statement filters on (or sets) `tenant_id`. */
export interface TenantUsers {
  /** The tenant's users, oldest first. */
  list(): Promise<User[]>;
  /** The user with this ID in the tenant, or null (also for another tenant's ID or a non-UUID). */
  findById(id: string): Promise<User | null>;
  /** The users of the tenant with these IDs, in one query (unknown, foreign and non-UUID IDs are skipped). */
  findByIds(ids: readonly string[]): Promise<User[]>;
  /**
   * Creates a user in the tenant (status INVITED unless given).
   * @throws ValidationError when the input is invalid (nothing is inserted).
   * @throws DuplicateEmailError when the tenant already has this email, in any case.
   * @throws TenantNotFoundError when the tenant does not exist.
   */
  create(input: CreateUserInput): Promise<User>;
  /**
   * Updates a user of the tenant in a single `UPDATE ... WHERE id AND tenant_id`;
   * `updated_at` strictly increases.
   * @returns the updated user, or null when the tenant has no user with this ID.
   * @throws ValidationError when the patch is invalid or empty.
   * @throws DuplicateEmailError when the new email is already used in the tenant.
   */
  update(id: string, patch: UpdateUserInput): Promise<User | null>;
  /**
   * Deletes a user of the tenant (hard delete).
   * @returns false when the tenant has no user with this ID.
   */
  delete(id: string): Promise<boolean>;
  /**
   * Sets the login password of a user of the tenant (stored as an argon2id hash) in a
   * single `UPDATE ... WHERE id AND tenant_id`.
   * @returns false when the tenant has no user with this ID (also a non-UUID); true otherwise.
   * @throws ValidationError when the password is shorter than 12 or longer than 1024
   *   characters (nothing changes).
   * @throws DuplicateLoginEmailError when another user already logs in with this email.
   */
  setPassword(id: string, password: string): Promise<boolean>;
}

export function tenantUsers(db: Database, tenantId: TenantId): TenantUsers {
  const inTenant = (id: string) => and(eq(users.id, id), eq(users.tenantId, tenantId));

  return {
    async list() {
      return db
        .select(userColumns)
        .from(users)
        .where(eq(users.tenantId, tenantId))
        .orderBy(asc(users.createdAt), asc(users.id));
    },

    async findByIds(ids) {
      const valid = [...new Set(ids)].filter((id) => userIdSchema.safeParse(id).success);
      if (valid.length === 0) return [];
      return db
        .select(userColumns)
        .from(users)
        .where(and(eq(users.tenantId, tenantId), inArray(users.id, valid)));
    },

    async findById(id) {
      if (!userIdSchema.safeParse(id).success) return null;
      const [user] = await db.select(userColumns).from(users).where(inTenant(id)).limit(1);
      return user ?? null;
    },

    async create(input) {
      const { email, firstName, lastName, role, status } = parse(createUserInputSchema, input);
      try {
        const [user] = await db
          .insert(users)
          .values({ email, firstName, lastName, role, status: status ?? "INVITED", tenantId })
          .returning(userColumns);
        return user;
      } catch (error) {
        rethrowAsDomainError(error, email, tenantId);
      }
    },

    async update(id, patch) {
      const { email, firstName, lastName, role, status } = parse(updateUserInputSchema, patch);
      if (!userIdSchema.safeParse(id).success) return null;
      try {
        return await db.transaction(async (tx) => {
          const [user] = await tx
            .update(users)
            // Only the known fields, listed one by one: `tenant_id` and `id` are never written.
            .set({
              email,
              firstName,
              lastName,
              role,
              status,
              updatedAt: sql`greatest(now(), ${users.updatedAt} + interval '1 microsecond')`,
            })
            .where(inTenant(id))
            .returning(userColumns);
          // A user leaving ACTIVE loses its sessions for good: reactivating must not revive them.
          if (user && status !== undefined && status !== "ACTIVE") await deleteUserSessions(id, tenantId, tx);
          return user ?? null;
        });
      } catch (error) {
        rethrowAsDomainError(error, email, tenantId);
      }
    },

    async delete(id) {
      if (!userIdSchema.safeParse(id).success) return false;
      const deleted = await db.delete(users).where(inTenant(id)).returning({ id: users.id });
      return deleted.length > 0;
    },

    async setPassword(id, password) {
      const valid = parse(passwordSchema, password);
      if (!userIdSchema.safeParse(id).success) return false;
      const passwordHash = await hashPassword(valid);
      // Read before the UPDATE: after a failed statement a transaction cannot run queries.
      const [current] = await db.select({ email: users.email }).from(users).where(inTenant(id)).limit(1);
      if (!current) return false;
      try {
        return await db.transaction(async (tx) => {
          const updated = await tx
            .update(users)
            .set({
              passwordHash,
              updatedAt: sql`greatest(now(), ${users.updatedAt} + interval '1 microsecond')`,
            })
            .where(inTenant(id))
            .returning({ id: users.id });
          if (updated.length === 0) return false;
          // A new password invalidates every session opened with the old one.
          await deleteUserSessions(id, tenantId, tx);
          return true;
        });
      } catch (error) {
        if (isUniqueViolation(error, LOGIN_EMAIL_UNIQUE_INDEX)) throw new DuplicateLoginEmailError(current.email);
        throw error;
      }
    },
  };
}

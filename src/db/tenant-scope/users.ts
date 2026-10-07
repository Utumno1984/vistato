import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "@/db/client";
import {
  DuplicateEmailError,
  isForeignKeyViolation,
  isUniqueViolation,
  TenantNotFoundError,
  ValidationError,
} from "@/db/errors";
import { users, userRole, userStatus, type User } from "@/db/schema";
import { emailSchema } from "@/lib/validation/email";
import { requiredTextSchema } from "@/lib/validation/text";

import type { TenantId } from "./tenant-id";

const EMAIL_UNIQUE_INDEX = "users_tenant_id_lower_email_unique";
const TENANT_FOREIGN_KEY = "users_tenant_id_tenants_id_fk";

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
  if (isForeignKeyViolation(error, TENANT_FOREIGN_KEY)) throw new TenantNotFoundError(tenantId);
  throw error;
}

/** Operations on the users of one tenant. Every statement filters on (or sets) `tenant_id`. */
export interface TenantUsers {
  /** The tenant's users, oldest first. */
  list(): Promise<User[]>;
  /** The user with this ID in the tenant, or null (also for another tenant's ID or a non-UUID). */
  findById(id: string): Promise<User | null>;
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
}

export function tenantUsers(db: Database, tenantId: TenantId): TenantUsers {
  const inTenant = (id: string) => and(eq(users.id, id), eq(users.tenantId, tenantId));

  return {
    async list() {
      return db
        .select()
        .from(users)
        .where(eq(users.tenantId, tenantId))
        .orderBy(asc(users.createdAt), asc(users.id));
    },

    async findById(id) {
      if (!userIdSchema.safeParse(id).success) return null;
      const [user] = await db.select().from(users).where(inTenant(id)).limit(1);
      return user ?? null;
    },

    async create(input) {
      const { email, firstName, lastName, role, status } = parse(createUserInputSchema, input);
      try {
        const [user] = await db
          .insert(users)
          .values({ email, firstName, lastName, role, status: status ?? "INVITED", tenantId })
          .returning();
        return user;
      } catch (error) {
        rethrowAsDomainError(error, email, tenantId);
      }
    },

    async update(id, patch) {
      const { email, firstName, lastName, role, status } = parse(updateUserInputSchema, patch);
      if (!userIdSchema.safeParse(id).success) return null;
      try {
        const [user] = await db
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
          .returning();
        return user ?? null;
      } catch (error) {
        rethrowAsDomainError(error, email, tenantId);
      }
    },

    async delete(id) {
      if (!userIdSchema.safeParse(id).success) return false;
      const deleted = await db.delete(users).where(inTenant(id)).returning({ id: users.id });
      return deleted.length > 0;
    },
  };
}

/**
 * TENANT ISOLATION: the only way for application code to read or write
 * tenant-owned data.
 *
 * `forTenant(tenantId)` returns, for each table with a `tenant_id`, operations that
 * add `tenant_id = <tenantId>` to every WHERE and force it on every INSERT. The
 * tenant never comes from the caller's input, and an ID belonging to another tenant
 * behaves exactly like a missing one.
 *
 * Application code (`src/app`, `src/lib`, ...) cannot import the Drizzle client or
 * the tenant-owned tables: an ESLint rule (`eslint.config.mjs`) restricts them to
 * `src/db/**`, `scripts/**` and `tests/**`. Cross-tenant operations are explicit and
 * live elsewhere (e.g. `src/db/platform/`).
 *
 * New tenant-owned tables add a namespace here instead of free queries.
 */
import { z } from "zod";

import { getDb, type Database } from "@/db/client";
import { ValidationError } from "@/db/errors";

import type { ModuleCode } from "@/db/catalog/modules";
import { hasModule } from "@/db/entitlements";

import { tenantModuleOperations, type TenantModules } from "./modules";
import type { TenantId } from "./tenant-id";
import { tenantInvoices, type TenantInvoices } from "./invoices";
import { tenantUsers, type TenantUsers } from "./users";

// Application code cannot import `@/db/schema` (ESLint): the types it needs come from here.
export type { User, UserRole, UserStatus } from "./users";
export {
  createUserInputSchema,
  PERSON_NAME_MAX_RAW_LENGTH,
  updateUserInputSchema,
  type CreateUserInput,
  type TenantUsers,
  type UpdateUserInput,
} from "./users";

export {
  createInvoiceInputSchema,
  INVOICE_TEXT_MAX_RAW_LENGTH,
  type CreateInvoiceInput,
  type Invoice,
  type InvoicePage,
  type InvoiceStatus,
  type ListInvoicesInput,
  type TenantInvoices,
} from "./invoices";

export {
  activateModuleInputSchema,
  type ActivateModuleOptions,
  type TenantModule,
  type TenantModuleEntry,
  type TenantModules,
} from "./modules";
export type { ModuleCode };

export interface TenantScope {
  /** The validated tenant ID every operation is bound to. */
  readonly tenantId: string;
  readonly users: TenantUsers;
  readonly modules: TenantModules;
  readonly invoices: TenantInvoices;
  /** Same rule as the standalone `hasModule` (`@/db/entitlements`), bound to this tenant. */
  hasModule(code: ModuleCode, at?: Date): Promise<boolean>;
}

const forTenantArgsSchema = z.object({ tenantId: z.uuid("ID del tenant non valido") });

/**
 * Data access bound to one tenant. It does not check the tenant's status
 * (a SUSPENDED or CLOSED tenant still works): that is up to authorisation.
 * @param db defaults to the application pool, resolved only after validation.
 * @throws ValidationError when `tenantId` is not a UUID, before any query.
 */
export function forTenant(tenantId: string, db?: Database): TenantScope {
  const parsed = forTenantArgsSchema.safeParse({ tenantId });
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  const id = parsed.data.tenantId as TenantId;
  const database = db ?? getDb();

  return Object.freeze({
    tenantId: id,
    users: Object.freeze(tenantUsers(database, id)),
    modules: Object.freeze(tenantModuleOperations(database, id)),
    invoices: Object.freeze(tenantInvoices(database, id)),
    hasModule: (code: ModuleCode, at?: Date) => hasModule(id, code, at, database),
  });
}

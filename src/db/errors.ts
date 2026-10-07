import type { z } from "zod";

/** One invalid input field, as reported by Zod (`field` is the dotted path, "" for the root). */
export interface FieldIssue {
  field: string;
  message: string;
}

/** The input was rejected before reaching the database. */
export class ValidationError extends Error {
  readonly issues: readonly FieldIssue[];

  constructor(issues: readonly FieldIssue[]) {
    super(`Invalid input: ${issues.map((i) => i.field || "(root)").join(", ")}`);
    this.name = "ValidationError";
    this.issues = issues;
  }

  /** Names of the invalid fields, without duplicates. */
  get fields(): string[] {
    return [...new Set(this.issues.map((i) => i.field))];
  }

  static fromZod(error: z.ZodError): ValidationError {
    return new ValidationError(
      error.issues.map((issue) => ({ field: issue.path.map(String).join("."), message: issue.message })),
    );
  }
}

/** Another tenant already has this partita IVA (unique constraint on `tenants.vat_number`). */
export class DuplicateVatNumberError extends Error {
  constructor(readonly vatNumber: string) {
    super("A tenant with this VAT number already exists");
    this.name = "DuplicateVatNumberError";
  }
}

/** No tenant has the given ID. */
export class TenantNotFoundError extends Error {
  constructor(readonly tenantId: string) {
    super("Tenant not found");
    this.name = "TenantNotFoundError";
  }
}

const UNIQUE_VIOLATION = "23505";

/**
 * True when `error` (or any error in its `cause` chain: Drizzle wraps driver
 * errors) is a Postgres unique violation on the given constraint.
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const pg = e as { code?: unknown; constraint_name?: unknown };
    if (pg.code === UNIQUE_VIOLATION && pg.constraint_name === constraint) return true;
  }
  return false;
}

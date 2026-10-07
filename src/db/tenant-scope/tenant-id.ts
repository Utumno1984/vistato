/**
 * A tenant ID already validated by `forTenant`. The brand keeps the per-table
 * scoped operations from being built with an unchecked string.
 */
export type TenantId = string & { readonly __brand: "TenantId" };

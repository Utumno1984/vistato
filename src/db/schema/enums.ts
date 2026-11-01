import { pgEnum } from "drizzle-orm/pg-core";

export const tenantStatus = pgEnum("tenant_status", ["ACTIVE", "SUSPENDED", "CLOSED"]);

export const userRole = pgEnum("user_role", ["OWNER", "ADMIN", "USER"]);

export const userStatus = pgEnum("user_status", ["ACTIVE", "INVITED", "DISABLED"]);

export const invoiceStatus = pgEnum("invoice_status", ["PENDING", "APPROVED", "REJECTED"]);

export const tenantModuleStatus = pgEnum("tenant_module_status", ["ACTIVE", "CANCELLED"]);

/**
 * State of a tenant's link to a Fatture in Cloud company ("not connected" is the absence of a row).
 * Lower case: the same values are exposed by `GET /api/integrations/fic`.
 */
export const ficConnectionStatus = pgEnum("fic_connection_status", ["pending_company_selection", "connected"]);

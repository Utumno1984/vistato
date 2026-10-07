import { pgEnum } from "drizzle-orm/pg-core";

export const tenantStatus = pgEnum("tenant_status", ["ACTIVE", "SUSPENDED", "CLOSED"]);

export const userRole = pgEnum("user_role", ["OWNER", "ADMIN", "USER"]);

export const userStatus = pgEnum("user_status", ["ACTIVE", "INVITED", "DISABLED"]);

export const tenantModuleStatus = pgEnum("tenant_module_status", ["ACTIVE", "CANCELLED"]);

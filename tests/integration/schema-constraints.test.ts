import { eq } from "drizzle-orm";
import type postgres from "postgres";
import { describe, expect, it } from "vitest";

import { modules, tenants } from "@/db/schema";

import { testDb, testSql } from "../helpers/db";

// Postgres SQLSTATE codes
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const NOT_NULL_VIOLATION = "23502";

/** Asserts that `query` fails with the given SQLSTATE (and constraint, when given). */
async function expectPgError(query: Promise<unknown>, code: string, constraint?: string) {
  const error = await query.then(
    () => undefined,
    (e: unknown) => e as { code?: string; constraint_name?: string },
  );
  expect(error, "expected the database to reject the statement").toBeDefined();
  expect(error?.code).toBe(code);
  if (constraint) expect(error?.constraint_name).toBe(constraint);
}

// Timestamps as ISO strings: postgres.js cannot serialise a Date in the insert helper.
type Values = Record<string, string | null>;
type Row = postgres.Row;

async function insertTenant(values: Values = {}): Promise<Row> {
  const row = { business_name: "Acme S.r.l.", vat_number: "12345678901", tax_code: null, ...values };
  const [tenant] = await testSql()`insert into tenants ${testSql()(row)} returning *`;
  return tenant;
}

async function insertUser(tenantId: string | null, values: Values = {}): Promise<Row> {
  const row = {
    tenant_id: tenantId,
    email: "mario@acme.it",
    first_name: "Mario",
    last_name: "Rossi",
    role: "USER",
    ...values,
  };
  const [user] = await testSql()`insert into users ${testSql()(row)} returning *`;
  return user;
}

async function moduleId(code: string): Promise<string> {
  const [row] = await testDb().select({ id: modules.id }).from(modules).where(eq(modules.code, code));
  return row.id;
}

async function insertTenantModule(tenantId: string | null, values: Values = {}): Promise<Row> {
  const row = {
    tenant_id: tenantId,
    module_id: await moduleId("cost_centers"),
    status: "ACTIVE",
    activated_at: "2026-01-01T00:00:00Z",
    ...values,
  };
  const [tm] = await testSql()`insert into tenant_modules ${testSql()(row)} returning *`;
  return tm;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function expectGeneratedColumns(row: Row) {
  expect(row.id).toMatch(UUID);
  expect(row.created_at).toBeInstanceOf(Date);
  expect(row.updated_at).toBeInstanceOf(Date);
}

describe("generated columns", () => {
  it("fill id, created_at and updated_at on every table", async () => {
    const tenant = await insertTenant();
    expectGeneratedColumns(tenant);
    expectGeneratedColumns(await insertUser(tenant.id));
    expectGeneratedColumns(await insertTenantModule(tenant.id));

    const [module] = await testSql()`
      insert into modules (code, name, description) values ('tmp_module', 'Tmp', 'Tmp') returning *`;
    try {
      expectGeneratedColumns(module);
      expect(module.is_base).toBe(false);
    } finally {
      await testSql()`delete from modules where code = 'tmp_module'`;
    }
  });

  it("use timestamptz for created_at and updated_at", async () => {
    const rows = await testSql()`
      select table_name, column_name, data_type from information_schema.columns
      where table_schema = 'public' and column_name in ('created_at', 'updated_at')`;
    expect(rows).toHaveLength(10); // 5 tables: tenants, users, modules, tenant_modules, sessions
    for (const row of rows) expect(row.data_type).toBe("timestamp with time zone");
  });

  it("refresh updated_at when a row is updated through Drizzle", async () => {
    const [tenant] = await testDb()
      .insert(tenants)
      .values({ businessName: "Acme S.r.l.", vatNumber: "12345678901" })
      .returning();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const [updated] = await testDb()
      .update(tenants)
      .set({ businessName: "Acme S.p.A." })
      .where(eq(tenants.id, tenant.id))
      .returning();

    expect(updated.updatedAt.getTime()).toBeGreaterThan(tenant.updatedAt.getTime());
    expect(updated.createdAt).toEqual(tenant.createdAt);
  });
});

describe("tenants", () => {
  it("default to status ACTIVE", async () => {
    expect((await insertTenant()).status).toBe("ACTIVE");
  });

  // The CHECK is `length(btrim(business_name)) > 0` as specified: btrim removes spaces only,
  // other whitespace (tabs, newlines) is left to the application-level validation.
  it.each(["", " ", "   "])("reject a blank business_name (%j)", async (businessName) => {
    await expectPgError(
      insertTenant({ business_name: businessName }),
      CHECK_VIOLATION,
      "tenants_business_name_not_blank",
    );
  });

  it("reject a missing business_name", async () => {
    await expectPgError(insertTenant({ business_name: null }), NOT_NULL_VIOLATION);
  });

  it("reject vat_number and tax_code both NULL", async () => {
    await expectPgError(
      insertTenant({ vat_number: null, tax_code: null }),
      CHECK_VIOLATION,
      "tenants_vat_number_or_tax_code",
    );
  });

  it.each(["123", "IT12345678901", "1234567890a", "123456789012", "1234567890", "12345 678901", " 12345678901", "12345678901\n", ""])(
    "reject vat_number %j (not exactly 11 digits)",
    async (vatNumber) => {
      await expectPgError(
        insertTenant({ vat_number: vatNumber }),
        CHECK_VIOLATION,
        "tenants_vat_number_format",
      );
    },
  );

  it.each([
    ["11 digits", "12345678901"],
    ["16 upper-case alphanumerics", "RSSMRA80A01H501U"],
    ["16 characters with omocodia", "RSSMRALPAMNH5Q1U"],
  ])("accept a tax_code of %s", async (_, taxCode) => {
    const tenant = await insertTenant({ vat_number: null, tax_code: taxCode });
    expect(tenant.tax_code).toBe(taxCode);
  });

  it.each(["rssmra80a01h501u", "RSSMRA80A01H501", "RSSMRA80A01H501UX", "1234567890", "RSSMRA80A01H50-U", "", "RSSMRA80A01H501U "])(
    "reject tax_code %j",
    async (taxCode) => {
      await expectPgError(
        insertTenant({ vat_number: null, tax_code: taxCode }),
        CHECK_VIOLATION,
        "tenants_tax_code_format",
      );
    },
  );

  it("reject a second tenant with the same vat_number", async () => {
    await insertTenant({ vat_number: "12345678901" });
    await expectPgError(
      insertTenant({ business_name: "Altra S.r.l.", vat_number: "12345678901" }),
      UNIQUE_VIOLATION,
      "tenants_vat_number_unique",
    );
  });

  it("accept several tenants without vat_number (tax_code only)", async () => {
    await insertTenant({ vat_number: null, tax_code: "RSSMRA80A01H501U" });
    await insertTenant({ vat_number: null, tax_code: "VRDLGU75B02F205X" });
    const [{ count }] = await testSql()`select count(*)::int as count from tenants`;
    expect(count).toBe(2);
  });

  it("reject an unknown status", async () => {
    await expectPgError(insertTenant({ status: "DELETED" }), "22P02");
  });

  it("cannot be deleted while it has users", async () => {
    const tenant = await insertTenant();
    await insertUser(tenant.id);
    await expectPgError(
      testSql()`delete from tenants where id = ${tenant.id}`,
      FOREIGN_KEY_VIOLATION,
      "users_tenant_id_tenants_id_fk",
    );
  });

  it("cannot be deleted while it has purchased modules", async () => {
    const tenant = await insertTenant();
    await insertTenantModule(tenant.id);
    await expectPgError(
      testSql()`delete from tenants where id = ${tenant.id}`,
      FOREIGN_KEY_VIOLATION,
      "tenant_modules_tenant_id_tenants_id_fk",
    );
  });

  it("can be deleted when nothing references it", async () => {
    const tenant = await insertTenant();
    await testSql()`delete from tenants where id = ${tenant.id}`;
    const [{ count }] = await testSql()`select count(*)::int as count from tenants`;
    expect(count).toBe(0);
  });
});

describe("foreign keys", () => {
  // 'r' = RESTRICT. The deletion tests above would also pass with NO ACTION (the default):
  // check the declared action explicitly.
  it("are all declared ON DELETE RESTRICT", async () => {
    const rows = await testSql()`
      select conname, conrelid::regclass::text as table_name, confdeltype
      from pg_constraint
      where contype = 'f' and connamespace = 'public'::regnamespace
      order by conname`;
    // The only exception is sessions -> users, which is ON DELETE CASCADE ('c') on purpose:
    // deleting a user deletes its sessions.
    expect(rows).toEqual([
      { conname: "sessions_tenant_id_tenants_id_fk", table_name: "sessions", confdeltype: "r" },
      { conname: "sessions_user_id_tenant_id_users_fk", table_name: "sessions", confdeltype: "c" },
      { conname: "tenant_modules_module_id_modules_id_fk", table_name: "tenant_modules", confdeltype: "r" },
      { conname: "tenant_modules_tenant_id_tenants_id_fk", table_name: "tenant_modules", confdeltype: "r" },
      { conname: "users_tenant_id_tenants_id_fk", table_name: "users", confdeltype: "r" },
    ]);
  });
});

describe("users", () => {
  it("default to status INVITED", async () => {
    const tenant = await insertTenant();
    expect((await insertUser(tenant.id)).status).toBe("INVITED");
  });

  it("reject the same email with different case in the same tenant", async () => {
    const tenant = await insertTenant();
    await insertUser(tenant.id, { email: "mario@acme.it" });
    await expectPgError(
      insertUser(tenant.id, { email: "MARIO@Acme.IT" }),
      UNIQUE_VIOLATION,
      "users_tenant_id_lower_email_unique",
    );
  });

  it("accept the same email in another tenant", async () => {
    const tenantA = await insertTenant({ vat_number: "12345678901" });
    const tenantB = await insertTenant({ business_name: "Beta S.r.l.", vat_number: "10987654321" });
    await insertUser(tenantA.id, { email: "mario@acme.it" });
    const user = await insertUser(tenantB.id, { email: "MARIO@Acme.IT" });
    expect(user.tenant_id).toBe(tenantB.id);
  });

  it("require an existing tenant", async () => {
    await expectPgError(
      insertUser("00000000-0000-4000-8000-000000000000"),
      FOREIGN_KEY_VIOLATION,
      "users_tenant_id_tenants_id_fk",
    );
  });

  it("require tenant_id", async () => {
    await expectPgError(insertUser(null), NOT_NULL_VIOLATION);
  });

  it("reject an unknown role", async () => {
    const tenant = await insertTenant();
    await expectPgError(insertUser(tenant.id, { role: "SUPERUSER" }), "22P02");
  });
});

describe("modules", () => {
  it("reject a duplicate code", async () => {
    await expectPgError(
      testSql()`insert into modules (code, name, description) values ('approvals', 'Doppio', 'Doppio')`,
      UNIQUE_VIOLATION,
      "modules_code_unique",
    );
  });
});

describe("tenant_modules", () => {
  it("have an index on module_id", async () => {
    const rows = await testSql()`
      select indexdef from pg_indexes
      where schemaname = 'public' and tablename = 'tenant_modules'
        and indexname = 'tenant_modules_module_id_idx'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/USING btree \(module_id\)$/);
  });

  it("reject a second row for the same tenant and module", async () => {
    const tenant = await insertTenant();
    await insertTenantModule(tenant.id);
    await expectPgError(
      insertTenantModule(tenant.id, { status: "CANCELLED" }),
      UNIQUE_VIOLATION,
      "tenant_modules_tenant_id_module_id_unique",
    );
  });

  it("accept the same module for different tenants", async () => {
    const tenantA = await insertTenant({ vat_number: "12345678901" });
    const tenantB = await insertTenant({ business_name: "Beta S.r.l.", vat_number: "10987654321" });
    await insertTenantModule(tenantA.id);
    await insertTenantModule(tenantB.id);
  });

  it("reject a row without activated_at", async () => {
    const tenant = await insertTenant();
    await expectPgError(insertTenantModule(tenant.id, { activated_at: null }), NOT_NULL_VIOLATION);
  });

  it.each([
    ["equal to", "2026-01-01T00:00:00Z"],
    ["before", "2025-12-31T23:59:59Z"],
  ])("reject expires_at %s activated_at", async (_, expiresAt) => {
    const tenant = await insertTenant();
    await expectPgError(
      insertTenantModule(tenant.id, { expires_at: expiresAt }),
      CHECK_VIOLATION,
      "tenant_modules_expires_after_activation",
    );
  });

  it("accept expires_at after activated_at, or no expiry", async () => {
    const tenantA = await insertTenant({ vat_number: "12345678901" });
    const tenantB = await insertTenant({ business_name: "Beta S.r.l.", vat_number: "10987654321" });
    const withExpiry = await insertTenantModule(tenantA.id, {
      expires_at: "2027-01-01T00:00:00Z",
    });
    expect(withExpiry.expires_at).toEqual(new Date("2027-01-01T00:00:00Z"));
    expect((await insertTenantModule(tenantB.id)).expires_at).toBeNull();
  });

  it("require existing tenant and module", async () => {
    const tenant = await insertTenant();
    await expectPgError(
      insertTenantModule(tenant.id, { module_id: "00000000-0000-4000-8000-000000000000" }),
      FOREIGN_KEY_VIOLATION,
      "tenant_modules_module_id_modules_id_fk",
    );
    await expectPgError(
      insertTenantModule("00000000-0000-4000-8000-000000000000"),
      FOREIGN_KEY_VIOLATION,
      "tenant_modules_tenant_id_tenants_id_fk",
    );
  });

  it("prevent deleting a module purchased by a tenant", async () => {
    const tenant = await insertTenant();
    await insertTenantModule(tenant.id);
    await expectPgError(
      testSql()`delete from modules where code = 'cost_centers'`,
      FOREIGN_KEY_VIOLATION,
      "tenant_modules_module_id_modules_id_fk",
    );
  });
});

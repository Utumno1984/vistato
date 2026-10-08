import { describe, expect, it } from "vitest";

import { testSql } from "../helpers/db";

async function counts() {
  const [row] = await testSql()`
    select
      (select count(*) from tenants)::int as tenants,
      (select count(*) from users)::int as users,
      (select count(*) from tenant_modules)::int as tenant_modules,
      (select count(*) from modules)::int as modules`;
  return row;
}

// The two tests run in order: the second checks what the first one left behind.
describe("cleanup between integration tests", () => {
  it("a test inserts tenant data", async () => {
    const [tenant] = await testSql()`
      insert into tenants (business_name, vat_number) values ('Acme S.r.l.', '12345678901')
      returning id`;
    await testSql()`
      insert into users (tenant_id, email, first_name, last_name, role)
      values (${tenant.id}, 'mario@acme.it', 'Mario', 'Rossi', 'OWNER')`;
    await testSql()`
      insert into tenant_modules (tenant_id, module_id, status, activated_at)
      select ${tenant.id}, id, 'ACTIVE', now() from modules where code = 'approvals'`;

    expect(await counts()).toEqual({ tenants: 1, users: 1, tenant_modules: 1, modules: 4 });
  });

  it("the next test starts with empty tenant tables and the full module catalogue", async () => {
    expect(await counts()).toEqual({ tenants: 0, users: 0, tenant_modules: 0, modules: 4 });
  });
});

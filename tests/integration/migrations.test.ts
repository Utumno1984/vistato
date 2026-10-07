import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrateDatabase } from "@/db/migrate";

import { createTempDatabase, type TempDatabase } from "../helpers/temp-database";

/** Structural fingerprint of the public schema, to detect any change. */
async function schemaSnapshot(db: TempDatabase) {
  const columns = await db.sql`
    select table_name, column_name, data_type, is_nullable, column_default
    from information_schema.columns where table_schema = 'public'
    order by table_name, column_name`;
  const constraints = await db.sql`
    select conrelid::regclass::text as table_name, conname, pg_get_constraintdef(oid) as def
    from pg_constraint where connamespace = 'public'::regnamespace
    order by conname`;
  const indexes = await db.sql`
    select indexname, indexdef from pg_indexes where schemaname = 'public' order by indexname`;
  const enums = await db.sql`
    select t.typname, array_agg(e.enumlabel order by e.enumsortorder) as labels
    from pg_type t join pg_enum e on e.enumtypid = t.oid
    group by t.typname order by t.typname`;
  const migrations = await db.sql`
    select hash, created_at from drizzle.__drizzle_migrations order by id`;
  return { columns, constraints, indexes, enums, migrations };
}

describe("migrations in drizzle/", () => {
  let db: TempDatabase;

  beforeAll(async () => {
    db = await createTempDatabase();
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("apply cleanly to an empty database and create tables and enums", async () => {
    await expect(migrateDatabase(db.url)).resolves.toBeUndefined();

    const tables = await db.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'`;
    expect(tables.map((t) => t.table_name)).toEqual(
      expect.arrayContaining(["tenants", "users", "modules", "tenant_modules"]),
    );

    const enums = await db.sql<{ typname: string }[]>`
      select typname from pg_type where typtype = 'e' and typnamespace = 'public'::regnamespace`;
    expect(enums.map((e) => e.typname)).toEqual(
      expect.arrayContaining(["tenant_status", "user_role", "user_status", "tenant_module_status"]),
    );
  });

  it("can be applied again with no errors and no changes", async () => {
    const before = await schemaSnapshot(db);
    expect(before.migrations.length).toBeGreaterThan(0);

    await expect(migrateDatabase(db.url)).resolves.toBeUndefined();

    expect(await schemaSnapshot(db)).toEqual(before);
  });
});

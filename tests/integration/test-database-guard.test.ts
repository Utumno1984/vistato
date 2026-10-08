import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { assertConnectedToTestDatabase, migrateDatabase, seedDatabase } from "@/db/migrate";

import { resetDb, testSql } from "../helpers/db";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-database";

async function publicTables(db: TempDatabase): Promise<string[]> {
  const rows = await db.sql<{ table_name: string }[]>`
    select table_name from information_schema.tables where table_schema = 'public'`;
  return rows.map((r) => r.table_name);
}

describe("test tooling refuses non-test databases", () => {
  // Stands in for the development database: its name does not end with `_test`.
  let devDb: TempDatabase;

  beforeAll(async () => {
    devDb = await createTempDatabase({ testSuffix: false });
  });
  afterAll(async () => {
    await devDb?.drop();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("migrateDatabase with testOnly does not migrate it", async () => {
    await expect(migrateDatabase(devDb.url, { testOnly: true })).rejects.toThrow(
      `Refusing to use database "${devDb.name}"`,
    );
    expect(await publicTables(devDb)).toEqual([]);
  });

  it("seedDatabase with testOnly does not write to it", async () => {
    await devDb.sql`create table modules (code text)`;
    try {
      await expect(seedDatabase(devDb.url, { testOnly: true })).rejects.toThrow(/Refusing/);
      expect(await devDb.sql`select * from modules`).toHaveLength(0);
    } finally {
      await devDb.sql`drop table modules`;
    }
  });

  it("resetDb refuses when TEST_DATABASE_URL points to it", async () => {
    vi.stubEnv("TEST_DATABASE_URL", devDb.url);
    await expect(resetDb()).rejects.toThrow(`Refusing to use database "${devDb.name}"`);
  });

  it("the server-side check rejects it and accepts the test database", async () => {
    await expect(assertConnectedToTestDatabase(devDb.sql)).rejects.toThrow(/Refusing/);
    await expect(assertConnectedToTestDatabase(testSql())).resolves.toBeUndefined();
  });
});

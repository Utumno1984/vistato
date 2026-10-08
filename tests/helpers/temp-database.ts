import { randomBytes } from "node:crypto";

import postgres from "postgres";

import { requireTestDatabaseUrl, TEST_DATABASE_SUFFIX } from "@/db/migrate";

export interface TempDatabase {
  name: string;
  url: string;
  /** Short-lived connection to the temporary database (closed by `drop`). */
  sql: postgres.Sql;
  drop: () => Promise<void>;
}

/**
 * Creates an empty database `vistato_migrate_<random>_test` on the test server, for tests
 * that need a pristine database (e.g. applying migrations from scratch).
 *
 * `testSuffix: false` omits the `_test` suffix: only for tests that check that test
 * tooling refuses non-test databases.
 */
export async function createTempDatabase({ testSuffix = true } = {}): Promise<TempDatabase> {
  const adminUrl = requireTestDatabaseUrl();
  const name = `vistato_migrate_${randomBytes(6).toString("hex")}${testSuffix ? TEST_DATABASE_SUFFIX : ""}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE "${name}"`);

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  url.searchParams.delete("database");
  const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });

  return {
    name,
    url: url.toString(),
    sql,
    drop: async () => {
      await sql.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
    },
  };
}

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  assertConnectedToTestDatabase,
  assertTestDatabase,
  requireTestDatabaseUrl,
} from "@/db/migrate";
import * as schema from "@/db/schema";

/**
 * Direct connections to the test database for integration tests, independent from
 * the application pool in `src/db/client.ts` (which some tests reset or redirect).
 *
 * Raw SQL and Drizzle use separate clients: Drizzle changes the type parsers of the
 * client it wraps (timestamps become strings), raw SQL keeps the postgres.js defaults.
 */
let rawClient: postgres.Sql | undefined;
let drizzleClient: postgres.Sql | undefined;
let database: PostgresJsDatabase<typeof schema> | undefined;

function connect(): postgres.Sql {
  return postgres(requireTestDatabaseUrl(), { max: 1, onnotice: () => {} });
}

export function testSql(): postgres.Sql {
  rawClient ??= connect();
  return rawClient;
}

export function testDb(): PostgresJsDatabase<typeof schema> {
  if (!database) {
    drizzleClient = connect();
    database = drizzle(drizzleClient, { schema });
  }
  return database;
}

/**
 * Empties every tenant-owned table. The global `modules` catalogue is kept.
 * Refuses unless both the URL and the connected database are a `*_test` database.
 */
export async function resetDb(): Promise<void> {
  assertTestDatabase(requireTestDatabaseUrl());
  const sql = testSql();
  await assertConnectedToTestDatabase(sql);
  await sql`TRUNCATE invoices, sessions, tenant_modules, users, tenants CASCADE`;
}

export async function closeTestDb(): Promise<void> {
  await Promise.all([rawClient?.end(), drizzleClient?.end()]);
  rawClient = undefined;
  drizzleClient = undefined;
  database = undefined;
}

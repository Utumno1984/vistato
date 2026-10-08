import "dotenv/config";

import { migrateDatabase, requireTestDatabaseUrl, seedDatabase } from "../src/db/migrate";

/**
 * Runs once before the integration tests: migrations, then the module catalogue.
 * Refuses to run unless TEST_DATABASE_URL points to a `*_test` database.
 */
export default async function setup() {
  const url = requireTestDatabaseUrl();
  await migrateDatabase(url, { testOnly: true });
  await seedDatabase(url, { testOnly: true });
}

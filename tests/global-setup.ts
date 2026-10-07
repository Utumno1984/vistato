import "dotenv/config";

import { migrateDatabase, requireTestDatabaseUrl, seedDatabase } from "../src/db/migrate";

/** Runs once before the integration tests: migrations, then the module catalogue. */
export default async function setup() {
  const url = requireTestDatabaseUrl();
  await migrateDatabase(url);
  await seedDatabase(url);
}

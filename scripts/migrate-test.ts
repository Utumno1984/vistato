/**
 * `npm run db:migrate:test`: applies the migrations to the test database
 * (TEST_DATABASE_URL). Fails without touching any database when the variable is missing
 * or does not point to a `*_test` database.
 */
import "dotenv/config";

import { migrateDatabase, requireTestDatabaseUrl } from "../src/db/migrate";
import { reportError } from "./report-error";

async function main() {
  const url = requireTestDatabaseUrl();
  await migrateDatabase(url, { testOnly: true });
  console.log("Test database migrated.");
}

main().catch((error: unknown) => {
  reportError(error);
  process.exit(1);
});

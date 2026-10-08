/**
 * `npm run db:seed`: writes the module catalogue to the database at DATABASE_URL.
 * Idempotent: it can be run any number of times.
 */
import "dotenv/config";

import { seedDatabase } from "../src/db/migrate";
import { reportError } from "./report-error";

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
  await seedDatabase(url);
  console.log("Module catalogue seeded.");
}

main().catch((error: unknown) => {
  reportError(error);
  process.exit(1);
});

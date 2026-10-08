/**
 * `npm run db:seed`: writes the module catalogue to the database at DATABASE_URL and,
 * when DEMO_USER_PASSWORD is set, the demo tenant and user. Idempotent: it can be run
 * any number of times. Without the variable only the catalogue is written (exit 0);
 * with a password shorter than 12 characters it fails and writes no demo data.
 */
import "dotenv/config";

import { seedDatabase } from "../src/db/migrate";
import { reportError } from "./report-error";

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
  const { demoSeeded } = await seedDatabase(url, { demoPassword: process.env.DEMO_USER_PASSWORD });
  console.log("Module catalogue seeded.");
  if (demoSeeded) {
    console.log("Demo tenant and user seeded.");
  } else {
    console.warn("Warning: DEMO_USER_PASSWORD is not set: demo tenant and user were NOT created.");
  }
}

main().catch((error: unknown) => {
  reportError(error);
  process.exit(1);
});

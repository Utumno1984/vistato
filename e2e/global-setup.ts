import "dotenv/config";

import { seedDatabase } from "../src/db/migrate";

/**
 * Runs once before the Playwright suite: module catalogue and demo tenant/user on the
 * database at DATABASE_URL (integration tests empty the shared database before the e2e run).
 */
export default async function globalSetup() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
  const { demoSeeded } = await seedDatabase(url, { demoPassword: process.env.DEMO_USER_PASSWORD });
  if (!demoSeeded) console.warn("DEMO_USER_PASSWORD is not set: the demo user does not exist.");
}

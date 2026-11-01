import { execFileSync } from "node:child_process";

import "dotenv/config";

import { FAKE_FIC_PORT } from "./helpers/fake-fic/control";
import { startFakeFic } from "./helpers/fake-fic/server";

/**
 * Runs once before the Playwright suite:
 * 1. `npm run db:seed` (module catalogue and demo tenant/user) on the database at
 *    DATABASE_URL, since the integration tests empty the shared database before the e2e
 *    run. It runs as a separate process because Playwright loads TypeScript as CommonJS,
 *    which cannot load `src/db/migrate.ts` (`import.meta`).
 * 2. Starts the fake Fatture in Cloud on its fixed port (the web server is configured to
 *    use it, see `playwright.config.ts`); the returned teardown stops it.
 */
export default async function globalSetup() {
  if (!process.env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL is not set (see .env.example)");
  execFileSync("npm", ["run", "--silent", "db:seed"], { stdio: "inherit", env: process.env });
  const fakeFic = await startFakeFic({ port: FAKE_FIC_PORT });
  return () => fakeFic.close();
}
